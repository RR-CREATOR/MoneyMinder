const path = require("path");
const crypto = require("crypto");
const fs = require("node:fs");
const db = require("./db");
const { addPaise, allocatePaise, parseMoney, toPaise } = require("./money");
const { dateKey, monthInfo, isDateKey } = require("./time");
const { asyncRoute, idempotencyKey, isCurrentUser } = require("./http");
const uploads = require("./uploads");

const BUCKETS = ["food", "travel", "housing", "misc", "other"];
const MAX_RECEIPTS_PER_USER = 1000;

function zeroBuckets() {
  return { food: 0, travel: 0, housing: 0, misc: 0, other: 0 };
}

// Map a receipt category to a dashboard bucket. Accepts our canonical bucket
// names (food/travel/housing/misc/other) plus legacy/OCR vocabulary
// (transport/accommodation/...), so a manually-tagged or OCR-tagged receipt
// lands where the user expects.
function bucket(category) {
  const c = String(category || "").toLowerCase();
  if (c === "food") return "food";
  if (c === "travel" || ["transport", "gasoline", "parking", "toll"].includes(c)) return "travel";
  if (c === "housing" || c === "accommodation") return "housing";
  if (c === "misc") return "misc";
  if (c === "other") return "other";
  return "misc";
}

// A household expense already carries a real category; trust it but fall back
// to "other" for anything missing or unknown (old rows have no category).
function expenseBucket(category) {
  const c = String(category || "").toLowerCase();
  return BUCKETS.includes(c) ? c : "other";
}

// First 7 chars (YYYY-MM) of any date-ish string.
function ym(d) {
  return String(d).slice(0, 7);
}
// A receipt's month: prefer its ISO `date` (YYYY-MM-...), else fall back to
// createdAt (old rows have free-text or empty dates).
function receiptYM(r) {
  return /^\d{4}-\d{2}/.test(String(r.date || "")) ? ym(r.date) : ym(dateKey(new Date(r.createdAt)));
}
function expenseYM(e) {
  return /^\d{4}-\d{2}/.test(String(e.date || "")) ? ym(e.date) : ym(dateKey(new Date(e.createdAt)));
}

function sharedSharePaise(expense, userKey) {
  const allocation = allocatePaise(expense.amount, expense.splitAmong, expense.paidBy);
  return allocation && Object.hasOwn(allocation, userKey) ? allocation[userKey] : null;
}

function receiptView(receipt) {
  const { operationKey: _operationKey, ...view } = receipt;
  return view;
}

function sameReceiptInput(left, right) {
  return ["category", "date", "amount", "supplier", "document", "image"]
    .every((fieldName) => left[fieldName] === right[fieldName]);
}

// Cost of living = your personal receipts + your share of every shared expense
// you're split into, bucketed together. Scoped to the CURRENT calendar month.
function costOfLiving(data, userKey, now = new Date()) {
  const currentMonth = monthInfo(now).month;
  const categoryPaise = zeroBuckets();
  let personalPaise = 0;
  let sharedPaise = 0;
  for (const r of Object.values(data.receipts || {})) {
    if (r.userKey !== userKey) continue;
    if (receiptYM(r) !== currentMonth) continue;
    const amount = toPaise(r.amount);
    if (amount === null) continue;
    const category = bucket(r.category);
    categoryPaise[category] = addPaise(categoryPaise[category], amount);
    personalPaise = addPaise(personalPaise, amount);
  }
  for (const e of Object.values(data.expenses || {})) {
    if (expenseYM(e) !== currentMonth) continue;
    const share = sharedSharePaise(e, userKey);
    if (share === null) continue;
    const category = expenseBucket(e.category);
    categoryPaise[category] = addPaise(categoryPaise[category], share);
    sharedPaise = addPaise(sharedPaise, share);
  }
  const categories = Object.fromEntries(
    Object.entries(categoryPaise).map(([category, amount]) => [category, amount / 100]),
  );
  const personalSpent = personalPaise / 100;
  const sharedShare = sharedPaise / 100;
  return {
    categories,
    personalSpent,
    sharedShare,
    spent: addPaise(personalPaise, sharedPaise) / 100,
  };
}

async function listReceipts(req, res) {
  const data = await db.load();
  const mine = Object.values(data.receipts)
    .filter((r) => r.userKey === req.userKey)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(receiptView);
  res.json({ receipts: mine });
}

function field(value, max) {
  const text = String(value || "").trim();
  return text.length <= max ? text : null;
}

