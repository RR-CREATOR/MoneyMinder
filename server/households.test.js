const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { simplify, computeBalances, MAX_EXPENSES_PER_HOUSEHOLD } = require("./households");
async function withFakeDb(store, fn) {
  const dbPath = require.resolve("./db");
  const fakeDb = { load: () => store, update: async (h) => h(store) };
  const real = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
  delete require.cache[require.resolve("./households")];
  try {
    return await fn(require("./households"));
  } finally {
    require.cache[dbPath] = real;
    delete require.cache[require.resolve("./households")];
  }
}
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function mountedRoutes(households) {
  const routes = new Map();
  const app = {};
  for (const method of ["get", "post", "delete"]) {
    app[method] = (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler);
  }
  households.mount(app);
  return routes;
}

async function callRoute(routes, method, path, req) {
  const res = fakeRes();
  const handler = routes.get(`${method} ${path}`);
  assert.ok(handler, `missing route ${method} ${path}`);
  await handler(req, res, (error) => {
    throw error;
  });
  return res;
}

test("simplify resolves nets into who-owes-whom", () => {
  // A paid 90 split 3 ways -> A +60, B -30, C -30.
  const owes = simplify({ A: 60, B: -30, C: -30 });
  assert.strictEqual(owes.reduce((s, o) => s + o.amount, 0), 60);
  assert.ok(owes.every((o) => o.to === "A"));
});

test("computeBalances tracks expenses then settlements to zero", () => {
  const data = {
    households: { h: { id: "h", members: ["A", "B"] } },
    expenses: { e1: { householdId: "h", paidBy: "A", amount: 100, splitAmong: ["A", "B"] } },
    settlements: {},
  };
  let r = computeBalances(data, "h");
  assert.strictEqual(r.net.A, 50);
  assert.strictEqual(r.net.B, -50);

  data.settlements.s1 = { householdId: "h", from: "B", to: "A", amount: 50 };
  r = computeBalances(data, "h");
  assert.strictEqual(r.net.A, 0);
  assert.strictEqual(r.net.B, 0);
  assert.deepStrictEqual(r.owes, []);
});

test("computeBalances conserves every paise when an amount splits unevenly", () => {
  const data = {
    households: { h: { id: "h", members: ["A", "B", "C"] } },
    expenses: {
      e1: { householdId: "h", paidBy: "A", amount: 100, splitAmong: ["A", "B", "C"] },
    },
    settlements: {},
  };
  const result = computeBalances(data, "h");
  assert.strictEqual(Object.values(result.net).reduce((sum, value) => sum + value, 0), 0);
  assert.strictEqual(result.owes.reduce((sum, item) => sum + item.amount, 0), 66.67);
});

test("pending UPI settlements do not change balances until the recipient confirms", () => {
  const data = {
    households: { h: { id: "h", members: ["A", "B"] } },
    expenses: { e1: { householdId: "h", paidBy: "A", amount: 100, splitAmong: ["A", "B"] } },
    settlements: { s1: { householdId: "h", from: "B", to: "A", amount: 50, method: "upi", status: "pending" } },
  };
  assert.strictEqual(computeBalances(data, "h").net.B, -50);
  data.settlements.s1.status = "confirmed";
  assert.strictEqual(computeBalances(data, "h").net.B, 0);
});

