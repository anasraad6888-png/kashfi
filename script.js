/* =========================================================
   كشفي — مولّد كشف الحساب الشخصي
   جميع البيانات تُحفظ محلياً في localStorage (بدون أي خادم)
   ========================================================= */

"use strict";

/* ---------- الثوابت ---------- */
const STORAGE_KEY = "kashifi_data_v2";

/* العملة الوحيدة: الدينار العراقي (3 كسور عشرية) */
const FIXED_CURRENCY = "IQD";
const DEC3 = new Set([FIXED_CURRENCY]);

/* ---------- الحالة ---------- */
let state = {
  months: 3,
  minBalance: 3000000,
  endMode: "prev", // "prev": ينتهي آخر الشهر السابق (افتراضي) | "today": حتى تاريخ اليوم
  account: {
    bankName: "",
    accountHolder: "",
    mobileNumber: "",
    accountNumber: "",
    accountType: "حساب جاري",
    currency: "IQD",
    openingBalance: 0,
    dateFrom: "",
    dateTo: "",
    branch: "",
  },
  transactions: [], // { id, date, desc, type:'deposit'|'withdraw', amount, currency, ref }
};

/* ---------- عناصر DOM ---------- */
const $ = (id) => document.getElementById(id);
const accountFields = ["accountHolder"];

/* ---------- أدوات مساعدة ---------- */
function decimalsFor(cur) { return DEC3.has(cur) ? 3 : 2; }