async function addReceipt(req, res) {
  const operationKey = idempotencyKey(req);
  if (operationKey === null) return res.status(400).json({ error: "Invalid Idempotency-Key" });
  const { category, date, amount, supplier, document, image } = req.body || {};
  const amt = parseMoney(amount);
  if (amt === null) return res.status(400).json({ error: "Invalid amount" });
  const values = {
    category: field(category || "miscellaneous", 32),
    date: field(date, 10),
    supplier: field(supplier, 120),
    document: field(document, 120),
    image: field(image, 100),
  };
  if (Object.values(values).some((value) => value === null) || (values.date && !isDateKey(values.date))) {
    return res.status(400).json({ error: "Invalid receipt fields" });
  }
  if (values.image) {
    try {
      values.image = path.basename(values.image);
      uploads.imagePath(req.userKey, values.image);
    } catch {
      return res.status(400).json({ error: "Invalid image name" });
    }
  }
  const id = crypto.randomUUID();
  const receipt = {
    id,
    userKey: req.userKey,
    category: values.category,
    date: values.date,
    amount: amt,
    supplier: values.supplier,
    document: values.document,
    image: values.image,
    createdAt: new Date().toISOString(),
    ...(operationKey ? { operationKey } : {}),
  };
  const stored = await db.update(async (d) => {
    if (!isCurrentUser(d, req)) return { unauthorized: true };
    const existing = operationKey && Object.values(d.receipts)
      .find((item) => item.userKey === req.userKey && item.operationKey === operationKey);
    if (existing) {
      return sameReceiptInput(existing, receipt)
        ? { receipt: existing }
        : { conflict: true };
    }
    if (values.image) {
      try {
        await fs.promises.access(uploads.imagePath(req.userKey, values.image), fs.constants.R_OK);
      } catch {
        return { missingImage: true };
      }
    }
    const count = Object.values(d.receipts).filter((item) => item.userKey === req.userKey).length;
    if (count >= MAX_RECEIPTS_PER_USER) return { limit: true };
    d.receipts[id] = receipt;
    return { receipt };
  });
  if (stored.unauthorized) return res.status(401).json({ error: "Not authenticated" });
  if (stored.conflict) return res.status(409).json({ error: "Idempotency-Key was already used for another receipt" });
  if (stored.missingImage) return res.status(409).json({ error: "Receipt image is no longer available; scan it again" });
  if (stored.limit) return res.status(413).json({ error: "Receipt limit reached; delete old receipts first" });
  res.json({ ok: true, receipt: receiptView(stored.receipt) });
}

// One receipt, but only if it's yours.
async function getReceipt(req, res) {
  const r = (await db.load()).receipts[req.params.id];
  if (!r || r.userKey !== req.userKey) return res.status(404).json({ error: "Not found" });
  res.json({ receipt: receiptView(r) });
}

// Delete a receipt you own (lets a user remove a wrong OCR scan or a duplicate).
async function deleteReceipt(req, res) {
  const id = req.params.id;
  const removed = await db.update((d) => {
    if (!isCurrentUser(d, req)) return { unauthorized: true };
    const r = d.receipts[id];
    if (!r || r.userKey !== req.userKey) return false;
    delete d.receipts[id];
    const referenced = r.image && Object.values(d.receipts)
      .some((other) => other.userKey === req.userKey && other.image === r.image);
    if (r.image && !referenced) uploads.queueImageDelete(d, req.userKey, r.image);
    return true;
  });
  if (removed?.unauthorized) return res.status(401).json({ error: "Not authenticated" });
  if (!removed) return res.status(404).json({ error: "Not found" });
  await db.scrubBackup();
  await uploads.retryPendingDeletes();
  res.json({ ok: true });
}

async function summary(req, res) {
  const data = await db.load();
  const user = data.users[req.userKey];
  const budget = Number(user && user.budget) || 0;
  const { categories, personalSpent, sharedShare, spent } = costOfLiving(data, req.userKey);
  const { day, daysInMonth: daysInCurrentMonth } = monthInfo();
  const dailyBudget = budget / daysInCurrentMonth;
  res.json({
    budget,
    dailyBudget,
    spent,
    personalSpent,
    sharedShare,
    categories,
    onTrack: spent <= dailyBudget * day,
  });
}

// An item's day: prefer its ISO `date` (YYYY-MM-DD), else fall back to the
// date portion of createdAt. One rule for both window keys and item bucketing.
function dayOf(item) {
  return /^\d{4}-\d{2}-\d{2}/.test(String(item.date || ""))
    ? String(item.date).slice(0, 10)
    : dateKey(new Date(item.createdAt));
}

// Last 14 days of spend for the charts: category buckets (current month, like
// the dashboard) plus a per-day series of personal receipts + shared share.
async function insights(req, res) {
  const data = await db.load();
  const { categories } = costOfLiving(data, req.userKey);
  const days = [];
  const byDate = {};
  for (let i = 13; i >= 0; i--) {
    const key = dateKey(new Date(Date.now() - i * 86400000));
    byDate[key] = 0;
    days.push(key);
  }
  for (const r of Object.values(data.receipts || {})) {
    if (r.userKey !== req.userKey) continue;
    const day = dayOf(r);
    const amount = toPaise(r.amount);
    if (day in byDate && amount !== null) byDate[day] = addPaise(byDate[day], amount);
  }
  for (const e of Object.values(data.expenses || {})) {
    const day = dayOf(e);
    const share = sharedSharePaise(e, req.userKey);
    if (day in byDate && share !== null) byDate[day] = addPaise(byDate[day], share);
  }
  res.json({ categories, daily: days.map((date) => ({ date, amount: byDate[date] / 100 })) });
}

// Serve a receipt image, but only from the requesting user's own folder.
function image(req, res) {
  let file;
  try {
    file = uploads.imagePath(req.userKey, req.params.name);
  } catch {
    return res.status(404).end();
  }
  res.set("Cache-Control", "private, no-store");
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

function mount(app) {
  app.get("/api/summary", asyncRoute(summary));
  app.get("/api/insights", asyncRoute(insights));
  app.get("/api/receipts", asyncRoute(listReceipts));
  app.post("/api/receipts", asyncRoute(addReceipt));
  app.get("/api/receipts/:id", asyncRoute(getReceipt));
  app.delete("/api/receipts/:id", asyncRoute(deleteReceipt));
  app.get("/api/image/:name", image);
}

module.exports = { mount, bucket, expenseBucket, costOfLiving, summary };
