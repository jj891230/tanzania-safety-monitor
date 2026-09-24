// 메일 발송 공용 모듈 — 경보(check-alerts)와 신청 확인(subscribe)이 같이 쓴다.
//
// 발송 경로(위에서부터 먼저 설정된 것):
//   1) Gmail SMTP  — GMAIL_USER + GMAIL_APP_PASSWORD(구글 계정 "앱 비밀번호" 16자리).
//                    도메인 인증 없이 아무 주소에나 보낼 수 있다(하루 약 500통).
//   2) Resend      — RESEND_API_KEY. 발신 도메인을 인증하지 않은 onboarding@resend.dev는
//                    Resend 계정 주인 주소로만 보낼 수 있어 신청자 발송에는 못 쓴다.
//
// SMTP는 nodemailer 없이 Node 기본 tls로 직접 말한다 — public/에 package.json을 두면
// Vercel이 정적 사이트를 빌드 프로젝트로 다르게 취급할 수 있어 의존성을 만들지 않았다.
// Gmail 465(암묵적 TLS) + AUTH PLAIN + 본문 base64라 점(.) 이스케이프 문제도 없다.

const tls = require("tls");
const crypto = require("crypto");

const hasGmail = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
// 신청자에게 보낼 수 있는가 — Gmail이 있거나, Resend에 인증된 발신 주소(ALERT_EMAIL_FROM)가 있을 때
const canMailAnyone = () => hasGmail() || !!(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_FROM);

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s) => s.replace(/.{1,76}/g, "$&\r\n");

// SMTP 대화 한 번 — 연결 하나로 여러 통을 보낸다(신청자 N명 발송 시 로그인 1회).
function smtpSession(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: "smtp.gmail.com", port: 465, servername: "smtp.gmail.com" });
    let buf = "", waiter = null, dead = null;
    const timer = setTimeout(() => sock.destroy(new Error("SMTP 응답 없음")), timeoutMs);
    sock.setEncoding("utf8");
    // 응답이 기다리기 전에 도착할 수도 있어(인사말 220 등) 버퍼에 쌓아 두고, 받았을 때와
    // 기다리기 시작할 때 양쪽에서 "완성된 응답이 있나"를 확인한다.
    // 여러 줄 응답은 "250-..." 로 이어지다 "250 ..." 줄에서 끝난다.
    const deliver = () => {
      if (!waiter) return;
      if (dead) { const w = waiter; waiter = null; return w({ code: 0, text: dead.message }); }
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const text = lines.slice(0, i + 1).join("\n");
          buf = lines.slice(i + 1).join("\r\n");
          const w = waiter; waiter = null;
          return w({ code: +lines[i].slice(0, 3), text });
        }
      }
    };
    sock.on("data", (d) => { buf += d; deliver(); });
    sock.on("error", (e) => { dead = e; deliver(); });
    sock.on("close", () => { dead = dead || new Error("SMTP 연결 끊김"); deliver(); });
    const read = () => new Promise((r) => { waiter = r; deliver(); });
    const cmd = async (line, expect) => {
      if (line != null) sock.write(line + "\r\n");
      const res = await read();
      if (!expect.includes(Math.floor(res.code / 100) * 100) && !expect.includes(res.code))
        throw new Error(`SMTP ${res.code}: ${res.text.slice(0, 160)}`);
      return res;
    };
    sock.once("secureConnect", async () => {
      try {
        await cmd(null, [220]);
        await cmd("EHLO tanzania-safety-monitor", [250]);
        await cmd("AUTH PLAIN " + b64(`\0${process.env.GMAIL_USER}\0${process.env.GMAIL_APP_PASSWORD}`), [235]);
        resolve({
          async send({ to, subject, html, headers = {} }) {
            const from = process.env.GMAIL_USER;
            const fromName = process.env.ALERT_FROM_NAME || "KOICA 탄자니아 안전모니터";
            const msg = [
              `From: ${encWord(fromName)} <${from}>`,
              `To: ${to.join(", ")}`,
              `Subject: ${encWord(subject)}`,
              `Date: ${new Date().toUTCString()}`,
              `Message-ID: <${crypto.randomBytes(12).toString("hex")}@tanzania-safety-monitor>`,
              "MIME-Version: 1.0",
              "Content-Type: text/html; charset=UTF-8",
              "Content-Transfer-Encoding: base64",
              ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
              "",
              wrap76(b64(html)),
            ].join("\r\n");
            await cmd(`MAIL FROM:<${from}>`, [250]);
            for (const r of to) await cmd(`RCPT TO:<${r}>`, [250, 251]);
            await cmd("DATA", [354]);
            await cmd(msg + "\r\n.", [250]);
          },
          async close() {
            clearTimeout(timer);
            try { sock.write("QUIT\r\n"); } catch {}
            sock.end();
          },
        });
      } catch (e) {
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      }
    });
  });
}

async function sendResend({ to, subject, html, headers }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.ALERT_EMAIL_FROM || "KOICA 안전모니터 <onboarding@resend.dev>",
        to, subject, html, headers,
      }),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 200));
  } finally {
    clearTimeout(timer);
  }
}

// 여러 통을 한 번에 보낸다. msgs: [{to:[...], subject, html, headers?}]
// 결과: [{ok, error?}] (입력 순서 그대로). 한 통 실패가 나머지를 막지 않는다.
async function sendMany(msgs) {
  if (!msgs.length) return [];
  if (hasGmail()) {
    let s;
    try {
      s = await smtpSession();
    } catch (e) {
      return msgs.map(() => ({ ok: false, error: "gmail: " + e.message }));
    }
    const out = [];
    for (const m of msgs) {
      try { await s.send(m); out.push({ ok: true }); }
      catch (e) { out.push({ ok: false, error: "gmail: " + e.message }); }
    }
    await s.close();
    return out;
  }
  if (process.env.RESEND_API_KEY) {
    const out = [];
    for (const m of msgs) {
      try { await sendResend(m); out.push({ ok: true }); }
      catch (e) { out.push({ ok: false, error: "email: " + e.message }); }
    }
    return out;
  }
  return msgs.map(() => ({ ok: false, error: "메일 발송 설정 없음" }));
}

module.exports = { sendMany, hasGmail, canMailAnyone };