function fmtNum(n, cur) {
  const dec = decimalsFor(cur);
  return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtSigned(t) {
  return `${fmtNum(t.amount, t.currency)}${t.type === "withdraw" ? "-" : "+"}`;
}

function fmtDateSlash(iso) { return iso ? iso.replaceAll("-", "/") : ""; }
/* عدد الأيام بين تاريخين ISO — لكشف وصول اليوم التالي */
function isoDayDiff(a, b) {
  const A = new Date((a || "") + "T00:00:00"), B = new Date((b || "") + "T00:00:00");
  if (isNaN(A.getTime()) || isNaN(B.getTime())) return 0;
  return Math.max(0, Math.round((B - A) / 86400000));
}

function generateAccountNumber() {
  let suffix = "";
  for (let i = 0; i < 7; i++) suffix += Math.floor(Math.random() * 10);
  return "153" + suffix;
}

/* +96478 + 8 أرقام عشوائية = 13 مرتبة */
function generateMobileNumber() {
  let suffix = "";
  for (let i = 0; i < 8; i++) suffix += Math.floor(Math.random() * 10);
  return "+96478" + suffix;
}

function toYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* أشهر فترة الكشف (الأقدم أولاً):
   prev  → آخر N أشهر منتهية بآخر يوم في الشهر السابق (الافتراضي)
   today → آخر N أشهر حتى الشهر الحالي (حركاته حتى اليوم فقط) */
function getPeriodMonths(n) {
  const now = new Date();
  const months = [];
  const lastOffset = state.endMode === "today" ? 0 : 1;
  for (let i = n - 1 + lastOffset; i >= lastOffset; i--) {
    const first = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    months.push({
      label: `${fmtDateSlash(toYmd(first))}-${fmtDateSlash(toYmd(last))}`,
      start: toYmd(first),
      end: toYmd(last),
      isCurrent: i === 0,
    });
  }
  return months;
}

/* نهاية الشهر: في وضع today يُقصّ الشهر الحالي عند اليوم، وغيره كامل منقضٍ */
function monthEndClamped(m) {
  if (state.endMode !== "today" || !m.isCurrent) return m.end;
  const today = toYmd(new Date());
  return today < m.end ? today : m.end;
}

/* فترة الكشف الكاملة: من أول شهر أول حتى اليوم */
function defaultPeriod() {
  const ms = getPeriodMonths(state.months || 3);
  const to = state.endMode === "today"
    ? monthEndClamped(ms[ms.length - 1])
    : ms[ms.length - 1].end;
  return { from: ms[0].start, to };
}

/* قواعد المبالغ (حسب متطلبات الكشف):
   - مبلغ الحركة: بين 500,000 و 3,000,000 IQD
   - الرصيد (الافتتاحي/الختامي) يبقى دائماً داخل النطاق [min, min+3M]
     مثال: min=3M → الأرصدة بين 3M و 6M لجميع الأشهر */
const TX_MIN = 500000;
const TX_MAX = 3000000;
const BALANCE_BAND = 3000000;

/* رصيد افتتاحي عشوائي داخل النطاق [min, min+3M] */
function randomOpeningAbove(min) {
  return Number((min + Math.random() * BALANCE_BAND).toFixed(3));
}
/* ضبط الافتتاحي داخل النطاق عند تغيّر الحد الأدنى */
function ensureOpeningInBand() {
  const min = state.minBalance || 0;
  const v = state.account.openingBalance || 0;
  if (!(v >= min && v <= min + BALANCE_BAND)) {
    state.account.openingBalance = randomOpeningAbove(min);
  }
}
function randomOpening() {
  return randomOpeningAbove(state.minBalance || 3000000);
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- الحفظ (بدون استرجاع: كل رفرش = إعادة تعيين من جديد) ---------- */
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

/* ---------- إعادة التعيين الكامل: مسح الاسم + أرقام وحساب/جوال جديدة + حركات جديدة ----------
   تُستدعى عند بدء الصفحة (بدل استرجاع المحفوظات) وعند ضغط زر إعادة التعيين */
function resetAll(message) {
  state = {
    months: 3,
    minBalance: 3000000,
    endMode: "prev",
    account: {
      bankName: "",
      accountHolder: "", /* الاسم يُمسح — يعيد المستخدم كتابته */
      mobileNumber: generateMobileNumber(),
      accountNumber: generateAccountNumber(),
      accountType: "حساب جاري",
      currency: FIXED_CURRENCY,
      openingBalance: 0,
      dateFrom: "",
      dateTo: "",
      branch: "",
    },
    transactions: [],
  };
  state.account.openingBalance = randomOpeningAbove(state.minBalance);
  const p = defaultPeriod();
  state.account.dateFrom = p.from;
  state.account.dateTo = p.to;
  state.transactions = generateRandomTransactions();
  /* مسح أي بيانات محفوظة سابقاً — البدء دائماً من الصفر */
  localStorage.removeItem(STORAGE_KEY);
  /* مزامنة أزرار الخيارات مع الحالة الافتراضية */
  document.querySelectorAll("#monthsSeg .seg-btn").forEach((b) =>
    b.classList.toggle("active", parseInt(b.dataset.m, 10) === state.months));
  document.querySelectorAll("#minSeg .seg-btn").forEach((b) =>
    b.classList.toggle("active", parseInt(b.dataset.v, 10) === state.minBalance));
  document.querySelectorAll("#endSeg .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.e === state.endMode));
  fillAccountForm();
  renderAll();
  if (message) toast(message);
}

/* ---------- مزامنة بيانات الحساب ---------- */
function fillAccountForm() {
  accountFields.forEach((f) => { $(f).value = state.account[f] ?? ""; });
}

function readAccountForm() {
  accountFields.forEach((f) => {
    state.account[f] = f === "openingBalance" ? parseFloat($(f).value) || 0 : $(f).value;
  });
}

/* ---------- الحركات مرتبة زمنياً + الرصيد التراكمي ---------- */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* رقم عملية: 33 + 8 أرقام عشوائية (10 مراتب مثل الكشوف الفعلية) */
function randomTxRef() {
  let s = "";
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 10);
  return "33" + s;
}

/* تاريخ عشوائي (yyyy-mm-dd) داخل فترة معينة */
function randomDate(from, to) {
  const f = from ? new Date(from) : new Date();
  const t = to ? new Date(to) : new Date();
  if (isNaN(f) || isNaN(t) || t < f) return toYmd(new Date());
  return toYmd(new Date(f.getTime() + Math.random() * (t.getTime() - f.getTime())));
}

/* أسماء ظهرت في الكشوف المستخرجة */
const P2P_NAMES = [
  "MOHAMMED", "AHMED", "ALI", "HASAN HADI", "SADDAM HAMEED", "SADEEM BASIM",
  "OMAR AMMAR FARIS", "NOORULDEEN ALI", "AHMED RAAD", "HIBA ZUHAIR",
  "HAMZAH IMAD", "SHAHAD MAHER", "BAQIR HAYTHAM", "RANYA ADEL", "ABBAS ALI",
  "DINA QAHTAN", "WAAD BADRI", "KHALIDA ILYAS", "ILYAS KHALIL",
  "MUHAMMAD YUNUS SULAIMAN", "ABDULAZEEZ YASEEN", "AHMED ABDULWAHHAB",
  "SAMIR HUSSEIN", "ALI ELIAS ABBAS", "MOYID HAIDER", "DHIYA AL DIN",
  "MUHAMMAD QASIM", "ALI HAYTHAM MUHAMMAD", "ABDULQADER KHAMEES",
  "ASHRAF KIFAH", "MAYTHAM ALRUKABI KADHIM", "MOHAMMED HASAN", "LAYDH SALIM",
];

/* رسوم متكررة (الأكثر شيوعاً في الكشوف) */
const FEES = [
  "01003211",
  "Card to Card Transfer MobApp Fee",
  "MobApp Fee Card to Card Transfer",
  "Cash withdrawal (cash out agent) fee",
];
const FEE_AMOUNTS = [1000, 3860];

/* حوالات بطاقة: "150000 IQD to 5213 ******** 6122" */
const CARD_BINS = ["5213", "4177", "6330", "5557", "6104"];
const CARD_AMOUNTS = [1000, 15000, 35000, 50000, 75000, 150000, 175000, 200000, 296000, 500000, 1000000, 2000000];

function cardMask() {
  const last = String(1000 + Math.floor(Math.random() * 9000));
  const style = Math.floor(Math.random() * 3);
  if (style === 0) return `******** ${last}`;
  if (style === 1) return `********${last}`;
  return `**** ****${last}`;
}

/* حوالات بين أشخاص — مبالغ واقعية من الكشوف */
const P2P_AMOUNTS = [25000, 50000, 75000, 100000, 120000, 150000, 250000, 500000, 1000000];

/* تجار محليون (بأسلوب الكشوف الفعلية) */
const LOCAL_MERCHANTS = [
  "vape bar, Baghdad, IRQ",
  "Princess Shawarma, Baghdad, IRQ",
  "The Grinders 18 Cafe, Baghdad, IRQ",
  "Sois Belle Nail Spa and S, Baghdad, IRQ",
  "DR ALI HAROUNS CLINIC, Baghdad, IRQ",
  "Al Obaidi Roses Salon, Baghdad, IRQ",
  "LUXURY BEAUTY, Baghdad, IRQ",
  "VIP Cloud Alqadisiya, Baghdad, IRQ",
  "DONUT MOOD ALMNSUR, Baghdad, IRQ",
  "alsalim zain, Baghdad, IRQ",
  "Ali alhatim, Baghdad, IRQ",
  "OMAR ALRAWI, Baghdad, IRQ",
  "Taj Althaqafa, Nineveh, IRQ",
  "Aswar Almosul, Nineveh, IRQ",
  "ahbar alzahara, Thi Qar, IQ",
  "ALGZAR MASTER, Thi Qar, IQ",
  "ayeen al mosul, Nineveh, IQ",
];
const SLASH_MERCHANTS = [
  "ROODI SALON/BAGHDAD/ YARMUK",
  "VANILLA COSMETICS/ BAGHDAD/ MANSOUR",
  "VANILLA 12/BAGHDAD/ MANSOUR",
  "MODEX ALMASBAH/ BAGHDAD/KARRADA",
  "JEDAR CENTER/BAGHDAD/ ZAYOUNA",
  "USTA QAS/BAGHDAD/ YARMUK-K",
  "ESPRESSO LAB/BAGHDAD/ MANSOUR",
  "ALI BEAUTY SHOP/ BAGHDAD/ MANSOUR",
  "ZEINAT ALZUHOUR ZARA/ BAGHDAD/ KARRADA",
  "LC WAIKIKI MALL ALIRAQ/ BAGHDAD",
  "ZUHUR ALZAYTOON CO/ BAGHDAD/ JADRIYA",
  "CHILI HOUSE 4/BAGHDAD/ YARMUK",
  "GREEN APPLE 2//HARTHIYA/BAGHDAD",
  "talabat pro BGH/BAGHDAD/ KARRADA",
  "QIMAT ALTHAWQ COMPANY/ BAGHDAD",
  "LA SHAHEERA/BAGHDAD/ JADRIYA",
  "Family Mall/TBI>IRAQ",
  "NAJAF Mall/TBI>IRAQ",
];
const MERCHANT_AMOUNTS = [1000, 2500, 5000, 7500, 15000, 20500, 25000, 29000, 50000, 75000, 100000];

/* خدمات وجمعيات وجهات رسمية */
const SERVICES = [
  "Ministry_of_Oil_OPDC_Fuel",
  "Vehicle Registration and Licensing",
  "Mosul Post Office/Nineveh",
  "Ahl Al Khair Exchange Com, Baghdad, IRQ",
];
const SERVICE_AMOUNTS = [3860, 10000, 15000, 25000, 50000, 100000];

/* اسم الطرف الآخر (يختلف عن اسم صاحب الحساب) */
function otherName() {
  const holder = (state.account.accountHolder || "").trim().toUpperCase();
  const pool = holder ? P2P_NAMES.filter((n) => n !== holder) : P2P_NAMES;
  return pick(pool.length ? pool : P2P_NAMES);
}

/* اسم بديل ثابت (حسب النص) لتجنب تطابق الأسماء */
function deterministicName(seedStr, exclude) {
  const pool = P2P_NAMES.filter((n) => n !== exclude);
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  return pool[h % (pool.length || 1)];
}

/* تخصيص الوصف: استبدال @@HOLDER@@ باسم صاحب الحساب الذي كتبه المستخدم */
function personalizeDesc(desc) {
  const holder = (state.account.accountHolder || "").trim().toUpperCase();
  let d = desc;
  if (d.includes("@@HOLDER@@")) {
    if (!holder) {
      /* بدون اسم بعد: صيغ عامة مقروءة */
      if (d.startsWith("@@HOLDER@@")) {
        return d.replace("@@HOLDER@@ send money to ", "Send money to ");
      }
      return "Receive money from " + d.replace(" send money to @@HOLDER@@", "");
    }
    d = d.replaceAll("@@HOLDER@@", holder);
  }
  /* تفادي تطابق الطرفين (مثال: كتب المستخدم اسماً موجوداً في القائمة) */
  const m1 = d.match(/^Receive money from (.+)$/);
  if (m1 && m1[1] === holder) d = `Receive money from ${deterministicName(d, holder)}`;
  const m2 = d.match(/^(.+?) send money to (.+)$/);
  if (m2 && m2[1] === m2[2]) d = `${deterministicName(d, holder)} send money to ${m2[2]}`;
  return d;
}

/* بناء حركة: المبلغ يُمرَّر محسوباً مسبقاً (500K-3M داخل نطاق الرصيد)، ونختار الوصف حسب الفئة */
function buildTransaction(type, amount) {
  if (type === "deposit") {
    /* إيداع: حوالة واردة من شخص (النمط الغالب) أو شحن بطاقة */
    const r = Math.random();
    if (r < 0.55) {
      return { type, amount, desc: `Receive money from ${otherName()}` };
    }
    if (r < 0.80) {
      return { type, amount, desc: `${otherName()} send money to @@HOLDER@@` };
    }
    return { type, amount, desc: `${amount} IQD to ${pick(CARD_BINS)} ${cardMask()}` };
  }

  /* سحب: فئة الوصف فقط — المبلغ محسوب مسبقاً ولا يُتجاوز به النطاق */
  const rr = Math.random();
  const category = rr < 0.15 ? "fee" : rr < 0.38 ? "card" : rr < 0.60 ? "p2p" : rr < 0.88 ? "merchant" : "service";
  if (category === "fee") {
    return { type, amount, desc: pick(FEES) };
  } else if (category === "card") {
    /* الوصف يعرض المبلغ الفعلي للحركة دائماً — أي رقم آخر في موضع المبلغ = تناقض */
    return { type, amount, desc: `${amount} IQD to ${pick(CARD_BINS)} ${cardMask()}` };
  } else if (category === "p2p") {
    /* المرسل هو صاحب الحساب (يُستبدل باسمه أثناء العرض) */
    return { type, amount, desc: `@@HOLDER@@ send money to ${otherName()}` };
  } else if (category === "merchant") {
    return { type, amount, desc: Math.random() < 0.5 ? pick(LOCAL_MERCHANTS) : pick(SLASH_MERCHANTS) };
  }
  return { type, amount, desc: pick(SERVICES) };
}

function generateRandomTransactions() {
  /* الافتتاحي داخل النطاق [min, min+3M] */
  ensureOpeningInBand();
  const min = state.minBalance || 0;
  let running = state.account.openingBalance;
  const txs = [];
  getPeriodMonths(state.months).forEach((m) => {
    const n = 14 + Math.floor(Math.random() * 7); // 14 إلى 20 حركة شهرياً — بحد أقصى صفحتان (10+10)
    /* تواريخ عشوائية مرتبة زمنياً حتى يتطابق الترتيب مع تتبع الرصيد */
    const dates = Array.from({ length: n }, () => randomDate(m.start, monthEndClamped(m))).sort();
    dates.forEach((date) => {
      /* مساحتا الحركة داخل النطاق: إيداع حتى min+3M وسحب حتى min */
      const roomUp = min + BALANCE_BAND - running;
      const roomDown = running - min;
      const canDep = roomUp >= TX_MIN;
      const canWdr = roomDown >= TX_MIN;
      /* الاتجاه مرجّح بمساحة الرصيد المتبقية (طبيعي ولا يخرج عن النطاق أبداً) */
      let isDeposit = canDep && (!canWdr || Math.random() < roomUp / (roomUp + roomDown));
      if (!canDep && !canWdr) isDeposit = true; /* لا يحدث عملياً: النطاق 3M أكبر من ضعف أدنى مبلغ */
      const cap = Math.min(TX_MAX, isDeposit ? roomUp : roomDown);
      /* مبلغ عشوائي 500K-3M مقرَّباً للألف وغير متجاوز للمساحة المتاحة */
      const amount = Math.max(TX_MIN, Math.min(cap, Math.round((TX_MIN + Math.random() * (cap - TX_MIN)) / 1000) * 1000));
      const t = buildTransaction(isDeposit ? "deposit" : "withdraw", amount);
      txs.push({
        id: uid(),
        date,
        desc: t.desc,
        type: t.type,
        amount: t.amount,
        currency: FIXED_CURRENCY,
        ref: randomTxRef(),
      });
      running += t.type === "deposit" ? t.amount : -t.amount;
    });
  });
  return txs;
}

/* ---------- ورقة الكشف: كل شهر يُقسَّم لعدة صفحات A4 حسب عدد الحركات ----------
   كل صفحة تكرر: شريط الاسم + حقول المعلومات + رأس جدول الحركات (كما في الكشوف الممتدة)،
   وآخر صفحة من الشهر تضيف الإجماليات والتذييل الأصفر والتنويه */
const ROWS_PER_PAGE = 10; /* عدد الحركات لكل صفحة — الشهر لا يتجاوز صفحتين */

function monthSectionHTML(m, txs, opening, closing, totalCredit, totalDebit, a) {
  const chunks = [];
  for (let i = 0; i < txs.length; i += ROWS_PER_PAGE) chunks.push(txs.slice(i, i + ROWS_PER_PAGE));
  if (!chunks.length) chunks.push([]);
  return chunks
    .map((chunk, ci) =>
      monthFullPageHTML(m, chunk, opening, closing, totalCredit, totalDebit, a, ci === 0, ci === chunks.length - 1)
    )
    .join("");
}

function monthFullPageHTML(m, txs, opening, closing, totalCredit, totalDebit, a, isFirst, isLast) {
  const rowsHTML = txs.length
    ? txs.map((t) => {
        const signed = fmtSigned(t);
        const debit = t.type === "withdraw" ? signed : "0";
        const credit = t.type === "deposit" ? signed : "0";
        return `
        <tr>
          <td>${escapeHtml(t.date || "")}</td>
          <td>${escapeHtml(t.ref || "")}</td>
          <td>${escapeHtml(personalizeDesc(t.desc))}</td>
          <td class="num">${debit}</td>
          <td class="num">${credit}</td>
          <td>${escapeHtml(t.currency || a.currency)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" style="text-align:center;color:#888;padding:22px;">No transactions recorded</td></tr>`;

  return `
  <div class="sp-month${isFirst ? " first-of-month" : ""}">
    <div class="sp-band">Customer Name: <strong>${escapeHtml(a.accountHolder || "—")}</strong></div>
    <div class="sp-fields">
      <div class="sp-frow"><div class="sp-label">Mobile Number</div><div class="sp-value">${escapeHtml(a.mobileNumber || "—")}</div></div>
      <div class="sp-frow alt"><div class="sp-label">Account Number</div><div class="sp-value">${escapeHtml(a.accountNumber || "—")}</div></div>
      <div class="sp-frow"><div class="sp-label">Statement Period</div><div class="sp-value">${m.label}</div></div>
      <div class="sp-frow alt"><div class="sp-label">Opening Balance</div><div class="sp-value">${fmtNum(opening, a.currency)} ${escapeHtml(a.currency)}</div></div>
    </div>
    <table class="sp-table">
      <thead>
        <tr>
          <th class="c-date">Date</th>
          <th class="c-no">Transaction No.</th>
          <th class="c-desc">Transaction Description</th>
          <th class="c-debit">Debit Amount</th>
          <th class="c-credit">Credit Amount</th>
          <th class="c-cur">Currency</th>
        </tr>
      </thead>
      <tbody>${rowsHTML}</tbody>
    </table>
    ${isLast ? `
    <div class="sp-totals">
      <div class="sp-trow"><div class="sp-tlabel">Closing Balance</div><div class="sp-tval">${fmtNum(closing, a.currency)}</div></div>
      <div class="sp-trow alt"><div class="sp-tlabel">Total Credit</div><div class="sp-tval">+${fmtNum(totalCredit, a.currency)} ${escapeHtml(a.currency)}</div></div>
      <div class="sp-trow"><div class="sp-tlabel">Total Debit</div><div class="sp-tval">-${fmtNum(totalDebit, a.currency)} ${escapeHtml(a.currency)}</div></div>
    </div>
    <div class="sp-bank">
      <div class="sp-bank-col">
        <div class="sp-bank-num">422</div>
        <div>Website: qi.iq</div>
        <div>Email: qicard@qi.iq</div>
      </div>
      <div class="sp-bank-col">
        <div>Qi - International Smart Card Company</div>
        <div>Baghdad, Iraq - Karrada - Qtr 901 - St 9 - H 8</div>
        <div>PO Box 2244</div>
      </div>
      <div class="sp-bank-logo"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAYAAADNkKWqAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAABQKADAAQAAAABAAABQAAAAABiXyf0AAA7uElEQVR4Ae2dB5hV1bn+zxHF3isKERTUWKNgFCuYRIMRjdHhatTEFo0NTfvH3JvEweQaE02ioOZKLERjyaC59q6MDaIOdjBeUEZB7Ar2fv6/9zADZ2bOObPP7nvt73ued2aXtdf6vnet/Z3Vd7FgYgwEZKBUKhQL0wrLFYaXViCqFYH+rwxW6jjW+aod0LXlgcJVynucfAj0f2EHdP5+xzVd1/H7hdbiB8WRhY84NjEGAjFQDPS0PZwLBkpTBi5XGDFnDYxdF/QDA8D6oD9YB6wNVgOrADm7ZUFfsBQIQ74gkk+AnN4H4B2wALwOXgUvdWAe/+eD12bfOuStIXvP/phjE2OgJgPmAGtSk78bpVJJtTM5to3ApmCzjmM5PDk61eKWBmmWT1FONUg5xrngOfBsB57n/8vFYlE1SRNjgKaLSS4ZwNmptjYIbAm2BVuBwWA9oFqciyLH9zKYBZ4Cj4EZoB2n+C7/TXLGgDnAnGQ4Dk/NVTm7HcD2YAuwAVgG5FnUtFbTWY7wYfAQeBqHKEdp4jgD5gAdzWAcnvrqVLPbDewENgdrApPeGVDfohziVHAfeAyH+Br/TRxjwBygIxk6d2r/5fsPn6sa3kiwB5DzU7+dSXAGXiGKR8Fd4F4GWGbYAEtwUtMQgznANOSCTx2o5a3Oo8PBKCCnp4GLPsAkOgY0yPIMuBvcCh6mdriQ/yYZZMAcYMYyDae3FirvCvYDqu19CZgkx4BGlu8B14MHcYZvJ6eKpdwoA+YAG2UsgfA4PU0q3gU0gW8ADWiYpI+BdlS6HVxTmL7B1OKw+ZqzaJJiBswBpjRzyqsrCqVhqCenp9reJilV1dSqzsBMLl8HrikWC48XCsVS9WB2NUkGzAEmyX6VtDtGb0dz6xCg/r28T1OpwlKmLn2Mtg+Av4ObaCK/kSntHVfWHGBKMhjHp/l53wP7g34pUcvUCJcBrUz5J7gMR6hRZZOEGTAHmGAG4PS0IcC3wNFgBLDaHiTkQFQr1CjyX9tbB902aGS7beyQUKabA0yAeBzfuiT7XXAU0IoMk/wyoOV4F4EWax7HXwjMAcbIOY5vEMmptqemro3kxsh9BpKag46TwKU4QjWVTWJgwBxgDCTj+DSCezw4FNhytBg4z3AS2sVmEpiII9QcQ5MIGTAHGCG5HY7vJJKQ49N+eSbGgFcG3iTgJHAejrCd/yYRMGAOMAJScXwDiXYsOBxouZqJMeCXAW3McDGQI3zJbyT2XHUGzAFW58XXVRyfNh9QU/c4YBsR+GLRHqrBgJzfBKCmsS23q0FSo5eXavQBC9+TgdLUwvI4Pzm+f4HTgDm/njTZlWAMaO/GM8E0ytqRpRlb9A0WnT0tBqwGGLAcUBj3IYpfg+0DRmWPGwONMHA/gX9DbfDORh6ysF0ZMAfYlQ/PZzg+7b2n2t6Bnh+ygMZAuAx8TnRXATnC/ws36nzEZg6wwXzG8a3KIz8CpwAdmxgDSTOg9cVnAw2UvJ+0MllK3xxgA7mF89MmBb8FWzfwmAU1BuJi4BES+i9rFnun2xygB65wfAMIdjrQCg4bOPLAmQVJjIHPSPmv4HQcobbyN6nDgDnAOuToFs7vMP6p1vclnZsYAxlhYDZ6/gIneE1G9E1ETXOANWjH8W3ILU07OKhGELtsDGSBgUtRUs1i+8xnldwyB1iFFJzfwVz+PVDT18QYyDoDqg3+DCeoHapNKhiw/qwKMnB8a4OLuHQlMOdXwY0dZpqBwWh/LWV7PLA16RVZaTXADjIoGCM51FIj25+vooDYoXMMTMeiE6kNatVS7iX3NcDSlMLSOL9fUBJuBub8cv9KOE/AUCy8gzI/FuS+ApRrAigAauaq1ref88XeDDQGejKgVSQ/ojaoPQhzKbl1gDi/PcjxC4H6R0yMgbwyMAPDf4ATnJZHAnLZBMb5nUxm3wjM+eWx1JvNlQyo2+c23okfVF7My3GuHCCZvArQLPlzwAp5yWSz0xjohYFVuD+Rd+PcuVP7L99LWKdu56YJTOZuTM5pUuiuTuWgGWMMhMvA7UR3NE3ieeFGm87YcuEAcX67Qf8kMCid2WBaGQOpYuAZtPk+TlCbKzgtzjeBcX6HkoPq7zPn53RRNuNCZODLxHUL787+IcaZyqicdoBk4KmwPgmoj8PEGDAGvDOwFkGv4h3iq4buzhd00gGW2grLkHHjycDfgT7e89xCGgPGQAUDy3LM8rnCGaVSs5O+wrk+QByfansa6R1TkZF2aAwYA8EYuGTetAEnDthp3ofBoknX0045QJyfvsb2d/CNdNFs2hgDTjCg3WQOZ3BkoRPWYIQzDhDnp2VtLWBHVzLH7DAGUsjAPeh0ME7wtRTq1rBKTjhAnJ9WdGjn220aZsAeMAaMgUYZ0E4yTS7MFcy8A8T5bUZm/C/QfxNjwBiIh4HHSOYAnOCceJKLJpVMO0Cc3+bQon6JIdHQY7EaA8ZAHQae4t7+OMHn6oRJ9a3MOkCcnxZx3wA2SjXDppwx4DYD2k1mv6w6wUw6QJyfZqpfD6zm5/bLZdZlg4GnUXM0TrA9G+ou0TJzDhDnpwEPLW2zPr8l+WhHxkDSDKhPcF+cYKY2UciUA8T5aarLTWDrpHPb0jcGjIEeDGh0WM3hzEyRyczyFpzf2pA7GZjz61Hu7IIxkAoGNAdX64dXTYU2HpTIhAOE0JWx5QqwgwebLIgxYAwkx8AeJD0pKxurpt4BlmYU+kKovtVry9uSK9SWsjHQCAPf7j987nktLU2p34gk7X2ARWp/2tXlxEbYt7DGgDGQCgbOoD/wv1KhSQ0lUu0AcX76Xu8ZNXS3y+lk4D3Uehe8DbRo/i3wDtA13dNuIh+BzzrAv8LSYBmg7ZdWAOryWAmoL2l1sFoHtNOP7ptkhwF9hP38tKqbWgeI8zsE0iYBvRwm6WLgfdR5GWgZ1PNgdsfxfP5rBHDB7NkT3hsy5KRP2W/jC879S3NpqTnfP6LvwIGXyiHKGWrHnw3AIKApUfrWy0CwHsjVB32wNwvyMUqOwQlq0ULqJJUOEOenDxfdDFQTMEmWAdXY5Oi07ElzvZ4Es8DLxaJqcwEdHBEFk9JSbNi5InGsDzYB24BtwZZgQ6BapUmyDLxB8nvhBB9NVo2eqafOAeL8NkLNu8HAnuralRgY+IA0/g00p+sB8Fh76xHtg0Zeyi95scR5JmR+2+gV+g29YRDKDgO7AM0gkIM0hwgJCcgzpPl1nKBaCamRVDlAnJ9qfLcAFViT+BiYR1JTwR3gwYnTJz537LBjab66I7NmjVp28OBb5ADVutgTaM7ausAkPgZua28fuf+gQa3qA06FpMYB0oxBl9JFsHJkKphxXwn13d0J1NUwjebsm1mq4QXLnhKzC8p9ifqhHQ00d02rjEyiZ+AcytqP01LWUuQASyfD/TnR85/rFF7B+tvANeABmiMapc290PJYExJGgCbwdaBzk2gYUDfKUZS9S6OJvrFYU+EAKYAjUVtrfG2KQ2P55yW0mrLqy9NKmpv59X01Lb++XpSPN0y5ZtifNPcF3wVqJi8FTMJlQD+838AJJv7h9cQdIM5vA8i4D2wULse5j021PdX0LsfpteH0gk1HyRmdLS0tfZqamnbG7O+Db4M1ckZB1OY+TQIjcYIaIc6nlKYUlsYBXg9MwmNgJlH9BOiHxSQEBuByEPg1eB6YhMfAFc3NyX5vONEaIDzaSo8QXtCOKKjlFc4H1/KrqlUXJiEzQHlV3+BB4Idgy5Cjz2t0J1BeL0jK+MQcIIVpd4y+Fdjs/WC5L8f3Z1ZeXDtkyFjNujeJmAHK7kokcTAYC8wRBuP7HR7fAyc4PVg0/p5OxAF2/JLej8ra2t7EHwNP8djZra3jWkaObE7NvCp/pmTzqQ5H+D20/xEYnE0rUqG1fsTlBGNvuSTlAC/G4CNTQX32lJiLyn8CFydRYLJHV/Qad/ygH0dKJwGtVTZpnIE/U56ZHxivxO4AKSzqQ7kSxJ52vNSGnpqWqE0EZ1FQ5oceu0UYmAHKtjZmUL+2aoXa3cbEOwOfEVTb6WslWGwSqxOigHwJy6YCG6FsLItvJ/ivKByJz5tqTO08hi7PJRyB5b8BmkZj4p2B2QTdmXKuHYVikdgmeS5a6lY4C6vM+XnPWq3RPWby5MK3zPl5Jy3ZkMUSeTWlvXWkVpT8BLDE0MQjA+pH/a3HsKEEi60GSO3vUDS+PBSt8xGJugn+k5fphXyY66aVlPvNsexMoDXHJr0z8DlBvkO5v6H3oMFDxFIDpBCo1ve74OrmIgbV+g5l9QYw55f1HCcPZxYK47SS5ARgtcHeM7QPQc7GZ6zVe9DgIWKpAWLMJFTVkiKT+gxcx+0f89LMqR/M7maRAd4DzRk8F+yRRf1j1nkC74HmWUYqkdcAyfS9sUDNX5PaDLzPrZ+OmVw40JxfbZKyfoe8fZq+wW9hh/q5Ps26PRHrfwy+Y7eI04h2KgoGrIIBGvXdImpDMhw/TaTCD3k57s+wDaZ6gwzwbuzDI+eBDRt8NE/BH5o3baeRA3aa9mFURkddA9QMeXN+tXPvWm59zZxfbYJcvUOea/s3NYXvdNXGEOzaof/wqVp3HZlE5gD5hdPoV+wzuyNjKtyINdJ1OsvYDuJF0LZVJjlkgLx/nhrOfpg+PofmezX5VHxJZLXkSAZBOra3vwYLv+PVyhyFW4Ct7IBRuMo2Js1Rrtc1tTx5+niCnAVsc5CeXF3K+3JUFO9LRA6wpI5ezeOJrIbZk6NMXNHo7mH88j+YCW1NyVgZoKajAcNLgH2sqSvzn3CqL8qF3k8euoMqTS3/gp2OwqHH3ZWTzJ09gsb6Nqo5v8xlXTwKUza0DlZO8Nl4UsxMKn3R9DdtbUNDX18deg2QXzHtinFBZqiNR9E7SEY1v9fiSc5SyTIDvEOD0P9q8NUs2xGB7ofwDmmFVGgSqgMk4zR7W3t7RdZpGZrl8UWkvlB9Beud+JK0lLLOAO/SOtigl/1rWbclRP1nEteOvEuh7RsYdjP1BBQ057ckxy9rbz9CNT9zfks4sSMPDFBm1Fo4EGi6jMkiBjbnH4Mh4UloNUB+sbTV1XSgWqAJG5ZOnjn5+DFbjFEHrokx4IsB3quVefBvYH9fEbj30FxMGsoPxOthmBZmDfAUFDLntyhXLp44feJx5vzCKKL5jqPc3Jte1FJSrRM3KRQGQMLxYRERSg2QX6mNUUh9f6uFpViG47mMmt8PzPllOAdTqDrv2EqopYERTTHLu7wKAdvx4zA/KBFh1QC15M2cHx8ip8/vWHN+QYulPd+dAV7297immuA93e/l8FzzJEOpBQauAfLLpF1cVftbNYcZUWmy1nQeUG6yVF61Y2MgRAZ43/Tya2BkWIjRZjEqDRKpFvhSEOXDqAGeiAJ5d34a/NEGpqENzwfJVHvWXQYoY2r+/QeY7a6VnizTNKFjPIWsEyhQDZBfI015eQysXicN12+1Y+CeFMxZrhtq9qWHAd69oWhzK1g7PVrFron6ALfl3VNt0JcErQHKA+fZ+S3Afs1ON+fnq/jZQ34ZoMyp1aE5cR/5jcOB59bHhu8HscO3A+QXSFXQw4MknvFntaXV8RTEqRm3w9TPKAOUvRtR/f9lVP2w1NbO0dp42Zf4doCkdgiQB86r/Ddb9GhagokxkBgDlMHzSPwviSmQfMIahD3Arxq+HCAed0US/IHfRB147p9sZvqbKPYnc4AbMyFWBoolkvsZuDfWZNOV2A9nzGjq60clX4MgOMAmEmvxk6ADz/wbG0bQ/NBonIkxkAoGeCe1GOE+kMdWmX4ERvFO3t5oZjRcA2S3Zz1zbKMJORJeX2872pyfI7npkBmUyecwR1vRfeaQWV5NUUUOn1RquELXsAMkEU3AjPxzdV4tjzncrylotqFpzKRbct4YoGxqF/Y/egvtXKi9qJxt1qhVPhxgeeQ39J1ZG1U8gfA3jGsdNz6BdC1JY8A7A9M3OJ3AeZyZsAJ2f887UYtCNlRlpJ9By3CeAPqfJ5mPsTvxC/tCnow2W7PJAO/p1mh+H8jbCq052KyJ0Qu95lyjNcD9iDhvzk8drD815+e1SFm4pBmgrD6JDs1J65FA+oNI85uNpOvZAZZaCn2I+LBGInck7NXMtfqHI7aYGXlhYPqw8zH17ryYW2EnzWDvgyGem8BUq7X2cBrIU/+fmr76BsHcCoLt0BjIBAO8s1uh6P0gT01hzdTQjtGevqznuQZIpAeBPDk/zC1o1Necn5gwyRwDlN2nUPoPmVM8mMJapHGg1yg8OUB+SbQb7be9RupIuLtaC+P+5ogtZkZ+GTgX07VjU57kwJLHlSGemsA4wFGwd0uOGPwAW3fjF1Q7bpgYA5lmgPd3Lwy4GagfPw+ijUp25/3tdc6upxogkTXlgbUKGyea86tgww4zzQBlWUvEJmfaiMaUl6P3tEFCrzVAfj3WIDINq2/QmA6ZDf0Smg+j0LySWQtMcWOgGwO8x5ty6SGQlwGR/8NWbZmvQZGa4qUGuDtP58X5iaizzPnVLC92I6MMUKY1KpqnbbOGYO8OvWWXFweoyc95kZkYenFejDU7c8fAOVisFk4eRK3bXn1XXQdItVmfuvxaHtjqsPFMfinfy5G9ZmqOGKBsv4q5coJ5kb3mzm1avp6xdR0gDw4H/etF4NC9R9nkNE8dxQ5lnZnSAANq4TzfQPgsBx3Sv3/LdvUM6M0B7l3vYcfunT1yZHOePzDjWHaaOdUYoBb4NtcnVLvn4DX5t7prg2s6wNKcgcvxcF6av4/Nnj3hnw4WADPJGKjGwCQuaueUPMieU6aMWLqWoTWnwdD/p41Ptfa35sO1Is3g9cP5ZfxbBvU2lY0BXwzwfutrcr/39XC2HvoQdTUdRp+y6CE1a4CE3APkwflpesC1PZixC8aA2wxchnl5mOuqQZCaO9jXc4B5af7+lV8HG/l1+2U367oxQJmX8/t7t8uunn69lmFVHSDVY216Wnf0pFaEGbv+GvpekTGdTV1jICwGNCJcd6VEWAklHM+O+LSqK2CqOkCU1d5/ayWsdBzJT2azU82NMjEGcsdAR7/YbTkwXCvZtDdiD6nlAGu2mXvEkN0Ln6D6pfZx8+xmoGkeCgOqBeqzDy6L/Nwu1Qzs4QCbm8vf/d25WmDHrj04Ln/7pDmWhWZOYAZaB00hjhmB40l/BLtW2yq/xzQY2sqqLmr3lzXSb1MgDY+kCUAN0MQYyDcDvPP/CQP/7TgLWgO9Fe+8JoIvlh41QO6orey681O/X542eF2c4XZgDFRh4BquuT4Y0g8bv9zd9moOsNctZLpHksHz2xj80AiwiTGQewaoFWnvvPscJ0K+bvvuNlZzgF/tHsjB8xYb/HAwV82kIAzkYSOQHpW7Lg6QvoBVYHCLICxm4Nl2dHwgA3qaisZAnAzcQWJvxZlgAmltPWvWqGUr0+3iALkxCKxfGcDB49up8r/joF1mkjHgmwHeCQ0S3O87gmw8OHDw4Fu6bO/X3QFuiR3LZMMW31re6PtJezA0Bkqlpj4zZmzRV2hpaeoTWsQWURAGbgjycAaeXREduwyELN1N6W27nbt2Oh+DtMONSUwM0K2iGQX6II+6VjYDG4K1wcqbb15Qc6TE/49LpYJq5a+DOUA7dzwNZlEzWch/k3gYuIdk3gUrx5NcIqlsQ6o3dabc3QFWXS7SGdiB/w8y+ttlHpADNqXOBJyeulK+AUaBYUBzS3vMOeVaPfmcm3OJ6yH+a8rS3R3NtHrP2L1gDLzA49PBiGDRpPppOcDFsrgJTEFbiauDF99x8+B2G/2NJmNLLYU+lKE9wT9IQS/RheDbQH0ujTo/Hil/xHsg//8D/A08StyXAmb0m0TBAD8wJeK9K4q4UxTnpm1tFy7u5ltcMClYm6Dk42D5FCkbpiofEtm2ZLL2/zMJkQHKzmii+wnYPcRoa0WlmqFGLM8mL9VkMwmRAfJSy2DvA4srRyFGn4ao1ALUihAN+nQxciPOXXV+svXfE6dPfF4HJuEwwMuyDVDHuRCH85PiGjAZBe4g7b+DIbpoEhoDTxHT3NBiS19E+tLlhp1qVXp5dVS7LFOPHXbspy4bGJdtpSmFpXE8PyO9e4Fqf0mIHOEh4H50OabaQvcklMp6mtSMNBjVlnU76uivVq9au2WpdIAaoXNZHnTZuLhsw9n0L4wo6QNSfwCrxpVunXTW5d6FjCJfhm5r1Alnt7wz4Pq70t0BluQVN/bOT+ZCqv/v0cxpnTKFcTBDUUn9b0nV+uoxcig3b0PHxYW7XmC7V5eBh7j7Rd0Q2b5Jt0nZ5y3qAyzNGtIXe7rMkM62fT20nzN79tj2HlftgmcGcCwjCXwz+LLnh+IPqMXut6LrdvEn7VSKGih81SmLuhqzIS0GVfo6BkEGz1qTYzUlXJWnhgwZ/4mrxkVtV4fzm0w6WSgjGsy7Dp1dn9QfYbYXtSbY5dkS/bBvFRHY2Qe4TucFXXRQaP6W5zg5aFq0JnXUpq4iFf1IZkUGoOg16O5yt05kecFiAc0H1JQ4V2V1DCt/86jTAWqmfvdVIS4Z/6RLxsRlCw5EG2NcCbJQ8+tOi2qCV2CDpj2YNM6Ayw5wBehQLXBxDVAO0FV5H8NmuWpcVHaV2sqbYlxI/FmeHrUD+v+xs8M7Kq4cjfcZ7HJ1IET9f2Wf11kDdHkA5GWM1UegTRphYGjpZILv08gjKQ17JB3eGiE2aYyBFwmuvkBXRa2bXNQA59Cn8aGruRiFXTQbtS3ar6KIO6E4z8Qm9QuaeGZg5BsEnec5ePYCdqkBahDEVXmOARBXq/Kh51mpufyjeAYRl0fJQk8gmQj1a39aMklnM9VisfUzNG/PpvaetF5PoZZqXlTgyyMinh7LXiAcoIlnBk4rfZOwLjR9u5t8KLVAzRM08c6Ay+/OolHgo/Ysb0qpYWFXZY6rhoVtl9b4EufPQXmSaNjxJxzfsqT/MxsQaSgXXH531mxpaemzVP/hJQ0Jr9wQLdkJrPlML2VH3YQ1HVHaHQ12SViLKJMfzYDI1lEm4FjcLu8Ks+ouG12+rEaBVwLaK99F0RQYbbNu4o2BownWOTPA2xPZCrUc6h6eLZUT1VazJ1ztP1+p39AbVlBhVw1QzQMX5V2MWuCiYWHb1DFKqv4/12V/bLXJ0d5yWSPBH3gLmrlQ8ntlB6gaoDZDcFEWzJ494T0XDYvApj2JMw+OYUPsdLmZH2bR0N6Arr4/qvQtdoCuNnsWDLnipE/DLBEOxzXKYdu6m5YnW7vb7v18WlFdSK5+lW8ZbFtRjs/V/j9l9NuFZpsDKCLqSUeT8Kv1wjh2b+eWlmZXWz3hZdUdhY+JTLVAF6Xs+/RneRet67DJ1V+vsLNsEyIsLw0KO+KUxje4qek0WxnSS+YUm8sDIK46QFlfbgKnYVvzXrLC920Ngpj0zsAWBOnTezBnQqjVs6kz1kRriMvv0HKqAbq05Kl7UXC1A7e7nUHPNwsaQQafV63XpHcGXB0FluV95QBdnQQtA13OPNkXlmhkNG+SR5v95LHLG4ks73ofoDpxTXpnoLwusvdgToVgMfyiD+M4ZVX4xnwSfpSpidH5UWDtaGFSh4Hm5mbXu0FqWe9yy6eWzX6uu/wOLaXC77K4nHmh5Nvuu7eqDGhOVN7EpsF4y3Gn59G67gC9ZXGOQ43Ise1muicGXNwZqNPwousOUNs7mdRjYMSUz7mdx77SPNpcryTUuufyO1SSA3R5qojLmVerwDZ0vVgsfy7U5cmutfiwSfK1mOl63eV36HM5QJeHubX9kUnvDLzWexDnQrDVk30r2kOuurpTlEz/wPUaoLa8MemdgfbegzgXYo5zFkVjkMtLZcsO0OWmgLb6MumdgWd6D+JciP9zzqJoDHK5EvGJaoAu9//YXC9vL8UMgjk93aEbDSrz5gC7kVLj1OWlsh/KAbq8XCwPG3zWKLcNXZ5N6BcbeiLbgZ8d1zrOvhXTSx7y/RT5B+cdoDY9dFVWKzSXR7pdtS8UuxgJ1kyAf4USWTYiubd5ZLNNku8lr16eXtAgoqsOUNO/3peHV+F39cMnq835/hE2458M9iA3eQjjQpASRtzqgiFR29BvaEnbhrnqANXls3gU2NUFz6sPHHip9QN6e1PuIdir3oJmOpT6/h7KtAXxKa+9Ql0dSNRE+HINUE1gV2fFy/lZPyAk9CY0gzUX8IbewjlwvwVbXe72CTOL1iYyV0eBNfZRrgGqMLhaIDSHaR1g4o2Biwjm8miwRn8v80aFhYIBtgwruLoW+L3p0/dlFLi1KE/o6lQYZd4GwMQTA8VHCHabp6DZDDS5WCw8l03VE9H6S4mkGk+iC28aesNHSxVGlJu/C+JJM5FUBiWSagYTxTlogOD3wMVaoL5tcbYtf2uoYLr87rzZTHlfqqPQv94QLdkKPNh2/vWeYfSPPUjoK70/kZmQf8G2f2dG23QounE61IhEi7LP0zQYicujf8pEV/sxypkXwZ/TiJPNApwRjfz+wRlrYjCkNGMLTR8bGENSSSXxsloDnQ7Q5VnxA5nRrvlMJh4ZoKb0AkFP9Rg87cE04fkUbHoz7YqmSr/Nn9YIsMv95/PFdx4coEay1pexJt4ZwGFcRuhLvD+R2pBn083j8sBOVMQPJGKXp5DNE3GdDrB8ogsOiqbCbOKgXVGbpAGRH4NpUScUYfw33Tp7QrMNfPhieHOecrXrSGW7Sw1QJy6vjdzaVxHI+UPUArVV2iFAfWhZE03pOWrvIWNdneQfdX58JeoEEoxf857LfdydNUANgrg8FWa7BMnOdNI4wTkYcCBoz5AhT6BrE7prdYtJgwzQZ66a3zYNPpal4G+hbLlPeJEDnLmlLrhcWLacO7dJTWETHwzgSJ7isdEgC9NIHkbP/dBZAzkmvhgoafWUy91G88eNK2he6JI2fqlU0g4Z39RFB0XNoKG8FDMctC02kygjA0nsb2C32BJtLKEbCX50HDW/KVNGLD1ixJTVSW8toE0DVgCqOWkSuXZYUqXiDXTRcaaEfB6BwvcA2eOi/IOBsYMxr1T5xSeXlwjpwy5DgTnAAMWZl7mdl2Mfovg9OC5AVGE/qv7rs269dcK4vfeOps+vhMMrjJiyBensDIaDzYGmiWikVOWrUsp7zXHhDfhSF8Kj4H7wMByquyntsiMKuur8xD192t0+iEVGnQRclolpL3XZ0a9UpKAcDOakoMDMRIe9o1rtQ9yDwangYfAxCCIv8/AVYJ+5Uwup7ZJBvxuDGJmBZw/t8a6h9J4ZUDyIik/OmNHct4fhdsE3A2TGBuA88EGQjPH57AKe+x1Y07cBdR4k3q3AX8HbIAp5lEh/UGpbX03n1Ag6rQFeisLglMT5OXrs0En44mouF4dw8XGQqgzpVDSE/+oHHEYT5OkQ4rIoKhig7GiU/UdgfxD1qhvNVvgHGE9ezuR/qIIt6xLhqeAooP0koxY1j0/HluujTshL/Ni/B+HuAot9g5fnMhRGo79bwffL0rlzGoyONRdQcFXUT7Orq8YlaReF6VFwGDqo7+gPYHYE+qj/thlsTwf2caQXhfOTA38AnALicH4kU9CPx3U4nklgPV1IWOQAXXV+ovbF1tbC61U5JgNuAS7LdVH1FVUlNKcXKUArg73An8AjYCFoVN7igangTDCire2YyFompVsGL0saZwE1j5KUZ0g8sR/pUkuhD+lPS5KAGNK+ovK17OLpSfxMbv68MoBjx69hj6q/+m8SAwMtLS19mpqaBpCUulg2ARsC1XRWAcsAySdgIVCzpB1o5cms4jhaJM3FLziOTCjz6kO8BOwbWSKNRfwOwY+njHZ5URuLwl9ouNiUJx8DqR2g8WdZl6d+DrdqpZSluwM8iKtXddxz9d8BEPBPV43Lhl2lLuVuic7dpiYsuRHJES98PyJuAbtEkoD/SD/j0bGU07/4j6LxJ+HjBJ46r/EnM/XEN+H19k6NK/sAdU0DBPo1dln4pa/1Arpsdppsk6Orhvh07Kj5pdH5iQTNz52AjsfFxYgyhLTSUguOyux3ifjZysi7O8B2br5UGcDB46+z1nE1B+0ykzwyoD4/gl4M0lbzq7SgDyfxOcFSaRDpDa9UwMHj56dPn9jFv3VxgFQNtWzH9Wkimr0/0sHMNZO8MjBq1ukE3c9r8ATDyQmOj6kmOIq04hr5TorSx4cNO0bdC4uliwPsuPrQ4rvuHoyxZrC7mVvPMpyJlvL9pF6YlN1TczhSJ0iLSH6gKWV2R6EOvq1rP3M1B/hwFCmnLM5vkOnrp0wnUydiBjr6/f5MMqpZZUk6+wR/GI3SpS2Jd/HqiGjSSDzWz9GgrbsW1RzgUwR6o3tAx87XwJ4sNIEcoz1xczTFa3DiWvhTQE5byw6jGBihRVRYzp9amXlqHpp2GQCR5lUcYHm3Ctf7AWX7odrSSAcm7jOA49Act4hqULHxF/rACLyo308O0HVhtdKiPQArDe3hAAnEiHhhamUgR4+/yn5urlf7Hc06X2aN5SkXOvnDHhjZE16G+GI0Ww/d373/T+r3cIAdNt2bLdt8aauCdKSvJ+2hTDFALUcrUTTJ3xXp7BMM1BxuYekbhASKIyOEqv/vwWq61nKAWg7zarUHHLu2Py+HlmaZuM3AAZinfl+XRM4rjHmCT7pESg1b2rledTPkqg6Q+YDaLWF6jchcurw6xnzPJYPMlq4MaIE/Vw7setWZs0BOcMyYAjWjcT+FjXOcYaS6IVPxae9Xu1XVAXYEvKvaAw5eO5JaoByhiYsMNJU06ruti6Z12CQn6HueYLHY/MW4ceM0L9JlJ3h3rfyv5wCn8JA+8OK6DMTAg103Msf27YTtKzhuv/oEfTvB5mY5waKc4LkO8vQuNt1fy66aDnD2rUOe4aF/13rQsesnUgtcyTGbzJxFDOyYEyICOsGCnOCP4cq1muBj4+p807pYr3DgFDRr/pR6YRy6dxT9BNoXzsQRBhZ94Lv0AOaoFpgX0YjnSZTlvzRosHwBr7x2hSn9iWNX3vtfwsV/1+KiZg2w44FbREqthx27/hNyP+rvWThGWdrNKa2ChgPSrmXI+vkdGCm/55oH7FCfoLrwbvPNLw5hFTAH5EWyvlLAd167+CCFdhB4Jy+Ft5udn3Hue44f/YJL8fyfu8WZtdMnZsxo6VuvbNdtAutBLP4r/46uF4lD957DFj66U3zbIZtyawpldxuM1wJ49Y/lUQLtLN3MLjGnLWoOn5xR8s7kXf5FPd17awLr2evqReDYvY2x53jHbMqzOctjvJqEeRU5ft+TpZuLGhgZl9WBEfWF3thbxnupAa5GJE+AL/UWmSP3tROOaoHtjtiTWzOoAWqH4zysa+8tj8MYGNGAaJZqgk/Nnj12+yFDJnxcj5xea4A4ggVEcGu9SBy7txb2/NIxm/Jqjr5v80Veja+wO/DASCF7NcHre3N+4qdXB9hB4mT+52U0WCYfRu1htw7b7V92GdDyJzlBk0VdAb6bw0UmS+MEs7JiRKO//+sl0z05wJenbzCNyJ71EqEjYTRydOacKSNc3yTSkeyqacbb3NFKAJNFDPitCZaflhPMyBSZttbW1nA3eaBG9FuQN/mRvTnZZaA0Y4u+FNin8lZoPdj7KWF8T5Hh2SJI8xQZz32VnmqAHa+AmsF1OxSz+6rU1PyXZLR2EjbJIAPFLWao+Tsrg6pHrXKg0WHGBegOS+2yuYWQ53nmincHOG7cU0RcdVPBqHMrwfjXIO0/lkpNeZ5KkSD9oSSteYAmPRkI1hxesmIkbRso3MFqlhd7mhvCFWpDh4M8iq0QCaH8JBEFhXU38EUeC61Hm11bMbJPZOUMQtcE8zwS61KwNzDmy5ERaxFHxgD5tjKYA0xqMxCsTzA9y+ZmtrUdE+3WZ3B4Tm0enb5zj40KR+anIo2YUvkXp0tmOMYFc4LpGBj5RaMFyXsf4JKYJ3GYt8EQWT9y4Igp/6kDk8wxcCUaazWESW0GAg+MdGyqek7tJCK9o8GPqyJNQZFrvzB+cG4J50cnc7F8jMajIifZEgiVgRLffybf7stcaUtG4UB9gqic1BSZv+Gdel3a271gNVwD7Phu8P90jygn55og/T9k8sCc2OuEmcWRrdoVZbwTxkRvRMDR4SL7CZa314+zJqj8nVjtu7+R0FWaM3A5nMATyfxApSLVO+dOHa6dRkwywkCpbegylByrBXp/fYL1CTYX4txP8J6WlhZfU9UarjJ2lnd41LZR53ee5/D/eGrDp8T2q5NDgsM2mTKr9d13AtXkTXpnINB+gvAt/xLH9vpNTM6+pndzeoZouAlcEcXVHL9YcZ63w7H0h9r8wAzlOi/Jfah7QYZUTlrVLAyMPDlv2pib/RLluwaoBPHwv+Lf6X4Td+C5D7HhO7xY/r874AAJWTKBMrsq+t4NhmZJ74R19bufYFntiGuCP+T9u9AvP0FqgErzEvC638QdeE79gJPI4K84YEsuTOBl0XSJI0Gey22jeZ3WgZHnMEQtUd8SyAFSmF4i5Ut9p+7Gg+tixtU4wYFumOO+FZRbbZV0BPjAfWtDszCQE2xuZmPa8PcTvKDjB823kYGawEqVF39D/j0KtHFAnuUhjB9NhljNIiOlgLJ7MKqqFbNcRlROg5ppGRh5ETK24317MwgpgWqAShgFXuBf3muBomIHcBUvlfqYTDLAAGVXKweOBh9lQN20qKiBkfGU8+P8KATnYc0TPC+o85P+gWuAiqSjFjidwzV1nnO5CfsPJnPeyzkPmTGf8nsIyl4ErCboPdeSHBhpR82hvGNveVe3esjANUBFiyKqBf61ehK5u6rteCaV2taPdleK3NEancGU3yuI3WqCjVEcqE8QzoPUBP8chvNrzNxeQvMr2g/MByaLGLiWfyv1QpvdThED5Nd3wYeLss/+emQg0IqR5sa30noGvVZJUbFZogqKneqRtLwEuwFDV1vCkB2lnQHy6xBgTrCxNzTODRQOD7MMhdIErlBImyTMrjjP++FoCLiGsrRO3onIiv3WHPaVU3E1hx9ubT0i0Ly/7taFMghSGSkv++Gc26hwJSmFwsOcHsTLNafrZTtLKwOUYxsYaTxzohwY+QJ1NM3slsbVqv1E2DXAQmHmltp8cmrtJHN556tYfRsvlS2/ykj2W03QV0ZFWRO8cdy4QjaWnPKi7wHUOWrSlYFXOI3uoy2+yqw9VI8B8sv6BLuWYS9nwfoEew6MvEeiWVpuWt4V9u9emMphGHWwn1TvpbN76WKA/DIn2PiLqgqQr8nSyn2erdxZ+o9cCb27LtJShgEbA31NzaQ6A+dxecVIM8EiD40B8sqcYPVyXO9qMCe4aFPVn5NA/9AysltEkXpVFP856Z3ZLU07XcLAPRweS3+TjZwv4SS1R5RnGxhpPHcCDYw0nlxjT0TtAFXDuQ9s15hauQo9F2tPwglenyurM2qsOUFfGZdaJxj+KHAFP7zU73P6M/BpxWU77MrAAE41V/B3tnyuKzFpPLPRYV+5otFh3xso+ErR40OR1gA7deDlvoBj3x2infHk4L9qyyfzkj2eA1szbaLVBH1l32c8NZby/RdfT0fwUKQ1wAp9mzl+vuLcDqszsBuX7+HlOqXtwqHLVA9iV9PAgNUEfeVCoK20fKXYy0Ox1AClAy/1AfxrAXE5XSWbZbkd5f8fL5p2LzZJKQNWE/SVManpE4zNAYomCssk/n1fxyaeGFhAqLPAuThC9aeapJABc4K+MiUVTjBuB7geVGmZ3CBflOX3oTZM/xVOMBtLgXKYT+YEfWV64k4w1uYoL/Ar0HQKkOEm3hkYRtCbecm0uubL3h+zkHExQNm2TVUbJzvx0eFYa4CL+NESl8J4jk9snC97AgbeBtp2bHzHD4qRkiIGrCboKzMSGx1OwAGW+wL14aApYFtfdNlDYuBFMAFcjCOUUzRJCQPmBH1lRCLN4UQcoOihkGiLqLvAyjo38c3ALJ48H1yOIwz8kRjfWtiDXRgwJ9iFDq8nsTvBxBygGKGQaFcUNYdNgjPwHFFMBHKELwePzmIIyoA5QV8MxuoEE3aAmhNYUufxQb6osoeqMTCfi9qU9lIc4cxqAexafAyYE/TFdWx9grGOAnenolgsaJvrscBe1O7k+D9fn0d/Ch7i5WsBo0pTBtr3bhvkE95WBPuDm8CEUkuTRiwbFn6EbHS4YdYKqVsx0rgJDTxBAdsRLAQm0TDwONH+AmzWQLbkMigcbQWawQxQKee1+HSCIpKIbD/BSja9HQfaWTpTBRg+jvbGiYUKwMC7PHsLOAL0z1QBiVBZuBgIjgV3gg9ALTnfnGAtaiK7HqkTTLQPsHuZhkINiNh28d2Jieb8DaJ9ANwA7qWplqvNKihrQ7B7DzAa7ARWB16EEfcx7NgzWZ31DQvp2qaqDbNWXjihPTND30UmXQ5wav/lC8PnXgc/ezbOkT0RgIF3eHY6uBu0gqcpbAv574zgeFbDmK3BSPA1oDmoKwE/cv7kyWNOHjPGnKAf8nw+E8nASKocoIihoG7AP72Im+rcJBEG9P3iR4FqiI+Af+MQ3+R/ZoRytBbKqs9zB7Az0CdJvwTCkvMLOMGiOcGw+PQST+hOMHUOUCxQeLX2VQv/19S5SeIMaGrNs+Bx8AR4BrASZeQbxWKrCmViUiqNYMRwipzdhkDrpL8CtgH6Ae0HopQLqAmOtZpglBT3iDvUeYKpdIAyGSf4bf5dDZbVuUmqGND0Ja06eQmo71BQrXEueAWof/GdwjS28Lqj8HGxuTzdiUuNCWvGizTIly2MKK3Ak1o+qR/E9YBqcoPAxh3/NaCzBkhiWtcF1ATHWk0Q9uMTOcETaZVoTXwgSa0DlFU4QQ2IaGDEJDsMyDl+AN4D6kd8F6iPUdD1j8DHQDXHT4GkBPoC/dgtD+TwVgFyeitX/NdHtpJwciRbV2xgpC49kdwMpSaYagco2nCCv+PfqZFQaJEaA+ExYH2C4XHpNabATjCNv6ZdjZ885pdcuLTrRTszBlLHwAmFppZz/c4TpDlnK0Yaz1Ktzgn0tbnU1wDFyVymx/QfPvcqDvfTuYkxkGIGbIpM/JnjuyaYCQcoPmkKax7XP8FInZsYAylmwEaH488cX04wMw5QfOIE1+HfDUBzu0yMgTQzYH2C8edOw04wUw5QfOIENeVBTlAz+U2MgTQzcAHL5vgQuK0YiTGTNLvA88fX0z8I0o05Oovncek74Olut+zUGEgbA8fzKezxNjASa7YwMd77wEjmHKCoxAm2808TpWcAE2MgzQwc32Sjw3Hnj5zgBFqLJ/SWcOaawJUGYaBWAvwv2Kryuh0bAylkwEaH488U9Qn+gApTzWl0mXaA4hMnOIh/1wLrExQhJmlmwAZG4s8drT7aDyd4V7WkM9kErjQEw7QGdV/wr8rrdmwMpJABmywdf6ZoWeVFVJQGVEs68w5QRuEENTCiPsG7dW5iDKSYgROsTzD23NmQFM/hSwc9/F3mm8CVVOLltXhe7f39K6/bsTGQQgasTzD+TDmUypKWHC6WHh5x8Z0MHmDcwnnTBnRuOZ5BC0zlHDFQrgna1+ZizfFxVJJWr0zRKQcowwbsNO/DQmHcsRyeUWmoHRsDKWRAfYIs5rdPbsaUN5o1cnRlWk41gSsN0zHeXvOA/gi0z5yJMZBWBoLuJ/hdDLsYLJdWA1OkVzu6bEdr8W3p5FwNUEZ1CkZSsAr/AV7vvGb/jYEUMsAPdcu5AZrDV2KTajbabNakPgMDub14VymnHaB4wAlez79RwFaNiBCTtDKwqDns8+PrlHPbT9B7zh5K67Dc+nXeAYoTCsd0/u0FbtW5iTGQUgaOV5+grR2OPHd2JIXBSiUXDlCG4gRfam8dpE0U/qxzE2MgpQyU1w4HaA5bTbD3jF2RILsrmNODINV5KBX52tgR3PsT0LxBE2MgjQzYsrloc+XvVIoOy00NcAmXxRKGX8K5msRPLrluR8ZAqhiwPsFos2ObGTOa++awBriEVTpC1+ZMNcFDl1y1I2MgVQxYTTCa7FhAtFvlsAa4hE1qgq8Xi4XvceVEsHDJHTsyBlLDQLkmaAMjoefHKsS4fq5rgJWUUhvcnvPzwFcrr9uxMZASBpjTOubkANvr22Tpnhk5Otc1wEo+qA0+wvk3gJrE2kjRxBhIEwOaLB1k2ZxNlu6Zm2uZA6wgBSf4DvgJl7S11rMVt+zQGEgDA+VvjAScInMUhtiKkUW5uZI5wCrFGid4E5d3AxPBF1WC2CVjICkGNFn63AB9gqoJmhNclHuLloMklZNZSJe+QdUGzwSbZkFf0zE3DLCfYPHkMWP8dddQrju3jcvzBgqHWA2wl/eF2uB1BNkVjAef9BLcbhsDcTHAfoKlIDVBWzFSKLxlo8ANFFd+NUcQXPsMDm/gMQtqDETJwAWFmcUfFbfw9+NMmc7r6LA+oD7MaoANFE1qg63sOP01HtFAyasNPGpBjYGoGDi+sHnpVL+RU6bzOjr8JpzNtxqgz5LDL+dGPPpf4DCwjM9o7DFjIAgD+uTjReAcHJm+juhbctgnqK9I7mw1QJ9FhgL3PKtItAnlnuAen9HYY8aAXwY0U2Ek5ZDJ0cGcnxQgjrz1CbZh8xfmAP0Wv/Jz5Y0VWltbR2pjBa0nfjpQdPawMdA7A5qwvz8/vvrY98O9B/ceImdOcIqYsSaw9/LRa0iaEVpfqDlWJ4MNe33AAhgD3hnQxPw/TZs25vKddprMh7+ikxw0h1+HvS1x+K+ZAwynHInHUmdUFKB1Of4hOBb067xu/40BHwy084zWqF/CC/u2j+d9PeK4E7ySGjQtNlpwvtixhzwxQCHqT0A5QfUVrufpIQtkDCxi4AX+/Q+Q43stCVIcdYKqqOwFp3eKU3OAMZQsCtIAkpETPBLIKZoYA7UYeI4bWoI5KSnHV6mYg07wIeokuxaLEz+VneYAK3M74mMKk2qB2n9Q/YSbRJycRZ8tBjSAphrfVTi+t9KkumNOsAl+r+nk10aBO5mI4T/EvwL+QFI7ADlBfo1McsyANtpoBVqNsSNl43yQKueHXi5NkWmdPn2iPpNrkgYG2tqOWYZf12+Ca8D7wCQfDCzAzMvB7s3NpcxUQtD3u+BDkEX5AKVV8egi1gTuQkdSJ+Uv1W1O6tqhYwzYOClNLN1IGZhJ7FcDmrkF+vqKi2cORJpqiJHjRFRGLwJZ20Xmt3D+6+6cmwMMsXCEERUFTJ/qHAUYpi+MACsCk+wyoG/N3AUu13+auO9n15RFmmfQCd7D/Ml9qs2fNAeY2tJYrhV+GfX2BweArwDLL0jIgHyGjm1gMriemsfz3WseGbChrooZcoIaVf86Pzzt1QyyF6oaKym7NmNGU9/NN2/Rx5rkDL8FbHPWlOUR6qg5q5Hcm8B1YyYXpk8eU/ycY2clA07wVcjfB+enH6OqYg6wKi3pvUihU5NY+xHuA7QGWc7Q8hESEhA5uBngNnBTe/sRjwwaNOmjBPRILEnK48Ekrj7BFRJTonrCr3BZU14eqH570VV7ceqxk/J789tGr9Bv6A3boeY3wdfB1mB5YBIdA+8R9WNA/Xq3zZ499okhQyZ8HF1y6Y8ZJ7gvWl4M1kqJtrPQ47v1an6depoD7GQi4/9LpWamU5ym2uCuQM5QTeYNgUkwBjRXbw6YBu4GD3T06em6SQcDOMGhHKomqL7qJOUOEj+2Vp9fd8XMAXZnxJFzCuRqmLIV2BnsArYBGwDLc0ioI3Jsc4FqeWo+PQhm8EK9y3+TOgxQ5tbk9hngaBD3/EaNrp9FjfzMRmrk9jLAmvtSHlFeHTs3A9sDTQhVc3kgyPs0m3fgQDW8J8BDQB3mz1LL43r25umhe+KCI9wbJZqByloccjuJ/JofqYfjSMzSyDwDpeKsWaOWpaAOBqPBL0ELeAK8BVyULzDqDfAouBL8HIwCg7Qih0FcqwyEWK7ntw1dAW6PBuI7ClF+toL9CxlaTRMixRZV2Ay0tV2opXkbgJ3A4eAMIMf4MJgL3gNpl3dR8AXwL3A1+A04FOwI+jVPKS0dNm8WX20G5swZsRy87wdUjl4DQeVFIrgIjGxqaelTO2Vvd+xXzxtPOQ5VKjY3F4qnnVbQChX18fQD6wP1J+q/ztcGawCFUZNaUyKWBfpYVNBCqqkmnwKNtH4ANAq7EOirXq8DTXd4qQPzO87fKI4rvEsjjLl51oyFkxRIuRtG5WU42B1o9sIgoHKjslJNPuSi8vg58Ai4FzxE9wQbRoSTr+YAYdQkOAMt/BrvstHlyzItR86vE3KGQqdDVEHXNB1d695JLkenjmwV+k86/utY1zqvvz99+r4f3jT0ho+a+aAN100yy0DZIcr5rQvWAauA5YBE+b4AaCLzazg8fvDCcXjE10X+P8OkdrFfeuubAAAAAElFTkSuQmCC" alt="Qi logo"></div>
    </div>
    <p class="sp-review">Please ensure you review the statement and inform us of any errors in the entries within a maximum of 14 days from the date of issue. Otherwise, the statement will be considered accurate.</p>
    ` : ""}
  </div>`;
}

function renderStatement() {
  const a = state.account;
  let opening = a.openingBalance || 0;
  /* الحساب زمني (افتتاحي كل شهر = ختامي الذي يسبقه) ثم يُعرض من الأحدث للأقدم */
  const sections = getPeriodMonths(state.months).map((m) => {
    const mt = state.transactions
      .filter((t) => (t.date || "") >= m.start && (t.date || "") <= m.end)
      .sort((x, y) => (y.date || "").localeCompare(x.date || "")); // الحركات: الأحدث أولاً
    const totalCredit = mt.filter((t) => t.type === "deposit").reduce((s, t) => s + t.amount, 0);
    const totalDebit = mt.filter((t) => t.type === "withdraw").reduce((s, t) => s + t.amount, 0);
    const closing = opening - totalDebit + totalCredit; // الختامي = الافتتاحي - سحب + إيداع
    const section = monthSectionHTML(m, mt, opening, closing, totalCredit, totalDebit, a);
    opening = closing; // افتتاحي الشهر التالي (الأحدث) = ختامي هذا الشهر
    return section;
  });
  $("stmtMonths").innerHTML = sections.reverse().join(""); // الأشهر: الأحدث أولاً
}

function renderAll() {
  renderStatement();
  save();
}

/* ---------- الأحداث ---------- */
document.addEventListener("DOMContentLoaded", () => {
  /* كل رفرش = إعادة تعيين من جديد: اسم فارغ + أرقام وحركات جديدة (بدون استرجاع المحفوظات) */
  resetAll();
  $("year").textContent = new Date().getFullYear();
  document.querySelectorAll("#monthsSeg .seg-btn").forEach((b) =>
    b.classList.toggle("active", parseInt(b.dataset.m, 10) === state.months));
  document.querySelectorAll("#minSeg .seg-btn").forEach((b) =>
    b.classList.toggle("active", parseInt(b.dataset.v, 10) === state.minBalance));
  document.querySelectorAll("#endSeg .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.e === state.endMode));

  // توليد أرقام جديدة (حساب + جوال)
  $("regenBtn").addEventListener("click", () => {
    state.account.accountNumber = generateAccountNumber();
    state.account.mobileNumber = generateMobileNumber();
    renderAll();
    toast("🎲 تم توليد أرقام جديدة");
  });

  // مزامنة بيانات الحساب فور أي تعديل
  // تحديث الكشف فور كتابة الاسم
  $("accountHolder").addEventListener("input", () => {
    readAccountForm();
    renderAll();
  });

  // تغيير مدة الكشف: توليد حركات جديدة للفترة المختارة
  $("monthsSeg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    state.months = parseInt(btn.dataset.m, 10);
    document.querySelectorAll("#monthsSeg .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    state.transactions = generateRandomTransactions();
    renderAll();
    toast(`📅 كشف ${state.months} أشهر — حركات جديدة`);
  });

  // تغيير أقل رصيد: رفع الافتتاحي إن لزم + توليد حركات متوافقة
  $("minSeg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    state.minBalance = parseInt(btn.dataset.v, 10);
    document.querySelectorAll("#minSeg .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    ensureOpeningInBand();
    state.transactions = generateRandomTransactions();
    renderAll();
    toast(`🔒 أقل رصيد: ${state.minBalance.toLocaleString("en-US")} IQD`);
  });

  // نهاية الكشف: آخر الشهر السابق أو حتى اليوم
  $("endSeg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    state.endMode = btn.dataset.e;
    document.querySelectorAll("#endSeg .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    state.transactions = generateRandomTransactions();
    renderAll();
    toast(state.endMode === "today" ? "📅 الكشف حتى تاريخ اليوم" : "📅 الكشف حتى آخر الشهر السابق");
  });

  // توليد حركات عشوائية جديدة
  $("regenTxBtn").addEventListener("click", () => {
    state.transactions = generateRandomTransactions();
    renderAll();
    toast("🧪 تم توليد حركات عشوائية جديدة");
  });

  // طباعة — اسم ملف PDF المقترح = "كشف + اسم صاحب الكشف" (يأتيه المتصفح من عنوان الصفحة)
  $("printBtn").addEventListener("click", () => {
    renderStatement();
    const holder = (state.account.accountHolder || "").trim();
    const oldTitle = document.title;
    document.title = holder ? `كشف ${holder}` : "كشف حساب شخصي";
    const restoreTitle = () => { document.title = oldTitle; };
    window.addEventListener("afterprint", restoreTitle, { once: true });
    window.print();
  });

  // تنزيل PDF مباشرة (بدون نافذة الطباعة): التقاط كل شهر ثم تقسيمه تلقائياً على صفحات A4
  $("pdfBtn").addEventListener("click", async () => {
    renderStatement();
    const holder = (state.account.accountHolder || "").trim();
    const filename = holder ? `كشف ${holder}.pdf` : "كشف حساب شخصي.pdf";
    toast("⏳ جاري تجهيز ملف PDF…");
    await new Promise((r) => setTimeout(r, 60)); /* فرصة للرسم قبل الالتقاط */
    try {
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF("p", "mm", "a4");
      const months = document.querySelectorAll("#stmtMonths .sp-month");
      if (!months.length) { toast("⚠️ لا يوجد كشف للتنزيل"); return; }
      let firstPage = true;
      for (const el of months) {
        const canvas = await html2canvas(el, {
          scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false,
        });
        const imgData = canvas.toDataURL("image/jpeg", 0.94);
        const imgW = 210; /* A4 بالملم */
        const imgH = (canvas.height * imgW) / canvas.width;
        const pageH = 297;
        let y = 0;
        while (true) {
          if (!firstPage) pdf.addPage();
          firstPage = false;
          pdf.addImage(imgData, "JPEG", 0, -y, imgW, imgH); /* الصفحة تقصّ ما يجاورها تلقائياً */
          y += pageH;
          if (y >= imgH - 1) break;
        }
      }
      pdf.save(filename);
      toast("✅ تم تنزيل الكشف PDF");
    } catch (err) {
      console.error(err);
      toast("⚠️ تعذر إنشاء PDF — حاول مجدداً");
    }
  });

  // إعادة تعيين (بدون رفرش): مسح الاسم + أرقام وحركات جديدة
  $("resetBtn").addEventListener("click", () => {
    resetAll("♻️ تمت إعادة التعيين — أرقام وحركات جديدة");
  });

  // مسح الكل (باعتراض المستخدم) — نفس منطق إعادة التعيين
  $("clearBtn").addEventListener("click", () => {
    if (!confirm("سيتم مسح جميع الحركات وبيانات الحساب نهائياً. هل أنت متأكد؟")) return;
    resetAll("🗑️ تم مسح البيانات وتوليد كشف جديد");
  });

  /* ═══════════ التبويبات: كشف الحساب / حجز طيران ═══════════ */
  const switchTab = (name) => {
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    const panel = document.getElementById("tab-" + name);
    if (panel) panel.classList.add("active");
    document.querySelectorAll(".tab-link").forEach((l) => l.classList.toggle("active", l.dataset.tab === name));
    if (name === "flights") ensureFlightDates();
  };
  document.querySelectorAll(".tab-link").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); switchTab(a.dataset.tab); }));

  // نوع الرحلة: إظهار/إخفاء تاريخ العودة + تحديث الليالي
  $("tripTypeSeg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    document.querySelectorAll("#tripTypeSeg .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    const round = btn.dataset.t === "round";
    $("returnField").style.display = round ? "" : "none";
    if (round && getDateField("depDate") && !getDateField("retDate")) autoReturnDate();
    updateNights();
  });

  // درجة السفر
  $("classSeg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    document.querySelectorAll("#classSeg .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  });

  ensureFlightDates();
  $("returnField").style.display = "none"; // الافتراضي: ذهاب فقط
  updateNights();
  $("nightsMinus").addEventListener("click", () => stepNights(-1));
  $("nightsPlus").addEventListener("click", () => stepNights(1));
  $("swapBtn").addEventListener("click", () => {
    const f = $("flightFrom"), t = $("flightTo");
    const v = f.value; f.value = t.value; t.value = v;
    refreshTripSummary();
  });
  $("flightFrom").addEventListener("input", refreshTripSummary);
  $("flightTo").addEventListener("input", refreshTripSummary);
  ["adults", "children", "infants"].forEach((id) =>
    $(id).addEventListener("change", refreshTripSummary));
  $("genTicketBtn").addEventListener("click", () => {
    genTicket();
    $("ticket-template").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("regenTicketBtn").addEventListener("click", () => genTicket());
  /* عنوان طباعة التذكرة = تكت + أسماء المسافرين الفعلية (first_family) مفصولة بـ"، "
     وإن لم يُدخل أي اسم: "تكت طيران" */
  const ticketPrintTitle = () => {
    const box = $("paxNamesList");
    const map = {};
    const order = [];
    if (box) {
      box.querySelectorAll("input").forEach((inp) => {
        const k = inp.dataset.paxKey, kind = inp.dataset.paxKind;
        if (!k) return;
        if (!map[k]) { map[k] = { first: "", family: "" }; order.push(k); }
        const v = (inp.value || "").trim();
        if (kind === "first") map[k].first = v; else map[k].family = v;
      });
    }
    const names = order.map((k) => {
      const first = map[k].first, family = map[k].family;
      if (first && family) return `${first.toUpperCase()}_${family.toUpperCase()}`;
      const any = (first || family).trim();
      return any ? any.toUpperCase() : "";
    }).filter(Boolean);
    return "تكت " + (names.length ? names.join("، ") : "طيران");
  };
  $("printTicketBtn").addEventListener("click", () => {
    document.body.classList.add("printing-ticket");
    const oldTitle = document.title;
    document.title = ticketPrintTitle();
    const cleanup = () => {
      document.body.classList.remove("printing-ticket");
      document.title = oldTitle;
    };
    window.addEventListener("afterprint", cleanup, { once: true });
    setTimeout(cleanup, 4000); // احتياط: لو أُلغيت الطباعة أو لم يعمل afterprint
    try { window.print(); } catch (e) { cleanup(); toast("🖨️ اطبع من قائمة المتصفح"); }
  });

  /* ═══ ⬇️ PDF احترافي: التقاط التذكرة وتوليد PDF بميتاداتا مرجعية (بدون أي معلومة إنشاء) ═══ */
  $("pdfTicketBtn").addEventListener("click", async () => {
    const tpl = $("ticket-template");
    const sheet = tpl ? tpl.querySelector(".tkt-sheet") : null;
    if (!sheet) { toast("⚠️ أنشئ التذكرة أولاً ثم نزّل PDF"); return; }
    toast("⏳ جاري تجهيز PDF الاحترافي…");
    await new Promise((r) => setTimeout(r, 60));
    /* ⚠️ التذكرة داخل #tab-flights (.tab-panel display:none ما لم يكن نشطاً) —
       إظهار التبويب مؤقتاً وقت الالتقاط كي لا تصبح أبعاد الـ sheet 0×0 */
    const tab = sheet.closest(".tab-panel");
    const tabWasHidden = tab && getComputedStyle(tab).display === "none";
    const prevTabDisplay = tab ? tab.style.display : null;
    if (tabWasHidden) tab.style.display = "block";
    const prev = {
      border: sheet.style.border, borderRadius: sheet.style.borderRadius,
      boxShadow: sheet.style.boxShadow, padding: sheet.style.padding,
      width: sheet.style.width, minHeight: sheet.style.minHeight,
    };
    /* محاكاة مرئية الطباعة: بلا حدود/ظلال، بهوامش الورقة، بارتفاع A4 تام 842pt */
    sheet.style.border = "none"; sheet.style.borderRadius = "0"; sheet.style.boxShadow = "none";
    sheet.style.padding = "15pt 17.6pt 28.5pt 32.6pt"; sheet.style.width = "595pt"; sheet.style.minHeight = "0"; /* ارتفاع طبيعي، ثم يُرصّ داخل A4 بهوامش 15/28.5 */
    try {
      await new Promise((r) => setTimeout(r, 120)); /* فرصة لتطبيق العرض قبل الالتقاط */
      const canvas = await html2canvas(sheet, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false });
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF("p", "mm", "a4");
      const imgData = canvas.toDataURL("image/jpeg", 0.95);
      /* الهوامش 15/28.5pt تأتي من padding الورقة نفسها داخل الصورة (علوي/سفلي + يسار/يمين).
         يوضع الإطار على حافة الصفحة — وإذا تجاوز ارتفاعه A4 يُقلَّص عرضاً متناسباً ويُوسَّط. */
      const imgW = 210, imgH = (canvas.height * imgW) / canvas.width, pageH = 297;
      if (imgH <= pageH) {
        /* يناسب A4: يوضع بمقياس 1:1 فتكون الهوامش هي padding الورقة نفسها (15/28.5/32.6/17.6pt) */
        pdf.addImage(imgData, "JPEG", 0, 0, imgW, imgH);
      } else {
        /* تذكرة أطول من A4: تقليص بلا انتفاخ الهوامش الجانبية —
           نعيد الالتقاط بهوامش داخلية معوَّضة بحيث تبقى هوامش الصفحة بعد التقليص
           مطابقة للمرجع تماماً (علوي 15 / سفلي 28.5 / يسار 32.6 / يمين 17.6pt)
           مع عرض محتوى مساوٍ للمرجع (544.8pt). */
        const sheetPtH = canvas.height / 2 / (96 / 72); /* ارتفاع الورقة الحقيقي بالنقط (التقاط scale:2) */
        const H0 = sheetPtH - (15 + 28.5);              /* ارتفاع المحتوى دون الهوامش */
        const F = (842 - 15 - 28.5) / H0;               /* عامل التقليص لمحتوى بارتفاع 798.17pt */
        const pagePtW = 595.28;
        const extra = (pagePtW * (1 - F)) / 2;          /* فراغ التوسيط لكل جانب (pt) */
        let padL = (32.6 - extra), padR = (17.6 - extra);   /* الهدف النهائي للساند بعد التقليص */
        let placeX = extra;                             /* pt — توسيط */
        if (padL < 0.5 || padR < 0.5) {
          /* تذاكر أطول من اللازم (تجاوز ~12%): توسيط متناظر بأصغر هوامش ممكنة بدل انحياز أيسر */
          padL = Math.max(0.5, padL); padR = Math.max(0.5, padR);
        }
        const P = (v) => (v / F).toFixed(2) + "pt";
        const prevPad = sheet.style.padding;
        sheet.style.padding = P(15) + " " + P(padR) + " " + P(28.5) + " " + P(padL); /* أعلى يمين أسفل يسار */
        await new Promise((r) => setTimeout(r, 120));
        const canvas2 = await html2canvas(sheet, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false });
        sheet.style.padding = prevPad;
        const xMm = placeX * (210 / 595.28);
        pdf.addImage(canvas2.toDataURL("image/jpeg", 0.95), "JPEG", xMm, 0, imgW * F, pageH);
      }
      /* ميتاداتا احترافية بدل التلقائية (jsPDF لا يكتب /Creator أصلاً → الإخفاء تام) */
      const info = "/Title (Travelport Viewtrip - My Trip)"
        + "\n/Subject (Designed exclusively for users booking travel through a Travelport-powered agency, Travelport ViewTrip is the ultimate itinerary manager.)"
        + "\n/Keywords (ViewTrip, Travelport, itinerary management, itinerary, flights, hotels, travel agent, assistant, view trip, trips)"
        + "\n/Producer (Winnovative HTML to PDF Converter 12.15)";
      let out = pdf.output();
      out = out.replace(/\/Producer \(jsPDF [^)]*\)/, info);
      /* ⚠️ لا تمرر out عبر encodeURIComponent/unescape — سلسلة ثنائية والبايتات ≥0x80
         ستُتلف وتتحول لكل بايت بايتين (0xC3 0xBF…) فتصبح صورة الـ PDF تالفة والصفحة بيضاء.
         نحول البايتات مباشرة حرفاً حرفاً كما هي. */
      const arr = new Uint8Array(out.length);
      for (let i = 0; i < out.length; i++) arr[i] = out.charCodeAt(i) & 0xff;
      const blob = new Blob([arr], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = ticketPrintTitle().replace(/[\\/:*?"<>|]/g, "-") + ".pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      toast("✅ تم تنزيل PDF بميتاداتا احترافية");
    } catch (err) {
      console.error(err);
      toast("⚠️ تعذر إنشاء PDF — حاول مجدداً");
    } finally {
      for (const k in prev) sheet.style[k] = prev[k];
      if (tabWasHidden) {
        if (prevTabDisplay) tab.style.display = prevTabDisplay;
        else tab.style.removeProperty("display");
      }
    }
  });
  $("nightsInput").addEventListener("input", (e) => {
    const cleaned = e.target.value.replace(/\D/g, "");
    e.target.value = cleaned;
    if (cleaned === "") return;
    let n = parseInt(cleaned, 10);
    if (n < 1) n = 1;
    if (n > 30) n = 30;
    nights = n;
    autoReturnDate();
  });
  $("nightsInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("nightsInput").blur(); }
  });
  $("nightsInput").addEventListener("blur", () => {
    const v = parseInt($("nightsInput").value.replace(/\D/g, "") || String(Math.max(1, nights)), 10);
    nights = Math.max(1, Math.min(30, v));
    updateNights();
    autoReturnDate();
  });

  /* ---------- التقويم المنبثق ---------- */
  $("depDate").addEventListener("click", () => openCalendar("dep"));
  $("depDate").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); openCalendar("dep"); }
  });
  $("retDate").addEventListener("click", () => {
    if (!getDateField("depDate")) { toast("⚠️ اختر تاريخ المغادرة أولاً"); openCalendar("dep"); return; }
    openCalendar("ret");
  });
  $("retDate").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!getDateField("depDate")) { toast("⚠️ اختر تاريخ المغادرة أولاً"); openCalendar("dep"); return; }
    openCalendar("ret");
  });
  $("calPrev").addEventListener("click", () => {
    cal.viewMonth--;
    if (cal.viewMonth < 0) { cal.viewMonth = 11; cal.viewYear--; }
    renderCalendar();
  });
  $("calNext").addEventListener("click", () => {
    cal.viewMonth++;
    if (cal.viewMonth > 11) { cal.viewMonth = 0; cal.viewYear++; }
    renderCalendar();
  });
  $("calClose").addEventListener("click", closeCalendar);
  $("calPopup").addEventListener("click", (e) => { if (e.target === $("calPopup")) closeCalendar(); });
  // إغلاق التقويم عند النقر خارج النافذة (ما عدا حقلي التاريخ نفسيهما)
  document.addEventListener("click", (e) => {
    const pop = $("calPopup");
    if (pop.hidden || !pop.classList.contains("open")) return;
    if (pop.contains(e.target)) return;
    if (e.target === $("depDate") || e.target === $("retDate")) return;
    closeCalendar();
  });
  $("calDays").addEventListener("click", (e) => {
    const el = e.target.closest(".cal-day");
    if (!el || !el.dataset.iso || el.classList.contains("disabled") || el.classList.contains("muted")) return;
    const iso = el.dataset.iso;
    if (cal.target === "dep") {
      setDateField("depDate", iso);
      cal.dep = iso;
      if (cal.ret && cal.ret <= iso) { cal.ret = ""; setDateField("retDate", ""); }
      if (tripIsRound()) {
        closeCalendar();
        autoReturnDate();
        toast(`🌙 ${nights} ${nights === 1 ? "ليلة" : "ليالي"} — تاريخ العودة تلقائياً: ${formatArabicDate(getDateField("retDate"))}`);
        return;
      }
    } else {
      if (cal.dep && iso <= cal.dep) { toast("⚠️ تاريخ العودة يجب أن يكون بعد تاريخ المغادرة"); return; }
      setDateField("retDate", iso);
      cal.ret = iso;
    }
    updateNights();
    closeCalendar();
  });

  /* =========================================================
   اقتراح المطارات — بحث فوري في كل مطارات العالم
   (بالاسم، المدينة، رمز IATA أو رمز ICAO)
   ========================================================= */
