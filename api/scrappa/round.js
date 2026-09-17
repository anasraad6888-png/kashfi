/* =========================================================
   كشفي — رحلات ذهاب وعودة بخطوتين (Scrappa v2 round-trip)
   /api/scrappa/round?origin&destination&outbound&return[&departure_token]
   Step 1: بدون توكن  → رحلات الذهاب (لكل عنصر departure_token)
   Step 2: بالتوكن     → رحلات العودة لرحلة الذهاب المختارة (سعر الباقة الكاملة)
   المفتاح: SCRAPPA_API_KEY (متغير بيئة Vercel)
   ========================================================= */
"use strict";

function splitRoundLegs(legs, destination) {
  const outbound = [];
  const returns = [];
  let seenDest = false;
  for (const l of legs) {
    if (!seenDest) { outbound.push(l); if (l.arrival_airport === destination) seenDest = true; }
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

module.exports = async function handler(req, res) {
  const send = (status, obj) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.status(status).end(JSON.stringify(obj));
  };
  try {
    const url = new URL(req.url, "https://kashfi.vercel.app");
    const key = (process.env.SCRAPPA_API_KEY || "").trim();
    if (!key) return send(503, { ok: false, error: "SCRAPPA_API_KEY غير مضبوط في Vercel" });
    const origin = (url.searchParams.get("origin") || "").trim().toUpperCase().slice(0, 3);
    const destination = (url.searchParams.get("destination") || "").trim().toUpperCase().slice(0, 3);
    const depDate = (url.searchParams.get("outbound") || "").trim();
    const retDate = (url.searchParams.get("return") || "").trim();
    if (origin.length !== 3 || destination.length !== 3 || !/^\d{4}-\d{2}-\d{2}$/.test(depDate) || !/^\d{4}-\d{2}-\d{2}$/.test(retDate)) {
      return send(400, { ok: false, error: "origin / destination / outbound / return (YYYY-MM-DD) مطلوبة" });
    }
    const depToken = (url.searchParams.get("departure_token") || "").trim();
    const api = `https://scrappa.co/api/flights/v2/round-trip?origin=${origin}&destination=${destination}&departure_date=${depDate}&return_date=${retDate}` + (depToken ? `&departure_token=${encodeURIComponent(depToken)}` : "");
    const r = await Promise.race([
      fetch(api, { headers: { "User-Agent": "kashfi/1.0", Accept: "application/json", "X-API-KEY": key } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)),
    ]);
    const j = await r.json();
    if (!j || !Array.isArray(j.flights)) return send(502, { ok: false, error: "Scrappa round-trip لم يستجب" });
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
        type: depToken ? "Return" : "One way",
        airline_logo: "",
        departure_token: depToken ? null : (it.departure_token || it.booking_token || null),
      });
    }
    if (!best.length) return send(502, { ok: false, error: "لا توجد رحلات لهذا المسار/التاريخ عبر Scrappa" });
    return send(200, { ok: true, source: "scrappa", currency: "USD", step: depToken ? 2 : 1, best, other: [], insights: null, url: null });
  } catch (e) {
    return send(504, { ok: false, error: "فشل الاتصال بـ Scrappa" });
  }
};
