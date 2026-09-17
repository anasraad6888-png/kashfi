/* كشفي — واجهة تصحيح خام: /api/scrappa/flights?origin=BGW&destination=BKK&date=2026-12-15
   تُظهر استجابة Scrappa كما هي (للفحص/التصحيح) — المفتاح: SCRAPPA_API_KEY */
"use strict";

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
    const origin = (url.searchParams.get("origin") || "BGW").trim().toUpperCase().slice(0, 3);
    const destination = (url.searchParams.get("destination") || "BKK").trim().toUpperCase().slice(0, 3);
    const date = (url.searchParams.get("date") || "").trim() || new Date().toISOString().slice(0, 10);
    const api = `https://scrappa.co/api/flights/one-way?origin=${origin}&destination=${destination}&departure_date=${date}`;
    const r = await Promise.race([
      fetch(api, { headers: { "User-Agent": "kashfi/1.0", Accept: "application/json", "X-API-KEY": key } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)),
    ]);
    const j = await r.json();
    return send(200, { ok: Array.isArray(j && j.flights), rawStatus: r.status, raw: j });
  } catch (e) {
    return send(504, { ok: false, error: "فشل الاتصال بـ Scrappa" });
  }
};