const sugEsc = (s) => String(s || "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let airSuggestDB = null;
async function airDB() {
  if (!airSuggestDB) airSuggestDB = await loadFlightDB();
  return airSuggestDB;
}

function scoreAirport(iata, a, ql, qUp) {
  // التفويض للدالة العامة (تُعرَّف مع محرك البحث في نهاية الملف)
  return rankAirport(iata, a, ql, qUp);
}

function collectSuggestions(query) {
  const q = query.trim();
  const out = [];
  if (!q) return out;
  const db = airSuggestDB;
  const ql = q.toLowerCase();
  const qUp = ql.toUpperCase();
  // المدن العربية أولاً (من جدول الأسماء العربية)
  for (const [ar, iata] of Object.entries(CITY_ALIAS)) {
    if (ar.startsWith(q) && db.airports[iata]) {
      out.push({ iata, a: db.airports[iata], score: 900 + (1000 - ar.length) });
    }
  }
  // كل مطارات العالم
  for (const [iata, a] of Object.entries(db.airports)) {
    const s = scoreAirport(iata, a, ql, qUp);
    if (s > 0) out.push({ iata, a, score: s });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 9);
}

function attachAirportSuggest(input, list) {
  let active = -1;
  let items = [];

  const close = () => { list.hidden = true; list.innerHTML = ""; active = -1; items = []; };
  const render = () => {
    list.innerHTML = items.map((it, i) => `
      <div class="suggest-item ${i === active ? "active" : ""}" data-iata="${it.iata}">
        <span class="si-code">${it.iata}</span>
        <span class="si-name">${sugEsc(it.a[1])} — ${sugEsc(it.a[0])}${it.a[6] ? ` <small>(${sugEsc(it.a[6])})</small>` : ""}</span>
      </div>`).join("");
    list.querySelectorAll(".suggest-item").forEach((el, i) =>
      el.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); }));
  };
  const open = (arr) => {
    items = arr;
    active = arr.length ? 0 : -1;
    render();
    list.hidden = false;
  };
  const pick = (i) => {
    const it = items[i];
    if (!it) return;
    input.value = `${it.a[1]} (${it.iata})`;
    close();
    refreshTripSummary();
    input.focus();
  };

  input.addEventListener("input", async () => {
    if (!input.value.trim()) { close(); return; }
    const db = await airDB();
    if (!db || !db.airports) return;
    open(collectSuggestions(input.value));
  });
  input.addEventListener("focus", async () => {
    if (!input.value.trim()) { close(); return; }
    const db = await airDB();
    if (!db || !db.airports) return;
    open(collectSuggestions(input.value));
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === "Enter") { e.preventDefault(); if (active >= 0) pick(active); }
    else if (e.key === "Escape") { close(); }
  });
  document.addEventListener("click", (e) => {
    if (!list.contains(e.target) && e.target !== input) close();
  });
}

