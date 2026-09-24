// 경보 메일 신청 — 대시보드의 「경보 메일」 창이 부른다.
//
//   GET  ?action=status              신청을 받을 준비가 됐는지(저장소 + 아무에게나 보낼 수 있는 메일)
//   POST {action:"subscribe", email, regions, districts, minLevel, digest, lang}
//        → 확인 대기로 저장하고 확인 메일 발송. 메일의 링크(대시보드 ?confirm=)에서 버튼을 눌러야 활성.
//   POST {action:"confirm", t}       확인 → 활성. 같은 이메일의 옛 신청은 대체된다.
//   POST {action:"get", t}           설정 보기(링크를 받은 본인만 token을 안다)
//   POST {action:"update", t, ...}   지역·등급·요약 변경
//   POST {action:"unsub", t}         해지(즉시 삭제)
//   POST ?action=unsub&t=...         메일 앱의 "원클릭 수신거부"(List-Unsubscribe-Post)용
//
// 확인·해지를 GET 링크 한 번으로 처리하지 않는 이유: 회사 메일 보안 스캐너가 메일 속 링크를
// 미리 열어 보는 일이 흔해서, GET만으로 처리하면 사람이 누르지 않아도 확인·해지가 된다.
// 그래서 링크는 대시보드를 열기만 하고, 실제 처리는 화면의 버튼(POST)으로 한다.

const crypto = require("crypto");
const { hasStore, redis, pipe, parse } = require("./_lib/store.js");
const { sendMany, canMailAnyone } = require("./_lib/mailer.js");
const baseline = require("../data/baseline.json");
const districtBase = require("../data/baseline_district.json");

const REGION_SET = new Set(baseline.map((r) => r.name));
const DISTRICT_SET = new Set(districtBase.map((d) => d.name));
const REGION_EN = Object.fromEntries(baseline.map((r) => [r.name, r.en]));
const EMAIL_RE = /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[a-z]{2,}$/i;
const LV = ["정상", "관심", "주의", "경계", "심각"];

function clean(b) {
  const regions = [...new Set((Array.isArray(b.regions) ? b.regions : []).filter((x) => REGION_SET.has(x)))];
  const districts = [...new Set((Array.isArray(b.districts) ? b.districts : []).filter((x) => DISTRICT_SET.has(x)))];
  const minLevel = [2, 3, 4].includes(+b.minLevel) ? +b.minLevel : 3;
  return { regions, districts, minLevel, digest: !!b.digest, lang: b.lang === "en" ? "en" : "ko" };
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const areaText = (p) =>
  !p.regions.length && !p.districts.length
    ? "전국 전체 / All of Tanzania"
    : [...p.regions.map((r) => `${r} 주 전체 (${REGION_EN[r] || r})`), ...p.districts.map((d) => `${d} 군`)].join(", ");

async function limited(key, max, sec) {
  const n = await redis("INCR", key);
  if (n === 1) await redis("EXPIRE", key, sec);
  return (n || 0) > max;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b && typeof b === "object" ? b : {};
  const action = String(b.action || q.action || "");

  if (req.method === "GET" && action === "status") {
    return res.status(200).json({ ready: hasStore() && canMailAnyone() });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!hasStore()) return res.status(503).json({ error: "not_ready" });

  const host = req.headers["x-forwarded-host"] || req.headers.host || "tanzania-safety-monitor.vercel.app";
  const origin = `https://${host}`;
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";

  try {
    if (action === "subscribe") {
      if (!canMailAnyone()) return res.status(503).json({ error: "not_ready" });
      const email = String(b.email || "").trim().toLowerCase();
      if (email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ error: "email" });
      if (await limited("rl:ip:" + ip, 8, 3600)) return res.status(429).json({ error: "rate" });
      if (await limited("rl:em:" + email, 3, 86400)) return res.status(429).json({ error: "rate" });
      const p = clean(b);
      const t = crypto.randomBytes(18).toString("base64url");
      await redis("SET", "pend:" + t, JSON.stringify({ email, ...p, at: new Date().toISOString() }), "EX", 172800);
      const link = `${origin}/?confirm=${t}`;
      const html =
        `<div style="font-family:sans-serif;font-size:14px;line-height:1.6">` +
        `<p><b>[탄자니아 안전모니터]</b> 경보 메일 신청을 확인해 주세요.<br><span style="color:#888;font-size:12px">Please confirm your Tanzania Safety Monitor alert subscription.</span></p>` +
        `<p>받을 지역 / Areas: <b>${esc(areaText(p))}</b><br>최소 등급 / Minimum level: <b>${LV[p.minLevel]}</b> 이상` +
        (p.digest ? `<br>매일 07:00(EAT) 요약 포함 / incl. daily 07:00 digest` : "") + `</p>` +
        `<p><a href="${link}" style="display:inline-block;background:#2e5c8a;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">신청 확인하기 / Confirm</a></p>` +
        `<p style="color:#888;font-size:12px">링크는 48시간 동안 유효합니다. 직접 신청하지 않으셨다면 이 메일을 무시하세요 — 확인하지 않으면 아무 메일도 가지 않고 주소는 48시간 뒤 삭제됩니다.<br>` +
        `The link is valid for 48 hours. If you did not request this, ignore this email — nothing will be sent and the address is deleted after 48 hours.</p></div>`;
      const [r] = await sendMany([{ to: [email], subject: "[탄자니아 안전모니터] 경보 메일 신청 확인 / Confirm subscription", html }]);
      if (!r.ok) { await redis("DEL", "pend:" + t); return res.status(502).json({ error: "mail", detail: r.error }); }
      return res.status(200).json({ ok: true });
    }

    const t = String(b.t || q.t || "");
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(t)) return res.status(400).json({ error: "token" });

    if (action === "confirm") {
      const pend = parse(await redis("GET", "pend:" + t));
      if (!pend) {
        // 이미 확인된 링크를 다시 누른 경우도 성공으로 보여 준다
        const cur = parse(await redis("GET", "sub:" + t));
        return cur ? res.status(200).json({ ok: true, sub: cur }) : res.status(404).json({ error: "expired" });
      }
      const old = await redis("GET", "em:" + pend.email);
      const sub = { ...pend, at: new Date().toISOString() };
      await pipe([
        ...(old && old !== t ? [["DEL", "sub:" + old], ["SREM", "subs", old]] : []),
        ["SET", "sub:" + t, JSON.stringify(sub)],
        ["SET", "em:" + pend.email, t],
        ["SADD", "subs", t],
        ["DEL", "pend:" + t],
      ]);
      return res.status(200).json({ ok: true, sub });
    }

    const sub = parse(await redis("GET", "sub:" + t));
    if (action === "unsub") {
      if (sub) await pipe([["DEL", "sub:" + t], ["SREM", "subs", t], ["DEL", "em:" + sub.email]]);
      return res.status(200).json({ ok: true });
    }
    if (!sub) return res.status(404).json({ error: "notfound" });
    if (action === "get") return res.status(200).json({ ok: true, sub });
    if (action === "update") {
      const next = { ...sub, ...clean(b), at: new Date().toISOString() };
      await redis("SET", "sub:" + t, JSON.stringify(next));
      return res.status(200).json({ ok: true, sub: next });
    }
    return res.status(400).json({ error: "action" });
  } catch (e) {
    return res.status(500).json({ error: "server", detail: e.message });
  }
};
