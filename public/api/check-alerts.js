// GitHub Actions가 15분마다 이 엔드포인트를 호출한다(Vercel Hobby는 자체 크론이
// 하루 1회뿐이라 외부 스케줄러로 우회 — 세션 논의 참조).
// 매 호출: 데이터 수집 → 규칙 평가(대시보드와 동일 로직) → 알림 정책에 따라 이메일/Slack 발송.
//
// ── 알림 정책(환경변수, 전부 선택 — 하나도 없으면 예전과 똑같이 동작한다) ──
//   ALERT_MODE        always(기본) : 위험 지역이 있으면 매 호출마다 보낸다(검증 단계의 무상태 설계).
//                     changes      : 이전 상태(prev, 워크플로가 POST 본문으로 넘김)와 비교해
//                                    "새로 생겼거나 등급이 오른" 곳이 있을 때만 보낸다.
//   ALERT_MIN_LEVEL   즉시 알림 최소 등급. 2=주의(기본) · 3=경계 · 4=심각
//   ALERT_LEAD_DAYS   즉시 알림에 포함할 예보 선행일. 7(기본)=7일 예보 전체, 4=오늘~D+3만.
//                     D+4~D+6에서만 걸린 건은 즉시 메일에서 빼고 일일 요약에만 싣는다.
//   ALERT_DIGEST_LEVEL 일일 요약(?digest=1 호출)에 실을 최소 등급. 기본 2(주의).
//   ?digest=1         이 쿼리로 부르면 상태 비교 없이 현재 '주의 이상' 전부를 한 통으로 보낸다
//                     (워크플로의 07:00 EAT 크론이 사용). 본문에 선행일(D+n)이 함께 나간다.
//
// 왜 이런 손잡이가 필요한가 — 2025-08-25~2026-08-24 ERA5 실측으로 현행 규칙을 되돌려 보면
// (호우·폭염·강풍 3축, 예보가 완벽하다는 가정) 31개 주 중 한 곳이라도 '주의' 이상인 날이
// 1년의 82%(299일), '경계' 이상이 51%(186일)다. 폭염 축 하나만으로 249일이 걸리는데, 연안·
// 잔지바르는 체감 35℃가 연 110~158일이라 '주의'가 재난이 아니라 계절 상태다. 즉 "주의부터
// 15분마다"는 하루 최대 96통이 되고, 상태 비교 없이 같은 메일이 반복된다. 같은 자료로
// "경계 이상 · 신규/상승 시에만"은 연 63통, "주의 이상 신규/상승"은 126통, "주의 일일 요약"은
// 299통 수준이다. 어떤 조합을 쓸지는 사무소가 정하되, 여기서는 모두 환경변수로 고를 수 있게 했다.
//
// 1단계(검증 단계) 설계 원칙(유지):
//  - GDACS 신호가 없어도 핵심 축(호우·폭염·강풍·하천·지진)만으로 판정한다. 소스 하나가
//    죽었다고 전체 점검을 실패로 처리하지 않는다. GDACS는 이제 _lib/gdacs.js(RSS 기반,
//    1~3초)로 받는다 — 예전 SEARCH API는 20~45초씩 걸리거나 끊기는 일이 절반이었다.
//  - 판정식은 대시보드(template.html)와 반드시 같아야 한다(heavyRain 등). 한쪽만 고치면
//    대시보드는 '주의'인데 메일은 '심각'으로 나가 신뢰를 잃는다.

const { fetchGdacs } = require("./_lib/gdacs.js");

const TZ = "Africa/Dar_es_Salaam";
const LV = ["정상", "관심", "주의", "경계", "심각"];
const LV_EN = ["Normal", "Low", "Moderate", "High", "Severe"];
const AX_EN = { 호우: "Heavy rain", 폭염: "Heat", 강풍: "Wind", 산불: "Wildfire", 하천: "River", 지진: "Quake" };
const ABS_FLOOR = 40; // mm, 7일 누적 — 평년비 판정의 절대 하한(건기 잡음 방지)

