const crypto = require("crypto");
const db = require("./db");
const { addPaise, allocatePaise, parseMoney, toPaise } = require("./money");
const { dateKey, isDateKey } = require("./time");
const { asyncRoute, idempotencyKey, isCurrentUser } = require("./http");

const CATEGORIES = ["food", "travel", "housing", "misc", "other"];
const MAX_HOUSEHOLDS_PER_USER = 20;
const MAX_MEMBERS_PER_HOUSEHOLD = 50;
const MAX_EXPENSES_PER_HOUSEHOLD = 1000;
const MAX_EXPENSES_PER_USER = 1000;
const MAX_RECURRING_PER_HOUSEHOLD = 100;
const MAX_RECURRING_PER_USER = 200;
const MAX_SETTLEMENTS_PER_HOUSEHOLD = 1000;
const MAX_SETTLEMENTS_PER_USER = 1000;
function cleanCategory(c) {
  return CATEGORIES.includes(String(c || "").toLowerCase()) ? String(c).toLowerCase() : "other";
}

// Short, unambiguous join code (no 0/O/1/I).
function code6() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function uniqueCode(households) {
  const existing = new Set(Object.values(households || {}).map((household) => household.code));
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = code6();
    if (!existing.has(code)) return code;
  }
  return null;
}

function isMember(h, userKey) {
  return !!h && h.members.includes(userKey);
}

function activeMembers(data, household) {
  const users = data.users || {};
  return Object.keys(users).length
    ? household.members.filter((member) => Object.hasOwn(users, member))
    : household.members.slice();
}

function operationView(record) {
  const { operationKey: _operationKey, ...view } = record;
  return view;
}

function sameExpenseInput(existing, candidate, { dateSpecified, splitSpecified }) {
  if (existing.householdId !== candidate.householdId
      || existing.description !== candidate.description
      || existing.amount !== candidate.amount
      || existing.category !== candidate.category) return false;
  if (dateSpecified && existing.date !== candidate.date) return false;
  return !splitSpecified
    || JSON.stringify(existing.splitAmong) === JSON.stringify(candidate.splitAmong);
}

function sameSettlementInput(existing, candidate) {
  return existing.householdId === candidate.householdId
    && existing.from === candidate.from
    && existing.to === candidate.to
    && existing.amount === candidate.amount
    && existing.method === candidate.method;
}

function sameRecurringInput(existing, householdId, candidate) {
  return existing.householdId === householdId
    && existing.item.description === candidate.description
    && existing.item.amount === candidate.amount
    && existing.item.category === candidate.category
    && existing.item.dayOfMonth === candidate.dayOfMonth
    && JSON.stringify(existing.item.splitAmong) === JSON.stringify(candidate.splitAmong);
}

// Net balance per member: positive means the group owes them, negative means
// they owe the group.
function computeBalances(data, householdId) {
  const h = data.households[householdId];
  const netPaise = {};
  for (const m of h.members) netPaise[m] = 0;
  for (const e of Object.values(data.expenses || {})) {
    if (e.householdId !== householdId) continue;
    const amount = toPaise(e.amount);
    const split = Array.isArray(e.splitAmong)
      ? [...new Set(e.splitAmong.filter((m) => Object.hasOwn(netPaise, m)))]
      : [];
    const allocation = allocatePaise(e.amount, split, e.paidBy);
    if (amount === null || !allocation || !Object.hasOwn(netPaise, e.paidBy)) continue;
    netPaise[e.paidBy] = addPaise(netPaise[e.paidBy], amount);
    for (const [member, share] of Object.entries(allocation)) {
      netPaise[member] = addPaise(netPaise[member], -share);
    }
  }
  for (const s of Object.values(data.settlements || {})) {
    if (s.householdId !== householdId) continue;
    if (s.status === "pending") continue;
    const amount = toPaise(s.amount);
    if (amount === null || !Object.hasOwn(netPaise, s.from) || !Object.hasOwn(netPaise, s.to)) continue;
    netPaise[s.from] = addPaise(netPaise[s.from], amount);
    netPaise[s.to] = addPaise(netPaise[s.to], -amount);
  }
  const net = Object.fromEntries(Object.entries(netPaise).map(([m, value]) => [m, value / 100]));
  return { net, owes: simplify(net) };
}

