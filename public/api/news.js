// 탄자니아 안전 관련 뉴스 — RSS/API를 서버에서 대신 읽어 JSON으로 내려준다.
// RSS는 대부분 CORS 헤더가 없어 브라우저 직접 fetch가 막힌다(실제 확인함).
// 그래서 정적 대시보드의 다른 패널(Open-Meteo 등, CORS 열려 있어 브라우저가 직접 호출)과
// 달리 이것만 서버 함수를 거친다.
//
// 소스 선정 근거 — 사무소 안전담당 직원이 실제로 매일 보는 매체를 우선했다:
//   The Citizen(영문) / Daily News(영문, 관영) / The Chanzo(영문, 독립) 3곳이 핵심이고,
//   현지어(스와힐리) 매체를 보강해 영문 매체가 늦게 싣거나 아예 안 싣는 지방 사건을 잡는다.
//
// RSS 제공 여부는 전부 직접 확인했다(2026-09 기준):
//   O 직접 RSS: dailynews.co.tz, thechanzo.com, habarileo.co.tz(sw), globalpublishers.co.tz(sw)
//   X RSS 없음: thecitizen.co.tz(/rss는 404, /tanzania/rss는 HTML을 반환),
//              mwananchi.co.tz(sw, 같은 Nation Media 계열이라 동일하게 없음)
//     -> 이 두 곳은 Google News RSS의 site: 검색으로 우회한다. 실제로 각각 100건/96건
//        수집되는 것을 확인했다. 링크가 news.google.com 리다이렉트라 URL은 지저분하지만
//        클릭하면 원문으로 정상 이동한다.
//   X millardayo.com(피드 비어 있음), mtanzania.co.tz / zanzinews.com(피드 경로가 HTML),
//     meteo.go.tz(기상청 — RSS 없음. 경보는 이미 Open-Meteo/GDACS로 직접 받고 있어 불필요)
//   X globalpublishers.co.tz(sw) — RSS는 되지만 실제로 받아보니 전부 연예/가십이었다.
//     "moto"(불) 같은 스와힐리 키워드가 노래 제목에 걸려 오검출만 늘어 뺐다.
//   X mtanzania / millardayo / ippmedia는 Google News site: 검색으로도 0건(색인 없음).
//
// Google News 검색에는 when:7d를 붙인다. 안 붙이면 관련도순이라 2020년 코로나 기사나
// 섹션/기자 페이지까지 섞여 나오는 걸 확인했다(붙이면 mwananchi 기준 경과일 중앙값 3일).
const GN = "https://news.google.com/rss/search?q=";
const gnSite = (domain, sw) => GN + encodeURIComponent("site:" + domain + " when:7d")
  + (sw ? "&hl=sw&gl=TZ&ceid=TZ:sw" : "&hl=en-TZ&gl=TZ&ceid=TZ:en");

const FEEDS = [
  // 영문 — 안전 키워드로 걸러야 하는 일반 종합 매체
  { name: "The Citizen", kind: "rss", filter: true, lang: "en", url: gnSite("thecitizen.co.tz") },
  { name: "Daily News", kind: "rss", filter: true, lang: "en",
    url: "https://dailynews.co.tz/feed/" },
  { name: "The Chanzo", kind: "rss", filter: true, lang: "en",
    url: "https://thechanzo.com/feed/" },
  { name: "allAfrica", kind: "rss", filter: true, lang: "en",
    url: "https://allafrica.com/tools/headlines/rdf/tanzania/headlines.rdf" },
  // 스와힐리어 — 지방 사건·사고가 영문 매체보다 빨리, 더 자세히 올라온다
  { name: "Mwananchi", kind: "rss", filter: true, lang: "sw", url: gnSite("mwananchi.co.tz", true) },
  { name: "HabariLeo", kind: "rss", filter: true, lang: "sw",
    url: "https://habarileo.co.tz/feed/" },
];