test("settle records the chosen method", async () => {
  const store = {
    households: { h: { id: "h", members: ["A", "B"], ownerKey: "A" } },
    expenses: { e: { householdId: "h", paidBy: "A", amount: 60, splitAmong: ["A", "B"] } },
    settlements: {},
  };
  await withFakeDb(store, async ({ settle }) => {
    const res = fakeRes();
    await settle({ userKey: "B", params: { id: "h" }, body: { to: "A", amount: 30, method: "upi" } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(Object.values(store.settlements)[0].method, "upi");
    assert.strictEqual(Object.values(store.settlements)[0].status, "pending");
  });
});

test("settle rejects a duplicate pending UPI confirmation request", async () => {
  const store = {
    households: { h: { id: "h", members: ["A", "B"], ownerKey: "A" } },
    expenses: { e: { householdId: "h", paidBy: "A", amount: 60, splitAmong: ["A", "B"] } },
    settlements: { old: { id: "old", householdId: "h", from: "B", to: "A", amount: 30, method: "upi", status: "pending" } },
  };
  await withFakeDb(store, async ({ settle }) => {
    const res = fakeRes();
    await settle({ userKey: "B", params: { id: "h" }, body: { to: "A", amount: 30, method: "upi" } }, res);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(Object.keys(store.settlements).length, 1);
  });
});

test("settle replays a completed operation without duplicating money state", async () => {
  const store = {
    users: { A: { username: "alice" }, B: { username: "bob" } },
    households: { h: { id: "h", members: ["A", "B"], ownerKey: "A" } },
    expenses: { e: { householdId: "h", paidBy: "A", amount: 60, splitAmong: ["A", "B"] } },
    settlements: {},
  };
  const key = "6a3cad80-e5b7-4ea6-b3e8-f9aa1b5dc3e2";
  await withFakeDb(store, async (households) => {
    const request = (amount) => ({
      userKey: "B",
      params: { id: "h" },
      body: { to: "A", amount, method: "upi" },
      get: (name) => name === "Idempotency-Key" ? key : "",
    });
    const first = fakeRes();
    await households.settle(request(30), first);

    const routes = mountedRoutes(households);
    const detail = await callRoute(routes, "GET", "/api/households/:id", {
      userKey: "B", params: { id: "h" },
    });
    assert.strictEqual(Object.hasOwn(detail.body.pendingSettlements[0], "operationKey"), false);

    store.settlements[first.body.id].status = "confirmed";
    const replay = fakeRes();
    const conflict = fakeRes();
    await households.settle(request(30), replay);
    await households.settle(request(29), conflict);

    assert.strictEqual(replay.statusCode, 200);
    assert.strictEqual(replay.body.id, first.body.id);
    assert.strictEqual(conflict.statusCode, 409);
    assert.strictEqual(Object.keys(store.settlements).length, 1);
  });
});

test("only the recipient can confirm a pending settlement", async () => {
  const store = {
    households: { h: { id: "h", members: ["A", "B"], ownerKey: "A" } },
    settlements: { s: { id: "s", householdId: "h", from: "A", to: "B", amount: 30, method: "upi", status: "pending" } },
  };
  await withFakeDb(store, async ({ confirmSettlement }) => {
    const denied = fakeRes();
    await confirmSettlement({ userKey: "A", params: { id: "h", sid: "s" } }, denied);
    assert.strictEqual(denied.statusCode, 404);
    const accepted = fakeRes();
    await confirmSettlement({ userKey: "B", params: { id: "h", sid: "s" } }, accepted);
    assert.strictEqual(accepted.statusCode, 200);
    assert.strictEqual(store.settlements.s.status, "confirmed");
    const confirmedAt = store.settlements.s.confirmedAt;
    const replay = fakeRes();
    await confirmSettlement({ userKey: "B", params: { id: "h", sid: "s" } }, replay);
    assert.strictEqual(replay.statusCode, 200);
    assert.strictEqual(store.settlements.s.confirmedAt, confirmedAt);
  });
});

test("addExpense deduplicates split members before calculating shares", async () => {
  const store = {
    households: { h: { id: "h", members: ["A", "B"], ownerKey: "A" } },
    expenses: {}, settlements: {},
  };
  await withFakeDb(store, async ({ addExpense }) => {
    const res = fakeRes();
    await addExpense({
      userKey: "A",
      params: { id: "h" },
      body: { description: "Rent", amount: 100, splitAmong: ["A", "A", "B"] },
    }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(Object.values(store.expenses)[0].splitAmong, ["A", "B"]);
  });
});

test("addExpense replays an idempotency key without duplicating a charge", async () => {
  const store = {
    households: { h: { id: "h", members: ["A", "B"], ownerKey: "A" } },
    expenses: {},
    settlements: {},
  };
  const key = "7a45d4b1-b073-4cb5-83fe-52aa6a550a57";
  await withFakeDb(store, async ({ addExpense }) => {
    const request = (amount) => ({
      userKey: "A",
      params: { id: "h" },
      body: { description: "Lunch", amount, splitAmong: ["A", "B"] },
      get: (name) => name === "Idempotency-Key" ? key : "",
    });
    const first = fakeRes();
    const replay = fakeRes();
    const conflict = fakeRes();
    await addExpense(request(10), first);
    await addExpense(request(10), replay);
    await addExpense(request(11), conflict);

    assert.strictEqual(Object.keys(store.expenses).length, 1);
    assert.strictEqual(replay.body.id, first.body.id);
    assert.strictEqual(conflict.statusCode, 409);
  });
});

test("settle defaults method to cash and rejects unknown methods", async () => {
  const store = {
    households: { h: { id: "h", members: ["A", "B"], ownerKey: "A" } },
    expenses: { e: { householdId: "h", paidBy: "A", amount: 100, splitAmong: ["A", "B"] } },
    settlements: {},
  };
  await withFakeDb(store, async ({ settle }) => {
    const cash = fakeRes();
    await settle({ userKey: "B", params: { id: "h" }, body: { to: "A", amount: 30 } }, cash);
    assert.strictEqual(cash.statusCode, 200);
    assert.strictEqual(Object.values(store.settlements)[0].method, "cash");
    assert.strictEqual(Object.values(store.settlements)[0].status, "pending");

    const invalid = fakeRes();
    await settle({ userKey: "B", params: { id: "h" }, body: { to: "A", amount: 5, method: "bitcoin" } }, invalid);
    assert.strictEqual(invalid.statusCode, 400);
    assert.strictEqual(Object.keys(store.settlements).length, 1);
  });
});

test("settle rejects self-payments, the wrong direction, and overpayments", async () => {
  const store = {
    households: { h: { id: "h", members: ["A", "B"], ownerKey: "A" } },
    expenses: { e: { householdId: "h", paidBy: "A", amount: 100, splitAmong: ["A", "B"] } },
    settlements: {},
  };
  await withFakeDb(store, async ({ settle }) => {
    for (const [userKey, to, amount] of [
      ["B", "B", 1],
      ["A", "B", 1],
      ["B", "A", 50.01],
    ]) {
      const res = fakeRes();
      await settle({ userKey, params: { id: "h" }, body: { to, amount, method: "cash" } }, res);
      assert.strictEqual(res.statusCode, 400);
    }
    assert.deepStrictEqual(store.settlements, {});
  });
});

test("create validates names and replays one normalized household per operation", async () => {
  const store = { households: {}, expenses: {}, settlements: {}, users: {} };
  await withFakeDb(store, async (households) => {
    const routes = mountedRoutes(households);
    const path = "/api/households";
    const missing = await callRoute(routes, "POST", path, { userKey: "A", body: { name: "  " } });
    assert.strictEqual(missing.statusCode, 400);
    const long = await callRoute(routes, "POST", path, { userKey: "A", body: { name: "x".repeat(101) } });
    assert.strictEqual(long.statusCode, 400);
    const key = "0f79368a-fdf6-461a-8581-8f0f42d3f9ce";
    const request = (name) => ({ userKey: "A", body: { name },
      get: (header) => header === "Idempotency-Key" ? key : "" });
    const created = await callRoute(routes, "POST", path, request("  Flat 9  "));
    const replay = await callRoute(routes, "POST", path, request("Flat 9"));
    const conflict = await callRoute(routes, "POST", path, request("Different home"));
    assert.strictEqual(created.statusCode, 200);
    assert.strictEqual(created.body.household.name, "Flat 9");
    assert.deepStrictEqual(created.body.household.members, ["A"]);
    assert.match(created.body.household.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.strictEqual(replay.body.household.id, created.body.household.id);
    assert.strictEqual(conflict.statusCode, 409);
    assert.strictEqual(Object.keys(store.households).length, 1);
    assert.strictEqual(Object.hasOwn(created.body.household, "operationKey"), false);
  });
});

test("create retries an invite-code collision inside the transaction", async () => {
  const store = {
    households: {
      existing: { id: "existing", code: "AAAAAA", ownerKey: "B", members: ["B"] },
    },
    expenses: {},
    settlements: {},
    users: {},
  };
  const originalRandomBytes = crypto.randomBytes;
  let calls = 0;
  crypto.randomBytes = (size) => Buffer.alloc(size, calls++);
  try {
    await withFakeDb(store, async (households) => {
      const routes = mountedRoutes(households);
      const created = await callRoute(routes, "POST", "/api/households", {
        userKey: "A", body: { name: "Collision safe" },
      });
      assert.strictEqual(created.statusCode, 200);
      assert.strictEqual(created.body.household.code, "BBBBBB");
      assert.strictEqual(new Set(Object.values(store.households).map((h) => h.code)).size, 2);
    });
  } finally {
    crypto.randomBytes = originalRandomBytes;
  }
});

test("join is case-insensitive, idempotent, and rejects unknown codes", async () => {
  const store = {
    households: { h: { id: "h", name: "Home", code: "ABC234", ownerKey: "A", members: ["A"] } },
    expenses: {},
    settlements: {},
    users: {},
  };
  await withFakeDb(store, async (households) => {
    const routes = mountedRoutes(households);
    const path = "/api/households/join";

    const invalid = await callRoute(routes, "POST", path, { userKey: "B", body: { code: "NOPE" } });
    assert.strictEqual(invalid.statusCode, 400);
    const missing = await callRoute(routes, "POST", path, { userKey: "B", body: { code: "ZZZ999" } });
    assert.strictEqual(missing.statusCode, 404);

    for (const code of [" abc234 ", "ABC234"]) {
      const joined = await callRoute(routes, "POST", path, { userKey: "B", body: { code } });
      assert.deepStrictEqual(joined.body, { ok: true, id: "h" });
    }
    assert.deepStrictEqual(store.households.h.members, ["A", "B"]);
  });
});

test("list and detail expose only member-scoped household data", async () => {
  const store = {
    users: {
      A: { username: "alice", vpa: "alice@upi" },
      B: { username: "bob", vpa: "" },
      C: { username: "carol", vpa: "carol@upi" },
    },
    households: {
      h: {
        id: "h",
        name: "Home",
        code: "ABC234",
        ownerKey: "A",
        members: ["A", "deleted-private-id", "B"],
      },
      private: { id: "private", name: "Private", code: "XYZ234", ownerKey: "C", members: ["C"] },
    },
    expenses: {
      older: {
        id: "older", householdId: "h", paidBy: "A", amount: 20, category: "FOOD",
        splitAmong: ["A", "B"], createdAt: "2026-01-01T00:00:00.000Z",
      },
      newer: {
        id: "newer", householdId: "h", paidBy: "B", amount: 10, category: "unknown",
        splitAmong: ["A", "B"], createdAt: "2026-01-02T00:00:00.000Z",
      },
    },
    settlements: {
      mine: { id: "mine", householdId: "h", from: "B", to: "A", amount: 5, status: "pending" },
      other: { id: "other", householdId: "private", from: "C", to: "A", amount: 5, status: "pending" },
    },
  };
  await withFakeDb(store, async (households) => {
    const routes = mountedRoutes(households);
    const listed = await callRoute(routes, "GET", "/api/households", { userKey: "B" });
    assert.deepStrictEqual(listed.body.households.map((h) => h.id), ["h"]);
    assert.strictEqual(listed.body.households[0].members, 2);
    assert.strictEqual(listed.body.households[0].balance, -5);

    const denied = await callRoute(routes, "GET", "/api/households/:id", {
      userKey: "B", params: { id: "private" },
    });
    assert.strictEqual(denied.statusCode, 404);

    const detail = await callRoute(routes, "GET", "/api/households/:id", {
      userKey: "B", params: { id: "h" },
    });
    assert.strictEqual(detail.statusCode, 200);
    assert.deepStrictEqual(detail.body.members, [
      { key: "A", name: "alice", vpa: "alice@upi" },
      { key: "B", name: "bob", vpa: "" },
    ]);
    assert.deepStrictEqual(detail.body.expenses.map((e) => [e.id, e.category]), [
      ["newer", "other"],
      ["older", "food"],
    ]);
    assert.deepStrictEqual(detail.body.pendingSettlements.map((s) => s.id), ["mine"]);
    assert.strictEqual(detail.body.owes[0].fromName, "bob");
    assert.strictEqual(detail.body.owes[0].toName, "alice");
  });
});

test("addExpense rejects invalid input and defaults a valid member split", async () => {
  const store = {
    users: { A: {}, B: {} },
    households: {
      h: { id: "h", ownerKey: "A", members: ["A", "deleted-private-id", "B"] },
    },
    expenses: {},
    settlements: {},
  };
  await withFakeDb(store, async (households) => {
    const routes = mountedRoutes(households);
    const path = "/api/households/:id/expenses";
    for (const body of [
      { description: "Rent", amount: 0 },
      { description: " ", amount: 10 },
      { description: "x".repeat(257), amount: 10 },
      { description: "Rent", amount: 10, date: "2026-02-30" },
    ]) {
      const invalid = await callRoute(routes, "POST", path, { userKey: "A", params: { id: "h" }, body });
      assert.strictEqual(invalid.statusCode, 400);
    }
    const denied = await callRoute(routes, "POST", path, {
      userKey: "C", params: { id: "h" }, body: { description: "Rent", amount: 10 },
    });
    assert.strictEqual(denied.statusCode, 404);

    const added = await callRoute(routes, "POST", path, {
      userKey: "A",
      params: { id: "h" },
      body: { amount: "10.25", category: "not-a-category", splitAmong: ["outsider"] },
    });
    assert.strictEqual(added.statusCode, 200);
    const expense = store.expenses[added.body.id];
    assert.strictEqual(expense.description, "Expense");
    assert.strictEqual(expense.amount, 10.25);
    assert.strictEqual(expense.category, "other");
    assert.deepStrictEqual(expense.splitAmong, ["A", "B"]);
    assert.match(expense.date, /^\d{4}-\d{2}-\d{2}$/);
  });
});

test("recurring routes validate membership and bill fields", async () => {
  const store = {
    users: {},
    households: {
      h: {
        id: "h", name: "Home", code: "ABC234", ownerKey: "A", members: ["A", "B"],
        recurring: [{ id: "old", description: "Rent", amount: 1000, dayOfMonth: 1 }],
      },
    },
    expenses: {},
    settlements: {},
  };
  await withFakeDb(store, async (households) => {
    const routes = mountedRoutes(households);
    const collection = "/api/households/:id/recurring";

    const deniedList = await callRoute(routes, "GET", collection, { userKey: "C", params: { id: "h" } });
    assert.strictEqual(deniedList.statusCode, 404);
    const listed = await callRoute(routes, "GET", collection, { userKey: "A", params: { id: "h" } });
    assert.deepStrictEqual(listed.body.recurring.map((item) => item.id), ["old"]);

    for (const body of [
      { amount: 0, dayOfMonth: 1, description: "Rent" },
      { amount: 10, dayOfMonth: 0, description: "Rent" },
      { amount: 10, dayOfMonth: 29, description: "Rent" },
      { amount: 10, dayOfMonth: 1, description: " " },
      { amount: 10, dayOfMonth: 1, description: "x".repeat(257) },
    ]) {
      const invalid = await callRoute(routes, "POST", collection, { userKey: "A", params: { id: "h" }, body });
      assert.strictEqual(invalid.statusCode, 400);
    }
    const deniedAdd = await callRoute(routes, "POST", collection, {
      userKey: "C", params: { id: "h" }, body: { amount: 10, dayOfMonth: 1, description: "Power" },
    });
    assert.strictEqual(deniedAdd.statusCode, 404);

    const added = await callRoute(routes, "POST", collection, {
      userKey: "A",
      params: { id: "h" },
      body: {
        amount: "199.90",
        dayOfMonth: "12",
        description: "  Power  ",
        category: "HOUSING",
        splitAmong: ["B", "B", "outsider"],
      },
    });
    assert.strictEqual(added.statusCode, 200);
    assert.deepStrictEqual(
      { ...added.body.recurring, id: "stable" },
      {
        id: "stable",
        description: "Power",
        amount: 199.9,
        category: "housing",
        splitAmong: ["B"],
        dayOfMonth: 12,
        lastPostedYM: null,
        createdBy: "A",
      },
    );

    const removePath = "/api/households/:id/recurring/:rid";
    const deniedRemove = await callRoute(routes, "DELETE", removePath, {
      userKey: "C", params: { id: "h", rid: "old" },
    });
    assert.strictEqual(deniedRemove.statusCode, 404);
    const missing = await callRoute(routes, "DELETE", removePath, {
      userKey: "A", params: { id: "h", rid: "missing" },
    });
    assert.strictEqual(missing.statusCode, 404);
    const removed = await callRoute(routes, "DELETE", removePath, {
      userKey: "A", params: { id: "h", rid: "old" },
    });
    assert.deepStrictEqual(removed.body, { ok: true });
    assert.ok(store.households.h.recurring.every((item) => item.id !== "old"));
  });
});

test("recurring creation replays an operation and hides its internal key", async () => {
  const store = {
    users: {},
    households: {
      h: { id: "h", ownerKey: "A", members: ["A", "B"], recurring: [] },
    },
    expenses: {},
    settlements: {},
  };
  const key = "04ba0fa4-5857-4d0e-9af3-f6d21b5e7aa9";
  await withFakeDb(store, async (households) => {
    const routes = mountedRoutes(households);
    const request = (amount) => ({
      userKey: "A",
      params: { id: "h" },
      body: { description: "Rent", amount, category: "housing", dayOfMonth: 1 },
      get: (name) => name === "Idempotency-Key" ? key : "",
    });
    const first = await callRoute(routes, "POST", "/api/households/:id/recurring", request(1000));
    const replay = await callRoute(routes, "POST", "/api/households/:id/recurring", request(1000));
    const conflict = await callRoute(routes, "POST", "/api/households/:id/recurring", request(1001));
    const listed = await callRoute(routes, "GET", "/api/households/:id/recurring", {
      userKey: "A", params: { id: "h" },
    });

    assert.strictEqual(replay.body.recurring.id, first.body.recurring.id);
    assert.strictEqual(conflict.statusCode, 409);
    assert.strictEqual(store.households.h.recurring.length, 1);
    assert.strictEqual(Object.hasOwn(first.body.recurring, "operationKey"), false);
    assert.strictEqual(Object.hasOwn(listed.body.recurring[0], "operationKey"), false);
  });
});

test("create and join enforce user and member quotas without mutating households", async () => {
  const householdsAtLimit = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `mine-${index}`,
    {
      id: `mine-${index}`,
      code: index === 0 ? "GHJ234" : undefined,
      ownerKey: "A",
      members: ["A"],
    },
  ]));
  const fullMembers = Array.from({ length: 50 }, (_, index) => `member-${index}`);
  const store = {
    users: {},
    households: {
      ...householdsAtLimit,
      open: { id: "open", code: "ABC234", ownerKey: "B", members: ["B"] },
      full: { id: "full", code: "DEF234", ownerKey: fullMembers[0], members: fullMembers },
    },
    expenses: {},
    settlements: {},
  };

  await withFakeDb(store, async (households) => {
    const routes = mountedRoutes(households);

    const created = await callRoute(routes, "POST", "/api/households", {
      userKey: "A", body: { name: "One too many" },
    });
    assert.strictEqual(created.statusCode, 413);
    assert.deepStrictEqual(created.body, { error: "Household limit reached" });

    const joined = await callRoute(routes, "POST", "/api/households/join", {
      userKey: "A", body: { code: "ABC234" },
    });
    assert.strictEqual(joined.statusCode, 413);
    assert.deepStrictEqual(joined.body, { error: "Household limit reached" });

    const full = await callRoute(routes, "POST", "/api/households/join", {
      userKey: "new-member", body: { code: "DEF234" },
    });
    assert.strictEqual(full.statusCode, 413);
    assert.deepStrictEqual(full.body, { error: "Household member limit reached" });

    const alreadyJoined = await callRoute(routes, "POST", "/api/households/join", {
      userKey: "A", body: { code: "GHJ234" },
    });
    assert.deepStrictEqual(alreadyJoined.body, { ok: true, id: "mine-0" });
    assert.strictEqual(Object.keys(store.households).length, 22);
    assert.deepStrictEqual(store.households.open.members, ["B"]);
    assert.deepStrictEqual(store.households.full.members, fullMembers);
  });
});

test("household mutations cannot commit after account deletion or username reuse", async () => {
  const store = {
    users: { A: { authVersion: "new-version" }, B: { authVersion: "b-version" } },
    households: {
      h: {
        id: "h",
        code: "ABC234",
        ownerKey: "A",
        members: ["A", "B"],
        recurring: [{ id: "old-bill", description: "Rent", amount: 10, dayOfMonth: 1 }],
      },
    },
    expenses: {
      debt: { householdId: "h", paidBy: "B", amount: 2, splitAmong: ["A", "B"] },
    },
    settlements: {
      pending: {
        id: "pending",
        householdId: "h",
        from: "B",
        to: "A",
        amount: 1,
        method: "cash",
        status: "pending",
      },
    },
  };
  const before = JSON.stringify(store);
  await withFakeDb(store, async (households) => {
    const routes = mountedRoutes(households);
    const base = { userKey: "A", authVersion: "old-version" };
    for (const [method, path, request] of [
      ["POST", "/api/households", { ...base, body: { name: "Orphan" } }],
      ["POST", "/api/households/join", { ...base, body: { code: "ABC234" } }],
      ["POST", "/api/households/:id/expenses", {
        ...base,
        params: { id: "h" },
        body: { description: "Orphan", amount: 1 },
      }],
      ["POST", "/api/households/:id/settle", {
        ...base,
        params: { id: "h" },
        body: { to: "B", amount: 1, method: "cash" },
      }],
      ["POST", "/api/households/:id/settlements/:sid/confirm", {
        ...base,
        params: { id: "h", sid: "pending" },
        body: {},
      }],
      ["POST", "/api/households/:id/recurring", {
        ...base,
        params: { id: "h" },
        body: { description: "Orphan", amount: 1, dayOfMonth: 1 },
      }],
      ["DELETE", "/api/households/:id/recurring/:rid", {
        ...base,
        params: { id: "h", rid: "old-bill" },
        body: {},
      }],
    ]) {
      const res = await callRoute(routes, method, path, request);
      assert.strictEqual(res.statusCode, 401);
    }
    assert.strictEqual(JSON.stringify(store), before);
  });
});

test("household resource quotas return 413 without adding state", async () => {
  const expenses = Object.fromEntries(Array.from(
    { length: MAX_EXPENSES_PER_HOUSEHOLD },
    (_, index) => [
      `expense-${index}`,
      index === 0
        ? { householdId: "h", paidBy: "A", amount: 100, splitAmong: ["A", "B"] }
        : { householdId: "h" },
    ],
  ));
  const settlements = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
    `settlement-${index}`,
    { householdId: "h", from: "A", to: "B", status: "pending" },
  ]));
  const recurring = Array.from({ length: 100 }, (_, index) => ({ id: `bill-${index}` }));
  const store = {
    users: {},
    households: {
      h: { id: "h", ownerKey: "A", members: ["A", "B"], recurring },
    },
    expenses,
    settlements,
  };

  await withFakeDb(store, async (households) => {
    const routes = mountedRoutes(households);

    const expense = await callRoute(routes, "POST", "/api/households/:id/expenses", {
      userKey: "A",
      params: { id: "h" },
      body: { description: "Blocked", amount: 1 },
    });
    assert.strictEqual(expense.statusCode, 413);
    assert.deepStrictEqual(expense.body, { error: "Expense limit reached for this household" });

    const bill = await callRoute(routes, "POST", "/api/households/:id/recurring", {
      userKey: "A",
      params: { id: "h" },
      body: { description: "Blocked", amount: 1, dayOfMonth: 1 },
    });
    assert.strictEqual(bill.statusCode, 413);
    assert.deepStrictEqual(bill.body, { error: "Recurring bill limit reached for this household" });

    const settlement = await callRoute(routes, "POST", "/api/households/:id/settle", {
      userKey: "B",
      params: { id: "h" },
      body: { to: "A", amount: 50, method: "cash" },
    });
    assert.strictEqual(settlement.statusCode, 413);
    assert.deepStrictEqual(settlement.body, { error: "Settlement limit reached for this household" });

    assert.strictEqual(Object.keys(store.expenses).length, MAX_EXPENSES_PER_HOUSEHOLD);
    assert.strictEqual(store.households.h.recurring.length, 100);
    assert.strictEqual(Object.keys(store.settlements).length, 1000);
  });
});