// Greedy debt simplification: largest debtor pays largest creditor until flat.
function simplify(net) {
  const debtors = [];
  const creditors = [];
  for (const [m, v] of Object.entries(net)) {
    const paise = Math.round(Number(v) * 100);
    if (paise < 0) debtors.push({ m, v: -paise });
    else if (paise > 0) creditors.push({ m, v: paise });
  }
  debtors.sort((a, b) => b.v - a.v);
  creditors.sort((a, b) => b.v - a.v);
  const owes = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].v, creditors[j].v);
    owes.push({ from: debtors[i].m, to: creditors[j].m, amount: amt / 100 });
    debtors[i].v -= amt;
    creditors[j].v -= amt;
    if (debtors[i].v === 0) i++;
    if (creditors[j].v === 0) j++;
  }
  return owes;
}

async function create(req, res) {
  const operationKey = idempotencyKey(req);
  if (operationKey === null) return res.status(400).json({ error: "Invalid Idempotency-Key" });
  const name = String((req.body && req.body.name) || "").trim();
  if (!name) return res.status(400).json({ error: "Household name is required" });
  if (name.length > 100) return res.status(400).json({ error: "Household name is too long" });
  const result = await db.update((d) => {
    if (!isCurrentUser(d, req)) return { unauthorized: true };
    const households = Object.values(d.households || {});
    const existing = operationKey && households
      .find((household) => household.ownerKey === req.userKey && household.operationKey === operationKey);
    if (existing) return existing.name === name
      ? { household: existing }
      : { conflict: true };
    const count = households.filter((h) => isMember(h, req.userKey)).length;
    if (count >= MAX_HOUSEHOLDS_PER_USER) return { limit: true };
    const code = uniqueCode(d.households);
    if (!code) return { codeUnavailable: true };
    const household = {
      id: crypto.randomUUID(),
      name,
      code,
      ownerKey: req.userKey,
      members: [req.userKey],
      createdAt: new Date().toISOString(),
      ...(operationKey ? { operationKey } : {}),
    };
    d.households = { ...(d.households || {}), [household.id]: household };
    return { household };
  });
  if (result.unauthorized) return res.status(401).json({ error: "Authentication expired" });
  if (result.conflict) return res.status(409).json({ error: "Idempotency-Key was already used for another household" });
  if (result.limit) return res.status(413).json({ error: "Household limit reached" });
  if (result.codeUnavailable) return res.status(503).json({ error: "Could not allocate a household code; retry" });
  res.json({ ok: true, household: operationView(result.household) });
}

async function join(req, res) {
  const code = String((req.body && req.body.code) || "").trim().toUpperCase();
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
    return res.status(400).json({ error: "Invalid household code" });
  }
  const result = await db.update((d) => {
    if (!isCurrentUser(d, req)) return { unauthorized: true };
    const h = Object.values(d.households).find((x) => x.code === code);
    if (!h) return { notFound: true };
    if (h.members.includes(req.userKey)) return { id: h.id };
    const count = Object.values(d.households).filter((x) => isMember(x, req.userKey)).length;
    if (count >= MAX_HOUSEHOLDS_PER_USER) return { householdLimit: true };
    if (activeMembers(d, h).length >= MAX_MEMBERS_PER_HOUSEHOLD) return { memberLimit: true };
    d.households = {
      ...d.households,
      [h.id]: { ...h, members: [...h.members, req.userKey] },
    };
    return { id: h.id };
  });
  if (result.unauthorized) return res.status(401).json({ error: "Authentication expired" });
  if (result.notFound) return res.status(404).json({ error: "No household with that code" });
  if (result.householdLimit) return res.status(413).json({ error: "Household limit reached" });
  if (result.memberLimit) return res.status(413).json({ error: "Household member limit reached" });
  res.json({ ok: true, id: result.id });
}

async function list(req, res) {
  const data = await db.load();
  const mine = Object.values(data.households)
    .filter((h) => isMember(h, req.userKey))
    .map((h) => {
      const { net } = computeBalances(data, h.id);
      const shared = {
        id: h.id,
        name: h.name,
        balance: net[req.userKey] || 0,
      };
      return req.authType === "bearer"
        ? shared
        : {
            ...shared,
            code: h.code,
            members: activeMembers(data, h).length,
          };
    });
  res.json({ households: mine });
}