// ReliefWeb — reliefweb.int/updates/rss.xml(RSS)은 서버리스 함수 IP에서 JS 챌린지로
// 막혀 있어(브라우저 헤더를 다 맞춰도 202 빈 응답 — 직접 확인함) 못 쓴다. 대신
// api.reliefweb.int(REST API, 별개 서브도메인)는 차단이 없지만 appname 사전승인이
// 필요하다(구글폼 제출 → 이메일 승인, https://apidoc.reliefweb.int/parameters#appname).
// RELIEFWEB_APPNAME 환경변수가 설정되면 자동으로 켜진다 — 승인 후 값만 넣으면 됨.
if (process.env.RELIEFWEB_APPNAME) {
  FEEDS.push({
    name: "ReliefWeb", kind: "reliefweb", filter: false, lang: "en",
    url: "https://api.reliefweb.int/v2/reports"
      + "?appname=" + encodeURIComponent(process.env.RELIEFWEB_APPNAME)
      + "&filter[field]=primary_country.name&filter[value]=Tanzania"
      + "&sort[]=date:desc&limit=15"
      + "&fields[include][]=title&fields[include][]=url&fields[include][]=date.created",
  });
}

// 안전 키워드. 영문 매체와 스와힐리 매체를 같이 걸러야 해서 두 언어를 한 목록에 둔다.
//
// 매칭 규칙(matchesKeyword 참고): 5글자 이상이면 부분일치, 4글자 이하는 단어 단위 일치.
//   - 부분일치가 필요한 이유: "flood"->"flooding/floods", "mafuriko"->"mafurikoni" 처럼
//     굴절형을 다 잡아야 한다.
//   - 짧은 단어까지 부분일치시키면 오검출이 난다: "fire"가 "fired"(해고)에,
//     "moto"가 다른 단어 안에 걸린다. 그래서 짧은 건 단어 경계로 제한한다.
//
// "kill"/"dead"/"gun"처럼 느슨한 단어는 일부러 뺐다 — allAfrica의 "탄자니아" 피드에
// 국제 연예/사건 기사가 섞여 들어올 때(예: 미국 살인사건 재판 기사) 이런 단어만으로
// 걸러내면 탄자니아와 무관한 기사가 안전 뉴스로 잘못 뜨는 게 실제로 확인됐다.
const KEYWORDS = [
  /* ── 영문 ── */
  // 기상·자연재해
  "flood", "cyclone", "tropical storm", "heavy rain", "drought", "el ni",
  "landslide", "mudslide", "earthquake", "tremor", "disaster", "emergency",
  "wildfire", "bush fire", "forest fire", "fire", "storm", "hailstorm",
  // 사고
  // 어미 변화에 주의해서 넣는다. 4글자 이하는 단어 단위로만 매칭되므로("sink"는 "sinks"에
  // 안 걸린다) 굴절형을 따로 적어 준다 — 실제로 "MV Pacific Explodes and Sinks" 기사를
  // 놓친 적이 있다.
  "road accident", "traffic accident", "crash", "collapse", "capsiz",
  "stampede", "drown", "shipwreck", "ferry accident", "bus accident",
  "explosion", "explod", "blast", "sinks", "sinking", "sank", "vessel",
  "blackout", "power cut", "derail",
  // 보건
  "outbreak", "cholera", "ebola", "marburg", "epidemic", "food poisoning",
  "water shortage", "famine",
  // 치안·강력사건
  // 사무소 안전담당이 실제로 공유하는 기사가 이 계열이 많다(경찰관 사망, 트럭 습격,
  // 총기 사면, 구금 중 사망 등). 다만 "death"/"police"/"arrested"처럼 너무 흔한 말은
  // 넣지 않았다 — 탄자니아 매체로 한정해도 무관한 기사가 대량으로 딸려온다.
  "curfew", "evacuat", "firearm", "illegal arms", "illegal gun", "robbery", "kidnap",
  "terror", "bombing", "banditry", "riot", "unrest", "protest",
  "killed", "shot", "murder", "stabb", "attack", "hijack",
  "raped", "rapist", "rape", "assault", "poison", "death toll",
  "gun", "guns", "gunman", "gunmen", "ambush", "looting",

  /* ── 스와힐리어 ── */
  // 기상·자연재해
  "mafuriko",      // 홍수
  "kimbunga",      // 사이클론
  "mvua kubwa",    // 폭우
  "ukame",         // 가뭄
  "tetemeko",      // 지진
  "maporomoko",    // 산사태
  "maafa",         // 재난
  "dharura",       // 비상
  "tahadhari",     // 경보·주의
  "onyo",          // 경고
  // 화재·사고
  "moto",          // 불
  "zimamoto",      // 소방
  "ajali",         // 사고
  "mlipuko",       // 폭발
  "kuzama",        // 침몰·익사
  "kuporomoka",    // 붕괴
  "majeruhi",      // 부상자
  "vifo",          // 사망
  "waliofariki",   // 사망자
  // 보건
  "kipindupindu",  // 콜레라
  "mlipuko wa ugonjwa", // 질병 발생
  "homa",          // 열병
  // 치안
  "ujambazi",      // 강도·산적
  "utekaji",       // 납치
  "ghasia",        // 폭동
  "wizi",          // 절도
  "ugaidi",        // 테러
  "maandamano",    // 시위
];