function nowTZMonth() {
  const s = new Date().toLocaleString("en-US", { timeZone: TZ, month: "numeric" });
  return parseInt(s, 10) - 1; // 0-11
}
// 오늘 날짜(EAT) "YYYY-MM-DD"
function todayTZ() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const intEnv = (k, d) => { const v = parseInt(process.env[k], 10); return isNaN(v) ? d : v; };

// index.html의 heavyRain과 판정식이 반드시 같아야 한다 — 한쪽만 고치면
// 대시보드는 '주의'인데 경보 메일은 '심각'으로 나가 신뢰를 잃는다.
// 평년 대비(lvRel)는 절대 강도가 받쳐줄 때만 등급을 올린다(최소 일강수 조건).
function heavyRain(region, daily) {
  const p = daily.precipitation_sum || [];
  const maxD = Math.max(0, ...p.map((v) => v ?? 0));
  const maxIdx = Math.max(0, p.findIndex((v) => (v ?? 0) === maxD));
  const acc7 = p.reduce((a, v) => a + (v ?? 0), 0);
  const norm = region.monthly[nowTZMonth()] || 1;
  const ratio = acc7 / Math.max(norm, 25);
  const useRatio = acc7 >= ABS_FLOOR;

  const lvAbs = maxD >= 50 ? 4 : maxD >= 30 ? 3 : maxD >= 20 ? 2 : maxD >= 10 ? 1 : 0;
  let lvRel = 0;
  if (useRatio) {
    if (ratio >= 0.8 && maxD >= 30) lvRel = 4;
    else if (ratio >= 0.8 && maxD >= 20) lvRel = 3;
    else if (ratio >= 0.5 && maxD >= 10) lvRel = 2;
    else if (ratio >= 0.3) lvRel = 1;
  }
  const lv = Math.max(lvAbs, lvRel);
  const by = lv === 0 ? "none" : lvRel > lvAbs ? "ratio" : "abs";
  return { lv, maxD, maxIdx, acc7, ratio, useRatio, lvAbs, lvRel, by };
}
function heat(daily) {
  const a = (daily.apparent_temperature_max || []).map((v) => v ?? 0);
  const t = Math.max(0, ...a);
  return { lv: t >= 40 ? 4 : t >= 38 ? 3 : t >= 35 ? 2 : 0, t, idx: Math.max(0, a.indexOf(t)) };
}
function gust(daily) {
  const a = (daily.wind_gusts_10m_max || []).map((v) => v ?? 0);
  const g = Math.max(0, ...a);
  return { lv: g >= 100 ? 4 : g >= 80 ? 3 : g >= 60 ? 2 : 0, g, idx: Math.max(0, a.indexOf(g)) };
}
function nearEvents(list, lat, lon, deg) {
  return list.filter((e) => Math.abs(e.lat - lat) <= deg && Math.abs(e.lon - lon) <= deg);
}