function initAirportSuggestions() {
  attachAirportSuggest($("flightFrom"), $("flightFromSuggest"));
  attachAirportSuggest($("flightTo"), $("flightToSuggest"));
}

  // تفعيل الاقتراح الفوري لمطارات العالم
  initAirportSuggestions();

  // بحث عن رحلات (عبر API أو تجريبية)
  $("searchFlightsBtn").addEventListener("click", async () => {
    const btn = $("searchFlightsBtn");
    if (btn.classList.contains("busy")) return;
    btn.classList.add("busy");
    btn.disabled = true;
    const ldr = $("srchLoading");
    const sec = $("flight-results");
    sec.hidden = false;               // كشف منطقة النتائج مبكراً ليستقر التمرير قبل الوصول
    // تفريغ أي نتائج وعناوين سابقة كلياً لتظهر بطاقة مؤشر التحميل وحدها مكانها (بلا blur)
    $("flightsList").innerHTML = "";
    const fb = $("flightsFilter"); if (fb) fb.hidden = true;
    setEmpty(false);
    rtHeading(null);
    const rh = $("realSearchHint"); if (rh) rh.hidden = true;
    if (ldr) ldr.hidden = false;      // بطاقة مؤشر التحميل داخل منطقة النتائج
    setTimeout(() => sec.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    let res;
    try {
      res = await searchFlights();
    } finally {
      if (ldr) ldr.hidden = true;
      btn.disabled = false;
      btn.classList.remove("busy");
    }
    if (!res) { sec.hidden = true; return; }
    renderFlights(res.flights);
    $("realSearchHint").hidden = true;
    if (res.roundStep === 1) {
      showRoundHeading(1);
    } else {
      rtHeading(null);
    }
    if (res.flights.length) toast(`🔎 ${res.flights.length} رحلات (${res.source}) — أسعار بالدولار`);
  });

  // تدفق ذهاب/عودة بخطوتين: اختيار رحلة الذهاب بالضغط على الكرت ثم جلب رحلات العودة
  document.addEventListener("click", async (e) => {
    const back = e.target.closest && e.target.closest("button[data-round-back]");
    if (back) {
      roundState.step = 1;
      renderFlights(roundState.outbounds);
      showRoundHeading(1);
      $("flight-results").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const cardEl = e.target.closest && e.target.closest(".flight-card[data-outbound]");
    if (cardEl) {
      if (e.target.closest && e.target.closest("button")) return; // أزرار داخلية (حجز) لا تختار الذهاب
      await selectRoundOutbound(+cardEl.dataset.outbound);
      return;
    }
    const retEl = e.target.closest && e.target.closest(".flight-card[data-return]");
    if (retEl) {
      if (e.target.closest && e.target.closest("button")) return; // أزرار داخلية لا تختار العودة
      await selectRoundReturn(+retEl.dataset.return);
    }
  });

  // إلغاء الحجز المبدئي
  $("cancelBookingBtn").addEventListener("click", () => {
    localStorage.removeItem(FLIGHT_STORAGE_KEY);
    $("booking-summary").hidden = true;
    $("paxNamesBox").hidden = true;
    $("ticket-template").hidden = true;
    lastFlight = null;
    lastReturn = null;
    toast("🗑️ تم إلغاء تحديد الرحلة");
  });

});