// 짧은 키워드는 단어 경계 매칭 — 미리 정규식으로 만들어 둔다(요청마다 재컴파일 방지).
const SHORT = KEYWORDS.filter((k) => k.length <= 4)
  .map((k) => new RegExp("(^|[^a-z])" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z]|$)", "i"));
const LONG = KEYWORDS.filter((k) => k.length > 4);

// 키워드에는 걸리지만 현장 안전과 무관한 기사를 되걸러낸다.
// 예: "terrorist financing"(자금세탁 규제 기사)이 "terror"에 걸려 올라온 걸 실제로 확인했다.
const NOISE = [
  "money laundering", "terrorist financing", "terrorism financing",
  "counter-terrorism financ", "anti-money", "insurance premium",
];

// ── 지리 게이트 ──────────────────────────────────────────────────────────
// 탄자니아 매체도 국제면을 싣고 allAfrica는 범아프리카 매체라, 키워드만으로 거르면
// 이란 전쟁·니제르 쿠데타·미국 살인사건 재판 같은 기사가 "안전 뉴스"로 올라온다(실제 확인).
//
// 규칙: 제목에 탄자니아 밖 지명이 나오면서 탄자니아 관련 지명이 하나도 없으면 버린다.
// 지명이 아예 없는 기사는 살린다 — 소스가 전부 탄자니아 매체라 "Relief as lion
// terrorising villagers is shot dead"처럼 국내 기사는 굳이 나라 이름을 안 쓰기 때문이다.
const TZ_TERMS = [
  "tanzania", "tanzanian", "zanzibar", "unguja", "pemba", "dar es salaam", "dar-es-salaam",
  // 31개 주(regions.json 기준) + 자주 쓰이는 지명
  "geita", "dodoma", "ruvuma", "rukwa", "lindi", "mara", "manyara", "morogoro", "mtwara",
  "songwe", "simiyu", "shinyanga", "singida", "arusha", "njombe", "mbeya", "mwanza",
  "iringa", "kagera", "katavi", "kigoma", "kilimanjaro", "tabora", "tanga", "pwani",
  "kusini", "kaskazini", "mjini magharibi", "serengeti", "ngorongoro", "kilwa", "bagamoyo",
  "stone town", "mafia island", "tanganyika", "zanzibari",
];