async function jget(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(url.split("?")[0] + " → " + r.status);
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(url.split("?")[0] + " → 응답 없음(" + timeoutMs / 1000 + "초 초과)");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 예보는 한 번 실패했다고 점검 전체를 접기엔 아깝다 — 평소 응답이 1~2초인데(실측:
// 주 31곳 0.9초, 군 170곳 2.1초) 가끔 멈추거나 429가 나서 15초 타임아웃에 걸린다.
// 25회 중 2회가 그렇게 실패했고, 실패하면 그 회차 점검이 통째로 건너뛰어진다.
// 그래서 짧게 두 번 시도한다(12초×2 = 최악 25초, 함수 제한 안).
async function jgetRetry(url, timeoutMs = 12000, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await jget(url, timeoutMs);
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw new Error(last.message + " (" + tries + "회 시도)");
}

// require()로 정적 로드 — Vercel의 빌드 시 번들러(@vercel/nft)가 require() 호출을
// 추적해 이 JSON들을 함수 배포물에 자동 포함시킨다. fs.readFile(런타임 경로)는
// 이 추적을 타지 않아 배포 후 "파일 없음"으로 깨질 수 있어 피한다.
const baseline = require("../data/baseline.json");
const riversCfg = require("../data/rivers.json");
// 170개 군(Wilaya) 기준선 — 폴리곤(rings)은 이메일에 필요 없어 빼고 위경도+평년값만
// 담은 경량판(대시보드가 쓰는 districts.json과 다른 파일, build.py와 별개로 생성).
const districtBase = require("../data/baseline_district.json");
const REGION_EN = Object.fromEntries(baseline.map((r) => [r.name, r.en]));

module.exports = async (req, res) => {
  // 아무나 이 URL을 반복 호출해 메일을 스팸하지 못하도록 공유 비밀키로 보호
  const secret = process.env.ALERT_SECRET;
  const auth = req.headers["authorization"] || "";
  const given = auth.replace(/^Bearer\s+/i, "") || req.query.token;
  if (secret && given !== secret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // ── 정책 손잡이 ──
  const MODE = (process.env.ALERT_MODE || "always").toLowerCase(); // always | changes
  const MIN_LV = Math.min(4, Math.max(2, intEnv("ALERT_MIN_LEVEL", 2)));
  const LEAD = Math.min(7, Math.max(1, intEnv("ALERT_LEAD_DAYS", 7)));
  const DIGEST_LV = Math.min(4, Math.max(1, intEnv("ALERT_DIGEST_LEVEL", 2)));
  const isDigest = String(req.query.digest || "") === "1";
  // 이전 상태 — 워크플로가 저장해 둔 alert-state.json을 POST 본문 {prev: ...}로 넘긴다
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const prev = (body && (body.prev || body.items ? (body.prev || body) : null)) || null;
  const prevItems = (prev && prev.items) || {};

  const lat = baseline.map((r) => r.lat).join(",");
  const lon = baseline.map((r) => r.lon).join(",");
  const dlat = districtBase.map((r) => r.lat).join(",");
  const dlon = districtBase.map((r) => r.lon).join(",");
  const rlat = riversCfg.map((r) => r.lat).join(",");
  const rlon = riversCfg.map((r) => r.lon).join(",");
  const from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const fcParams = `&daily=precipitation_sum,temperature_2m_max,apparent_temperature_max,wind_gusts_10m_max&forecast_days=7&timezone=${TZ}`;

  const [fcR, fcDR, flR, gdR, eqR] = await Promise.allSettled([
    // 이 둘만 재시도한다 — 주 예보는 없으면 점검 자체가 불가능하고(아래 502),
    // 군 예보는 없으면 메일이 주 단위로 떨어져 쓸모가 준다. 나머지 셋은 없어도
    // 해당 축만 빠지므로 한 번만 시도한다.
    jgetRetry(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}${fcParams}`),
    // 위험 알림 메일은 군(Wilaya) 단위로 보내야 해서(대시보드 토글과 같은 이유 — 어느
    // 주가 아니라 어느 군인지까지 알아야 실무적으로 쓸모 있다) 170곳 예보를 따로 받는다.
    jgetRetry(`https://api.open-meteo.com/v1/forecast?latitude=${dlat}&longitude=${dlon}${fcParams}`),
    jget(`https://flood-api.open-meteo.com/v1/flood?latitude=${rlat}&longitude=${rlon}&daily=river_discharge,river_discharge_mean&forecast_days=14`),
    // GDACS: RSS(1~3초) → 실패 시 예전 SEARCH JSON(20초) 순으로 시도. 둘 다 안 되면 산불 축 0건.
    fetchGdacs({ timeoutMs: 12000, searchTimeoutMs: 20000 }),
    jget(
      `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=-13&maxlatitude=0&minlongitude=28&maxlongitude=42&minmagnitude=4&starttime=${from}&limit=100`
    ),
  ]);

  const fc = fcR.status === "fulfilled" ? fcR.value : null;
  const fcD = fcDR.status === "fulfilled" ? fcDR.value : null;
  const fl = flR.status === "fulfilled" ? flR.value : null;
  const gdRaw = gdR.status === "fulfilled" ? gdR.value : null;
  const eqRaw = eqR.status === "fulfilled" ? eqR.value : null;
  const sourceFails = [
    !fc && "forecast: " + fcR.reason?.message,
    !fcD && "forecast(군): " + fcDR.reason?.message,
    !fl && "flood: " + flR.reason?.message,
    !gdRaw && "gdacs: " + gdR.reason?.message,
    !eqRaw && "usgs: " + eqR.reason?.message,
  ].filter(Boolean);

  if (!fc) {
    res.status(502).json({ error: "핵심 기상 데이터 실패", sourceFails });
    return;
  }

  // GDACS 산불 — 응답 없으면 그냥 0건으로 취급(대시보드와 동일 원칙)
  const ACTIVE_DAYS = 14;
  const CUT = new Date(Date.now() - ACTIVE_DAYS * 864e5).toISOString().slice(0, 10);
  const wf = [];
  if (gdRaw && gdRaw.features) {
    for (const f of gdRaw.features) {
      const p = f.properties || {};
      const g = f.geometry || {};
      const c = g.coordinates && typeof g.coordinates[0] === "number" ? g.coordinates : [null, null];
      const to = String(p.todate || "").slice(0, 10);
      const active = !to || to >= CUT;
      if ((p.eventtype || "").toUpperCase() === "WF" && c[1] != null && active) {
        wf.push({ lon: c[0], lat: c[1] });
      }
    }
  }

  const eq = (eqRaw?.features || []).map((f) => ({
    mag: f.properties.mag,
    t: f.properties.time,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));

  const today = todayTZ();
  const dayDiff = (iso) => {
    if (!iso) return 0;
    const a = Date.parse(today + "T00:00:00Z"), b = Date.parse(String(iso).slice(0, 10) + "T00:00:00Z");
    return isNaN(b) ? 0 : Math.max(0, Math.round((b - a) / 864e5));
  };

  // 하천 — 같은 날짜의 평년값과 비교(계절 상승분을 이상치로 오판하지 않도록)
  const rivers = riversCfg.map((rv, i) => {
    const dd = (Array.isArray(fl) ? fl[i]?.daily : fl?.daily) || null;
    if (!dd) return { ...rv, ok: false };
    const dis = dd.river_discharge || [];
    const mns = dd.river_discharge_mean || [];
    let ratio = 0,
      peakDay = "";
    for (let i2 = 0; i2 < dis.length; i2++) {
      const v = dis[i2],
        m = mns[i2];
      if (v == null || m == null || m < 0.3) continue;
      if (v / m > ratio) {
        ratio = v / m;
        peakDay = dd.time?.[i2] || "";
      }
    }
    const lv = ratio >= 3 ? 4 : ratio >= 2 ? 3 : ratio >= 1.5 ? 2 : 0;
    return { ...rv, ok: true, ratio, lv, peakDay, lead: dayDiff(peakDay) };
  });

  // 지역 하나의 6축 판정 — 주(baseline)든 군(districtBase)이든 lat/lon+monthly만
  // 있으면 되므로 그대로 재사용한다(대시보드 template.html의 buildRows()와 같은 이유).
  // lead = 그 등급을 만든 값이 예보 며칠째에 있는지(0=오늘). 메일 본문의 D+n과
  // ALERT_LEAD_DAYS 필터에 쓴다. 산불·지진은 현재 상태라 0.
  function axesOf(r, daily) {
    const rain = heavyRain(r, daily);
    const ht = heat(daily);
    const gu = gust(daily);
    const nwf = nearEvents(wf, r.lat, r.lon, 1.1);
    const fire = nwf.length >= 5 ? 3 : nwf.length >= 2 ? 2 : nwf.length ? 1 : 0;
    const nq = nearEvents(eq, r.lat, r.lon, 1.8).filter((q) => Date.now() - q.t <= 30 * 864e5);
    const mq = nq.length ? Math.max(...nq.map((q) => q.mag)) : 0;
    const quake = mq >= 5.5 ? 3 : mq >= 4.5 ? 2 : mq ? 1 : 0;
    const days = daily.time || [];
    return {
      axes: { 호우: rain.lv, 폭염: ht.lv, 강풍: gu.lv, 산불: fire, 지진: quake },
      lead: { 호우: rain.maxIdx, 폭염: ht.idx, 강풍: gu.idx, 산불: 0, 지진: 0 },
      when: { 호우: days[rain.maxIdx] || "", 폭염: days[ht.idx] || "", 강풍: days[gu.idx] || "", 산불: today, 지진: today },
      val: {
        호우: `${rain.maxD.toFixed(0)}mm` + (rain.by === "ratio" ? ` · 7일 ${rain.acc7.toFixed(0)}mm=평년 ${(rain.ratio * 100).toFixed(0)}%` : ""),
        폭염: `체감 ${ht.t.toFixed(1)}℃`, 강풍: `돌풍 ${gu.g.toFixed(0)}km/h`, 산불: `${nwf.length}건`, 지진: mq ? `M${mq.toFixed(1)}` : "",
      },
    };
  }
  const md = (iso) => (iso ? String(iso).slice(5).replace(/^0/, "").replace("-0", "/").replace("-", "/") : "");
  // 축별 적중 목록: [{ax, lv, lead, when, val}] (등급 2 이상만)
  const hitsOf = (o) =>
    Object.entries(o.axes)
      .filter(([, v]) => v >= 2)
      .map(([k, v]) => ({ ax: k, lv: v, lead: o.lead[k] ?? 0, when: o.when[k] || "", val: o.val[k] || "" }));
  const hitKo = (h) => `${h.ax} ${LV[h.lv]}` + (h.lead > 0 ? ` (D+${h.lead}·${md(h.when)})` : "") + (h.val ? ` ${h.val}` : "");
  const hitEn = (h) => `${AX_EN[h.ax]} ${LV_EN[h.lv]}` + (h.lead > 0 ? ` (D+${h.lead})` : "");

  // 주(Mkoa) 단위 — 하천 축은 GloFAS 관측지점을 직접 v.region으로 매칭한다.
  const regionRiver = {}; // 군 판정이 하천 축을 그대로 물려받기 위해 이름으로 보관
  const alerts = [];
  baseline.forEach((r, i) => {
    const daily = (Array.isArray(fc) ? fc[i]?.daily : fc.daily) || null;
    if (!daily) return;
    const o = axesOf(r, daily);
    const rrs = rivers.filter((v) => v.ok && v.region === r.name);
    const top = rrs.sort((a, b) => (b.lv || 0) - (a.lv || 0) || (b.ratio || 0) - (a.ratio || 0))[0];
    o.axes.하천 = top ? top.lv || 0 : 0;
    o.lead.하천 = top ? top.lead : 0;
    o.when.하천 = top ? top.peakDay : "";
    o.val.하천 = top && top.ratio ? `${top.name} ${top.ratio.toFixed(2)}배` : "";
    regionRiver[r.name] = { lv: o.axes.하천, lead: o.lead.하천, when: o.when.하천, val: o.val.하천 };
    const risk = Math.max(...Object.values(o.axes));
    if (risk >= 2) {
      const hits = hitsOf(o);
      alerts.push({ key: "R:" + r.name, region: r.name, regionEn: r.en, project: r.project || null, risk, hits,
        lead: Math.min(...hits.filter((h) => h.lv === risk).map((h) => h.lead)), hitsText: hits.map(hitKo) });
    }
  });
  alerts.sort((a, b) => b.risk - a.risk);

  // 군(Wilaya) 단위 — 위험 알림 메일은 이 배열로 보낸다. 하천 축은 강이 정확히 어느
  // 군을 지나는지 격자로 특정할 수 없어(대시보드와 동일 이유) 상위 주(zone)의
  // 판정을 그대로 물려받는다.
  const districtAlerts = [];
  if (fcD) {
    districtBase.forEach((r, i) => {
      const daily = (Array.isArray(fcD) ? fcD[i]?.daily : fcD.daily) || null;
      if (!daily) return;
      const o = axesOf(r, daily);
      const rr = regionRiver[r.zone] || { lv: 0, lead: 0, when: "", val: "" };
      o.axes.하천 = rr.lv; o.lead.하천 = rr.lead; o.when.하천 = rr.when; o.val.하천 = rr.val;
      const risk = Math.max(...Object.values(o.axes));
      if (risk >= 2) {
        const hits = hitsOf(o);
        districtAlerts.push({ key: "D:" + r.name, district: r.name, districtEn: r.en || r.name, zone: r.zone,
          zoneEn: REGION_EN[r.zone] || r.zone, risk, hits,
          lead: Math.min(...hits.filter((h) => h.lv === risk).map((h) => h.lead)), hitsText: hits.map(hitKo) });
      }
    });
  }
  districtAlerts.sort((a, b) => b.risk - a.risk);

  // 메일은 군 단위, 군 예보가 실패했을 때만 주 단위로 대체한다.
  const useDistrict = !!fcD;
  const current = useDistrict ? districtAlerts : alerts;
  const unit = useDistrict ? "군" : "주";
  const unitEn = useDistrict ? "district" : "region";
  const nameOf = (a) => (useDistrict ? `${a.district} (${a.zone})` : a.region + (a.project ? ` (${a.project})` : ""));
  const nameEn = (a) => (useDistrict ? `${a.districtEn} (${a.zoneEn})` : a.regionEn);

  // ── 이번 호출에서 실제로 알릴 목록 ──
  // 즉시 알림: 등급 ≥ MIN_LV 이고 선행일 < LEAD. changes 모드면 이전 상태보다 새로/높아진 곳만.
  // 일일 요약: 등급 ≥ DIGEST_LV 전부(선행일 무관, 상태 비교 없음).
  let mailList, mailKind;
  if (isDigest) {
    mailList = current.filter((a) => a.risk >= DIGEST_LV);
    mailKind = "digest";
  } else {
    mailList = current.filter((a) => a.risk >= MIN_LV && a.lead < LEAD);
    if (MODE === "changes") {
      mailList = mailList.filter((a) => {
        const p = prevItems[a.key];
        return !p || (p.lv || 0) < a.risk;
      });
    }
    mailKind = MODE === "changes" ? "changes" : "always";
  }
  // 다음 호출에 넘길 상태 — 현재 '주의 이상'인 곳 전부(등급·최초 감지 시각). 요약 호출도 같은 값을 돌려준다.
  const state = { at: new Date().toISOString(), unit, items: {} };
  for (const a of current) {
    const p = prevItems[a.key];
    state.items[a.key] = { lv: a.risk, since: p && p.lv === a.risk ? p.since || state.at : state.at, hits: a.hits.map((h) => h.ax + ":" + h.lv) };
  }

  let posted = false;
  const notifyErrors = [];
  const shouldSend = mailList.length > 0;
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const dashUrl = host ? `https://${host}/` : "";
  const stamp = new Date().toLocaleString("ko-KR", { timeZone: TZ });
  const topLv = mailList.length ? Math.max(...mailList.map((a) => a.risk)) : 0;
  const policyLine = isDigest
    ? `일일 요약 · ${LV[DIGEST_LV]} 이상 전부`
    : `${LV[MIN_LV]} 이상` + (LEAD < 7 ? ` · 오늘~D+${LEAD - 1}` : ` · 7일 예보`) + (MODE === "changes" ? " · 신규/상승분만" : "");

  // Slack(선택) — SLACK_WEBHOOK_URL을 넣으면 자동으로 같이 발송된다(같은 목록·같은 판단).
  if (shouldSend && process.env.SLACK_WEBHOOK_URL) {
    const lines = mailList.map((a) => `• *${nameOf(a)}* — ${a.hitsText.join(", ")}`);
    const text = `*[탄자니아 안전모니터] ${isDigest ? "일일 요약" : "위험 등급"} ${unit} ${mailList.length}건 (최고 ${LV[topLv]})*\n${lines.join("\n")}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      // Slack 웹훅은 응답 본문이 JSON이 아니라 문자열 "ok"라서 jget이 아닌 plain fetch를 쓴다.
      const r = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: ac.signal,
      });
      posted = posted || r.ok;
      if (!r.ok) notifyErrors.push("slack: HTTP " + r.status);
    } catch (e) {
      notifyErrors.push("slack: " + e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  // 이메일(Resend) — Vercel엔 자체 발송 기능이 없어 무료 API를 쓴다.
  // RESEND_API_KEY만 있으면 도메인 인증 없이 onboarding@resend.dev 발신으로 바로 된다
  // (하루 100통 무료). 커스텀 발신 도메인을 인증하면 ALERT_EMAIL_FROM으로 바꾸면 된다.
  // 본문은 한·영 병기 — 사업수행기관(외국인 포함)에 그대로 전달할 수 있게.
  if (shouldSend && process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_TO) {
    const color = ["#8fa3b8", "#3d8f5a", "#c9971f", "#d9682b", "#c0342b"];
    const rows = mailList
      .map(
        (a) =>
          `<tr>` +
          `<td style="padding:5px 10px 5px 0;vertical-align:top;white-space:nowrap"><b>${nameOf(a)}</b><br><span style="color:#888;font-size:12px">${nameEn(a)}</span></td>` +
          `<td style="padding:5px 8px;vertical-align:top;white-space:nowrap"><span style="background:${color[a.risk]};color:#fff;border-radius:9px;padding:1px 8px;font-size:12px">${LV[a.risk]} · ${LV_EN[a.risk]}</span></td>` +
          `<td style="padding:5px 0;vertical-align:top">${a.hits.map(hitKo).join("<br>")}<br><span style="color:#888;font-size:12px">${a.hits.map(hitEn).join(" · ")}</span></td>` +
          `</tr>`
      )
      .join("");
    const html =
      `<div style="font-family:sans-serif;font-size:14px;line-height:1.45">` +
      `<p><b>[탄자니아 안전모니터]</b> ${isDigest ? "일일 요약 —" : ""} 위험 등급 ${unit} ${mailList.length}건 · 최고 <b>${LV[topLv]}</b> (${stamp} EAT)<br>` +
      `<span style="color:#888;font-size:12px">Tanzania Safety Monitor — ${isDigest ? "daily digest" : "alert"}: ${mailList.length} ${unitEn}${mailList.length > 1 ? "s" : ""}, highest ${LV_EN[topLv]}</span></p>` +
      (useDistrict ? "" : `<p style="color:#c62828">군 단위 예보 실패로 주 단위로 대체 발송</p>`) +
      `<table style="border-collapse:collapse">${rows}</table>` +
      `<p style="color:#888;font-size:12px;margin-top:12px">기준: ${policyLine}. D+n = 예보 며칠째에 걸린 값인지(없으면 오늘). ` +
      `등급은 7일 예보 중 최댓값 기준이며 D+4 이후 값은 불확실성이 큽니다.` +
      (dashUrl ? ` 상세: <a href="${dashUrl}">${dashUrl}</a> (영문: <a href="${dashUrl}?lang=en">?lang=en</a>)` : "") + `</p></div>`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.ALERT_EMAIL_FROM || "KOICA 안전모니터 <onboarding@resend.dev>",
          to: process.env.ALERT_EMAIL_TO.split(",").map((s) => s.trim()),
          subject: `[탄자니아 안전모니터] ${isDigest ? "일일 요약 · " : ""}${LV[topLv]} ${unit} ${mailList.length}건`,
          html,
        }),
        signal: ac.signal,
      });
      posted = posted || r.ok;
      if (!r.ok) notifyErrors.push("email: HTTP " + r.status + " " + (await r.text()).slice(0, 200));
    } catch (e) {
      notifyErrors.push("email: " + e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  const summary = `${isDigest ? "digest" : mailKind} · ${unit} ${current.length}건 중 알림 ${mailList.length}건` + (topLv ? ` · 최고 ${LV[topLv]}` : "");
  res.status(200).json({
    checkedAt: new Date().toISOString(),
    policy: { mode: MODE, minLevel: MIN_LV, leadDays: LEAD, digestLevel: DIGEST_LV, digest: isDigest, hadPrev: !!prev },
    regionsChecked: baseline.length,
    districtsChecked: fcD ? districtBase.length : 0,
    alertCount: alerts.length,
    districtAlertCount: districtAlerts.length,
    mailUnit: unit,
    mailKind,
    mailed: mailList.length,
    posted,
    summary,
    alerts: alerts.slice(0, 10).map(({ key, region, project, risk, lead, hitsText }) => ({ key, region, project, risk, lead, hits: hitsText })),
    districtAlerts: districtAlerts.slice(0, 15).map(({ key, district, zone, risk, lead, hitsText }) => ({ key, district, zone, risk, lead, hits: hitsText })),
    gdacsSource: gdRaw ? gdRaw.source : null,
    sourceFails,
    notifyErrors,
    state,
  });
};
