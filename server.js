/* =========================================================
   كشفي — خادم محلي بسيط: ملفات ثابتة + وسطاء Google Flights (SerpApi) وScrappa
   ---------------------------------------------------------
   · البحث المحلي يعمل بدون مفاتيح عبر قاعدة OpenFlights المدمجة (/data)
   · الأسعار الحقيقية: Google Flights (SerpApi) أساساً ثم Scrappa ثم المحرك المحلي
   🔐 الأمان: المفاتيح لا تُمرَّر إلى المتصفح أبداً —
     تُقرأ من متغيرات البيئة أو من kashfi.config.json
     (والذي يُمنع تحميله كملف ثابت في هذا الخادم).
     عند النشر على Vercel: انقل نفس المنطق إلى Serverless Functions
     وضع المفاتيح في متغيرات البيئة لديهم.
   ========================================================= */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ROOT = __dirname;
const DEFAULT_INDEX = "index.html";
const SECRET_FILE = "kashfi.config.json";

/* أدوات قراءة المفاتيح: من متغير البيئة أولاً ثم من ملف الإعداد المحلي */
function loadKey(field, envName) {
  if (process.env[envName]) return process.env[envName].trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, SECRET_FILE), "utf8")) || {};
    return (cfg[field] || "").trim();
  } catch (e) { return ""; }
}
const SERPAPI_KEY = loadKey("serpapi_key", "SERPAPI_KEY");
const SCRAPPA_KEY = loadKey("scrappa_key", "SCRAPPA_API_KEY");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function sendJSON(res, status, obj, sMaxAge) {
  const ctrl = sMaxAge ? `public, max-age=300, s-maxage=${sMaxAge}` : "no-store";
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": ctrl });
  res.end(JSON.stringify(obj));
}

function apiGet(url, timeoutMs, extraHeaders) {
  const headers = { "User-Agent": "kashfi/1.0", Accept: "application/json" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.get(u, { timeout: timeoutMs, headers }, (r) => {
        let body = "";
        r.on("data", (c) => { body += c; if (body.length > 3000000) req.destroy(); });
        r.on("end", () => {
          let json = null;
          try { json = JSON.parse(body); } catch (e) { /* تجاهل */ }
          finish({ status: r.statusCode, json, body });
        });
      });
      req.on("error", () => finish({ status: 0, json: null, body: "" }));
      req.setTimeout(timeoutMs, () => { req.destroy(); finish({ status: 0, json: null, body: "" }); });
    } catch (e) {
      finish({ status: 0, json: null, body: "" });
    }
  });
}

const iata3 = (v) => String(v || "").trim().toUpperCase().slice(0, 3);

/* ===== كاش بسيط في الذاكرة (12 ساعة) — يوفّر حصص Google/Scrappa ===== */
const CACHE_TTL_MS = 12 * 3600 * 1000;
const searchCache = new Map();
function cacheGet(key) {
  const e = searchCache.get(key);
  if (e && Date.now() - e.at < CACHE_TTL_MS) return e.body;
  if (e) searchCache.delete(key);
  return null;
}
function cachePut(key, body) {
  if (searchCache.size > 800) searchCache.clear();
  searchCache.set(key, { at: Date.now(), body });
}

/* تطبيع استجابة Scrappa إلى نفس شكل بطاقات Google Flights (best_flights) */
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
    out.best.push({
      flights, layovers: [], total_duration: it.total_duration_minutes,
      price: it.price, type: "One way", airline_logo: "",
    });
  }
  return out.best.length ? out : null;
}

async function callSerp(origin, destination, date, round, retDate) {
  const api = `https://serpapi.com/search?engine=google_flights&departure_id=${origin}&arrival_id=${destination}&outbound_date=${date}${round ? `&return_date=${retDate}` : ""}&type=${round ? 1 : 2}&currency=USD&hl=en&gl=us&api_key=${encodeURIComponent(SERPAPI_KEY)}`;
  const r = await apiGet(api, 45000);
  const j = r.json || {};
  if (r.status === 200 && j.search_metadata && j.search_metadata.status === "Success") {
    return {
      ok: true, source: "google_flights", currency: "USD",
      best: j.best_flights || [], other: j.other_flights || [],
      insights: j.price_insights || null,
      url: (j.search_metadata && j.search_metadata.google_flights_url) || null,
    };
  }
  return null;
}

async function callScrappa(origin, destination, date) {
  if (!SCRAPPA_KEY) return null;
  const api = `https://scrappa.co/api/flights/one-way?origin=${origin}&destination=${destination}&departure_date=${date}`;
  const r = await apiGet(api, 30000, { "X-API-KEY": SCRAPPA_KEY });
  return (r.status === 200 && r.json) ? normalizeScrappa(r.json) : null;
}