// 자주 섞여 들어오는 외국 지명·고유명사. 완전할 필요는 없다 — 실제로 관측된 오검출을
// 막는 게 목적이고, 목록에 없는 나라는 지명 없는 기사로 취급돼 통과한다.
const FOREIGN_TERMS = [
  "kenya", "kenyan", "nairobi", "uganda", "ugandan", "kampala", "rwanda", "kigali",
  "burundi", "congo", "congolese", "drc", "zambia", "malawi", "mozambique", "somalia",
  "ethiopia", "ethiopian", "eritrea", "sudan", "nigeria", "nigerian", "ghana", "niger",
  "south africa", "zimbabwe", "egypt", "libya", "mali", "senegal", "cameroon", "chad",
  "botswana", "namibia", "angola", "lesotho", "eswatini", "gabon", "gambia",
  "sierra leone", "liberia", "guinea", "ivory coast", "cote d'ivoire", "benin",
  "togo", "burkina faso", "mauritania", "tunisia", "algeria", "morocco", "sudan",
  "iran", "israel", "gaza", "lebanon", "hezbollah", "ukraine", "russia", "moscow",
  "china", "chinese", "india", "pakistan", "afghanistan", "syria", "yemen", "iraq",
  "united states", "u.s.", "america", "american", "trump", "washington", "britain",
  "uk ", "london", "france", "paris", "germany", "europe", "european union",
  "brazil", "mexico", "argentina", "chile", "colombia", "venezuela", "bolivia",
  "peru", "ecuador", "cuba", "canada", "australia",
  "japan", "korea", "philippines", "indonesia", "myanmar", "thailand", "vietnam",
  "malaysia", "singapore", "bangladesh", "nepal", "sri lanka", "turkey", "poland",
  "spain", "italy", "netherlands", "sweden", "norway", "belgium",
];

function isTanzaniaRelated(title) {
  const t = " " + title.toLowerCase() + " ";
  if (TZ_TERMS.some((k) => t.includes(k))) return true;
  return !FOREIGN_TERMS.some((k) => t.includes(k));
}

// 제목에 지난 연도가 박혀 있으면 지금 벌어지는 사건이 아니라 과거 사건의 후속
// (재판·판결·보상·회고) 기사다. "1996 Killing of Tupac", "2019 Ethiopian Airlines
// 보상" 둘 다 이 방식으로 걸러진다 — 실제로 올라왔던 오검출이다.
// 미래 연도(엘니뇨 2027년 전망 등)는 살려야 하므로 작년보다 이전 것만 본다.
function isStaleRetrospective(title) {
  const y = new Date().getFullYear();
  const m = title.match(/\b(19|20)\d{2}\b/g);
  return !!m && m.every((s) => +s < y - 1);
}

function matchesKeyword(title) {
  const t = title.toLowerCase();
  if (NOISE.some((k) => t.includes(k))) return false;
  if (!isTanzaniaRelated(title)) return false;
  if (isStaleRetrospective(title)) return false;
  return LONG.some((k) => t.includes(k)) || SHORT.some((re) => re.test(t));
}

async function jget(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 (KOICA-Tanzania-Safety-Monitor)" },
    });
    if (!r.ok) throw new Error(r.status + "");
    return await r.text();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("응답 없음(" + timeoutMs / 1000 + "초 초과)");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");   // 반드시 마지막 — 먼저 풀면 &amp;lt; 가 이중 해제된다
}

function unwrapCdata(s) {
  if (!s) return "";
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return decodeEntities(m ? m[1] : s).replace(/<[^>]+>/g, "").trim();
}

// utm_* 추적 파라미터 제거 — 같은 기사가 소스별로 다른 utm을 달고 와서 중복 제거에 실패하는 걸 막는다.
function cleanLink(u) {
  const i = u.indexOf("?");
  if (i < 0) return u;
  const kept = u.slice(i + 1).split("&").filter((p) => !/^utm_/i.test(p));
  return kept.length ? u.slice(0, i) + "?" + kept.join("&") : u.slice(0, i);
}

