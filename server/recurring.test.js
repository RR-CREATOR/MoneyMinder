const test = require("node:test");
const assert = require("node:assert");
const { dueRecurring } = require("./recurring");
const { MAX_EXPENSES_PER_HOUSEHOLD, MAX_EXPENSES_PER_USER } = require("./households");

test("dueRecurring fires once its day has arrived and it hasn't posted this month", () => {
  const now = new Date("2026-06-20T10:00:00Z");
  // Day 5 <= 20, never posted -> due.
  assert.strictEqual(dueRecurring({ amount: 100, dayOfMonth: 5, lastPostedYM: null }, now), true);
  // Day 20 == 20 -> due.
  assert.strictEqual(dueRecurring({ amount: 100, dayOfMonth: 20, lastPostedYM: null }, now), true);
});

test("dueRecurring is idempotent within a month", () => {
  const now = new Date("2026-06-20T10:00:00Z");
  // Already posted in June -> not due again.
  assert.strictEqual(dueRecurring({ amount: 100, dayOfMonth: 5, lastPostedYM: "2026-06" }, now), false);
  // Posted last month -> due again this month.
  assert.strictEqual(dueRecurring({ amount: 100, dayOfMonth: 5, lastPostedYM: "2026-05" }, now), true);
});

test("dueRecurring waits until the day-of-month arrives", () => {
  const now = new Date("2026-06-10T10:00:00Z");
  assert.strictEqual(dueRecurring({ amount: 100, dayOfMonth: 25, lastPostedYM: null }, now), false);
});

test("dueRecurring rejects zero/invalid amounts", () => {
  const now = new Date("2026-06-20T10:00:00Z");
  assert.strictEqual(dueRecurring({ amount: 0, dayOfMonth: 1, lastPostedYM: null }, now), false);
  assert.strictEqual(dueRecurring(null, now), false);
});

test("dueRecurring uses the India-local day at a UTC boundary", () => {
  const now = new Date("2026-07-31T19:00:00.000Z"); // 2026-08-01 00:30 Asia/Kolkata
  assert.strictEqual(dueRecurring({ amount: 100, dayOfMonth: 1, lastPostedYM: "2026-07" }, now), true);
});

// Drive the full engine against an in-memory db to prove it posts exactly once
// per month. Hermetic: swap require.cache so recurring.js's db is our fake.
test("recurring engine posts once per month (idempotent across runs)", async () => {
  const dbPath = require.resolve("./db");
  const store = {
    users: { owner: { username: "Owner" }, b: { username: "B" } },
    households: {
      h: {
        id: "h",
        ownerKey: "owner",
        members: ["owner", "b"],
        recurring: [
          { id: "rent", description: "Rent", amount: 1200, category: "housing", splitAmong: null, dayOfMonth: 1, lastPostedYM: null },
        ],
      },
    },
    expenses: {},
  };
  const fakeDb = {
    load: () => store,
    update: async (fn) => fn(store),
  };
  const real = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
  delete require.cache[require.resolve("./recurring")];
  try {
    const { runOnce } = require("./recurring");
    const now = new Date("2026-06-20T10:00:00Z");
    const first = await runOnce(now);
    assert.strictEqual(first, 1, "posts the bill the first run");
    assert.strictEqual(Object.keys(store.expenses).length, 1);
    const exp = Object.values(store.expenses)[0];
    assert.strictEqual(exp.paidBy, "owner");
    assert.strictEqual(exp.amount, 1200);
    assert.strictEqual(exp.category, "housing");
    assert.deepStrictEqual(exp.splitAmong, ["owner", "b"]);
    assert.strictEqual(exp.date, "2026-06-01");

    const second = await runOnce(now);
    assert.strictEqual(second, 0, "does not re-post in the same month");
    assert.strictEqual(Object.keys(store.expenses).length, 1);

    // Next month -> posts again.
    const third = await runOnce(new Date("2026-07-05T10:00:00Z"));
    assert.strictEqual(third, 1, "posts again next month");
    assert.strictEqual(Object.keys(store.expenses).length, 2);
  } finally {
    require.cache[dbPath] = real;
    delete require.cache[require.resolve("./recurring")];
  }
});

test("recurring engine never charges deleted members or an inactive owner", async () => {
  const dbPath = require.resolve("./db");
  const store = {
    users: { active: { username: "Active" } },
    households: {
      h: {
        id: "h",
        ownerKey: "deleted-old",
        members: ["deleted-old", "active"],
        recurring: [
          { id: "rent", amount: 100, dayOfMonth: 1, splitAmong: null, lastPostedYM: null },
        ],
      },
    },
    expenses: {},
  };
  const fakeDb = { load: () => store, update: async (fn) => fn(store) };
  const real = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
  delete require.cache[require.resolve("./recurring")];
  try {
    const { runOnce } = require("./recurring");
    assert.strictEqual(await runOnce(new Date("2026-06-20T10:00:00Z")), 1);
    const expense = Object.values(store.expenses)[0];
    assert.strictEqual(expense.paidBy, "active");
    assert.deepStrictEqual(expense.splitAmong, ["active"]);
  } finally {
    require.cache[dbPath] = real;
    delete require.cache[require.resolve("./recurring")];
  }
});

test("recurring engine leaves due bills retryable at the household expense ceiling", async () => {
  const dbPath = require.resolve("./db");
  const bill = { id: "rent", amount: 100, dayOfMonth: 1, splitAmong: null, lastPostedYM: null };
  const store = {
    users: { owner: { username: "Owner" } },
    households: {
      h: { id: "h", ownerKey: "owner", members: ["owner"], recurring: [bill] },
    },
    expenses: Object.fromEntries(Array.from(
      { length: MAX_EXPENSES_PER_HOUSEHOLD },
      (_, index) => [`expense-${index}`, { householdId: "h" }],
    )),
  };
  const fakeDb = { update: async (fn) => fn(store) };
  const real = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
  delete require.cache[require.resolve("./recurring")];
  try {
    const { runOnce } = require("./recurring");
    assert.strictEqual(await runOnce(new Date("2026-06-20T10:00:00Z")), 0);
    assert.strictEqual(Object.keys(store.expenses).length, MAX_EXPENSES_PER_HOUSEHOLD);
    assert.strictEqual(bill.lastPostedYM, null);
  } finally {
    require.cache[dbPath] = real;
    delete require.cache[require.resolve("./recurring")];
  }
});

test("recurring engine respects the payer's cross-household expense ceiling", async () => {
  const dbPath = require.resolve("./db");
  const bill = { id: "rent", amount: 100, dayOfMonth: 1, splitAmong: null, lastPostedYM: null };
  const store = {
    users: { owner: { username: "Owner" } },
    households: {
      h: { id: "h", ownerKey: "owner", members: ["owner"], recurring: [bill] },
    },
    expenses: Object.fromEntries(Array.from(
      { length: MAX_EXPENSES_PER_USER },
      (_, index) => [`expense-${index}`, { householdId: "other", paidBy: "owner" }],
    )),
  };
  const fakeDb = { update: async (fn) => fn(store) };
  const real = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
  delete require.cache[require.resolve("./recurring")];
  try {
    const { runOnce } = require("./recurring");
    assert.strictEqual(await runOnce(new Date("2026-06-20T10:00:00Z")), 0);
    assert.strictEqual(bill.lastPostedYM, null);
  } finally {
    require.cache[dbPath] = real;
    delete require.cache[require.resolve("./recurring")];
  }
});
