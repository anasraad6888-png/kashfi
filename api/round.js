/* =========================================================
   كشفي — ذهاب وعودة بخطوتين — Vercel Node Function
   /api/round?origin&destination&outbound&return[&departure_token][&match]
   Step 1 (بدون توكن): SerpApi type=1 (غوغل) → Scrappa احتياطي — كاش 12 ساعة
   Step 2 (بالتوكن):  SerpApi departure_token → Scrappa (إعادة إرساء) عند الفشل
   المفاتيح: SERPAPI_KEY و SCRAPPA_API_KEY
   ========================================================= */
"use strict";

const cache = new Map();
const TTL = 12 * 3600 * 1000;
function cacheGet(k) { const e = cache.get(k); if (e && Date.now() - e.at < TTL) return e.body; if (e) cache.delete(k); return null; }
function cachePut(k, body) { if (cache.size > 800) cache.clear(); cache.set(k, { at: Date.now(), body }); }

function normalizeFn(f) { return String(f || "").replace(/\s+/g, "").toUpperCase(); }
function legArrCode(l) {
  const a = l && l.arrival_airport;
  return (a && (a.id || a)) || null;
}
function splitRoundLegs(legs, destination) {
  const outbound = [];
  const returns = [];
  let seenDest = false;
  for (const l of legs) {
    if (!seenDest) { outbound.push(l); if (legArrCode(l) === destination) seenDest = true; }
    else returns.push(l);
  }
  return { outbound, returns };
}
function scrappaNormalizeLegs(legs) {
  return legs.map((l) => ({
    airline: l.airline,
    flight_number: l.flight_number,
    duration: l.duration_minutes,
    airline_logo: `https://www.gstatic.com/flights/airline_logos/70px/${l.airline}.png`,
    departure_airport: { id: l.departure_airport, name: l.departure_airport, time: String(l.departure_time || "").replace("T", " ").slice(0, 16) },
    arrival_airport: { id: l.arrival_airport, name: l.arrival_airport, time: String(l.arrival_time || "").replace("T", " ").slice(0, 16) },
  }));
}
async function scrappaRoundTrip(origin, destination, depDate, retDate, depToken, key) {
  const api = `https://scrappa.co/api/flights/v2/round-trip?origin=${origin}&destination=${destination}&departure_date=${depDate}&return_date=${retDate}` + (depToken ? `&departure_token=${encodeURIComponent(depToken)}` : "");
  const r = await Promise.race([
    fetch(api, { headers: { "User-Agent": "kashfi/1.0", Accept: "application/json", "X-API-KEY": key } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)),
  ]);
  const j = await r.json();
  if (!j || !Array.isArray(j.flights)) return null;
  const best = [];
  for (const it of j.flights) {
    const all = it.legs || [];
    if (!all.length) continue;
    const { outbound, returns } = splitRoundLegs(all, destination);
    const legs = depToken ? returns : outbound;
    if (!legs.length) continue;
    best.push({
      flights: scrappaNormalizeLegs(legs),
      layovers: [],
      total_duration: depToken ? it.return_duration_minutes : it.outbound_duration_minutes,
      price: it.price,
      type: depToken ? "Round trip" : "One way",
      airline_logo: "",
      departure_token: depToken ? null : (it.departure_token || it.booking_token || null),
    });
  }
  return best.length ? { ok: true, source: "scrappa", currency: "USD", step: depToken ? 2 : 1, best, other: [], insights: null, url: null } : null;
}
async function serpRound(origin, destination, depDate, retDate, depToken, key) {
  const api = `https://serpapi.com/search?engine=google_flights&departure_id=${origin}&arrival_id=${destination}&outbound_date=${depDate}&return_date=${retDate}` + (depToken ? `&departure_token=${encodeURIComponent(depToken)}` : "") + `&type=1&currency=USD&hl=en&gl=us&api_key=${encodeURIComponent(key)}`;
  const r = await Promise.race([
    fetch(api, { headers: { "User-Agent": "kashfi/1.0", Accept: "application/json" } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)),
  ]);
  const j = await r.json();
  if (!j || !j.search_metadata || j.search_metadata.status !== "Success") return null;
  const itins = (j.best_flights || []).concat(j.other_flights || []);
  if (!itins.length) return null;
  const step = depToken ? 2 : 1;
  const best = itins
    .map((it) => ({
      flights: it.flights || [],
      layovers: it.layovers || [],
      total_duration: it.total_duration,
      price: it.price,
      type: step === 1 ? "One way" : "Round trip",
      airline_logo: it.airline_logo || "",
      departure_token: step === 1 ? (it.departure_token || null) : null,
    }))
    .filter((b) => b.flights.length);
  if (!best.length) return null;
  return { ok: true, source: "google_flights", currency: "USD", step, best, other: [], insights: j.price_insights || null, url: (j.search_metadata && j.search_metadata.google_flights_url) || null };
}
async function scrappaReanchor(origin, destination, depDate, retDate, match, key) {
  const [fnPart, timePart] = String(match || "").split("|");
  if (!fnPart) return null;
  const s1 = await scrappaRoundTrip(origin, destination, depDate, retDate, null, key);
  if (!s1) return null;
  let hit = null;
  for (const b of s1.best) {
    const f0 = b.flights[0];
    const sameFn = normalizeFn(f0 && f0.flight_number) === normalizeFn(fnPart);
    const timeS = timePart ? String(timePart).replace("T", " ") : "";
    const sameTime = !timeS || (f0 && f0.departure_airport && f0.departure_airport.time === timeS);
    if (sameFn && sameTime && b.departure_token) { hit = b; break; }
  }
  if (!hit) return null;
  return await scrappaRoundTrip(origin, destination, depDate, retDate, hit.departure_token, key);
}