function parseRss(xml, feed) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  return items.map((it) => {
    const grab = (tag) => {
      const m = it.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">"));
      return m ? unwrapCdata(m[1]) : "";
    };
    let title = grab("title");
    // Google News는 제목 끝에 " - 매체명"을 붙인다. 우리는 매체명을 따로 표시하므로 잘라낸다.
    title = title.replace(/\s+-\s+[^-]{3,40}$/, "").trim();
    const link = cleanLink(grab("link") || grab("guid"));
    const pubDateRaw = grab("pubDate") || grab("dc:date");
    const t = Date.parse(pubDateRaw);
    return { title, link, source: feed.name, lang: feed.lang, pubDate: pubDateRaw, ts: isNaN(t) ? 0 : t };
  // Google News는 섹션/기자 페이지도 항목으로 뱉는다(제목이 "Teknolojia", "| Mwananchi" 등).
  // 실제 기사 제목은 이보다 훨씬 길어서 길이로 걸러낸다.
  }).filter((x) => x.title.length >= 15 && x.link);
}

// ReliefWeb REST API 응답(JSON) 파서 — RSS와 구조가 달라 별도로 둔다.
// data[].fields.{title,url,date.created} 형태(공식 문서 기준, appname 승인 후 실제
// 응답으로 재검증 필요 — 필드명이 다르면 이 함수만 고치면 된다).
function parseReliefWeb(json, feed) {
  let obj;
  try { obj = JSON.parse(json); } catch { return []; }
  return (obj.data || []).map((d) => {
    const f = d.fields || {};
    const dateStr = (f.date && (f.date.created || f.date.original)) || "";
    const t = Date.parse(dateStr);
    return { title: f.title || "", link: f.url || d.href || "", source: feed.name,
      lang: feed.lang, pubDate: dateStr, ts: isNaN(t) ? 0 : t };
  }).filter((x) => x.title && x.link);
}

// 오래된 기사가 티커에 계속 남지 않도록 상한을 둔다. Google News 경유 소스의
// when:7d 검색 범위와 맞춰, 실시간 안전 모니터 성격에 맞게 7일로 통일한다.
const MAX_AGE_DAYS = 7;

module.exports = async (req, res) => {
  const results = await Promise.allSettled(FEEDS.map((f) => jget(f.url)));
  const all = [];
  const fails = [];
  const perSource = {};

  FEEDS.forEach((f, i) => {
    const r = results[i];
    if (r.status !== "fulfilled") {
      fails.push(f.name + ": " + r.reason.message);
      return;
    }
    let items = f.kind === "reliefweb" ? parseReliefWeb(r.value, f) : parseRss(r.value, f);
    if (f.filter) items = items.filter((x) => matchesKeyword(x.title));
    perSource[f.name] = items.length;
    all.push(...items);
  });

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400e3;
  const fresh = all.filter((x) => !x.ts || x.ts >= cutoff);

  // 같은 기사가 여러 소스로 들어온다(예: The Citizen 기사가 Mwananchi에도 실리고,
  // Google News 경유분과 직접 RSS분이 각각 들어온다). 링크가 서로 달라 링크만으로는
  // 못 잡으므로 제목을 정규화해 묶는다. 같은 기사 중에서는 원문 링크(직접 RSS)를 남긴다 —
  // Google News 링크는 리다이렉트라 주소가 불투명하고 수명도 짧다.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "").slice(0, 60);
  const isGN = (x) => /news\.google\./.test(x.link);

  const byTitle = new Map();
  for (const x of fresh) {
    const key = norm(x.title);
    const cur = byTitle.get(key);
    // 원문 링크 우선, 그다음 최신 기사 우선
    if (!cur || (isGN(cur) && !isGN(x)) || (isGN(cur) === isGN(x) && x.ts > cur.ts)) {
      byTitle.set(key, x);
    }
  }

  const dedup = [...byTitle.values()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 30)
    .map((x) => ({ title: x.title, link: x.link, source: x.source, lang: x.lang, pubDate: x.pubDate }));

  res.setHeader("Cache-Control", "public, max-age=600"); // 10분 — RSS도 자주 안 바뀜, 방문마다 재크롤링 방지
  res.status(200).json({
    checkedAt: new Date().toISOString(),
    count: dedup.length,
    sources: FEEDS.length,
    perSource,
    items: dedup,
    sourceFails: fails,
  });
};