async function detail(req, res) {
  const data = await db.load();
  const h = data.households[req.params.id];
  if (!isMember(h, req.userKey)) return res.status(404).json({ error: "Household not found" });
  const active = activeMembers(data, h);
  const activeSet = new Set(active);
  const nameOf = (k) => (data.users[k] ? data.users[k].username : "Deleted member");
  const vpaOf = (k) => (data.users[k] && data.users[k].vpa) || "";
  const expenses = Object.values(data.expenses)
    .filter((e) => e.householdId === h.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((e) => ({
      ...operationView(e),
      category: cleanCategory(e.category),
      paidByName: nameOf(e.paidBy),
      splitNames: e.splitAmong.map(nameOf),
    }));
  const { net, owes } = computeBalances(data, h.id);
  const pendingSettlements = Object.values(data.settlements || {})
    .filter((s) => s.householdId === h.id && s.status === "pending" && (s.from === req.userKey || s.to === req.userKey))
    .map((s) => ({ ...operationView(s), fromName: nameOf(s.from), toName: nameOf(s.to) }));
  res.json({
    id: h.id,
    name: h.name,
    code: h.code,
    me: req.userKey,
    members: active.map((k) => ({ key: k, name: nameOf(k), vpa: vpaOf(k) })),
    expenses,
    balances: Object.entries(net).map(([k, v]) => ({
      key: activeSet.has(k) ? k : "",
      name: nameOf(k),
      net: v,
    })),
    owes: owes
      .filter((o) => activeSet.has(o.from) && activeSet.has(o.to))
      .map((o) => ({ from: o.from, fromName: nameOf(o.from), to: o.to, toName: nameOf(o.to), amount: o.amount })),
    pendingSettlements,
  });
}

async function addExpense(req, res) {
  const operationKey = idempotencyKey(req);
  if (operationKey === null) return res.status(400).json({ error: "Invalid Idempotency-Key" });
  const { description, amount, date, splitAmong, category } = req.body || {};
  const amt = parseMoney(amount);
  if (amt === null) return res.status(400).json({ error: "Amount must be greater than 0" });
  const label = String(description || "Expense").trim();
  if (!label || label.length > 256) return res.status(400).json({ error: "Invalid description" });
  const expenseDate = date ? String(date) : dateKey();
  if (!isDateKey(expenseDate)) return res.status(400).json({ error: "Invalid date" });
  const result = await db.update((d) => {
    if (!isCurrentUser(d, req)) return { unauthorized: true };
    const h = d.households[req.params.id];
    if (!isMember(h, req.userKey)) return { forbidden: true };
    const members = activeMembers(d, h);
    let split = Array.isArray(splitAmong) && splitAmong.length
      ? [...new Set(splitAmong.filter((m) => members.includes(m)))]
      : members.slice();
    if (!split.length) split = members.slice();
    const id = crypto.randomUUID();
    const expense = {
      id,
      householdId: h.id,
      paidBy: req.userKey,
      description: label,
      amount: amt,
      category: cleanCategory(category),
      splitAmong: split,
      date: expenseDate,
      createdAt: new Date().toISOString(),
      ...(operationKey ? { operationKey } : {}),
    };
    const expenses = Object.values(d.expenses || {});
    const existing = operationKey && expenses
      .find((item) => item.paidBy === req.userKey && item.operationKey === operationKey);
    if (existing) {
      return sameExpenseInput(existing, expense, {
        dateSpecified: !!date,
        splitSpecified: Array.isArray(splitAmong) && splitAmong.length > 0,
      })
        ? { id: existing.id }
        : { conflict: true };
    }
    if (expenses.filter((e) => e.paidBy === req.userKey).length >= MAX_EXPENSES_PER_USER) {
      return { userLimit: true };
    }
    if (expenses.filter((e) => e.householdId === h.id).length >= MAX_EXPENSES_PER_HOUSEHOLD) {
      return { limit: true };
    }
    d.expenses = { ...(d.expenses || {}), [id]: expense };
    return { id };
  });
  if (result.unauthorized) return res.status(401).json({ error: "Authentication expired" });
  if (result.forbidden) return res.status(404).json({ error: "Household not found" });
  if (result.conflict) return res.status(409).json({ error: "Idempotency-Key was already used for another expense" });
  if (result.userLimit) return res.status(413).json({ error: "Expense limit reached for this account" });
  if (result.limit) return res.status(413).json({ error: "Expense limit reached for this household" });
  res.json({ ok: true, id: result.id });
}

async function settle(req, res) {
  const operationKey = idempotencyKey(req);
  if (operationKey === null) return res.status(400).json({ error: "Invalid Idempotency-Key" });
  const { to, amount, method } = req.body || {};
  const amt = parseMoney(amount);
  if (amt === null) return res.status(400).json({ error: "Amount must be greater than 0" });
  const how = method || "cash";
  if (!["cash", "upi"].includes(how)) return res.status(400).json({ error: "Unknown payment method" });
  const result = await db.update((d) => {
    if (!isCurrentUser(d, req)) return { unauthorized: true };
    const h = d.households[req.params.id];
    if (!isMember(h, req.userKey)) return { forbidden: true };
    const settlements = Object.values(d.settlements || {});
    const candidate = {
      householdId: h.id,
      from: req.userKey,
      to,
      amount: amt,
      method: how,
    };
    const existing = operationKey && settlements
      .find((settlement) => settlement.from === req.userKey && settlement.operationKey === operationKey);
    if (existing) return sameSettlementInput(existing, candidate)
      ? { id: existing.id }
      : { conflict: true };
    if (!activeMembers(d, h).includes(to) || to === req.userKey) return { badTarget: true };
    if (settlements.filter((s) => s.from === req.userKey).length >= MAX_SETTLEMENTS_PER_USER) {
      return { userLimit: true };
    }
    if (settlements.filter((s) => s.householdId === h.id).length >= MAX_SETTLEMENTS_PER_HOUSEHOLD) {
      return { limit: true };
    }
    if (settlements.some((s) =>
      s.householdId === h.id && s.from === req.userKey && s.to === to && s.status === "pending")) {
      return { duplicate: true };
    }
    const debt = computeBalances(d, h.id).owes
      .find((item) => item.from === req.userKey && item.to === to);
    if (!debt || toPaise(amt) > toPaise(debt.amount)) return { invalidDebt: true };
    const id = crypto.randomUUID();
    const settlement = {
      id,
      ...candidate,
      status: "pending",
      confirmedAt: null,
      date: dateKey(),
      createdAt: new Date().toISOString(),
      ...(operationKey ? { operationKey } : {}),
    };
    d.settlements = { ...(d.settlements || {}), [id]: settlement };
    return { id };
  });
  if (result.unauthorized) return res.status(401).json({ error: "Authentication expired" });
  if (result.forbidden) return res.status(404).json({ error: "Household not found" });
  if (result.conflict) return res.status(409).json({ error: "Idempotency-Key was already used for another settlement" });
  if (result.badTarget) return res.status(400).json({ error: "Unknown member" });
  if (result.userLimit) return res.status(413).json({ error: "Settlement limit reached for this account" });
  if (result.limit) return res.status(413).json({ error: "Settlement limit reached for this household" });
  if (result.duplicate) return res.status(409).json({ error: "A payment is already awaiting confirmation" });
  if (result.invalidDebt) return res.status(400).json({ error: "Payment does not match an outstanding debt" });
  res.json({ ok: true, id: result.id });
}

async function confirmSettlement(req, res) {
  const result = await db.update((d) => {
    if (!isCurrentUser(d, req)) return { unauthorized: true };
    const h = d.households[req.params.id];
    const s = d.settlements[req.params.sid];
    if (!isMember(h, req.userKey) || !s || s.householdId !== h.id || s.to !== req.userKey) {
      return { notFound: true };
    }
    if (s.status === "confirmed") return { confirmed: true };
    if (s.status !== "pending") return { notFound: true };
    d.settlements = {
      ...d.settlements,
      [s.id]: { ...s, status: "confirmed", confirmedAt: new Date().toISOString() },
    };
    return { confirmed: true };
  });
  if (result.unauthorized) return res.status(401).json({ error: "Authentication expired" });
  if (result.notFound) return res.status(404).json({ error: "Pending payment not found" });
  res.json({ ok: true });
}

// Recurring bills live inside the household (no top-level collection). All
// three handlers are members-only.
async function listRecurring(req, res) {
  const data = await db.load();
  const h = data.households[req.params.id];
  if (!isMember(h, req.userKey)) return res.status(404).json({ error: "Household not found" });
  res.json({ recurring: (h.recurring || []).map(operationView) });
}

async function addRecurring(req, res) {
  const operationKey = idempotencyKey(req);
  if (operationKey === null) return res.status(400).json({ error: "Invalid Idempotency-Key" });
  const { description, amount, category, dayOfMonth, splitAmong } = req.body || {};
  const amt = parseMoney(amount);
  if (amt === null) return res.status(400).json({ error: "Amount must be greater than 0" });
  const day = Number(dayOfMonth);
  if (!Number.isInteger(day) || day < 1 || day > 28) return res.status(400).json({ error: "Day of month must be 1-28" });
  const label = String(description || "Bill").trim();
  if (!label || label.length > 256) return res.status(400).json({ error: "Invalid description" });
  const result = await db.update((d) => {
    if (!isCurrentUser(d, req)) return { unauthorized: true };
    const h = d.households[req.params.id];
    if (!isMember(h, req.userKey)) return { forbidden: true };
    const recurring = Array.isArray(h.recurring) ? h.recurring : [];
    const members = activeMembers(d, h);
    let split = Array.isArray(splitAmong) && splitAmong.length
      ? [...new Set(splitAmong.filter((m) => members.includes(m)))]
      : null;
    if (split && !split.length) split = null;
    const candidate = {
      description: label,
      amount: amt,
      category: cleanCategory(category),
      splitAmong: split,
      dayOfMonth: day,
    };
    const existing = operationKey && Object.values(d.households || {})
      .flatMap((household) => (household.recurring || [])
        .map((item) => ({ householdId: household.id, item })))
      .find(({ item }) => item.createdBy === req.userKey && item.operationKey === operationKey);
    if (existing) return sameRecurringInput(existing, h.id, candidate)
      ? { item: existing.item }
      : { conflict: true };
    const userRecurring = Object.values(d.households || {}).reduce(
      (count, household) => count + (Array.isArray(household.recurring)
        ? household.recurring.filter((item) => item.createdBy === req.userKey).length
        : 0),
      0,
    );
    if (userRecurring >= MAX_RECURRING_PER_USER) return { userLimit: true };
    if (recurring.length >= MAX_RECURRING_PER_HOUSEHOLD) return { limit: true };
    const item = {
      id: crypto.randomUUID(),
      ...candidate,
      lastPostedYM: null,
      createdBy: req.userKey,
      ...(operationKey ? { operationKey } : {}),
    };
    d.households = {
      ...d.households,
      [h.id]: { ...h, recurring: [...recurring, item] },
    };
    return { item };
  });
  if (result.unauthorized) return res.status(401).json({ error: "Authentication expired" });
  if (result.forbidden) return res.status(404).json({ error: "Household not found" });
  if (result.conflict) return res.status(409).json({ error: "Idempotency-Key was already used for another recurring bill" });
  if (result.userLimit) return res.status(413).json({ error: "Recurring bill limit reached for this account" });
  if (result.limit) return res.status(413).json({ error: "Recurring bill limit reached for this household" });
  res.json({ ok: true, recurring: operationView(result.item) });
}

async function removeRecurring(req, res) {
  const result = await db.update((d) => {
    if (!isCurrentUser(d, req)) return { unauthorized: true };
    const h = d.households[req.params.id];
    if (!isMember(h, req.userKey)) return { forbidden: true };
    const recurring = Array.isArray(h.recurring) ? h.recurring : [];
    const filtered = recurring.filter((r) => r.id !== req.params.rid);
    if (filtered.length === recurring.length) return { removed: false };
    d.households = {
      ...d.households,
      [h.id]: { ...h, recurring: filtered },
    };
    return { removed: true };
  });
  if (result.unauthorized) return res.status(401).json({ error: "Authentication expired" });
  if (result.forbidden) return res.status(404).json({ error: "Household not found" });
  if (!result.removed) return res.status(404).json({ error: "Recurring bill not found" });
  res.json({ ok: true });
}

function mount(app) {
  app.get("/api/households", asyncRoute(list));
  app.post("/api/households", asyncRoute(create));
  app.post("/api/households/join", asyncRoute(join));
  app.get("/api/households/:id", asyncRoute(detail));
  app.post("/api/households/:id/expenses", asyncRoute(addExpense));
  app.post("/api/households/:id/settle", asyncRoute(settle));
  app.post("/api/households/:id/settlements/:sid/confirm", asyncRoute(confirmSettlement));
  app.get("/api/households/:id/recurring", asyncRoute(listRecurring));
  app.post("/api/households/:id/recurring", asyncRoute(addRecurring));
  app.delete("/api/households/:id/recurring/:rid", asyncRoute(removeRecurring));
}

module.exports = {
  mount,
  computeBalances,
  simplify,
  settle,
  confirmSettlement,
  addExpense,
  uniqueCode,
  MAX_EXPENSES_PER_HOUSEHOLD,
  MAX_EXPENSES_PER_USER,
};
