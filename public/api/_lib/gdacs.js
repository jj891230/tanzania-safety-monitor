// GDACS 이벤트 수집 — 대시보드(/api/gdacs)와 경보 점검(check-alerts)이 함께 쓴다.
//
// 왜 JSON API 대신 RSS인가: 이 프로젝트가 처음부터 써 온
//   gdacsapi/api/events/geteventlist/SEARCH?country=Tanzania&alertlevel=...
// 는 응답이 20~45초 이상 걸리거나 아예 끊긴다(2026-09-07 실측: 12회 중 성공 2회,
// 성공해도 21~28초). 반면 같은 서버의 RSS 피드는 매번 1~3초에 온다:
//   /xml/rss.xml     현재 진행 중인 이벤트 전체(전 세계, 약 1.3MB)
//   /xml/rss_7d.xml  최근 7일간 갱신된 이벤트(전 세계, 약 2MB)
//   /xml/rss_24h.xml 최근 24시간(약 60KB)
// 두 피드를 같이 받아 eventid로 합치면 "최근 14일 내 갱신"(대시보드의 ACTIVE_DAYS)을
// 판정하기에 충분하다. RSS에는 CORS 헤더가 없어 브라우저가 직접 읽지 못하므로
// 서버 함수를 거친다(뉴스 패널과 같은 이유).
//
// 반환 형식은 예전 SEARCH JSON과 같은 GeoJSON 모양으로 맞춘다 — 대시보드의 parseGdacs()와
// check-alerts의 산불 집계가 코드 수정 없이 그대로 동작하도록.
//   { features: [ { properties: { eventtype, alertlevel, fromdate, todate, htmldescription,
//                                  country, eventid, iscurrent }, geometry: { coordinates: [lon, lat] } } ] }
// htmldescription은 SEARCH가 주던 "Green Forest fires in Tanzania from: 23 Aug 2026 to: 03 Sep 2026."
// 형식으로 재구성한다(대시보드 koDesc()가 이 형식을 파싱한다).
//
// 이 파일은 api/ 아래 있지만 이름이 _ 로 시작해서 Vercel이 함수로 배포하지 않는다(공용 모듈).

const RSS_URLS = [
  "https://www.gdacs.org/xml/rss_7d.xml",
  "https://www.gdacs.org/xml/rss.xml",
];
const SEARCH_URL =
  "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?country=Tanzania&alertlevel=Green;Orange;Red";

const EVENT_NAME = { WF: "Forest fires", FL: "Flood", DR: "Drought", TC: "Tropical Cyclone", EQ: "Earthquake", VO: "Volcano", TS: "Tsunami" };

async function getText(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "User-Agent": "koica-tz-safety-monitor" } });
    if (!r.ok) throw new Error(url.split("?")[0] + " → " + r.status);
    return await r.text();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(url.split("?")[0] + " → 응답 없음(" + timeoutMs / 1000 + "초 초과)");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// <name>...</name> 본문. [^] 는 JS 정규식에서 줄바꿈 포함 아무 문자.
function tag(xml, name) {
  const m = xml.match(new RegExp("<" + name + "(?:[ \t\r\n][^>]*)?>([^]*?)</" + name + ">"));
  return m ? m[1].trim() : "";
}
function unesc(s) {
  return s.replace(/<!\[CDATA\[([^]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// "Thu, 03 Sep 2026 00:00:00 GMT" → "2026-09-03T00:00:00" (SEARCH JSON이 주던 형식과 앞 10자가 같다)
function isoDate(rfc) {
  const t = Date.parse(rfc);
  return isNaN(t) ? "" : new Date(t).toISOString().slice(0, 19);
}
// "2026-09-03T..." → "03 Sep 2026" (htmldescription 재구성용). 시간대 표기가 없는 ISO 문자열은
// new Date()가 서버 현지시각으로 읽어 날짜가 하루 밀릴 수 있으므로 Z를 붙여 UTC로 고정한다.
function dmy(iso) {
  if (!iso) return "";
  const d = new Date(iso + "Z");
  return String(d.getUTCDate()).padStart(2, "0") + " " +
    d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) + " " + d.getUTCFullYear();
}

// RSS 본문 → features 배열. countryRe가 있으면 국가명이 맞는 항목만(복수 국가 표기 포함).
function parseRss(xml, countryRe) {
  const out = [];
  const items = xml.split("<item>").slice(1);
  for (const raw of items) {
    const it = raw.split("</item>")[0];
    const country = unesc(tag(it, "gdacs:country"));
    if (countryRe && !countryRe.test(country)) continue;
    const type = tag(it, "gdacs:eventtype").toUpperCase();
    const alert = tag(it, "gdacs:alertlevel") || "Green";
    const from = isoDate(tag(it, "gdacs:fromdate"));
    const to = isoDate(tag(it, "gdacs:todate"));
    const lat = parseFloat(tag(it, "geo:lat")), lon = parseFloat(tag(it, "geo:long"));
    const id = tag(it, "gdacs:eventid");
    out.push({
      type: "Feature",
      properties: {
        eventid: id ? +id : null,
        eventtype: type,
        alertlevel: alert,
        fromdate: from,
        todate: to,
        iscurrent: tag(it, "gdacs:iscurrent") === "true",
        country,
        name: unesc(tag(it, "title")),
        description: unesc(tag(it, "description")),
        htmldescription: alert + " " + (EVENT_NAME[type] || type) + " in " + country +
          " from: " + dmy(from) + " to: " + dmy(to) + ".",
        source: "rss",
      },
      geometry: { type: "Point", coordinates: [isNaN(lon) ? null : lon, isNaN(lat) ? null : lat] },
    });
  }
  return out;
}

/**
 * 탄자니아 GDACS 이벤트를 GeoJSON 모양으로 돌려준다.
 * 1) rss_7d.xml + rss.xml 병렬(각 timeoutMs) → eventid로 합침(todate가 더 최근인 쪽 우선)
 * 2) 둘 다 실패하면 예전 SEARCH JSON을 searchTimeoutMs로 한 번 더 시도
 * 그래도 안 되면 throw — 호출 쪽에서 "산불 축 0건"으로 처리한다(기존 원칙).
 */
async function fetchGdacs(opt) {
  const o = Object.assign({ timeoutMs: 12000, searchTimeoutMs: 20000, countryRe: /Tanzania/i }, opt || {});
  const errors = [];
  const results = await Promise.allSettled(RSS_URLS.map((u) => getText(u, o.timeoutMs)));
  const byId = new Map();
  let any = false;
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") { errors.push(RSS_URLS[i].split("/").pop() + ": " + r.reason.message); return; }
    any = true;
    for (const f of parseRss(r.value, o.countryRe)) {
      const k = f.properties.eventid || f.properties.name;
      const prev = byId.get(k);
      if (!prev || (f.properties.todate || "") > (prev.properties.todate || "")) byId.set(k, f);
    }
  });
  if (any) {
    const features = [...byId.values()]
      .sort((a, b) => (b.properties.todate || "").localeCompare(a.properties.todate || ""));
    return { features, source: "rss", errors };
  }
  // 최후 수단 — 느리지만 가끔은 된다
  const j = JSON.parse(await getText(SEARCH_URL, o.searchTimeoutMs));
  return { features: j.features || [], source: "search", errors };
}

module.exports = { fetchGdacs, parseRss };
