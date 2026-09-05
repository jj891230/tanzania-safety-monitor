// 탄자니아 안전 관련 뉴스 — RSS/API를 서버에서 대신 읽어 JSON으로 내려준다.
// allAfrica RSS는 CORS 헤더가 없어 브라우저 직접 fetch가 막힌다(실제 확인함).
// 그래서 정적 대시보드의 다른 패널(Open-Meteo 등, CORS 열려 있어 브라우저가 직접 호출)과
// 달리 이것만 서버 함수를 거친다.
//
// 소스 1: allAfrica 탄자니아 RSS(일반 뉴스, 안전 키워드로 걸러야 함).
// 소스 2: ReliefWeb — reliefweb.int/updates/rss.xml(RSS)은 서버리스 함수 IP에서
//   JS 챌린지로 막혀 있어(브라우저 헤더를 다 맞춰도 202 빈 응답 — 직접 확인함) 못 쓴다.
//   대신 api.reliefweb.int(REST API, 별개 서브도메인)는 차단이 없지만 appname 사전승인이
//   필요하다(구글폼 제출 → 이메일 승인, https://apidoc.reliefweb.int/parameters#appname).
//   RELIEFWEB_APPNAME 환경변수가 설정되면 자동으로 켜진다 — 승인 후 값만 넣으면 됨.
const FEEDS = [
  { name: "allAfrica", url: "https://allafrica.com/tools/headlines/rdf/tanzania/headlines.rdf", filter: true, kind: "rss" },
];
if (process.env.RELIEFWEB_APPNAME) {
  FEEDS.push({
    name: "ReliefWeb",
    url: "https://api.reliefweb.int/v2/reports"
      + "?appname=" + encodeURIComponent(process.env.RELIEFWEB_APPNAME)
      + "&filter[field]=primary_country.name&filter[value]=Tanzania"
      + "&sort[]=date:desc&limit=15"
      + "&fields[include][]=title&fields[include][]=url&fields[include][]=date.created",
    filter: false, kind: "reliefweb",
  });
}

// 영어 안전 키워드 — 소스가 전부 영문 매체라 한글 키워드는 의미가 없다.
// "kill"/"dead"/"gun"처럼 너무 느슨한 단어는 뺐다 — allAfrica의 "탄자니아" 피드에
// 국제 연예/사건 기사가 섞여 들어올 때(예: 미국 살인사건 재판 기사) 이런 단어만으로
// 걸러내면 탄자니아와 무관한 기사가 안전 뉴스로 잘못 뜨는 게 실제로 확인됨.
const KEYWORDS = [
  "flood", "cyclone", "tropical storm", "heavy rain", "drought", "wildfire",
  "bush fire", "forest fire", "road accident", "traffic accident", "crash",
  "collapse", "outbreak", "cholera", "ebola", "marburg", "epidemic",
  "landslide", "mudslide", "earthquake", "tremor", "disaster", "emergency",
  "capsiz", "blackout", "power cut", "curfew", "evacuat", "firearm",
  "illegal arms", "robbery", "kidnap", "terror", "bombing", "explosion",
  "stampede", "drown", "shipwreck", "ferry accident", "bus accident",
  "food poisoning", "water shortage", "famine",
];

async function jget(url, timeoutMs = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "User-Agent": "Mozilla/5.0 (KOICA-Tanzania-Safety-Monitor)" } });
    if (!r.ok) throw new Error(url.split("?")[0] + " → " + r.status);
    return await r.text();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(url.split("?")[0] + " → 응답 없음(" + timeoutMs / 1000 + "초 초과)");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function unwrapCdata(s) {
  if (!s) return "";
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (m ? m[1] : s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

function parseRss(xml, sourceName) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  return items.map((it) => {
    const grab = (tag) => {
      const m = it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? unwrapCdata(m[1]) : "";
    };
    const title = grab("title");
    const link = grab("link") || grab("guid");
    const pubDateRaw = grab("pubDate") || grab("dc:date");
    const t = Date.parse(pubDateRaw);
    return { title, link, source: sourceName, pubDate: pubDateRaw, ts: isNaN(t) ? 0 : t };
  }).filter((x) => x.title && x.link);
}

function matchesKeyword(title) {
  const t = title.toLowerCase();
  return KEYWORDS.some((k) => t.includes(k));
}

// ReliefWeb REST API 응답(JSON) 파서 — RSS와 구조가 달라 별도로 둔다.
// data[].fields.{title,url,date.created} 형태(공식 문서 기준, appname 승인 후 실제
// 응답으로 재검증 필요 — 필드명이 다르면 이 함수만 고치면 된다).
function parseReliefWeb(json, sourceName) {
  let obj;
  try { obj = JSON.parse(json); } catch { return []; }
  const data = obj.data || [];
  return data.map((d) => {
    const f = d.fields || {};
    const dateStr = f.date?.created || f.date?.original || "";
    const t = Date.parse(dateStr);
    return { title: f.title || "", link: f.url || (d.href || ""), source: sourceName,
      pubDate: dateStr, ts: isNaN(t) ? 0 : t };
  }).filter((x) => x.title && x.link);
}

module.exports = async (req, res) => {
  const results = await Promise.allSettled(FEEDS.map((f) => jget(f.url)));
  const all = [];
  const fails = [];

  FEEDS.forEach((f, i) => {
    const r = results[i];
    if (r.status !== "fulfilled") {
      fails.push(f.name + ": " + r.reason.message);
      return;
    }
    let items = f.kind === "reliefweb" ? parseReliefWeb(r.value, f.name) : parseRss(r.value, f.name);
    if (f.filter) items = items.filter((x) => matchesKeyword(x.title));
    all.push(...items);
  });

  // 링크 기준 중복 제거 + 최신순 정렬 + 상한
  const seen = new Set();
  const dedup = [];
  all.sort((a, b) => b.ts - a.ts);
  for (const x of all) {
    if (seen.has(x.link)) continue;
    seen.add(x.link);
    dedup.push({ title: x.title, link: x.link, source: x.source, pubDate: x.pubDate });
    if (dedup.length >= 15) break;
  }

  res.setHeader("Cache-Control", "public, max-age=600"); // 10분 — RSS도 자주 안 바뀜, 방문마다 재크롤링 방지
  res.status(200).json({ checkedAt: new Date().toISOString(), count: dedup.length, items: dedup, sourceFails: fails });
};
