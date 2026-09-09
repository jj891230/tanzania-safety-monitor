// 외교부(공공데이터포털 data.go.kr) 탄자니아 자료 — 여행경보·재외공관 안전공지·대사관 연락처.
// 대시보드(/api/mofa)와 경보 점검(check-alerts)이 함께 쓴다.
//
// 인증키(serviceKey)가 필요해 브라우저가 직접 부를 수 없다(키 노출) → 서버 함수 경유.
// 키는 Vercel 환경변수 DATA_GO_KR_KEY 로만 다루고 코드·저장소에 넣지 않는다.
//
// 엔드포인트(2026-09-09 실측, 모두 1~3초):
//   여행경보  TravelAlarmService2/getTravelAlarmList2   cond[country_iso_alp2::EQ]=TZ
//             → 탄자니아는 항목이 둘: 3단계(음트와라 주) + 2단계(그 외 지역)
//   안전공지  CountrySafetyService7/getCountrySafetyList7 cond[country_iso_alp2::EQ]=TZ
//             → 주탄자니아대사관이 올리는 안전공지(총 37건, 최신 2026-09-08). 본문은 HTML.
//             ※ 포털 문서에는 요청주소가 안 나온다 — 페이지 HTML에서 찾아낸 이름이다.
//   재외공관  EmbassyService2/getEmbassyList2            cond[country_iso_alp2::EQ]=TZ
//             → 대사관 대표번호·긴급(영사콜센터)·주소·좌표
//   (국가별 안전정보 CountrySafetyService 는 2021년 이후 갱신이 없어 쓰지 않는다)
//
// 주의: URL의 cond[...] 대괄호를 curl 로 시험할 땐 -g 옵션이 필요하다(글로빙).

const BASE = "https://apis.data.go.kr/1262000/";
const ISO = "TZ";

const LEVEL_KO = { 1: "여행유의", 2: "여행자제", 3: "출국권고", 4: "여행금지" };
const LEVEL_EN = { 1: "Exercise caution", 2: "Reconsider travel", 3: "Leave / avoid travel", 4: "Travel ban" };

async function getJson(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const text = await r.text();
    if (!r.ok) throw new Error("data.go.kr → " + r.status + " " + text.slice(0, 80));
    let j;
    try { j = JSON.parse(text); } catch { throw new Error("data.go.kr → JSON 아님: " + text.slice(0, 80)); }
    // 포털 공통 오류 봉투(키 미등록·서비스 없음 등)
    if (j.OpenAPI_ServiceResponse) {
      const h = j.OpenAPI_ServiceResponse.cmmMsgHeader || {};
      throw new Error("data.go.kr → " + (h.errMsg || "ERROR") + " " + (h.returnAuthMsg || ""));
    }
    const body = (j.response && j.response.body) || {};
    const items = body.items && body.items.item;
    return { items: Array.isArray(items) ? items : items ? [items] : [], total: body.totalCount || 0 };
  } catch (e) {
    if (e.name === "AbortError") throw new Error(url.split("?")[0].split("/").slice(-2).join("/") + " → 응답 없음(" + timeoutMs / 1000 + "초 초과)");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 안전공지 본문(HTML, 일부는 &lt; 로 이중 이스케이프) → 읽을 수 있는 평문
function plainText(html, max) {
  let s = String(html || "");
  for (let i = 0; i < 2; i++) s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&middot;/g, "·");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ");
  s = s.replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
  return max && s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * @returns {{alarm, notices, embassy, errors}}
 *   alarm    { levels:[{lvl, ko, en, region, remark}], max, summaryKo, summaryEn }
 *   notices  [{ id, date, title, level, category, text }]  최신순
 *   embassy  { name, tel, urgency, addr, lat, lng }
 */
async function fetchMofa({ key, timeoutMs = 10000, notices = 8 } = {}) {
  if (!key) throw new Error("DATA_GO_KR_KEY 환경변수가 없습니다");
  const q = (svc, extra) => BASE + svc + "?returnType=JSON&pageNo=1&" + extra + "&cond[country_iso_alp2::EQ]=" + ISO + "&serviceKey=" + key;
  const [aR, nR, eR] = await Promise.allSettled([
    getJson(q("TravelAlarmService2/getTravelAlarmList2", "numOfRows=10"), timeoutMs),
    getJson(q("CountrySafetyService7/getCountrySafetyList7", "numOfRows=" + notices), timeoutMs),
    getJson(q("EmbassyService2/getEmbassyList2", "numOfRows=5"), timeoutMs),
  ]);
  const errors = [];
  const pick = (r, name) => { if (r.status === "fulfilled") return r.value.items; errors.push(name + ": " + r.reason.message); return null; };
  const aItems = pick(aR, "alarm"), nItems = pick(nR, "notices"), eItems = pick(eR, "embassy");

  let alarm = null;
  if (aItems) {
    const levels = aItems
      .map((it) => ({ lvl: +it.alarm_lvl || 0, ko: LEVEL_KO[+it.alarm_lvl] || "", en: LEVEL_EN[+it.alarm_lvl] || "",
        region: it.region_ty || "", remark: it.remark || "", written: it.written_dt || null }))
      .sort((a, b) => b.lvl - a.lvl);
    const max = levels.length ? levels[0].lvl : 0;
    alarm = {
      levels, max,
      summaryKo: levels.map((l) => `${l.lvl}단계 ${l.ko}` + (l.remark ? `(${l.remark})` : "")).join(" · "),
      summaryEn: levels.map((l) => `Level ${l.lvl} ${l.en}` + (l.remark ? ` (${l.remark})` : "")).join(" · "),
    };
  }
  const list = nItems
    ? nItems.map((it) => ({
        id: String(it.sfty_notice_id || ""), date: String(it.wrt_dt || "").slice(0, 10), title: String(it.title || "").trim(),
        level: it.sfty_notice_lv || null, category: it.ctgy_nm || null, text: plainText(it.txt_origin_cn, 1200),
      })).sort((a, b) => b.date.localeCompare(a.date))
    : null;
  const e = eItems && eItems[0];
  const embassy = e
    ? { name: e.embassy_kor_nm || "주 탄자니아 대한민국 대사관", tel: e.tel_no || "", urgency: e.urgency_tel_no || "",
        addr: e.emblgbd_addr || "", lat: e.embassy_lat, lng: e.embassy_lng }
    : null;
  return { alarm, notices: list, embassy, errors };
}

module.exports = { fetchMofa, plainText, LEVEL_KO, LEVEL_EN };