/* =========================================================
   تبويب حجز الطيران المبدئي — بيانات وهمية للتجربة فقط
   الحجز مبدئي ولا يُصدر تذاكر فعلية
   ========================================================= */
const FLIGHT_STORAGE_KEY = "qayim_flight_v1";

const CLASS_MULT = { economy: 1, business: 2.6, first: 5.2 };
const CLASS_LABEL = { economy: "اقتصادية", business: "رجال الأعمال", first: "أولى" };
const TRIP_LABEL = { oneway: "ذهاب فقط", round: "ذهاب وعودة" };

/* ---------- التقويم المخصص: أسماء وحالة ---------- */
const ARABIC_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const ARABIC_WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

const cal = { open: false, target: "dep", viewYear: 0, viewMonth: 0, dep: "", ret: "" };

function formatArabicDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${ARABIC_WEEKDAYS[d.getDay()]}، ${d.getDate()} ${ARABIC_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* حفظ التاريخ في الحقل: value للعرض الأنيق و data-iso للقيمة القياسية */
function setDateField(id, iso) {
  $(id).dataset.iso = iso || "";
  $(id).value = formatArabicDate(iso);
}
function getDateField(id) {
  return $(id).dataset.iso || "";
}

function tripIsRound() {
  const btn = [...document.querySelectorAll("#tripTypeSeg .seg-btn")].find((b) => b.classList.contains("active"));
  return !!btn && btn.dataset.t === "round";
}

let nights = 7; // الليالي المفضّلة — المستخدم يضبطها والعودة تُشتق منها

/* شريط الملخص الحي أعلى بطاقة البحث */
function refreshTripSummary() {
  const sm = $("tripSummary");
  if (!sm) return;
  const f = ($("flightFrom").value || "").trim();
  const t = ($("flightTo").value || "").trim();
  if (!f && !t) { sm.hidden = true; return; }
  $("tsRoute").textContent = f && t ? `${f} ← ${t}` : (f || t);
  const meta = [];
  const n = Math.max(1, nights);
  if (tripIsRound()) meta.push(`${n} ${n === 1 ? "ليلة" : "ليالٍ"}`);
  const p = (+$("adults").value || 1) + (+$("children").value || 0) + (+$("infants").value || 0);
  meta.push(`${p} ${p === 1 ? "مسافر" : "مسافرين"}`);
  $("tsMeta").textContent = meta.join(" · ");
  sm.hidden = false;
}

/* ═══════════ التذكرة — إعادة بناء حرفية من الـ PDF المرجعي (Travelport · PT Sans · LTR)
   أحجامه pt من هندسة الـ PDF، ألوانه من تعبئاته (#006696 / #F7E4CB / #969696 / أسود)،
   ونصوصه الثابتة من طبقة النص نفسها. المتغير: الأسماء، الرحلة، والرقمان العشوائيان */
const TKT_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ENG_CLASS = { economy: "Economy", business: "Business", first: "First" };
let lastFlight = null;
let lastReturn = null; // رحلة العودة المختارة (ذهاب وعودة)
const TKT_DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const TKT_MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function tktCode(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) s += TKT_CHARS[Math.floor(Math.random() * TKT_CHARS.length)];
  return s;
}

function buildPaxNameRows() {
  const box = $("paxNamesList");
  if (!box) return;
  const form = readFlightForm();
  const old = new Map(); // key → { first, family }
  box.querySelectorAll("input").forEach((inp) => {
    const k = inp.dataset.paxKey;
    if (k) {
      const cur = old.get(k) || {};
      cur[inp.dataset.paxKind] = inp.value.trim();
      old.set(k, cur);
    }
  });
  const rows = [];
  let i = 1;
  const addRow = (type, key) => {
    const saved = old.get(key) || {};
    rows.push(`<div class="pn-row">
      <span class="pn-tag">${type} ${i}</span>
      <span class="pn-fld">
        <label class="pn-lbl">الاسم الأول</label>
        <input type="text" class="pn-input" data-pax-key="${key}" data-pax-kind="first" placeholder="مثال: YAQEEN" value="${escapeHtml(saved.first || "")}" autocomplete="off">
      </span>
      <span class="pn-fld">
        <label class="pn-lbl">اسم العائلة</label>
        <input type="text" class="pn-input" data-pax-key="${key}" data-pax-kind="family" placeholder="مثال: ALOBAIDI" value="${escapeHtml(saved.family || "")}" autocomplete="off">
      </span>
    </div>`);
    i++;
  };
  for (let a = 0; a < form.adults; a++) addRow("بالغ", `a${a}`);
  for (let c = 0; c < form.children; c++) addRow("طفل", `c${c}`);
  for (let inf = 0; inf < form.infants; inf++) addRow("رضيع", `i${inf}`);
  box.innerHTML = rows.join("");
}

/* جمع الأسماء بالصيغة المرجعية: العائلة، الاسم — ALOBAIDI, YAQEEN */
function collectPaxNames() {
  const box = $("paxNamesList");
  const map = {};
  const order = [];
  if (box) {
    box.querySelectorAll("input").forEach((inp) => {
      const k = inp.dataset.paxKey, kind = inp.dataset.paxKind;
      if (!k) return;
      if (!map[k]) { map[k] = { first: "", family: "" }; order.push(k); }
      const v = (inp.value || "").trim();
      if (kind === "first") map[k].first = v; else map[k].family = v;
    });
  }
  const names = order.map((k) => {
    const first = map[k].first, family = map[k].family;
    if (first && family) return `${family.toUpperCase()}, ${first.toUpperCase()}`;
    const any = (first || family).trim();
    return any ? any.toUpperCase() : "";
  }).filter(Boolean);
  if (!names.length) {
    const form = readFlightForm();
    const n = Math.min(9, form.adults + form.children + form.infants);
    for (let k = 0; k < n; k++) names.push(`PASSENGER ${k + 1}`);
  }
  return names;
}