test("per-account quotas prevent multiplying state across many households", async () => {
  const expenses = Object.fromEntries(Array.from(
    { length: MAX_EXPENSES_PER_HOUSEHOLD },
    (_, index) => [`mine-${index}`, {
      householdId: "other",
      paidBy: "A",
      amount: 1,
      splitAmong: ["A"],
    }],
  ));
  expenses.debt = {
    householdId: "h",
    paidBy: "B",
    amount: 2,
    splitAmong: ["A", "B"],
  };
  const settlements = Object.fromEntries(Array.from(
    { length: 1000 },
    (_, index) => [`mine-${index}`, {
      householdId: "other",
      from: "A",
      to: "B",
      amount: 1,
      status: "confirmed",
    }],
  ));
  const recurring = Array.from(
    { length: 200 },
    (_, index) => ({ id: `mine-${index}`, createdBy: "A" }),
  );
  const store = {
    users: { A: {}, B: {} },
    households: {
      h: { id: "h", ownerKey: "B", members: ["A", "B"], recurring: [] },
      other: { id: "other", ownerKey: "A", members: ["A", "B"], recurring },
    },
    expenses,
    settlements,
  };

  await withFakeDb(store, async (households) => {
    const routes = mountedRoutes(households);
    const expense = await callRoute(routes, "POST", "/api/households/:id/expenses", {
      userKey: "A",
      params: { id: "h" },
      body: { description: "Blocked", amount: 1 },
    });
    const settlement = await callRoute(routes, "POST", "/api/households/:id/settle", {
      userKey: "A",
      params: { id: "h" },
      body: { to: "B", amount: 1, method: "cash" },
    });
    const bill = await callRoute(routes, "POST", "/api/households/:id/recurring", {
      userKey: "A",
      params: { id: "h" },
      body: { description: "Blocked", amount: 1, dayOfMonth: 1 },
    });

    assert.strictEqual(expense.statusCode, 413);
    assert.strictEqual(settlement.statusCode, 413);
    assert.strictEqual(bill.statusCode, 413);
    assert.match(expense.body.error, /account/i);
    assert.match(settlement.body.error, /account/i);
    assert.match(bill.body.error, /account/i);
  });
});