/* الواجهة الرئيسية: /api/serp/flights?origin=BGW&destination=BKK&date=2026-12-15[&retDate][&trip=one|round][&force=scrappa]
   السلسلة: Google Flights (SerpApi) → Scrappa (احتياطي) → النتيجة تُخزَّن في الكاش 12 ساعة */
async function handleSerpFlights(url, res) {
  const origin = iata3(url.searchParams.get("origin"));
  const destination = iata3(url.searchParams.get("destination"));
  const date = (url.searchParams.get("date") || "").trim();
  if (origin.length !== 3 || destination.length !== 3 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return sendJSON(res, 400, { ok: false, error: "origin / destination / date (YYYY-MM-DD) مطلوبة" });
  }
  const trip = (url.searchParams.get("trip") || "one").toLowerCase();
  const retDate = (url.searchParams.get("retDate") || "").trim();
  const round = trip === "round" && /^\d{4}-\d{2}-\d{2}$/.test(retDate);
  const force = (url.searchParams.get("force") || "").toLowerCase();
  const ckey = `${origin}|${destination}|${date}|${trip}|${retDate}`;

  const cached = cacheGet(ckey);
  if (cached && force !== "scrappa") {
    cached.cacheHit = true;
    return sendJSON(res, 200, cached, 43200);
  }

  let out = null;
  if (SERPAPI_KEY && force !== "scrappa") out = await callSerp(origin, destination, date, round, retDate);
  if ((!out || !(out.best.length || out.other.length)) && !round) {
    out = await callScrappa(origin, destination, date) || out;
  }
  if (out && (out.best.length || out.other.length)) {
    cachePut(ckey, out);
    return sendJSON(res, 200, out, 43200);
  }
  return sendJSON(res, 502, { ok: false, error: "لا توجد نتائج من Google Flights أو Scrappa لهذا المسار" });
}

/* واجهة تصحيح: /api/scrappa/flights?origin=BGW&destination=BKK&date=2026-12-15 → استجابة Scrappa الخام */
async function handleScrappaRaw(url, res) {
  if (!SCRAPPA_KEY) return sendJSON(res, 503, { ok: false, error: "SCRAPPA_KEY غير مضبوط في الإعدادات" });
  const origin = iata3(url.searchParams.get("origin")) || "BGW";
  const destination = iata3(url.searchParams.get("destination")) || "BKK";
  const date = (url.searchParams.get("date") || "").trim() || new Date().toISOString().slice(0, 10);
  const api = `https://scrappa.co/api/flights/one-way?origin=${origin}&destination=${destination}&departure_date=${date}`;
  const r = await apiGet(api, 30000, { "X-API-KEY": SCRAPPA_KEY });
  return sendJSON(res, 200, { ok: r.json && Array.isArray(r.json.flights), rawStatus: r.status, raw: r.json || r.body });
}

/* ===== رحلات ذهاب وعودة بخطوتين (Scrappa v2 round-trip) =====
   Step 1: بدون توكن  → رحلات الذهاب (لكل عنصر departure_token)
   Step 2: بالتوكن     → رحلات العودة لرحلة الذهاب المختارة (سعر الباقة الكاملة) */
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

async function scrappaRoundTrip(origin, destination, depDate, retDate, depToken) {
  if (!SCRAPPA_KEY) return null;
  const api = `https://scrappa.co/api/flights/v2/round-trip?origin=${origin}&destination=${destination}&departure_date=${depDate}&return_date=${retDate}` + (depToken ? `&departure_token=${encodeURIComponent(depToken)}` : "");
  const r = await apiGet(api, 30000, { "X-API-KEY": SCRAPPA_KEY });
  const j = r.json;
  if (r.status !== 200 || !j || !Array.isArray(j.flights)) return null;
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
  return best.length ? { ok: true, source: "scrappa", currency: "USD", step: depToken ? 2 : 1, best, other: [], insights: null, url: null } : null;
}

async function handleScrappaRound(url, res) {
  const origin = iata3(url.searchParams.get("origin"));
  const destination = iata3(url.searchParams.get("destination"));
  const depDate = (url.searchParams.get("outbound") || "").trim();
  const retDate = (url.searchParams.get("return") || "").trim();
  if (origin.length !== 3 || destination.length !== 3 || !/^\d{4}-\d{2}-\d{2}$/.test(depDate) || !/^\d{4}-\d{2}-\d{2}$/.test(retDate)) {
    return sendJSON(res, 400, { ok: false, error: "origin / destination / outbound / return (YYYY-MM-DD) مطلوبة" });
  }
  const depToken = (url.searchParams.get("departure_token") || "").trim();
  const out = await scrappaRoundTrip(origin, destination, depDate, retDate, depToken || null);
  if (out) return sendJSON(res, 200, out);
  return sendJSON(res, 502, { ok: false, error: "Scrappa round-trip لم يستجب لهذا المسار" });
}

