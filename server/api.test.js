const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { costOfLiving, bucket, expenseBucket, summary } = require("./api");
const { dateKey } = require("./time");

// costOfLiving scopes to the current calendar month, so test items need a date
// in this month to count. Derive it from "now" to stay time-robust.
const THIS_MONTH = new Date().toISOString().slice(0, 7); // YYYY-MM
const THIS_DAY = THIS_MONTH + "-15"; // a safe mid-month day in the current month

test("expenseBucket trusts known categories, defaults unknown to other", () => {
  assert.strictEqual(expenseBucket("food"), "food");
  assert.strictEqual(expenseBucket("HOUSING"), "housing");
  assert.strictEqual(expenseBucket(""), "other");
  assert.strictEqual(expenseBucket("groceries"), "other");
  assert.strictEqual(expenseBucket(undefined), "other");
});

test("bucket maps canonical, legacy, and unknown receipt categories", () => {
  const cases = {
    food: "food",
    travel: "travel",
    transport: "travel",
    gasoline: "travel",
    parking: "travel",
    toll: "travel",
    housing: "housing",
    accommodation: "housing",
    misc: "misc",
    other: "other",
    unknown: "misc",
  };
  for (const [input, expected] of Object.entries(cases)) assert.strictEqual(bucket(input), expected);
  assert.strictEqual(bucket(), "misc");
});

test("costOfLiving merges personal receipts with the user's shared share", () => {
  const data = {
    users: { a: { username: "a", budget: 9000 } },
    receipts: {
      r1: { userKey: "a", category: "food", amount: 200, date: THIS_DAY },
      r2: { userKey: "a", category: "transport", amount: 100, date: THIS_DAY },
      rOther: { userKey: "b", category: "food", amount: 999, date: THIS_DAY }, // not mine
    },
    expenses: {
      // a is split into a 600 housing bill 3 ways -> share 200
      e1: { householdId: "h", amount: 600, category: "housing", splitAmong: ["a", "b", "c"], date: THIS_DAY },
      // a is split into a 300 food bill 2 ways -> share 150
      e2: { householdId: "h", amount: 300, category: "food", splitAmong: ["a", "b"], date: THIS_DAY },
      // a is NOT in this one
      e3: { householdId: "h", amount: 500, category: "misc", splitAmong: ["b", "c"], date: THIS_DAY },
    },
  };
  const r = costOfLiving(data, "a");
  assert.strictEqual(r.personalSpent, 300); // 200 + 100
  assert.strictEqual(r.sharedShare, 350); // 200 + 150
  assert.strictEqual(r.spent, 650);
  // food = 200 personal + 150 shared, housing = 200 shared, travel = 100 personal
  assert.strictEqual(r.categories.food, 350);
  assert.strictEqual(r.categories.housing, 200);
  assert.strictEqual(r.categories.travel, 100);
  assert.strictEqual(r.categories.misc, 0);
  assert.strictEqual(r.categories.other, 0);
});

test("costOfLiving uses the ledger's deterministic paise allocation", () => {
  const data = {
    receipts: {},
    expenses: {
      uneven: {
        amount: 1,
        paidBy: "a",
        category: "food",
        splitAmong: ["a", "b", "c"],
        date: THIS_DAY,
      },
    },
  };
  assert.strictEqual(costOfLiving(data, "a").sharedShare, 0.33);
  assert.strictEqual(costOfLiving(data, "b").sharedShare, 0.34);
});

test("costOfLiving tolerates missing collections and unknown expense categories", () => {
  const data = {
    receipts: { r1: { userKey: "a", category: "food", amount: 50, date: THIS_DAY } },
    expenses: { e1: { amount: 80, splitAmong: ["a", "b"], date: THIS_DAY } }, // no category -> other
  };
  const r = costOfLiving(data, "a");
  assert.strictEqual(r.spent, 90); // 50 + 40
  assert.strictEqual(r.categories.other, 40);
  assert.strictEqual(r.categories.food, 50);
});

test("costOfLiving counts only the current month, ignoring prior-month items", () => {
  const data = {
    receipts: {
      thisMonth: { userKey: "a", category: "food", amount: 200, date: THIS_DAY },
      lastMonth: { userKey: "a", category: "food", amount: 5000, date: "2000-01-15" }, // old -> excluded
      // createdAt fallback for a row with no ISO date: an ancient createdAt is excluded
      ancient: { userKey: "a", category: "food", amount: 7000, createdAt: "2000-01-15T00:00:00.000Z" },
    },
    expenses: {
      thisMonthExp: { amount: 100, splitAmong: ["a", "b"], category: "misc", date: THIS_DAY }, // share 50
      lastMonthExp: { amount: 900, splitAmong: ["a", "b"], category: "misc", date: "2000-01-15" }, // excluded
    },
  };
  const r = costOfLiving(data, "a");
  assert.strictEqual(r.personalSpent, 200); // only thisMonth receipt
  assert.strictEqual(r.sharedShare, 50); // only thisMonth expense share
  assert.strictEqual(r.spent, 250);
});

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    ended: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
}