/* ===== أدوات تنسيق (بنفس اصطلاح الـ PDF) ===== */
function eng12(t) {
  const m = String(t || "").match(/(\d{1,2}):(\d{2})/);
  if (!m) return { hm: "—", ap: "" };
  let h = +m[1];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return { hm: `${h}:${m[2]}`, ap };
}
function engDurMins(m) {
  m = Math.max(0, parseInt(m, 10) || 0);
  if (!m) return "";
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h}H ${mm}M`;
}
function engDurAny(d) {
  if (!d) return "";
  if (/^\d+$/.test(String(d).trim())) return engDurMins(+d);
  const s = String(d).toUpperCase();
  const m = s.match(/(\d+)\s*(?:H|س)[^0-9]*(\d+)\s*(?:M|د)/);
  if (m) return `${m[1]}H ${m[2]}M`;
  const m2 = s.match(/(\d+)\s*(?:H|س)/);
  return m2 ? `${m2[1]}H 0M` : s;
}
function engDate(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) {
    const dm = String(iso || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (dm) return engDate(`${dm[3]}-${dm[2]}-${dm[1]}`);
    return "——";
  }
  return `${TKT_DOW[d.getDay()]}, ${TKT_MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function engAirline(code, fb) {
  // الاسم الإنجليزي فقط للخطوط (لا عربي أبداً) — من قائمة airlines الإنجليزية، وإن بقي عربي نعرض الكود
  let n = (flightDB && flightDB.airlines && code && flightDB.airlines[String(code).toUpperCase()]) || fb || code;
  n = String(n || "").trim();
  if (/[\u0600-\u06FF]/.test(n)) n = String(code || "").toUpperCase();
  return n || String(code || "").toUpperCase() || "——";
}
function airportLines(code, name) {
  const db = flightDB && flightDB.airports;
  const a = db && code ? db[String(code).toUpperCase()] : null;
  const c = code ? String(code).toUpperCase() : "——";
  const l1 = a ? `${a[0]} (${c})` : `${name || c} (${c})`;
  const l2 = a ? `${a[1]}, ${a[2]}` : "—";
  return `<div class="ap"><p>${escapeHtml(l1)}</p><p>${escapeHtml(l2)}</p></div>`;
}

/* أنواع الطائرات حسب الشركة لحقل FLIGHT INFO — حتمي لكل شركة+رحلة (كما في التذاكر المرجعية) */
const TKT_AIRCRAFT = {
  QR: ["Airbus A380-800", "Airbus A350-900", "Airbus A350-1000", "Boeing 777-300", "Boeing 787-9", "Airbus A320"],
  G9: ["Airbus A320", "Airbus A320neo", "Airbus A321neo"],
  EK: ["Airbus A380-800", "Boeing 777-300"],
  SV: ["Boeing 777-300", "Boeing 787-9", "Airbus A330-300", "Airbus A320"],
  FZ: ["Boeing 737-800", "Boeing 737 MAX 8"],
  PC: ["Airbus A320", "Airbus A321neo"],
  ME: ["Airbus A321neo", "Airbus A330-200"],
  RJ: ["Airbus A320", "Boeing 787-8"],
  MS: ["Boeing 737-800", "Boeing 777-300", "Airbus A320"],
  KU: ["Airbus A320", "Airbus A321"],
  GF: ["Airbus A320", "Airbus A321", "Boeing 787-9"],
  IY: ["Airbus A320", "Airbus A330-200"],
  WB: ["Boeing 737-800", "Boeing 787-8", "Airbus A330-300"],
  JZ: ["Boeing 737-800", "Boeing 737 MAX 8"]
};
function engAircraft(code, seed) {
  const key = String(code || "").toUpperCase();
  const pool = TKT_AIRCRAFT[key] || ["Airbus A320", "Airbus A321", "Boeing 737-800", "Airbus A350-900", "Boeing 777-300"];
  let h = 7;
  const src = key + "|" + String(seed || "");
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}
/* الصيغ القانونية للخطوط كما تُكتب في التذاكر (اسم الشركة + الصيغة بين القوسين)
   Q.C.S.C = Qatar Closed Shareholding Company · P.J.S.C = Public Joint Stock Company
   S.A.E = Société Anonyme Égyptienne · S.A.L = Société Anonyme Libanaise … إلخ
   الخطوط التي لا تثبّت صيغة قانونية في تذاكرها (Emirates, Saudia, flydubai…) تُعرض بالاسم فقط كما في المرجع */
const TKT_LEGAL = {
  QR: "Q.C.S.C",   // Qatar Airways — شركة مساهمة قطرية مقفلة
  G9: "P.J.S.C",   // Air Arabia — شركة مساهمة عامة (مدرجة في سوق دبي)
  EY: "P.J.S.C",   // Etihad Airways — شركة مساهمة عامة
  TK: "A.O.",      // Turkish Airlines — Türk Hava Yolları Anonim Ortaklığı
  PC: "A.Ş.",      // Pegasus Airlines — Anonim Şirket
  MS: "S.A.E",     // EgyptAir — شركة مساهمة مصرية
  ME: "S.A.L",     // Middle East Airlines — شركة مساهمة لبنانية
  AH: "S.P.A",     // Air Algérie — Société Par Actions
  AT: "S.A",       // Royal Air Maroc — Société Anonyme
  TU: "S.A",       // Tunisair — Société Anonyme
  ET: "S.C",       // Ethiopian Airlines — Share Company
  KU: "K.S.C",     // Kuwait Airways — شركة مساهمة كويتية
  GF: "B.S.C",     // Gulf Air — شركة مساهمة بحرينية
  WY: "S.A.O.C",   // Oman Air — شركة مساهمة عمانية
  RJ: "P.L.C",     // Royal Jordanian — Public Limited Company
  LH: "A.G",       // Lufthansa — Aktiengesellschaft
  LX: "A.G",       // SWISS International Air Lines — Aktiengesellschaft
  OS: "A.G",       // Austrian Airlines — Aktiengesellschaft
  LO: "S.A",       // LOT Polish Airlines — Spółka Akcyjna
  IB: "S.A",       // Iberia — Sociedad Anónima
  AF: "S.A",       // Air France — Société Anonyme
  KL: "N.V",       // KLM Royal Dutch Airlines — Naamloze Vennootschap
  BA: "P.L.C",     // British Airways — Public Limited Company
  EI: "Ltd",       // Aer Lingus — Limited Company
  FR: "D.A.C",     // Ryanair — Designated Activity Company
  UL: "Ltd",       // SriLankan Airlines — Limited
  AI: "Ltd",       // Air India — Limited
  QF: "Ltd",       // Qantas — Limited
  NZ: "Ltd",       // Air New Zealand — Limited
  CX: "Ltd",       // Cathay Pacific — Limited
  SQ: "Ltd"        // Singapore Airlines — Limited
};
function tktLegHTML(l, conf, paxList, clsEng, airline, code, flightNo, dateStr) {
  const dep = (l.dep || "——").toUpperCase(), arr = (l.arr || "——").toUpperCase();
  const dDep = eng12(l.depTime), dArr = eng12(l.arrTime);
  const dur = engDurAny(l.duration);
  /* اسم المدينة قبل القوس: Baghdad (BGW) — لا رمز مكرر أبداً */
  const cityOf = (code, fallback) => {
    const db = flightDB && flightDB.airports;
    const a = db && code ? db[String(code).toUpperCase()] : null;
    if (a && String(a[1] || "").trim()) return String(a[1]).trim();
    const fb = String(fallback || "").trim();
    return (fb && fb.toUpperCase() !== String(code).toUpperCase()) ? fb : code;
  };
  const depName = cityOf(dep, l.depName || dep);
  const arrName = cityOf(arr, l.arrName || arr);
  const route = `<span class="d">${engDate(dateStr)}</span> - ${escapeHtml(depName)} (${escapeHtml(dep)}) to ${escapeHtml(arrName)} (${escapeHtml(arr)}) - Confirmed <img class="ic-check" src="assets/tk/check.png" alt="✓" draggable="false">`;
  const engAir = engAirline(code, airline);
  /* الصيغة القانونية للشركة بين القوسين (مثل Q.C.S.C) لكل خط يعتمدها فعلياً في التذاكر */
  const legalS = TKT_LEGAL[String(code).toUpperCase()];
  const airSuf = legalS ? ` (${legalS})` : "";
  const logo = code && code !== "——" ? `<img class="al-tk${String(code).toUpperCase() === "QR" ? " al-tk-qr" : ""}" src="${logoUrl(code)}" alt="" draggable="false" onerror="this.remove()">` : "";
  const air = `${logo}<span class="tk-airn">${escapeHtml(engAir)}${airSuf}</span> (${escapeHtml(code)}) ${escapeHtml(l.flight || flightNo)}`;
  return `<div class="tk-leg">
  <div class="tk-route">${route}</div>
  <div class="tk-rule"></div>
  <div class="tk-body">
    <div class="tk-airrow">
      <div class="tk-air">${air}</div>
      <div class="tk-times">
        <img class="ic-arrow" src="assets/tk/arrow.png" alt="" draggable="false">
        <div class="tc tc-dep">
          <span class="sup">DEPART</span>
          <span class="row2"><b>${dDep.hm}</b><span class="sub"><i>${dDep.ap}</i><i>${escapeHtml(dep)}</i></span></span>
        </div>
        <div class="tm">
          <span class="ns1">NON</span><span class="ns2">STOP</span>
          <img class="ic-mid" src="assets/tk/midicon.png" alt="" draggable="false">
          <i class="dur">${dur || "—"}</i>
        </div>
        <div class="tc tc-arr">
          <span class="sup">ARRIVE</span>
          <span class="row2"><b>${dArr.hm}</b><span class="sub"><i>${dArr.ap}</i><i>${escapeHtml(arr)}</i></span></span>
        </div>
      </div>
    </div>
    <div class="tk-conf">Confirmation Number: <b>${escapeHtml(conf)}</b></div>
    <div class="tk-sec">
      <span class="h">PASSENGERS</span>
      <div class="pv">${escapeHtml(paxList)}</div>
      <div class="sl">Class Of Service: ${escapeHtml(clsEng)}</div>
    </div>
    <div class="tk-sec">
      <span class="h">AIRPORT INFO</span>
      ${airportLines(dep, depName)}
      <div class="ap-sep"><span>to</span></div>
      ${airportLines(arr, arrName)}
    </div>
    <div class="tk-sec">
      <span class="h">FLIGHT INFO</span>
      <div class="af">${escapeHtml(engAircraft(code, l.flight || flightNo))}</div>
      <div class="af">Meal</div>
    </div>
  </div>
</div>`;
}

function genTicket() {
  const tkt = $("ticket-template");
  if (!tkt) return;
  const form = readFlightForm();
  const f = lastFlight;
  /* خاتم الوكالة في التذييل: الملكية الأردنية (R / RJ BGW-BAGHD) — وباقي الخطوط (Q / QR-BAGHDAD) */
  const rjFooter = !!(f && String(f.code || "").toUpperCase() === "RJ");
  const abEl = $("tk-ab"), phEl = $("tk-ph");
  if (abEl) abEl.textContent = "BILAD AL SAFARI TRAVEL " + (rjFooter ? "R" : "Q");
  if (phEl) phEl.textContent = "07700006631-BILAD AL SAFARI TRAVEL " + (rjFooter ? "RJ BGW-BAGHD" : "QR-BAGHDAD");
  /* سنة حقوق النشر تعكس السنة الحالية تلقائياً */
  const crEl = $("tk-cr");
  if (crEl) crEl.textContent = "©" + new Date().getFullYear() + " Travelport.";
  const conf = tktCode();
  const res = tktCode();
  $("tk-res").textContent = res;
  const pax = collectPaxNames();
  const paxList = pax.join(", ");
  const clsEng = f ? (ENG_CLASS[f.cls] || f.cls) : "Economy";
  /* دمج مقاطع رحلة الذهاب ثم رحلة العودة معاً، مثل النموذج المرجعي (أربع كتل) */
  const segs = [];
  const pushCard = (card) => {
    if (!card) return;
    const legs = (card.legs && card.legs.length) ? card.legs
      : [{ dep: card.fromCode, depName: card.fromName, arr: card.toCode, arrName: card.toName, depTime: card.depTime, arrTime: card.arrTime, duration: card.duration, flight: card.flightNo, airline: card.airline }];
    legs.forEach((l) => {
      const code = (String(l.flight || card.flightNo).match(/^([A-Z0-9]{2,3})\s/) || [0, card.code || "QR"])[1];
      segs.push({ l, airline: l.airline || card.airline, code, flightNo: l.flight || card.flightNo, dateStr: String(card.date || "").slice(0, 10) });
    });
  };
  pushCard(f);   // الذهاب
  pushCard(lastReturn); // العودة
  if (!segs.length) {
    segs.push({ l: { dep: form.from && form.from.code, depName: form.fromRaw, arr: form.to && form.to.code, arrName: form.toRaw, depTime: form.depDate, arrTime: form.retDate, duration: "", flight: "——", airline: "Qatar Airways" }, airline: "Qatar Airways", code: "QR", flightNo: "——", dateStr: form.depDate || "" });
  }
  $("tktLegs").innerHTML = segs.map((sg) => tktLegHTML(sg.l, conf, paxList, clsEng, sg.airline, sg.code, sg.flightNo, sg.dateStr)).join("");
  tkt.hidden = false;
  toast(`✅ تم إنشاء التذكرة بنجاح — رقم الحجز: ${conf} · رمز الحجز: ${res}`);
}

/* الليالي محرك فعلي: تاريخ العودة = المغادرة + عدد الليالي (تلقائياً) */
function autoReturnDate() {
  const dep = getDateField("depDate");
  if (!dep) return;
  const depD = new Date(dep + "T12:00:00");
  depD.setDate(depD.getDate() + Math.max(1, Math.min(30, nights)));
  setDateField("retDate", toYmd(depD));
  updateNights();
}

function stepNights(delta) {
  const dep = getDateField("depDate");
  const ret = getDateField("retDate");
  if (!dep) { toast("⚠️ اختر تاريخ المغادرة أولاً"); return; }
  if (ret) {
    const n = Math.round((new Date(ret + "T12:00:00") - new Date(dep + "T12:00:00")) / 86400000);
    if (n >= 0) nights = n;
  }
  nights = Math.max(1, Math.min(30, nights + delta));
  autoReturnDate();
}

/* عدد الليالي = الفرق بالأيام بين المغادرة والعودة (مع مراقبة الحدود) */
function updateNights() {
  const dep = getDateField("depDate");
  const ret = getDateField("retDate");
  const line = $("nightsLine");
  const val = $("nightsInput");
  const unit = $("nightsUnit");
  const hint = $("nightsHint");
  const mn = $("nightsMinus");
  const pl = $("nightsPlus");
  if (!line || !val) return;
  if (!tripIsRound()) { line.hidden = true; return; }
  line.hidden = false;
  const setVal = (n) => {
    if (document.activeElement !== val) val.value = String(n); // لا نمحو ما يكتبه المستخدم أثناء الكتابة
    if (unit) unit.textContent = n === 1 ? "ليلة" : "ليالٍ";
    if (mn) mn.disabled = n <= 1;
    if (pl) pl.disabled = n >= 30;
  };
  if (dep && ret) {
    const n = Math.max(0, Math.round((new Date(ret + "T12:00:00") - new Date(dep + "T12:00:00")) / 86400000));
    nights = n;
    setVal(n);
    hint.textContent = `تاريخ العودة: ${formatArabicDate(ret)}`;
  } else if (dep) {
    setVal(Math.max(1, nights));
    hint.textContent = "حدّد عدد الليالي لتُشتق العودة تلقائياً";
  } else {
    setVal(Math.max(1, nights));
    hint.textContent = "اختر تاريخ المغادرة أولاً";
  }
  refreshTripSummary();
}

/* تواريخ افتراضية: المغادرة بعد 14 يوماً والعودة بعد 22 يوماً */
function ensureFlightDates() {
  const d14 = new Date(); d14.setDate(d14.getDate() + 14);
  const d22 = new Date(); d22.setDate(d22.getDate() + 22);
  if (!getDateField("depDate")) setDateField("depDate", toYmd(d14));
  if (!getDateField("retDate")) setDateField("retDate", toYmd(d22));
}

/* ---------- منطق التقويم ---------- */
function openCalendar(target) {
  cal.target = target;
  cal.dep = getDateField("depDate");
  cal.ret = getDateField("retDate");
  const refIso = target === "dep" ? cal.dep : cal.ret;
  const ref = refIso ? new Date(refIso) : (cal.dep ? new Date(cal.dep) : new Date());
  cal.viewYear = ref.getFullYear();
  cal.viewMonth = ref.getMonth();
  renderCalendar();
  const pop = $("calPopup");
  pop.hidden = false;
  pop.classList.add("open");
  positionCalendar(pop, target);
}

/* تموضع التقويم: قائمة منسدلة أسفل حقل التاريخ مباشرة
   (وإن لم تتسع المساحة بالأسفل تُفتح للأعلى بدل التغطية على الشاشة) */
function positionCalendar(pop, target) {
  const input = $(target === "dep" ? "depDate" : "retDate");
  if (!input || typeof input.getBoundingClientRect !== "function") return;
  const rect = input.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
  const vh = window.innerHeight || document.documentElement.clientHeight || 768;
  const w = Math.min(348, Math.max(280, vw - 24));
  const hApprox = 360;
  pop.style.width = w + "px";
  const left = Math.max(8, Math.min(rect.left, Math.max(8, vw - w - 8)));
  const below = Math.round(rect.bottom + 8);
  const above = Math.round(rect.top - hApprox - 8);
  let top = below;
  if (vh - below < hApprox && rect.top > hApprox) top = Math.max(8, above);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  // موضع السهم أسفل مركز الحقل
  const caret = Math.max(16, Math.min(w - 16, Math.round(rect.left + rect.width / 2 - left)));
  pop.style.setProperty("--caret", caret + "px");
}

function closeCalendar() {
  const pop = $("calPopup");
  pop.classList.remove("open");
  pop.hidden = true;
}

function renderCalendar() {
  const y = cal.viewYear, m = cal.viewMonth;
  $("calTitle").textContent = `${ARABIC_MONTHS[m]} ${y}`;
  $("calLegend").textContent = cal.target === "ret"
    ? "اختر تاريخ العودة (بعد المغادرة)"
    : "اختر تاريخ المغادرة";
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const offset = new Date(y, m, 1).getDay(); // الأحد = 0 (بداية الأسبوع)
  const now = new Date();
  const todayIso = toYmd(now);
  let html = "";
  // أيام الشهر السابق (تعبئة معطلة)
  for (let i = offset - 1; i >= 0; i--) {
    const d = new Date(y, m, -i);
    html += `<span class="cal-day muted" data-iso="">${d.getDate()}</span>`;
  }
  // أيام الشهر الحالي
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = toYmd(new Date(y, m, d));
    const past = iso < todayIso;
    let cls = "cal-day";
    if (past) cls += " disabled";
    if (!past && iso === todayIso) cls += " today";
    if (iso === cal.dep) cls += " dep";
    if (iso === cal.ret) cls += " ret";
    if (cal.dep && cal.ret && iso > cal.dep && iso < cal.ret) cls += " inrange";
    html += `<span class="${cls}" data-iso="${iso}">${d}</span>`;
  }
  // أيام الشهر التالي (تعبئة معطلة)
  const endOffset = (offset + daysInMonth) % 7;
  const fill = endOffset === 0 ? 0 : 7 - endOffset;
  for (let i = 1; i <= fill; i++) {
    html += `<span class="cal-day muted" data-iso="">${i}</span>`;
  }
  $("calDays").innerHTML = html;
}

/* "بغداد (BGW)" ← { name: "بغداد", code: "BGW" } */
function parseCity(s) {
  const m = String(s || "").match(/\(([A-Za-z]{3})\)/);
  const name = (m ? String(s).replace(m[0], "") : String(s)).trim();
  return { name: name || "غير محدد", code: m ? m[1].toUpperCase() : "——" };
}

function paxVal(id) {
  const v = parseInt($(id).value || "0", 10);
  return Number.isNaN(v) ? 0 : Math.max(0, Math.min(9, v));
}

function readFlightForm() {
  const tripBtn = [...document.querySelectorAll("#tripTypeSeg .seg-btn")].find((b) => b.classList.contains("active"));
  const clsBtn = [...document.querySelectorAll("#classSeg .seg-btn")].find((b) => b.classList.contains("active"));
  return {
    trip: tripBtn ? tripBtn.dataset.t : "oneway",
    cls: clsBtn ? clsBtn.dataset.c : "economy",
    fromRaw: $("flightFrom").value.trim(),
    toRaw: $("flightTo").value.trim(),
    from: parseCity($("flightFrom").value),
    to: parseCity($("flightTo").value),
    depDate: getDateField("depDate"),
    retDate: getDateField("retDate"),
    adults: Math.max(1, paxVal("adults")),
    children: paxVal("children"),
    infants: paxVal("infants"),
  };
}

