/* =========================================================
   أداة بناء بيانات الطيران (تُشغَّل مرة واحدة للتطوير فقط)
   المصدر: OpenFlights (رخصة CC-BY-SA / ODbL)
   المخرجات في المجلد /data كملفات JSON مدمجة يحمّلها الموقع.
   التشغيل: node data/build.mjs
   ========================================================= */
"use strict";

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = (f) => join(__dirname, f);

// تحليل سطر CSV بسيط (مع إزالة علامات الاقتباس)
function parseRow(line) {
  return line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
}

/* ---------- الشركات: iata → الاسم (النشطة فقط) ---------- */
const airlines = {};
for (const raw of readFileSync(DATA("airlines.dat"), "utf8").split(/\r?\n/)) {
  if (!raw.trim()) continue;
  const c = parseRow(raw);
  if (c.length < 8) continue;
  const iata = c[3].trim();
  if (iata.length === 2 && c[7] === "Y" && c[1] !== "\\N") {
    airlines[iata] = c[1];
  }
}

/* ---------- المطارات: iata → [الاسم، المدينة، الدولة، خط عرض، خط طول، فرق التوقيت، ICAO] ---------- */
const airports = {};
for (const raw of readFileSync(DATA("airports.dat"), "utf8").split(/\r?\n/)) {
  if (!raw.trim()) continue;
  const c = parseRow(raw);
  if (c.length < 14) continue;
  const iata = c[4].trim();
  if (iata.length === 3 && c[12] === "airport") {
    const la = parseFloat(c[6]);
    const lo = parseFloat(c[7]);
    if (Number.isNaN(la) || Number.isNaN(lo)) continue;
    const icao = c[5].trim();
    airports[iata] = [c[1], c[2], c[3], la, lo, parseInt(c[9], 10) || 0, icao.length === 4 ? icao : ""];
  }
}

/* ---------- المسارات: "من-إلى" → قائمة الشركات العاملة (مباشر فقط) ---------- */
const routes = {};
let kept = 0;
for (const raw of readFileSync(DATA("routes.dat"), "utf8").split(/\r?\n/)) {
  if (!raw.trim()) continue;
  const c = parseRow(raw);
  if (c.length < 9) continue;
  const carrier = c[0].trim();
  const from = c[2].trim();
  const to = c[4].trim();
  const codeshare = c[6].trim();
  const stops = c[7].trim();
  if (stops !== "0" || codeshare !== "" || !airlines[carrier]) continue;
  if (!airports[from] || !airports[to]) continue;
  const key = `${from}-${to}`;
  (routes[key] ||= new Set()).add(carrier);
  kept++;
}

/* ترتيب ثابت وكتابة الملفات */
const sortSet = (s) => [...s].sort();

const outRoutes = {};
for (const [k, v] of Object.entries(routes)) outRoutes[k] = sortSet(v);

writeFileSync(DATA("airlines.json"), JSON.stringify(airlines));
writeFileSync(DATA("airports.json"), JSON.stringify(airports));
writeFileSync(DATA("routes.json"), JSON.stringify(outRoutes));

const kb = (f) => Math.round(readFileSync(DATA(f)).length / 1024);
console.log("الشركات النشطة:", Object.keys(airlines).length);
console.log("المطارات:", Object.keys(airports).length);
console.log("المسارات المباشرة المحفوظة:", kept, "→ فريدة:", Object.keys(outRoutes).length);
console.log("airlines.json:", kb("airlines.json") + "KB");
console.log("airports.json:", kb("airports.json") + "KB");
console.log("routes.json:", kb("routes.json") + "KB");