// GitHub Actions가 15~30분마다 이 엔드포인트를 호출한다(Vercel Hobby는 자체 크론이
// 하루 1회뿐이라 외부 스케줄러로 우회 — 세션 논의 참조).
// 매 호출: 데이터 수집 → 규칙 평가(대시보드와 동일 로직) → 위험지역 있으면 Slack 발송.
//
// 1단계(검증 단계) 설계 원칙:
//  - GDACS는 절반 가까이 응답이 느리거나 없다(직접 확인됨) → 산불/가뭄 신호가
//    없어도 핵심 축(호우·폭염·강풍·하천·지진)만으로 판정한다. 소스 하나가
//    죽었다고 전체 점검을 실패로 처리하지 않는다.
//  - 중복 억제(쿨다운) 없이 매번 현재 상태를 그대로 알린다 — 검증 기간에는
//    "얼마나 자주/일관되게 뜨는지" 자체가 확인 대상이므로 상태 저장 없이 무상태로 둔다.
//    실제 운영 전환 시 Vercel Blob 등으로 이전 상태를 저장해 상승분만 알리도록 바꾼다.

const TZ = "Africa/Dar_es_Salaam";
const LV = ["정상", "관심", "주의", "경계", "심각"];
const ABS_FLOOR = 40; // mm, 7일 누적 — 평년비 판정의 절대 하한(건기 잡음 방지)

function nowTZMonth() {
  const s = new Date().toLocaleString("en-US", { timeZone: TZ, month: "numeric" });
  return parseInt(s, 10) - 1; // 0-11
}

