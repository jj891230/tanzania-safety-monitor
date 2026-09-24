// 경보 메일 신청자 저장소 — Upstash Redis(Vercel Marketplace 무료 플랜)를 REST로 쓴다.
// 저장소가 공개라 신청자 이메일을 alert-state.json처럼 git에 둘 수 없어서 따로 둔다.
// Vercel에서 Upstash를 연결하면 KV_REST_API_URL / KV_REST_API_TOKEN이 자동으로 들어온다
// (직접 만든 경우의 UPSTASH_REDIS_REST_URL / _TOKEN 이름도 받는다).
//
// 키 구조
//   sub:<token>   활성 신청 JSON {email, regions[], districts[], minLevel, digest, lang, at}
//   em:<email>    그 이메일의 현재 token (재신청 시 옛 신청을 대체하려고)
//   subs          활성 token 집합
//   pend:<token>  확인 대기 JSON (48시간 뒤 자동 삭제)
//   rl:*          신청 남용 방지 카운터

const URL_ = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const hasStore = () => !!(URL_() && TOKEN());

async function call(path, body, timeoutMs = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(URL_().replace(/\/$/, "") + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error("redis HTTP " + r.status + (j && j.error ? " " + j.error : ""));
    return j;
  } finally {
    clearTimeout(timer);
  }
}
// 명령 하나: redis("SET", "k", "v", "EX", 60)
async function redis(...cmd) {
  const j = await call("", cmd.map(String));
  if (j && j.error) throw new Error("redis " + j.error);
  return j ? j.result : null;
}
// 여러 명령 한 번에: pipe([["GET","a"],["DEL","b"]]) → [결과...]
async function pipe(cmds) {
  if (!cmds.length) return [];
  const j = await call("/pipeline", cmds.map((c) => c.map(String)));
  return (j || []).map((x) => (x && x.error ? null : x && x.result));
}
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// 활성 신청자 전부 [{token, ...신청}] — 경보 함수가 매 회차 한 번 부른다
async function listSubscribers() {
  const toks = (await redis("SMEMBERS", "subs")) || [];
  if (!toks.length) return [];
  const vals = await redis("MGET", ...toks.map((t) => "sub:" + t));
  return toks.map((t, i) => ({ token: t, ...(parse(vals[i]) || {}) })).filter((s) => s.email);
}

module.exports = { hasStore, redis, pipe, parse, listSubscribers };
