/* =========================================================
   كشفي — وسيط الرحلات — Vercel Node Function
   /api/serp/flights?origin=BGW&destination=BKK&date=2026-12-15[&retDate][&trip=one|round][&force=scrappa]
   السلسلة: Google Flights (SerpApi) → Scrappa (احتياطي مجاني) → الكاش 12 ساعة (CDN + ذاكرة المثيل)
   المفاتيح: SERPAPI_KEY و SCRAPPA_API_KEY (متغيرات بيئة Vercel)
   ========================================================= */
"use strict";

const cache = new Map();
const TTL = 12 * 3600 * 1000;
function cacheGet(k) { const e = cache.get(k); if (e && Date.now() - e.at < TTL) return e.body; if (e) cache.delete(k); return null; }
function cachePut(k, body) { if (cache.size > 800) cache.clear(); cache.set(k, { at: Date.now(), body }); }

function normalizeScrappa(j) {
  const out = { ok: true, source: "scrappa", currency: "USD", best: [], other: [], insights: null, url: null };
  for (const it of (j.flights || [])) {
    const legs = it.legs || [];
    if (!legs.length) continue;
    const flights = legs.map((l) => ({
      airline: l.airline,
      flight_number: l.flight_number,
      duration: l.duration_minutes,
      airline_logo: `https://www.gstatic.com/flights/airline_logos/70px/${l.airline}.png`,
      departure_airport: { id: l.departure_airport, name: l.departure_airport, time: String(l.departure_time || "").replace("T", " ").slice(0, 16) },
      arrival_airport: { id: l.arrival_airport, name: l.arrival_airport, time: String(l.arrival_time || "").replace("T", " ").slice(0, 16) },
    }));
    out.best.push({ flights, layovers: [], total_duration: it.total_duration_minutes, price: it.price, type: "One way", airline_logo: "" });
  }
  return out.best.length ? out : null;
}

module.exports = async function handler(req, res) {
  const send = (status, obj, sMaxAge) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", sMaxAge ? `public, max-age=300, s-maxage=${sMaxAge}` : "no-store");
    res.status(status).end(JSON.stringify(obj));
  };

  try {
    let url;
    try { url = new URL(req.url, "https://kashfi.vercel.app"); } catch (e) { return send(400, { ok: false, error: "bad url" }); }

    const origin = (url.searchParams.get("origin") || "").trim().toUpperCase().slice(0, 3);
    const destination = (url.searchParams.get("destination") || "").trim().toUpperCase().slice(0, 3);
    const date = (url.searchParams.get("date") || "").trim();
    if (origin.length !== 3 || destination.length !== 3 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return send(400, { ok: false, error: "origin / destination / date (YYYY-MM-DD) مطلوبة" });
    }
    const trip = (url.searchParams.get("trip") || "one").toLowerCase();
    const retDate = (url.searchParams.get("retDate") || "").trim();
    const round = trip === "round" && /^\d{4}-\d{2}-\d{2}$/.test(retDate);
    const force = (url.searchParams.get("force") || "").toLowerCase();
    const key = `${origin}|${destination}|${date}|${trip}|${retDate}`;

    const hit = cacheGet(key);
    if (hit && force !== "scrappa") { hit.cacheHit = true; return send(200, hit, 43200); }

    const SERP = (process.env.SERPAPI_KEY || "").trim();
    const SCRAPPA = (process.env.SCRAPPA_API_KEY || "").trim();
    let out = null;

    if (SERP && force !== "scrappa") {
      const api = `https://serpapi.com/search?engine=google_flights&departure_id=${origin}&arrival_id=${destination}&outbound_date=${date}${round ? `&return_date=${retDate}` : ""}&type=${round ? 1 : 2}&currency=USD&hl=en&gl=us&api_key=${encodeURIComponent(SERP)}`;
      try {
        const r = await Promise.race([
          fetch(api, { headers: { "User-Agent": "kashfi/1.0", Accept: "application/json" } }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)),
        ]);
        const j = await r.json();
        if (j && j.search_metadata && j.search_metadata.status === "Success") {
          out = {
            ok: true, source: "google_flights", currency: "USD",
            best: j.best_flights || [], other: j.other_flights || [],
            insights: j.price_insights || null,
            url: (j.search_metadata && j.search_metadata.google_flights_url) || null,
          };
        }
      } catch (e1) { /* ننتقل للاحتياطي */ }
    }

    if ((!out || !(out.best.length || out.other.length)) && !round && SCRAPPA) {
      const api2 = `https://scrappa.co/api/flights/one-way?origin=${origin}&destination=${destination}&departure_date=${date}`;
      try {
        const r2 = await Promise.race([
          fetch(api2, { headers: { "User-Agent": "kashfi/1.0", Accept: "application/json", "X-API-KEY": SCRAPPA } }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)),
        ]);
        const j2 = await r2.json();
        const n = normalizeScrappa(j2);
        if (n) out = n;
      } catch (e2) { /* تجاهل */ }
    }

    if (out && (out.best.length || out.other.length)) {
      cachePut(key, out);
      return send(200, out, 43200);
    }
    return send(502, { ok: false, error: "لا توجد نتائج من Google Flights أو Scrappa لهذا المسار" });
  } catch (e) {
    return send(504, { ok: false, error: "فشل الاتصال بالوسطاء" });
  }
};