module.exports = async function handler(req, res) {
  const send = (status, obj, sMaxAge) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", sMaxAge ? `public, max-age=300, s-maxage=${sMaxAge}` : "no-store");
    res.status(status).end(JSON.stringify(obj));
  };
  try {
    const url = new URL(req.url, "https://kashfi.vercel.app");
    const SERP = (process.env.SERPAPI_KEY || "").trim();
    const SCRAPPA = (process.env.SCRAPPA_API_KEY || "").trim();
    const origin = (url.searchParams.get("origin") || "").trim().toUpperCase().slice(0, 3);
    const destination = (url.searchParams.get("destination") || "").trim().toUpperCase().slice(0, 3);
    const depDate = (url.searchParams.get("outbound") || "").trim();
    const retDate = (url.searchParams.get("return") || "").trim();
    if (origin.length !== 3 || destination.length !== 3 || !/^\d{4}-\d{2}-\d{2}$/.test(depDate) || !/^\d{4}-\d{2}-\d{2}$/.test(retDate)) {
      return send(400, { ok: false, error: "origin / destination / outbound / return (YYYY-MM-DD) مطلوبة" });
    }
    const depToken = (url.searchParams.get("departure_token") || "").trim();

    if (!depToken) {
      const ckey = `round1|${origin}|${destination}|${depDate}|${retDate}`;
      const hit = cacheGet(ckey);
      if (hit) { hit.cacheHit = true; return send(200, hit, 43200); }
      let out = null;
      if (SERP) out = await serpRound(origin, destination, depDate, retDate, null, SERP);
      if ((!out || !out.best.length) && SCRAPPA) out = await scrappaRoundTrip(origin, destination, depDate, retDate, null, SCRAPPA) || out;
      if (out && out.best && out.best.length) { cachePut(ckey, out); return send(200, out, 43200); }
      return send(502, { ok: false, error: "لا توجد رحلات ذهاب لهذا المسار/التاريخ" });
    }

    let out = null;
    if (SERP) out = await serpRound(origin, destination, depDate, retDate, depToken, SERP);
    if ((!out || !out.best.length) && SCRAPPA) out = (await scrappaReanchor(origin, destination, depDate, retDate, (url.searchParams.get("match") || "").trim(), SCRAPPA)) || out;
    if (out && out.best && out.best.length) return send(200, out);
    return send(502, { ok: false, error: "تعذر جلب رحلات العودة — اختر رحلة ذهاب أخرى" });
  } catch (e) {
    return send(504, { ok: false, error: "فشل الاتصال بالوسطاء" });
  }
};