async function withFakeApi(store, fn, overrides = {}) {
  const dbPath = require.resolve("./db");
  const uploadsPath = path.join(__dirname, "uploads.js");
  const real = require.cache[dbPath];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-api-"));
  const fakeDb = {
    load: () => store,
    update: async (handler) => handler(store),
    scrubBackup: async () => {},
    dir: root,
    ...overrides,
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
  delete require.cache[require.resolve("./api")];
  delete require.cache[uploadsPath];
  try {
    const api = require("./api");
    const routes = {};
    const app = {
      get(route, handler) { routes["GET " + route] = handler; },
      post(route, handler) { routes["POST " + route] = handler; },
      delete(route, handler) { routes["DELETE " + route] = handler; },
    };
    api.mount(app);
    return await fn(routes, root);
  } finally {
    require.cache[dbPath] = real;
    delete require.cache[require.resolve("./api")];
    delete require.cache[uploadsPath];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("costOfLiving uses the India calendar at the UTC month boundary", () => {
  const data = {
    receipts: {
      july: { userKey: "a", category: "food", amount: 10, date: "2026-07-31" },
      august: { userKey: "a", category: "food", amount: 20, date: "2026-08-01" },
    },
    expenses: {},
  };
  const now = new Date("2026-07-31T19:00:00.000Z"); // 2026-08-01 00:30 Asia/Kolkata
  assert.strictEqual(costOfLiving(data, "a", now).spent, 20);
});

test("receipt creation rejects zero and malformed money values", async () => {
  const store = { receipts: {}, expenses: {} };
  await withFakeApi(store, async (routes) => {
    const add = routes["POST /api/receipts"];
    for (const amount of [0, "1e3", "1.001", true]) {
      const res = fakeRes();
      await add({ userKey: "a", body: { amount } }, res);
      assert.strictEqual(res.statusCode, 400);
    }
    assert.deepStrictEqual(store.receipts, {});
  });
});

test("receipt creation caps per-account state growth", async () => {
  const store = {
    receipts: Object.fromEntries(Array.from(
      { length: 1000 },
      (_, index) => [`receipt-${index}`, { id: `receipt-${index}`, userKey: "a", amount: 1 }],
    )),
    expenses: {},
  };
  await withFakeApi(store, async (routes) => {
    const res = fakeRes();
    await routes["POST /api/receipts"]({ userKey: "a", body: { amount: 1 } }, res);
    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(Object.keys(store.receipts).length, 1000);
  });
});

test("receipt creation replays the same idempotency key without a duplicate charge", async () => {
  const store = { receipts: {}, expenses: {} };
  const key = "7a45d4b1-b073-4cb5-83fe-52aa6a550a57";
  const request = (amount) => ({
    userKey: "a",
    body: { amount, supplier: "Cafe" },
    get: (name) => name === "Idempotency-Key" ? key : "",
  });
  await withFakeApi(store, async (routes) => {
    const add = routes["POST /api/receipts"];
    const first = fakeRes();
    const replay = fakeRes();
    const conflict = fakeRes();
    await add(request(12.34), first);
    await add(request(12.34), replay);
    await add(request(99), conflict);

    assert.strictEqual(Object.keys(store.receipts).length, 1);
    assert.strictEqual(replay.body.receipt.id, first.body.receipt.id);
    assert.strictEqual(conflict.statusCode, 409);
  });
});

test("receipt creation cannot commit after the authenticated user is deleted", async () => {
  const store = { users: {}, receipts: {}, expenses: {} };
  await withFakeApi(store, async (routes) => {
    const request = {
      userKey: "a",
      authVersion: "deleted-version",
      body: { amount: 1 },
    };
    const res = fakeRes();
    await routes["POST /api/receipts"]({
      ...request,
    }, res);
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(store.receipts, {});

    store.users.a = { authVersion: "new-version" };
    store.receipts.current = { id: "current", userKey: "a", amount: 1 };
    const deleted = fakeRes();
    await routes["DELETE /api/receipts/:id"]({
      ...request,
      params: { id: "current" },
    }, deleted);
    assert.strictEqual(deleted.statusCode, 401);
    assert.ok(store.receipts.current);
  });
});

test("receipt routes scope reads, validate fields, and delete owned rows", async () => {
  const store = {
    receipts: {
      old: { id: "old", userKey: "a", amount: 10, category: "food", createdAt: "2026-01-01T00:00:00Z" },
      new: { id: "new", userKey: "a", amount: 20, category: "travel", createdAt: "2026-02-01T00:00:00Z" },
      other: { id: "other", userKey: "b", amount: 30, category: "misc", createdAt: "2026-03-01T00:00:00Z" },
    },
    expenses: {},
  };
  await withFakeApi(store, async (routes) => {
    const listRes = fakeRes();
    await routes["GET /api/receipts"]({ userKey: "a" }, listRes);
    assert.deepStrictEqual(listRes.body.receipts.map((receipt) => receipt.id), ["new", "old"]);

    const ownRes = fakeRes();
    await routes["GET /api/receipts/:id"]({ userKey: "a", params: { id: "new" } }, ownRes);
    assert.strictEqual(ownRes.body.receipt.id, "new");

    const hiddenRes = fakeRes();
    await routes["GET /api/receipts/:id"]({ userKey: "a", params: { id: "other" } }, hiddenRes);
    assert.strictEqual(hiddenRes.statusCode, 404);

    const invalidText = fakeRes();
    await routes["POST /api/receipts"]({
      userKey: "a",
      body: { amount: 12, supplier: "x".repeat(121) },
    }, invalidText);
    assert.strictEqual(invalidText.statusCode, 400);

    const addRes = fakeRes();
    await routes["POST /api/receipts"]({
      userKey: "a",
      body: { amount: "12.34", category: "food", supplier: "Cafe" },
    }, addRes);
    assert.strictEqual(addRes.body.receipt.amount, 12.34);

    const deniedDelete = fakeRes();
    await routes["DELETE /api/receipts/:id"]({ userKey: "a", params: { id: "other" } }, deniedDelete);
    assert.strictEqual(deniedDelete.statusCode, 404);

    const deleteRes = fakeRes();
    await routes["DELETE /api/receipts/:id"]({ userKey: "a", params: { id: "old" } }, deleteRes);
    assert.deepStrictEqual(deleteRes.body, { ok: true });
    assert.strictEqual(store.receipts.old, undefined);
  });
});

test("receipt image names and dates are validated at the API boundary", async () => {
  const store = { receipts: {}, expenses: {} };
  await withFakeApi(store, async (routes, root) => {
    for (const body of [
      { amount: 1, date: "2026-02-30" },
      { amount: 1, category: "x".repeat(33) },
      { amount: 1, image: "." },
    ]) {
      const res = fakeRes();
      await routes["POST /api/receipts"]({ userKey: "a", body }, res);
      assert.strictEqual(res.statusCode, 400);
    }

    const missing = fakeRes();
    await routes["POST /api/receipts"]({
      userKey: "a",
      body: { amount: 1, image: "missing.jpg" },
    }, missing);
    assert.strictEqual(missing.statusCode, 409);
    assert.deepStrictEqual(store.receipts, {});

    fs.mkdirSync(path.join(root, "uploads", "a"), { recursive: true });
    fs.writeFileSync(path.join(root, "uploads", "a", "receipt.jpg"), "image");
    const res = fakeRes();
    await routes["POST /api/receipts"]({
      userKey: "a",
      body: { amount: 1, date: "2026-07-26", image: "nested/receipt.jpg" },
    }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.receipt.image, "receipt.jpg");
  });
});

test("deleting an image receipt preserves a shared file and removes the last reference", async () => {
  const store = {
    receipts: {
      first: { id: "first", userKey: "a", amount: 1, image: "same.jpg" },
      second: { id: "second", userKey: "a", amount: 2, image: "same.jpg" },
      foreign: { id: "foreign", userKey: "b", amount: 3, image: "same.jpg" },
    },
    expenses: {},
  };
  const realRm = require("node:fs").promises.rm;
  const removed = [];
  require("node:fs").promises.rm = async (file, options) => { removed.push({ file, options }); };
  try {
    await withFakeApi(store, async (routes) => {
      const shared = fakeRes();
      await routes["DELETE /api/receipts/:id"]({ userKey: "a", params: { id: "first" } }, shared);
      assert.deepStrictEqual(shared.body, { ok: true });
      assert.deepStrictEqual(removed, []);

      const last = fakeRes();
      await routes["DELETE /api/receipts/:id"]({ userKey: "a", params: { id: "second" } }, last);
      assert.deepStrictEqual(last.body, { ok: true });
      assert.strictEqual(removed.length, 1);
      assert.match(removed[0].file, /same\.jpg$/);
      assert.deepStrictEqual(removed[0].options, { force: true });
      assert.ok(store.receipts.foreign);
    });
  } finally {
    require("node:fs").promises.rm = realRm;
  }
});

test("receipt deletion survives rm failure without retaining receipt data in the scrubbed backup", async () => {
  const store = {
    users: { a: { username: "A" } },
    receipts: {
      doomed: {
        id: "doomed",
        userKey: "a",
        image: "doomed.jpg",
        supplier: "Private merchant",
        amount: 10,
      },
    },
    expenses: {},
  };
  const realRm = require("node:fs").promises.rm;
  let backup;
  let attempts = 0;
  require("node:fs").promises.rm = async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
  };
  try {
    await withFakeApi(store, async (routes) => {
      const res = fakeRes();
      await routes["DELETE /api/receipts/:id"](
        { userKey: "a", params: { id: "doomed" } },
        res,
      );

      assert.deepStrictEqual(res.body, { ok: true });
      assert.strictEqual(store.receipts.doomed, undefined);
      assert.strictEqual(backup.receipts.doomed, undefined);
      assert.strictEqual(Object.keys(store.pendingUploadDeletes).length, 1);

      await require("./uploads").retryPendingDeletes();
      assert.strictEqual(store.pendingUploadDeletes, undefined);
      assert.strictEqual(attempts, 2);
    }, {
      scrubBackup: async () => { backup = structuredClone(store); },
    });
  } finally {
    require("node:fs").promises.rm = realRm;
  }
});

test("insights combines owned receipts and shared shares over the last 14 India dates", async () => {
  const today = dateKey(new Date());
  const store = {
    users: { a: { username: "A", budget: 0 } },
    receipts: {
      dated: { userKey: "a", amount: 10.01, category: "food", date: today },
      fallback: { userKey: "a", amount: 4, category: "misc", createdAt: new Date().toISOString() },
      foreign: { userKey: "b", amount: 999, category: "food", date: today },
      old: { userKey: "a", amount: 999, category: "food", date: "2000-01-01" },
    },
    expenses: {
      shared: { amount: 30, splitAmong: ["a", "b"], category: "housing", date: today },
      notMine: { amount: 90, splitAmong: ["b"], category: "food", date: today },
      emptySplit: { amount: 90, splitAmong: [], category: "food", date: today },
      old: { amount: 90, splitAmong: ["a"], category: "food", date: "2000-01-01" },
    },
  };
  await withFakeApi(store, async (routes) => {
    const res = fakeRes();
    await routes["GET /api/insights"]({ userKey: "a" }, res);
    assert.strictEqual(res.body.daily.length, 14);
    assert.strictEqual(res.body.daily.at(-1).date, today);
    assert.strictEqual(res.body.daily.at(-1).amount, 29.01);
    assert.strictEqual(res.body.categories.food, 10.01);
    assert.strictEqual(res.body.categories.housing, 15);
  });
});

test("image route rejects unsafe names, sets no-store, and maps send errors to 404", async () => {
  await withFakeApi({ receipts: {}, expenses: {} }, async (routes) => {
    const invalid = fakeRes();
    routes["GET /api/image/:name"]({ userKey: "a", params: { name: ".." } }, invalid);
    assert.strictEqual(invalid.statusCode, 404);
    assert.strictEqual(invalid.ended, true);

    const headers = {};
    const missing = {
      statusCode: 200,
      headersSent: false,
      ended: false,
      status(code) { this.statusCode = code; return this; },
      end() { this.ended = true; return this; },
      set(name, value) { headers[name] = value; return this; },
      sendFile(file, callback) { this.file = file; callback(new Error("missing")); },
    };
    routes["GET /api/image/:name"]({ userKey: "a", params: { name: "receipt.jpg" } }, missing);
    assert.strictEqual(headers["Cache-Control"], "private, no-store");
    assert.match(missing.file, /receipt\.jpg$/);
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(missing.ended, true);

    const alreadySent = { ...missing, headersSent: true, ended: false, statusCode: 200 };
    alreadySent.set = missing.set;
    alreadySent.sendFile = (file, callback) => callback(new Error("late"));
    routes["GET /api/image/:name"]({ userKey: "a", params: { name: "receipt.jpg" } }, alreadySent);
    assert.strictEqual(alreadySent.statusCode, 200);
    assert.strictEqual(alreadySent.ended, false);
  });
});

// Hermetic: stub db.load() on the cached db module so summary() reads our store
// and never touches data/db.json. Restored in finally.
test("summary spent reflects only the current month, not a prior-month receipt", async () => {
  const dbPath = require.resolve("./db");
  const db = require.cache[dbPath].exports;
  const realLoad = db.load;
  const store = {
    users: { a: { username: "a", budget: 3000 } },
    receipts: {
      thisMonth: { userKey: "a", category: "food", amount: 120, date: THIS_DAY },
      prevMonth: { userKey: "a", category: "food", amount: 9999, date: "2000-01-15" }, // excluded
    },
    expenses: {},
    settlements: {},
  };
  db.load = () => store;
  try {
    const res = fakeRes();
    await summary({ userKey: "a" }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.spent, 120); // prior-month 9999 not counted
    assert.strictEqual(res.body.personalSpent, 120);
    assert.strictEqual(res.body.budget, 3000);
  } finally {
    db.load = realLoad;
  }
});