function addMinutes(h, m, mins) {
  const t = (h * 60 + m + mins) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/* =========================================================
   الأسعار من Google Flights (SerpApi) ثم Scrappa عبر وسيط الخادم
   تُطبع النتائج مباشرة في شكل بطاقات مع وسم المصدر (serpapi / scrappa).
   تعيد [] عندما تغطية فارغة للمسار، و null عند خطأ تقني.
   ========================================================= */


/* تحويل نتيجة Google Flights (SerpApi) إلى بطاقة عرض */
function googleToCard(it, f, from, to, db, requested, sourceLabel) {
  const segs = it.flights || [];
  if (!segs.length) return null;
  const first = segs[0];
  const last = segs[segs.length - 1];
  const m = String(first.airline_logo || "").match(/\/70px\/([A-Z0-9]+)\.png/i);
  const code = (m && m[1]) || String(first.flight_number || "").split(" ")[0] || "GF";
  const depRaw = (first.departure_airport && first.departure_airport.time) || "";
  const arrRaw = (last.arrival_airport && last.arrival_airport.time) || "";
  if (!depRaw || !arrRaw) return null;
  const dep = new Date(depRaw.replace(" ", "T"));
  const arr = new Date(arrRaw.replace(" ", "T"));
  if (isNaN(dep.getTime())) return null;
  const segCount = segs.length;
  const plusDays = (!isNaN(arr.getTime())) ? Math.max(0, Math.round((arr - dep) / 86400000)) : 0;
  const durMin = Math.max(0, parseInt(it.total_duration, 10) || 0);
  const aptName = (id) => {
    if (!id) return "؟";
    const a0 = db && db.airports;
    let a = null;
    if (a0) {
      const key = String(id).toUpperCase();
      if (Array.isArray(a0)) a = a0.find((x) => String(x.iata || x.code || "").toUpperCase() === key);
      else a = a0[key];
    }
    return a ? (Array.isArray(a) ? (String(a[1] || "").trim() || String(a[0] || "").trim() || id) : (String(a.city || "").trim() || String(a.name || "").trim() || id)) : id;
  };
  const legDay = (da, aa) => {
    const d = new Date((da || "").replace(" ", "T"));
    const a2 = new Date((aa || "").replace(" ", "T"));
    if (isNaN(d.getTime()) || isNaN(a2.getTime())) return 0;
    return Math.max(0, Math.round((a2 - d) / 86400000));
  };
  const legs = segs.map((l) => {
    const depA = l.departure_airport || {};
    const arrA = l.arrival_airport || {};
    return {
      dep: depA.id || "",
      depName: aptName(depA.id),
      depTime: depA.time || "",
      arr: arrA.id || "",
      arrName: aptName(arrA.id),
      arrTime: arrA.time || "",
      flight: String(l.flight_number || ""),
      airline: l.airline || "",
      duration: l.duration || "",
      dayDiff: legDay(depA.time, arrA.time),
    };
  });
  return {
    airline: airlineName(code, db, first.airline),
    code,
    flightNo: String(first.flight_number || ""),
    trip: f.trip, cls: f.cls,
    fromName: from.city, fromCode: from.iata,
    toName: to.city, toCode: to.iata,
    date: fmtDateSlash(depRaw.slice(0, 10)),
    depTime: depRaw.slice(11, 16),
    arrTime: arrRaw.slice(11, 16) + (plusDays ? ` (+${plusDays})` : ""),
    duration: `${Math.floor(durMin / 60)}س ${durMin % 60}د`,
    stops: segCount <= 1 ? "مباشر" : `${segCount - 1} توقف`,
    price: Math.max(1, Math.round(it.price || 0)),
    realPrice: true, gate: sourceLabel === "scrappa" ? "scrappa" : "serpapi",
    depIso: depRaw.slice(0, 10),
    arrIso: arrRaw.slice(0, 10), // تاريخ الوصول الفعلي — لكشف وصول اليوم التالي
    retIso: f.retDate,
    legs,
    _diff: Math.abs(dep - requested),
  };
}

async function serpFlightsSearch(f) {
  try {
    const db = await loadFlightDB();
    if (!db || !db.airports || !db.routes) return null;
    const from = resolveAirport(f.fromRaw, db.airports);
    const to = resolveAirport(f.toRaw, db.airports);
    if (!from || !to || from.iata === to.iata) return null;
    const requested = new Date(f.depDate + "T00:00:00");

    // المصدر الأساسي: Google Flights (SerpApi) → Scrappa احتياطي — بيانات لحظية شاملة
    const gRes = await fetch(`/api/serp/flights?origin=${from.iata}&destination=${to.iata}&date=${f.depDate}${f.trip === "round" && f.retDate ? `&retDate=${f.retDate}` : ""}&trip=${f.trip}`, { cache: "no-store" });
    if (!gRes.ok) return null;
    const gj = await gRes.json();
    if (!gj.ok || !((gj.best && gj.best.length) || (gj.other && gj.other.length))) return [];
    const itins = (gj.best || []).concat(gj.other || []);
    const cards = itins
      .map((it) => googleToCard(it, f, from, to, db, requested, gj.source || "serpapi"))
      .filter(Boolean)
      .sort((a, b) => a._diff - b._diff)
      .slice(0, 8);
    if (!cards.length) return [];
    return cards.map(({ _diff, ...card }) => card);
  } catch (e) {
    return null;
  }
}

async function scrappaRoundStep1(f) {
  const db = await loadFlightDB();
  if (!db || !db.airports) return null;
  const from = resolveAirport(f.fromRaw, db.airports);
  const to = resolveAirport(f.toRaw, db.airports);
  if (!from || !to || from.iata === to.iata) return null;
  const res = await fetch(`/api/round?origin=${from.iata}&destination=${to.iata}&outbound=${f.depDate}&return=${f.retDate}`, { cache: "no-store" });
  if (!res.ok) return null;
  const j = await res.json();
  if (!j.ok || !(j.best && j.best.length)) return null;
  const requested = new Date(f.depDate + "T00:00:00");
  const cards = j.best
    .map((it) => {
      const c = googleToCard(it, f, from, to, db, requested, j.source || "scrappa");
      if (c) {
        c.trip = "one"; // رحلات الذهاب تُعرض على أنها ذهاب فقط
        c._departureToken = it.departure_token || null;
        c._startingPrice = true;
      }
      return c;
    })
    .filter(Boolean)
    .slice(0, 8);
  roundState = { step: 1, outbounds: cards, selected: null, returns: [] };
  return cards;
}

async function scrappaRoundReturns(card) {
  const f = readFlightForm();
  if (!card || !card._departureToken) return null;
  const db = await loadFlightDB();
  if (!db || !db.airports) return null;
  const from = resolveAirport(f.fromRaw, db.airports);
  const to = resolveAirport(f.toRaw, db.airports);
  if (!from || !to) return null;
  const match = `${card.flightNo}|${card.depIso}T${card.depTime}`;
  const res = await fetch(`/api/round?origin=${from.iata}&destination=${to.iata}&outbound=${f.depDate}&return=${f.retDate}&departure_token=${encodeURIComponent(card._departureToken)}&match=${encodeURIComponent(match)}`, { cache: "no-store" });
  if (!res.ok) return null;
  const j = await res.json();
  if (!j.ok || !(j.best && j.best.length)) return null;
  const requested = new Date(f.retDate + "T00:00:00");
  const cards = j.best
    .map((it) => googleToCard(it, f, from, to, db, requested, j.source || "scrappa"))
    .filter(Boolean)
    .slice(0, 8);
  cards.forEach((c) => { c._return = true; c._package = true; });
  roundState.selected = card;
  roundState.returns = cards;
  return cards;
}

/* =========================================================
   البديل المحلي: يولّد رحلات توضيحية من قاعدة /data المدمجة
   عند تعذّر الوصول لخادم الرحلات (فتح الملف مباشرة، توقف الخادم،
   أو انقطاع المفاتيح/النتائج الخارجية) — أسعار رمزية للعرض التجريبي فقط.
   ========================================================= */
/* كرت توضيحي محلي واحد — يُبنى لأي اتجاه (ذهاب أو عودة) من المطارين الممرَّرين */
function buildLocalCard(db, f, depApt, arrApt, i, depISO, requested, retIso) {
  const key = `${depApt.iata}-${arrApt.iata}`;
  const carriers = (db.routes && db.routes[key] && db.routes[key].length)
    ? db.routes[key].slice(0, 6)
    : ["QR", "EK", "ET", "TK", "SV", "GF"]; // لا مسار مباشر مسجّل → شركات عامة للعرض
  const code = String(carriers[i % carriers.length]).toUpperCase();
  const airline = airlineName(code, db, null);
  const depTime = new Date(new Date(depISO + "T06:00:00").getTime() + (58 * i + 7) * 60000);
  const durMin = 145 + ((i * 43) % 160) + (i % 3 === 0 ? 95 : 0); // 145–400 دقيقة توضيحية
  const arrTime = new Date(depTime.getTime() + durMin * 60000);
  const plusDays = Math.max(0, Math.floor((arrTime - depTime) / 86400000));
  const arrIso = arrTime.toISOString().slice(0, 10);
  const flightNo = `${code} ${(78 + i * 17) % 990}`;
  const price = 165 + i * 34 + (durMin > 300 ? 60 : 0);
  const hh = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return {
    airline, code, flightNo,
    trip: f.trip, cls: f.cls,
    fromName: depApt.city, fromCode: depApt.iata,
    toName: arrApt.city, toCode: arrApt.iata,
    date: fmtDateSlash(depISO),
    depTime: hh(depTime),
    arrTime: hh(arrTime) + (plusDays ? ` (+${plusDays})` : ""),
    duration: `${Math.floor(durMin / 60)}س ${durMin % 60}د`,
    stops: "مباشر",
    price,
    realPrice: false, gate: "local",
    depIso: depISO, arrIso, retIso: retIso || "",
    legs: [{
      dep: depApt.iata, depName: depApt.name, depTime: hh(depTime),
      arr: arrApt.iata, arrName: arrApt.name, arrTime: hh(arrTime),
      flight: flightNo, airline, duration: durMin, dayDiff: plusDays,
    }],
    _diff: Math.abs(depTime - requested),
  };
}

/* رحلات توضيحية محلية لمسار البحث (ذهاب، أو الخطوة الأولى في ذهاب/عودة) */
async function localFallbackFlights(f) {
  const db = await loadFlightDB();
  if (!db || !db.airports) return null;
  const from = resolveAirport(f.fromRaw, db.airports);
  const to = resolveAirport(f.toRaw, db.airports);
  if (!from || !to || from.iata === to.iata) return null;
  const requested = new Date(f.depDate + "T00:00:00");
  const cards = [];
  for (let i = 0; i < 6; i++) {
    const c = buildLocalCard(db, f, from, to, i, f.depDate, requested, f.retDate);
    if (f.trip === "round") c._startingPrice = true; // في سياق ذهاب/عودة: سعر يبدأ منه
    cards.push(c);
  }
  return cards;
}

/* رحلات العودة التوضيحية — تُولَّد محلياً عند اختيار ذهاب توضيحي دون اتصال بالخادم */
async function localFallbackReturns(card) {
  const f = readFlightForm();
  if (!card || card.gate !== "local" || !f || !f.retDate) return null;
  const db = await loadFlightDB();
  if (!db || !db.airports) return null;
  const from = resolveAirport(f.fromRaw, db.airports);
  const to = resolveAirport(f.toRaw, db.airports);
  if (!from || !to || from.iata === to.iata) return null;
  const requested = new Date(f.retDate + "T00:00:00");
  const cards = [];
  for (let i = 0; i < 6; i++) {
    cards.push(buildLocalCard(db, f, to, from, i, f.retDate, requested, f.retDate));
  }
  cards.forEach((c) => { c._return = true; c._package = true; }); // الباقة كاملة (ذهاب وعودة)
  roundState.selected = card;
  roundState.returns = cards;
  return cards;
}

async function searchFlights() {
  const f = readFlightForm();
  if (!f.fromRaw || !f.toRaw) { toast("⚠️ أدخل مدينتي المغادرة والوصول"); return null; }
  if (f.from.code !== "——" && f.from.code === f.to.code) { toast("⚠️ مدينة المغادرة والوصول متطابقتان"); return null; }
  const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  if (!f.depDate) { toast("⚠️ اختر تاريخ المغادرة"); return null; }
  if (new Date(f.depDate) < today) { toast("⚠️ تاريخ المغادرة يجب أن يكون اليوم أو بعده"); return null; }
  if (f.trip === "round" && f.retDate && new Date(f.retDate) < new Date(f.depDate)) {
    toast("⚠️ تاريخ العودة يجب أن يكون بعد تاريخ المغادرة"); return null;
  }

  // ===== ذهاب وعودة: تدفق بخطوتين (SerpApi/Scrappa) — ذهاب أولاً ثم العودة عند الاختيار =====
  roundState = { step: 0, outbounds: [], selected: null, returns: [] };
  lastReturn = null;
  if (f.trip === "round" && f.retDate) {
    try {
      const out = await scrappaRoundStep1(f);
      if (out && out.length) {
        return { flights: out, real: true, source: "رحلات الذهاب — اختر ذهاباً لعرض رحلات العودة", roundStep: 1 };
      }
    } catch (e) { /* لا شيء */ }
    const local = await localFallbackFlights(f);
    if (local && local.length) {
      roundState = { step: 1, outbounds: local, selected: null, returns: [] };
      return { flights: local, real: false, source: "رحلات توضيحية محلية (دون اتصال بخادم الرحلات) — أسعار للعرض فقط", roundStep: 1 };
    }
    return { flights: [], real: true, empty: true, roundStep: 1 };
  }

  // ===== الأسعار: وسيط Google Flights (SerpApi/Scrappa) عبر الخادم =====
  const realDeals = await serpFlightsSearch(f);
  if (realDeals && realDeals.length) {
    return { flights: realDeals, real: true, source: "أسعار من Google Flights (SerpApi/Scrappa)" };
  }
  const local = await localFallbackFlights(f);
  if (local && local.length) {
    return { flights: local, real: false, source: "رحلات توضيحية محلية (دون اتصال بخادم الرحلات) — أسعار للعرض فقط" };
  }
  return { flights: [], real: true, empty: true };
}

/* =========================================================
   شعارات شركات الطيران — تُجلَب من CDN مفرّغ ومرن من Kiwi.com
   حسب رمز الشركة IATA، مع بديل ملوّن بالأحرف عند غياب اللوكو
   ========================================================= */
/* لوكو الخطوط الجوية القطرية (QR) من مجلد المشروع — والباقي من CDN الشعارات */
const logoUrl = (code) => {
  const c = String(code || "").toUpperCase();
  if (c === "QR") return "QR_LOGO/new_qr.png"; // لوكو القطرية المفرّغ عالي الوضوح من مجلد المشروع
  return `https://images.kiwi.com/airlines/64/${c}.png`;
};

function logoFallback(name) {
  const parts = String(name || "").trim().split(/\s+/).filter((w) => /[A-Za-z\u0600-\u06FF]/.test(w));
  let ini = "";
  for (const p of parts) { ini += p[0]; if (ini.length >= 2) break; }
  return (ini || "✈").toUpperCase();
}

function logoColor(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + (ch.codePointAt(0) || 0)) % 360;
  return `hsl(${h},55%,38%)`;
}

/* ---------- فلترة النتائج حسب شركة الطيران ---------- */
let resultCache = [];
let activeFilter = -1;
let filterUniq = [];
let roundState = { step: 0, outbounds: [], selected: null, returns: [] };
let roundLoading = false;

function setEmpty(show) {
  const el = $("flightsEmpty");
  if (el) el.hidden = !show;
}

function renderFlights(flights) {
  const sl = $("srchLoading"); if (sl) sl.hidden = true;  // المؤشر يختفي فور ظهور النتائج
  rtLoading(false);
  setEmpty(flights.length === 0);
  resultCache = flights;
  // فهرس ثابت لكل كرت — لا يتغير مع الفلترة (اختيار الذهاب والحجز يستخدمانه)
  flights.forEach((c, idx) => { if (c && typeof c === "object") c._idx = idx; });
  activeFilter = -1;
  buildFilterBar();
  renderCards(flights);
}