function heavyRain(region, daily) {
  const p = daily.precipitation_sum || [];
  const maxD = Math.max(0, ...p.map((v) => v ?? 0));
  const acc7 = p.reduce((a, v) => a + (v ?? 0), 0);
  const norm = region.monthly[nowTZMonth()] || 1;
  const ratio = acc7 / Math.max(norm, 25);
  const useRatio = acc7 >= ABS_FLOOR;
  let lv = 0;
  if (maxD >= 50 || (useRatio && ratio >= 0.8)) lv = 4;
  else if (maxD >= 30 || (useRatio && ratio >= 0.5)) lv = 3;
  else if (maxD >= 20 || (useRatio && ratio >= 0.3)) lv = 2;
  else if (maxD >= 10) lv = 1;
  return { lv, maxD, acc7, ratio, useRatio };
}
function heat(daily) {
  const t = Math.max(0, ...(daily.apparent_temperature_max || []).map((v) => v ?? 0));
  return { lv: t >= 40 ? 4 : t >= 38 ? 3 : t >= 35 ? 2 : 0, t };
}
function gust(daily) {
  const g = Math.max(0, ...(daily.wind_gusts_10m_max || []).map((v) => v ?? 0));
  return { lv: g >= 100 ? 4 : g >= 80 ? 3 : g >= 60 ? 2 : 0, g };
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

// require()로 정적 로드 — Vercel의 빌드 시 번들러(@vercel/nft)가 require() 호출을
// 추적해 이 JSON들을 함수 배포물에 자동 포함시킨다. fs.readFile(런타임 경로)는
// 이 추적을 타지 않아 배포 후 "파일 없음"으로 깨질 수 있어 피한다.
const baseline = require("../data/baseline.json");
const riversCfg = require("../data/rivers.json");
// 170개 군(Wilaya) 기준선 — 폴리곤(rings)은 이메일에 필요 없어 빼고 위경도+평년값만
// 담은 경량판(대시보드가 쓰는 districts.json과 다른 파일, build.py와 별개로 생성).
// 실측(ERA5, baseline_district.py) 전이면 상위 주 평년값을 임시로 물려받은 값이다.
const districtBase = require("../data/baseline_district.json");

module.exports = async (req, res) => {
  // 아무나 이 URL을 반복 호출해 Slack을 스팸하지 못하도록 공유 비밀키로 보호
  const secret = process.env.ALERT_SECRET;
  const auth = req.headers["authorization"] || "";
  const given = auth.replace(/^Bearer\s+/i, "") || req.query.token;
  if (secret && given !== secret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const lat = baseline.map((r) => r.lat).join(",");
  const lon = baseline.map((r) => r.lon).join(",");
  const dlat = districtBase.map((r) => r.lat).join(",");
  const dlon = districtBase.map((r) => r.lon).join(",");
  const rlat = riversCfg.map((r) => r.lat).join(",");
  const rlon = riversCfg.map((r) => r.lon).join(",");
  const from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const fcParams = `&daily=precipitation_sum,temperature_2m_max,apparent_temperature_max,wind_gusts_10m_max&forecast_days=7&timezone=${TZ}`;

  const [fcR, fcDR, flR, gdR, eqR] = await Promise.allSettled([
    jget(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}${fcParams}`),
    // 위험 알림 메일은 군(Wilaya) 단위로 보내야 해서(대시보드 토글과 같은 이유 — 어느
    // 주가 아니라 어느 군인지까지 알아야 실무적으로 쓸모 있다) 170곳 예보를 따로 받는다.
    jget(`https://api.open-meteo.com/v1/forecast?latitude=${dlat}&longitude=${dlon}${fcParams}`),
    jget(`https://flood-api.open-meteo.com/v1/flood?latitude=${rlat}&longitude=${rlon}&daily=river_discharge,river_discharge_mean&forecast_days=14`),
    jget(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?country=Tanzania&alertlevel=Green;Orange;Red`, 12000),
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
    return { ...rv, ok: true, ratio, lv, peakDay };
  });

  // 지역 하나의 6축 판정 — 주(baseline)든 군(districtBase)이든 lat/lon+monthly만
  // 있으면 되므로 그대로 재사용한다(대시보드 template.html의 buildRows()와 같은 이유).
  function axesOf(r, daily) {
    const rain = heavyRain(r, daily);
    const ht = heat(daily);
    const gu = gust(daily);
    const nwf = nearEvents(wf, r.lat, r.lon, 1.1);
    const fire = nwf.length >= 5 ? 3 : nwf.length >= 2 ? 2 : nwf.length ? 1 : 0;
    const nq = nearEvents(eq, r.lat, r.lon, 1.8).filter((q) => Date.now() - q.t <= 30 * 864e5);
    const mq = nq.length ? Math.max(...nq.map((q) => q.mag)) : 0;
    const quake = mq >= 5.5 ? 3 : mq >= 4.5 ? 2 : mq ? 1 : 0;
    return { 호우: rain.lv, 폭염: ht.lv, 강풍: gu.lv, 산불: fire, 지진: quake };
  }
  const hitsOf = (axes) =>
    Object.entries(axes)
      .filter(([, v]) => v >= 2)
      .map(([k, v]) => `${k} ${LV[v]}`);

  // 주(Mkoa) 단위 — 하천 축은 GloFAS 관측지점을 직접 v.region으로 매칭한다.
  const regionAxes = {}; // 군 판정이 하천 축을 그대로 물려받기 위해 이름으로 보관
  const alerts = [];
  baseline.forEach((r, i) => {
    const daily = (Array.isArray(fc) ? fc[i]?.daily : fc.daily) || null;
    if (!daily) return;
    const axes = axesOf(r, daily);
    const rrs = rivers.filter((v) => v.ok && v.region === r.name);
    axes.하천 = Math.max(0, ...rrs.map((v) => v.lv || 0));
    regionAxes[r.name] = axes;
    const risk = Math.max(...Object.values(axes));
    if (risk >= 2) alerts.push({ region: r.name, project: r.project || null, risk, hits: hitsOf(axes) });
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
      const axes = axesOf(r, daily);
      axes.하천 = (regionAxes[r.zone] || {}).하천 || 0;
      const risk = Math.max(...Object.values(axes));
      if (risk >= 2) districtAlerts.push({ district: r.name, zone: r.zone, risk, hits: hitsOf(axes) });
    });
  }
  districtAlerts.sort((a, b) => b.risk - a.risk);

  // 메일은 군 단위, 군 예보가 실패했을 때만 주 단위로 대체한다(위 이메일 블록에서
  // 실제 발송에 씀). 응답 JSON에도 그대로 노출하기 위해 여기서 미리 정한다.
  const useDistrict = districtAlerts.length > 0 || !!fcD;
  const mailAlerts = useDistrict ? districtAlerts : alerts;
  const unit = useDistrict ? "군" : "주";

  let posted = false;
  const notifyErrors = [];

  // Slack(선택) — SLACK_WEBHOOK_URL을 넣으면 자동으로 같이 발송된다
  if (alerts.length && process.env.SLACK_WEBHOOK_URL) {
    const lines = alerts.map((a) => `• *${a.region}*${a.project ? ` (${a.project})` : ""} — ${a.hits.join(", ")}`);
    const text = `*[탄자니아 안전모니터] 위험 등급 지역 ${alerts.length}건*\n${lines.join("\n")}`;
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
  //
  // 메일은 군(Wilaya) 단위로 보낸다 — Slack은 위 alerts(주 단위, 전체 개황용)를 쓰지만,
  // 메일은 실무자가 실제로 확인할 대상 지역을 정하는 데 쓰이므로 더 정밀한 군 단위가
  // 실무적으로 더 쓸모 있다는 요청에 따른 것이다. 군 예보가 실패했을 때는(fcD 없음)
  // 주 단위로 대체 발송한다 — 메일이 아예 안 가는 것보다 낫다.
  if (mailAlerts.length && process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_TO) {
    const rows = mailAlerts
      .map((a) =>
        useDistrict
          ? `<tr><td style="padding:4px 10px 4px 0"><b>${a.district}</b> <span style="color:#888">(${a.zone})</span></td>` +
            `<td style="padding:4px 0">${a.hits.join(", ")}</td></tr>`
          : `<tr><td style="padding:4px 10px 4px 0"><b>${a.region}</b>${a.project ? ` <span style="color:#888">(${a.project})</span>` : ""}</td>` +
            `<td style="padding:4px 0">${a.hits.join(", ")}</td></tr>`
      )
      .join("");
    const html =
      `<div style="font-family:sans-serif;font-size:14px">` +
      `<p><b>[탄자니아 안전모니터]</b> 위험 등급 ${unit} ${mailAlerts.length}건 (${new Date().toLocaleString("ko-KR", { timeZone: TZ })} EAT)` +
      (useDistrict ? "" : ` <span style="color:#c62828">— 군 단위 예보 실패로 주 단위로 대체 발송</span>`) +
      `</p><table>${rows}</table></div>`;
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
          subject: `[탄자니아 안전모니터] 위험 등급 ${unit} ${mailAlerts.length}건`,
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

  res.status(200).json({
    checkedAt: new Date().toISOString(),
    regionsChecked: baseline.length,
    districtsChecked: fcD ? districtBase.length : 0,
    alertCount: alerts.length,
    districtAlertCount: districtAlerts.length,
    mailUnit: unit,
    posted,
    alerts: alerts.slice(0, 10),
    districtAlerts: districtAlerts.slice(0, 15),
    sourceFails,
    notifyErrors,
  });
};