/* ===== ذهاب وعودة بخطوتين — المصدر الأساسي: SerpApi (Google Flights) ===== */
async function serpRound(origin, destination, depDate, retDate, depToken) {
  if (!SERPAPI_KEY) return null;
  const api = `https://serpapi.com/search?engine=google_flights&departure_id=${origin}&arrival_id=${destination}&outbound_date=${depDate}&return_date=${retDate}` + (depToken ? `&departure_token=${encodeURIComponent(depToken)}` : "") + `&type=1&currency=USD&hl=en&gl=us&api_key=${encodeURIComponent(SERPAPI_KEY)}`;
  const r = await apiGet(api, 45000);
  const j = r.json || {};
  if (r.status !== 200 || !j.search_metadata || j.search_metadata.status !== "Success") return null;
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

/* عند فشل SerpApi في الخطوة 2: نعيد الإرساء على Scrappa باختيار نفس رحلة الذهاب (تطابق رقم الرحلة + وقت الإقلاع) */
function normalizeFn(f) { return String(f || "").replace(/\s+/g, "").toUpperCase(); }
async function scrappaReanchor(origin, destination, depDate, retDate, match) {
  const [fnPart, timePart] = String(match || "").split("|");
  if (!fnPart) return null;
  const s1 = await scrappaRoundTrip(origin, destination, depDate, retDate, null);
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
  return await scrappaRoundTrip(origin, destination, depDate, retDate, hit.departure_token);
}

/* الواجهة الموحدة: /api/round?origin&destination&outbound&return[&departure_token][&match]
   Step 1 (بدون توكن): SerpApi type=1 → Scrappa — يُخزَّن في الكاش 12 ساعة
   Step 2 (بالتوكن):  SerpApi departure_token → Scrappa (إعادة إرساء) عند الفشل */
async function handleRound(url, res) {
  const origin = iata3(url.searchParams.get("origin"));
  const destination = iata3(url.searchParams.get("destination"));
  const depDate = (url.searchParams.get("outbound") || "").trim();
  const retDate = (url.searchParams.get("return") || "").trim();
  if (origin.length !== 3 || destination.length !== 3 || !/^\d{4}-\d{2}-\d{2}$/.test(depDate) || !/^\d{4}-\d{2}-\d{2}$/.test(retDate)) {
    return sendJSON(res, 400, { ok: false, error: "origin / destination / outbound / return (YYYY-MM-DD) مطلوبة" });
  }
  const depToken = (url.searchParams.get("departure_token") || "").trim();

  if (!depToken) {
    const ckey = `round1|${origin}|${destination}|${depDate}|${retDate}`;
    const cached = cacheGet(ckey);
    if (cached) { cached.cacheHit = true; return sendJSON(res, 200, cached, 43200); }
    const out = (await serpRound(origin, destination, depDate, retDate, null)) || (await scrappaRoundTrip(origin, destination, depDate, retDate, null));
    if (out && out.best && out.best.length) { cachePut(ckey, out); return sendJSON(res, 200, out, 43200); }
    return sendJSON(res, 502, { ok: false, error: "لا توجد رحلات ذهاب لهذا المسار/التاريخ" });
  }

  let out = await serpRound(origin, destination, depDate, retDate, depToken);
  if (!out || !out.best.length) {
    out = (await scrappaReanchor(origin, destination, depDate, retDate, (url.searchParams.get("match") || "").trim())) || out;
  }
  if (out && out.best && out.best.length) return sendJSON(res, 200, out);
  return sendJSON(res, 502, { ok: false, error: "تعذر جلب رحلات العودة — اختر رحلة ذهاب أخرى" });
}

/* ---------- الخادم ---------- */
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  // واجهات API الداخلية
  if (pathname === "/api/serp/flights") return await handleSerpFlights(url, res);
  if (pathname === "/api/scrappa/flights") return await handleScrappaRaw(url, res);
  if (pathname === "/api/scrappa/round") return await handleScrappaRound(url, res);
  if (pathname === "/api/round") return await handleRound(url, res);

  // ملفات ثابتة مع حماية: ملف المفتاح والمجلدات المخفية غير قابلة للتحميل
  const rel = pathname === "/" ? DEFAULT_INDEX : pathname.slice(1);
  if (!rel || rel === SECRET_FILE || rel.startsWith(".")) {
    return send(res, 403, "text/plain; charset=utf-8", "Forbidden");
  }
  const file = path.normalize(path.join(ROOT, rel));
  if (file !== path.join(ROOT, DEFAULT_INDEX) && !file.startsWith(ROOT + path.sep)) {
    return send(res, 403, "text/plain; charset=utf-8", "Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "text/plain; charset=utf-8", "Not Found");
    const ext = path.extname(file).toLowerCase();
    send(res, 200, MIME[ext] || "application/octet-stream", data);
  });
}).listen(PORT, () => {
  console.log(`✅ كشفي يعمل على: http://localhost:${PORT}`);
  console.log("   الوسطاء: /api/serp/flights | /api/scrappa/flights | /api/round");
});