/* عناوين وأدوات تدفق ذهاب/عودة */
function rtHeading(html) {
  const el = $("rtHeading");
  if (!el) return;
  if (!html) { el.hidden = true; el.innerHTML = ""; return; }
  el.innerHTML = html;
  el.hidden = false;
}
function rtLoading(show, msg) {
  const el = $("rtLoading");
  if (!el) return;
  if (show) {
    if (msg) { const b = el.querySelector("b"); if (b) b.textContent = msg; }
    el.hidden = false;
  } else el.hidden = true;
}
function showRoundHeading(step, card) {
  if (step === 1) {
    rtHeading(`<div class="rt-head-inner">
      <h2>🛫 اختر رحلة الذهاب</h2>
      <p>اضغط على كرت أي رحلة ذهاب لعرض رحلات العودة المناسبة له مع سعر الباقة الكامل</p>
    </div>`);
  } else {
    rtHeading(`<div class="rt-head-inner">
      <h2>🔁 اختر رحلة العودة الآن</h2>
      <p>ذهابك المختار: <b>${escapeHtml(card.airline)} ${escapeHtml(card.flightNo)}</b> · ${card.date} · ${card.depTime} <span>←</span> ${card.arrTime} · ${card.stops} · يبدأ من ${fmtNum(card.price, "USD")} USD</p>
      <button type="button" class="btn btn-ghost" data-round-back>↩ تغيير رحلة الذهاب</button>
    </div>`);
  }
}
async function selectRoundOutbound(i) {
  const card = roundState.outbounds[i];
  if (!card || roundLoading) return;
  lastReturn = null; // اختيار ذهاب جديد يُلغي أي عودة سابقة — يجب إعادة اختيارها
  if (card.gate === "local") {
    // رحلات توضيحية محلية بلا خادم: توليد رحلات العودة محلياً أيضاً
    roundLoading = true;
    rtHeading(null);
    $("flightsList").innerHTML = ""; // تظهر بطاقة مؤشر تحميل العودة وحدها (بلا blur)
    setEmpty(false);
    rtLoading(true, "تجهيز رحلات العودة التوضيحية…");
    const cards = await localFallbackReturns(card);
    roundLoading = false;
    rtLoading(false);
    if (!cards || !cards.length) {
      toast("ℹ️ لا توجد رحلات عودة لهذا الذهاب — اختر رحلة أخرى");
      renderFlights(roundState.outbounds);
      showRoundHeading(1);
      return;
    }
    roundState.step = 2;
    renderFlights(cards);
    showRoundHeading(2, card);
    $("flight-results").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (!card._departureToken) { toast("ℹ️ هذه الرحلة لا تدعم جلب رحلات العودة — اختر أخرى"); return; }
  roundLoading = true;
  rtHeading(null);
  // إخفاء نتائج الذهاب كلياً لتظهر بطاقة مؤشر تحميل العودة وحدها (بلا blur)
  $("flightsList").innerHTML = "";
  setEmpty(false);
  rtLoading(true, "جلب رحلات العودة لرحلتك المختارة…");
  const cards = await scrappaRoundReturns(card);
  roundLoading = false;
  rtLoading(false);
  if (!cards || !cards.length) {
    toast("ℹ️ لا توجد رحلات عودة لهذا الذهاب — اختر رحلة أخرى");
    renderFlights(roundState.outbounds);
    showRoundHeading(1);
    return;
  }
  roundState.step = 2;
  renderFlights(cards);
  showRoundHeading(2, card);
  $("flight-results").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* اختيار رحلة العودة بالضغط على كرتها — كمثل النقر على كرت الذهاب تماماً */
async function selectRoundReturn(i) {
  const card = roundState.returns[i];
  const out = roundState.selected;
  if (!card || !out || roundLoading) return;
  lastFlight = out;      // رحلة الذهاب المختارة
  lastReturn = card;     // رحلة العودة المختارة
  roundState.step = 1;   // نعود لعرض رحلات الذهاب في وضع الاختيار الصحيح
  roundState.returnCard = card;
  renderFlights(roundState.outbounds);
  showRoundHeading(1);
  $("flight-results").scrollIntoView({ behavior: "smooth", block: "start" });
  confirmRoundBooking(out, card);
}

/* ملخص حجز موحّد: الذهاب والعودة معاً، والتذكرة تبني المقاطع من الاثنتين */
function confirmRoundBooking(out, ret) {
  const form = readFlightForm();
  const childPrice = Math.round(ret.price * 0.75);
  const infantPrice = Math.round(ret.price * 0.10);
  const total = form.adults * ret.price + form.children * childPrice + form.infants * infantPrice;
  const ref = "QB-" + uid().toUpperCase();
  const order = {
    ref,
    flightNo: `${out.flightNo} → ${ret.flightNo}`,
    airline: `${out.airline} → ${ret.airline}`,
    route: `${out.fromName} ← ${out.toName} → ${ret.fromName} ← ${ret.toName}`,
    date: `${out.date} → ${ret.date}`,
    time: `${out.depTime} — ${out.arrTime} / ${ret.depTime} — ${ret.arrTime}`,
    cls: CLASS_LABEL[out.cls], trip: TRIP_LABEL[out.trip],
    pax: `${form.adults} بالغ / ${form.children} طفل / ${form.infants} رضيع`,
    total, createdAt: toYmd(new Date()),
  };
  try { localStorage.setItem(FLIGHT_STORAGE_KEY, JSON.stringify(order)); } catch (e) {}
  $("bs-ref").textContent = ref;
  $("bs-route").textContent = `${out.airline} — ${out.fromName} ← ${out.toName}  →  ${ret.airline} — ${ret.fromName} ← ${ret.toName}`;
  $("bs-date").textContent = `ذهاب ${out.date} · عودة ${ret.date} (${TRIP_LABEL[out.trip]})`;
  $("bs-class").textContent = CLASS_LABEL[out.cls];
  $("bs-pax").textContent = order.pax;
  $("bs-time").textContent = `${out.depTime} — ${out.arrTime} · عودة ${ret.depTime} — ${ret.arrTime}`;
  $("bs-flight").textContent = `${out.flightNo} → ${ret.flightNo}`;
  $("bs-total").textContent = `${fmtNum(total, "USD")} USD`;
  $("booking-summary").hidden = false;
  buildPaxNameRows();
  $("paxNamesBox").hidden = false;
  $("ticket-template").hidden = false;
  $("paxNamesBox").scrollIntoView({ behavior: "smooth", block: "center" }); // تمرير تلقائي إلى حقول أسماء المسافرين
  toast(`👥 رحلتك محددة ✓ — أدخل أسماء المسافرين الآن ثم اضغط «إنشاء التذكرة» لإتمام الحجز`);
}

/* حجز مبدئي لرحلة ذهاب فقط — مثل ملخص العودة مع بطاقة واحدة */
function confirmBooking(card) {
  const form = readFlightForm();
  const childPrice = Math.round(card.price * 0.75);
  const infantPrice = Math.round(card.price * 0.10);
  const total = form.adults * card.price + form.children * childPrice + form.infants * infantPrice;
  const ref = "QB-" + uid().toUpperCase();
  const order = {
    ref,
    flightNo: card.flightNo,
    airline: card.airline,
    route: `${card.fromName} ← ${card.toName}`,
    date: card.date,
    time: `${card.depTime} — ${card.arrTime}`,
    cls: CLASS_LABEL[card.cls], trip: TRIP_LABEL[card.trip],
    pax: `${form.adults} بالغ / ${form.children} طفل / ${form.infants} رضيع`,
    total, createdAt: toYmd(new Date()),
  };
  try { localStorage.setItem(FLIGHT_STORAGE_KEY, JSON.stringify(order)); } catch (e) {}
  lastFlight = card;
  lastReturn = null;
  $("bs-ref").textContent = ref;
  $("bs-route").textContent = `${card.airline} — ${card.fromName} ← ${card.toName}`;
  $("bs-date").textContent = `${card.date} (${TRIP_LABEL[card.trip] || "ذهاب فقط"})`;
  $("bs-class").textContent = CLASS_LABEL[card.cls];
  $("bs-pax").textContent = order.pax;
  $("bs-time").textContent = `${card.depTime} — ${card.arrTime}`;
  $("bs-flight").textContent = card.flightNo;
  $("bs-total").textContent = `${fmtNum(total, "USD")} USD`;
  $("booking-summary").hidden = false;
  buildPaxNameRows();
  $("paxNamesBox").hidden = false;
  $("ticket-template").hidden = false;
  $("paxNamesBox").scrollIntoView({ behavior: "smooth", block: "center" }); // تمرير تلقائي إلى حقول أسماء المسافرين
  toast(`👥 رحلتك محددة ✓ — أدخل أسماء المسافرين الآن ثم اضغط «إنشاء التذكرة» لإتمام الحجز`);
}

/* =========================================================
   قاعدة بيانات الطيران المدمجة (OpenFlights → ملفات /data)
   ---------------------------------------------------------
   airports.json : { IATA → [الاسم، المدينة، الدولة، خط عرض، خط طول، فرق التوقيت، ICAO] }
   airlines.json : { IATA → اسم شركة الطيران }
   routes.json   : { "من-إلى" → [رموز الشركات] }
   تُحمَّل مرة واحدة وتُخزَّن في المتغير العام flightDB
   (تستخدمه التذكرة مباشرة: أسماء الشركات والمطارات).
   ========================================================= */
let flightDB = null;

/* الأسماء العربية للمدن الشهيرة → رمز IATA (للبحث الفوري ولحل المدخلات) */
const CITY_ALIAS = {
  // العراق
  "بغداد": "BGW", "أربيل": "EBL", "البصرة": "BSR", "النجف": "NJF",
  "السليمانية": "ISU", "الموصل": "OSM", "كركوك": "KIK",
  // الخليج
  "دبي": "DXB", "أبو ظبي": "AUH", "أبوظبي": "AUH", "الشارقة": "SHJ",
  "الكويت": "KWI", "المنامة": "BAH", "منامة": "BAH", "الدوحة": "DOH",
  "مسقط": "MCT", "صلالة": "SLL",
  // الجزيرة والعالم العربي
  "الرياض": "RUH", "جدة": "JED", "الدمام": "DMM", "المدينة المنورة": "MED", "مكة المكرمة": "JED",
  "عمّان": "AMM", "عمان": "AMM", "بيروت": "BEY", "دمشق": "DAM", "حلب": "ALP",
  "صنعاء": "SAH", "عدن": "ADE", "طهران": "IKA",
  "القاهرة": "CAI", "الإسكندرية": "HBE", "الغردقة": "HRG", "شرم الشيخ": "SSH",
  "طرابلس": "TIP", "بنغازي": "BEN", "تونس": "TUN", "الجزائر": "ALG", "وهران": "ORN",
  "الدار البيضاء": "CMN", "الرباط": "RBA", "مراكش": "RAK", "الخرطوم": "KRT",
  "جوبا": "JUB", "أديس أبابا": "ADD", "نيروبي": "NBO", "لاغوس": "LOS",
  "أبوجا": "ABV", "أكرا": "ACC", "داكار": "DSS", "أبيدجان": "ABJ",
  "جوهانسبرغ": "JNB", "كيب تاون": "CPT",
  // تركيا وأوروبا
  "إسطنبول": "IST", "أنقرة": "ESB", "إزمير": "ADB", "أنطاليا": "AYT",
  "لندن": "LHR", "باريس": "CDG", "أمستردام": "AMS", "فرانكفورت": "FRA",
  "ميونخ": "MUC", "فيينا": "VIE", "روما": "FCO", "ميلانو": "MXP",
  "مدريد": "MAD", "برشلونة": "BCN", "لشبونة": "LIS", "أثينا": "ATH",
  "زيوريخ": "ZRH", "بروكسل": "BRU", "ستوكهولم": "ARN", "أوسلو": "OSL",
  "كوبنهاغن": "CPH", "هلسنكي": "HEL", "وارسو": "WAW", "موسكو": "SVO",
  "كييف": "KBP", "تبليسي": "TBS", "يريفان": "EVN", "باكو": "GYD",
  // أمريكا وآسيا
  "نيويورك": "JFK", "لوس أنجلوس": "LAX", "واشنطن": "IAD", "شيكاغو": "ORD",
  "دالاس": "DFW", "هيوستن": "IAH", "سان فرانسيسكو": "SFO", "تورونتو": "YYZ",
  "مونتريال": "YUL", "فانكوفر": "YVR", "تل أبيب": "TLV",
  "بانكوك": "BKK", "كوالالمبور": "KUL", "سنغافورة": "SIN", "طوكيو": "NRT",
  "أوساكا": "KIX", "سيول": "ICN", "بكين": "PEK", "شنغهاي": "PVG",
  "غوانزو": "CAN", "هونغ كونغ": "HKG", "تايبيه": "TPE", "مانيلا": "MNL",
  "جاكرتا": "CGK", "دلهي": "DEL", "مومباي": "BOM", "كراتشي": "KHI",
  "لاهور": "LHE", "إسلام آباد": "ISB", "كابل": "KBL", "كابول": "KBL",
  "عشق أباد": "ASB", "طشقند": "TAS", "ألماتي": "ALA",
};

/* تحميل قاعدة بيانات الطيران من ملفات /data (مع تخزين في flightDB) */
async function loadFlightDB() {
  if (flightDB) return flightDB;
  try {
    const [ap, al, rt] = await Promise.all([
      fetch("data/airports.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("data/airlines.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})),
      fetch("data/routes.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})),
    ]);
    if (!ap) return null;
    flightDB = { airports: ap || {}, airlines: al || {}, routes: rt || {} };
  } catch (e) {
    flightDB = null;
  }
  return flightDB;
}

/* اسم شركة الطيران الإنجليزي من قاعدة البيانات (أو السقوط على البديل/الكود) */
function airlineName(code, db, fb) {
  const key = String(code || "").toUpperCase();
  const a = (db && db.airlines) ? db.airlines[key] : null;
  return a || String(fb || code || "").trim() || key;
}

/* عدّاد المسارات لكل مطار (يُبنى مرة واحدة من routes.json) —
   يُستخدم لكسر التعادل بين مطارات متعددة في المدينة نفسها لصالح الأكثر نشاطاً */
let flightRouteCount = null;
function routeCountMap() {
  if (flightRouteCount) return flightRouteCount;
  flightRouteCount = new Map();
  const rt = flightDB ? flightDB.routes : null;
  if (rt) {
    for (const k of Object.keys(rt)) {
      const dash = k.indexOf("-");
      if (dash > 0) {
        const o = k.slice(0, dash);
        flightRouteCount.set(o, (flightRouteCount.get(o) || 0) + 1);
      }
    }
  }
  return flightRouteCount;
}

/* ترتيب اقتراحات المطارات: الرمز أولاً ثم المدينة ثم الاسم ثم الدولة */
function rankAirport(iata, a, ql, qUp) {
  if (!a || !ql) return 0;
  const name = String(a[0] || "");
  const city = String(a[1] || "");
  const icao = String(a[6] || "");
  const nl = name.toLowerCase(), cl = city.toLowerCase();
  let s;
  if (iata === qUp) s = 1000;                          // رمز IATA مطابق
  else if (icao && icao === qUp) s = 990;              // رمز ICAO مطابق
  else if (cl === ql) s = 950;                         // المدينة مطابقة تماماً
  else if (cl.startsWith(ql) && cl.length - ql.length <= 3) s = 900 - cl.length;
  else if (cl.startsWith(ql)) s = 820 - cl.length;
  else if (nl.startsWith(ql)) s = 700 - Math.min(30, nl.length);
  else if (cl.includes(ql)) s = 500 - Math.min(40, cl.length);
  else if (nl.includes(ql)) s = 420;
  else if (String(a[2] || "").toLowerCase().includes(ql)) s = 300;
  else return 0;
  if (s < 1000) s += Math.min(40, routeCountMap().get(iata) || 0);
  return s;
}

/* تحويل مدخل المستخدم إلى مطار:
   "بغداد (BGW)" / "BGW" / "Dubai" / اسم عربي في CITY_ALIAS … → { iata, city, name, code } */
function resolveAirport(raw, airports) {
  const s = String(raw || "").trim();
  if (!s || !airports) return null;
  const aliasCode = CITY_ALIAS[s];
  if (aliasCode && airports[aliasCode]) {
    const a = airports[aliasCode];
    return { iata: aliasCode, city: a[1], name: a[0], code: aliasCode };
  }
  const m = s.match(/\(([A-Za-z]{3})\)/);
  const code = (m ? m[1] : s).toUpperCase();
  if (m && airports[code]) {
    const a = airports[code];
    return { iata: code, city: a[1], name: a[0], code };
  }
  if (/^[A-Z]{3}$/.test(code) && airports[code]) {
    const a = airports[code];
    return { iata: code, city: a[1], name: a[0], code };
  }
  const ql = s.toLowerCase();
  let best = null;
  let exact = null, bestRc = -1;
  for (const [k, a] of Object.entries(airports)) {
    const name = String(a[0] || "").toLowerCase();
    const city = String(a[1] || "").toLowerCase();
    if (name === ql || city === ql) {
      // مطابقة تامة للمدينة/الاسم: نفضّل المطار الأكثر نشاطاً بالمسارات (مثلاً BKK على DMK)
      const rc = routeCountMap().get(k) || 0;
      if (rc > bestRc) { exact = { iata: k, city: a[1], name: a[0], code: k }; bestRc = rc; }
      continue;
    }
    if (!best && (name.startsWith(ql) || city.startsWith(ql))) best = { iata: k, city: a[1], name: a[0], code: k };
    if (!best && (name.includes(ql) || city.includes(ql))) best = { iata: k, city: a[1], name: a[0], code: k };
  }
  return exact || best;
}

/* =========================================================
   بطاقات نتائج الرحلات + فلتر شركات الطيران
   ========================================================= */
function timeHM(t) {
  const s = String(t || "");
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? `${String(+m[1]).padStart(2, "0")}:${m[2]}` : "——";
}

/* أيقونة الشركة في الكرت مع بديل ملوّن بالأحرف عند فشل التحميل */
function airlineLogo(code, name) {
  return `<span class="alogo-wrap"><img class="alogo" src="${logoUrl(code)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="alogo-fallback" style="display:none;background:${logoColor(name)}">${escapeHtml(logoFallback(name))}</span></span>`;
}
function chipLogo(code, name) {
  return `<span class="chip-logo-wrap"><img class="chip-logo" src="${logoUrl(code)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="chip-logo-fb" style="display:none;background:${logoColor(name)}">${escapeHtml(logoFallback(name))}</span></span>`;
}

/* مخطط الرحلة داخل الكرت (يظهر للرحلات المتعددة المحطات فقط) */
function itinHTML(c) {
  const legs = c.legs || [];
  if (legs.length < 2) return "";
  let out = '<div class="fc-itin">';
  legs.forEach((l, i) => {
    const isLast = i === legs.length - 1;
    const air = String(l.airline || c.airline || "").trim();
    const flight = String(l.flight || c.flightNo || "").trim();
    out += `<div class="itn-leg">
      <div class="itn-cell">
        <span class="itn-tag">${i === 0 ? "انطلاق" : "توقف"}</span>
        <span class="itn-time">${timeHM(l.depTime)}</span>
        ${l.depTime ? `<span class="itn-date">${escapeHtml(fmtDateSlash(l.depTime.slice(0, 10)))}</span>` : ""}
        <span class="itn-apt">${escapeHtml(l.depName || l.dep)} <small>${escapeHtml(l.dep)}</small></span>
      </div>
      <div class="itn-route">
        <span class="itn-air">${escapeHtml(air)} · ${escapeHtml(flight)}</span>
        <span class="itn-line">——— ✈ ———</span>
        ${l.duration ? `<span class="itn-dur">${escapeHtml(String(l.duration))}</span>` : ""}
      </div>
      <div class="itn-cell ${isLast ? "itn-arr" : ""}">
        <span class="itn-tag">${isLast ? "وصول" : "محطة"}</span>
        <span class="itn-time">${timeHM(l.arrTime)}${l.dayDiff ? `<i class="itn-plus">+${l.dayDiff}</i>` : ""}</span>
        ${l.arrTime ? `<span class="itn-date${l.dayDiff ? " itn-date-warn" : ""}">${escapeHtml(fmtDateSlash(l.arrTime.slice(0, 10)))}</span>` : ""}
        <span class="itn-apt">${escapeHtml(l.arrName || l.arr)} <small>${escapeHtml(l.arr)}</small></span>
      </div>
    </div>`;
    if (!isLast) out += `<div class="itn-stop">🕐 توقف رقم ${i + 1} — ${escapeHtml(l.arrName || l.arr)}</div>`;
  });
  return out + "</div>";
}

/* بناء كرت الرحلة الواحد — مع خصائص اختيار الذهاب/العودة أو زر الحجز المبدئي */
function cardHTML(c) {
  const isOut = roundState.step === 1 && c && (c._departureToken || c.gate === "local");
  const isRet = !!(c && c._return);
  const selectable = (isOut || isRet) ? " rt-selectable" : "";
  const data = isOut ? `data-outbound="${c._idx}"` : (isRet ? `data-return="${c._idx}"` : "");
  const gateLbl = c.gate === "scrappa" ? "Scrappa" : "Google Flights";
  const dur = String(c.duration || "").trim() || "—";
  const cls = CLASS_LABEL[c.cls] || c.cls || "اقتصادية";
  /* تواريخ الانطلاق والوصول — يُحمرّ تاريخ الوصول إن كان في اليوم التالي أو بعده */
  const depDate = c.depIso ? fmtDateSlash(c.depIso) : (c.date || "");
  const arrDate = c.arrIso ? fmtDateSlash(c.arrIso) : depDate;
  const dayN = isoDayDiff(c.depIso, c.arrIso);
  const arrWarn = dayN > 0;
  let priceNote;
  if (c._package) priceNote = "الباقة كاملة (ذهاب وعودة) لكل بالغ";
  else if (c._startingPrice) priceNote = "سعر يبدأ منه — لكل بالغ (ذهاب)";
  else priceNote = "لكل بالغ";
  const priceCaption = c._package ? "سعر الباقة لكل بالغ" : "السعر لكل بالغ";
  const btn = (isOut || isRet)
    ? ""
    : `<button type="button" class="btn btn-primary" data-book="${c._idx}">🎟️ اختر الرحلة</button>`;
  return `<div class="flight-card${selectable}" ${data}>
  <div class="fc-head">
    <span class="fc-airline">${airlineLogo(c.code, c.airline)} ${escapeHtml(c.airline)}</span>
    <span class="fc-num">${escapeHtml(c.flightNo)}</span>
  </div>
  <div class="fc-route">
    <div class="fc-leg"><small>${escapeHtml(c.fromCode)}</small><b>${timeHM(c.depTime)}</b><i class="fc-date">${escapeHtml(depDate)}</i></div>
    <span class="fc-arrow">←</span>
    <div class="fc-leg"><small>${escapeHtml(c.toCode)}</small><b>${escapeHtml(c.arrTime)}</b><i class="fc-date${arrWarn ? " fc-date-warn" : ""}">${escapeHtml(arrDate)}</i>${arrWarn ? `<i class="itn-plus">+${dayN}يوم</i>` : ""}</div>
  </div>
  <div class="fc-meta">
    <span>📅 ${escapeHtml(c.date)}</span>
    <span>⏱ ${escapeHtml(dur)}</span>
    <span>🛬 ${escapeHtml(c.stops || "مباشر")}</span>
    <span>💺 ${escapeHtml(cls)}</span>
    ${c.realPrice ? `<span class="rb">✓ ${escapeHtml(gateLbl)}</span>` : ""}
  </div>
  ${itinHTML(c)}
  <div class="fc-price-row">
    <div class="fc-price">
      <span>${priceCaption}</span>
      <b>${fmtNum(c.price, "USD")} USD</b>
      <small>${priceNote}</small>
    </div>
    ${btn}
  </div>
</div>`;
}

/* فلتر النتائج حسب شركة الطيران — يُبنى من النتائج المعروضة */
function buildFilterBar() {
  const bar = $("flightsFilter");
  if (!bar) return;
  const counts = new Map();
  resultCache.forEach((c) => {
    const k = c && c.code ? String(c.code).toUpperCase() : "";
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  });
  filterUniq = [...counts.keys()];
  bar.innerHTML = "";
  if (filterUniq.length <= 1) { bar.hidden = true; activeFilter = -1; return; }
  bar.hidden = false;
  const all = resultCache.length;
  let html = `<button type="button" class="filter-chip active" data-f="-1">الكل <b>${all}</b></button>`;
  html += filterUniq.map((code, i) => {
    const c = resultCache.find((x) => x && x.code && String(x.code).toUpperCase() === code);
    const nm = c ? c.airline : code;
    return `<button type="button" class="filter-chip" data-f="${i}">${chipLogo(code, nm)}${escapeHtml(nm)} <b>${counts.get(code)}</b></button>`;
  }).join("");
  bar.innerHTML = html;
  bar.querySelectorAll(".filter-chip").forEach((ch) => ch.addEventListener("click", () => {
    activeFilter = parseInt(ch.dataset.f, 10);
    bar.querySelectorAll(".filter-chip").forEach((o) => o.classList.toggle("active", o === ch));
    renderCards(resultCache);
  }));
}

/* رسم بطاقات النتائج (مع احترام فلتر الشركة وفهرس _idx الثابت للاختيار) */
function renderCards(flights) {
  const list = $("flightsList");
  if (!list) return;
  const source = Array.isArray(flights) ? flights : resultCache;
  const shown = (activeFilter < 0)
    ? source
    : source.filter((c) => c && c.code && String(c.code).toUpperCase() === filterUniq[activeFilter]);
  setEmpty(shown.length === 0);
  list.innerHTML = shown.map(cardHTML).join("");
  shown.forEach((c) => {
    const b = list.querySelector(`button[data-book="${c._idx}"]`);
    if (b) b.addEventListener("click", () => confirmBooking(c));
  });
}
