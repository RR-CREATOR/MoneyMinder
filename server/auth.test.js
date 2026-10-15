const test = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const NEW_PASSWORD = "correct horse battery";
const CURRENT_PASSWORD = "current horse battery";

async function withFakeDb(store, fn, overrides = {}) {
  const dbPath = require.resolve("./db");
  const fakeDb = {
    load: () => store,
    update: async (h) => h(store),
    scrubBackup: async () => {},
    dir: "unused",
    kind: "file",
    ...overrides,
  };
  const real = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
  delete require.cache[require.resolve("./auth")];
  delete require.cache[require.resolve("./uploads")];
  try { return await fn(require("./auth")); }
  finally {
    require.cache[dbPath] = real;
    delete require.cache[require.resolve("./auth")];
    delete require.cache[require.resolve("./uploads")];
  }
}

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function emptyStore() {
  return { users: {}, receipts: {}, households: {}, expenses: {}, settlements: {}, tokens: {} };
}

test("register rejects unsafe or invalid account fields", async () => {
  const store = emptyStore();
  const valid = {
    username: "Alice",
    email: "alice@example.com",
    mobile: "1234567890",
    budget: 1000,
    password: NEW_PASSWORD,
  };
  const cases = [
    [{}, /All fields/],
    [{ ...valid, username: "../alice" }, /Username/],
    [{ ...valid, username: "." }, /Username/],
    [{ ...valid, username: ".." }, /Username/],
    [{ ...valid, password: "x".repeat(14) }, /at least 15/],
    [{ ...valid, password: "\u{1F600}".repeat(14) }, /at least 15/],
    [{ ...valid, password: "x".repeat(73) }, /72/],
    [{ ...valid, password: "\u{1F600}".repeat(19) }, /72/],
    [{ ...valid, email: "not-an-email" }, /email/i],
    [{ ...valid, mobile: "x" }, /mobile/i],
    [{ ...valid, email: "a".repeat(255) }, /too long/],
    [{ ...valid, budget: -1 }, /Invalid budget/],
    [{ ...valid, vpa: "not-a-vpa" }, /Invalid UPI/],
  ];

  await withFakeDb(store, async ({ register }) => {
    for (const [body, expectedError] of cases) {
      const res = fakeRes();
      await register({ body, get: () => "", session: {} }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.match(res.body.error, expectedError);
    }
    assert.deepStrictEqual(store.users, {});
  });
});

test("register persists a safe account once and establishes extension auth", async () => {
  const store = emptyStore();
  const body = {
    username: "Alice",
    email: "alice@example.com",
    mobile: "1234567890",
    budget: "2500",
    password: NEW_PASSWORD,
    vpa: "alice@upi",
  };

  await withFakeDb(store, async ({ register, isKnownBearerToken }) => {
    const req = {
      body,
      get: (name) => name === "X-Client" ? "extension" : "",
      session: { regenerate: (callback) => callback() },
    };
    const res = fakeRes();
    await register(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(req.session.user, undefined);
    assert.match(res.body.token, /^[a-f0-9]{64}$/);
    assert.strictEqual(res.body.user.passwordHash, undefined);
    assert.strictEqual(store.users.alice.budget, 2500);
    assert.match(store.users.alice.authVersion, /^[0-9a-f-]{36}$/);
    assert.strictEqual(req.session.authVersion, undefined);
    assert.strictEqual(await bcrypt.compare(body.password, store.users.alice.passwordHash), true);
    const digest = crypto.createHash("sha256").update(res.body.token).digest("hex");
    assert.strictEqual(store.tokens[res.body.token], undefined);
    assert.strictEqual(store.tokens[digest].userKey, "alice");
    assert.strictEqual(store.tokens[digest].authVersion, store.users.alice.authVersion);
    assert.strictEqual(isKnownBearerToken(`Bearer ${res.body.token}`), true);

    const duplicate = fakeRes();
    await register({
      body: { ...body, username: "ALICE", email: "changed@example.com" },
      get: () => "",
      session: {},
    }, duplicate);
    assert.strictEqual(duplicate.statusCode, 409);
    assert.strictEqual(store.users.alice.email, body.email);
    assert.strictEqual(Object.keys(store.users).length, 1);
  });
});

test("bearer digest cache seeds only current, unexpired tokens", async () => {
  const store = emptyStore();
  const authVersion = crypto.randomUUID();
  const tokens = {
    fresh: "a".repeat(64),
    expired: "b".repeat(64),
    stale: "c".repeat(64),
    deleted: "d".repeat(64),
  };
  store.users.alice = { username: "Alice", authVersion };
  for (const [name, token] of Object.entries(tokens)) {
    const digest = crypto.createHash("sha256").update(token).digest("hex");
    store.tokens[digest] = {
      userKey: name === "deleted" ? "missing" : "alice",
      authVersion: name === "stale" ? crypto.randomUUID() : authVersion,
      createdAt: new Date(Date.now() - (name === "expired" ? 31 * 86400000 : 0)).toISOString(),
    };
  }

  await withFakeDb(store, async ({ initializeTokenCache, isKnownBearerToken }) => {
    await initializeTokenCache();
    assert.strictEqual(isKnownBearerToken(`Bearer ${tokens.fresh}`), true);
    assert.strictEqual(isKnownBearerToken(`Bearer ${tokens.expired}`), false);
    assert.strictEqual(isKnownBearerToken(`Bearer ${tokens.stale}`), false);
    assert.strictEqual(isKnownBearerToken(`Bearer ${tokens.deleted}`), false);
    assert.strictEqual(
      isKnownBearerToken(`Bearer ${tokens.fresh}`, Date.now() + 31 * 86400000),
      false,
    );
  });
});

test("login hides account existence on failures and authenticates valid credentials", async () => {
  const store = emptyStore();
  store.users.alice = {
    username: "Alice",
    email: "alice@example.com",
    mobile: "1234567890",
    budget: 1000,
    authVersion: crypto.randomUUID(),
    passwordHash: await bcrypt.hash("secret123", 4),
  };

  await withFakeDb(store, async ({ login }) => {
    for (const body of [
      { username: "missing", password: "secret123" },
      { username: "alice", password: "wrong" },
    ]) {
      const res = fakeRes();
      await login({ body, get: () => "", session: {} }, res);
      assert.strictEqual(res.statusCode, 401);
      assert.deepStrictEqual(res.body, { error: "Invalid username or password" });
    }

    const req = {
      body: { username: "ALICE", password: "secret123" },
      get: (name) => name === "X-Client" ? "extension" : "",
      session: { regenerate: (callback) => callback() },
    };
    const res = fakeRes();
    await login(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(req.session.user, undefined);
    assert.strictEqual(req.session.authVersion, undefined);
    assert.match(res.body.token, /^[a-f0-9]{64}$/);
    assert.strictEqual(res.body.user.passwordHash, undefined);
  });
});

test("extension login cannot persist a token after the account auth version changes", async () => {
  const store = emptyStore();
  const originalVersion = crypto.randomUUID();
  store.users.alice = {
    username: "Alice",
    authVersion: originalVersion,
    passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4),
  };
  let firstUpdate = true;

  await withFakeDb(store, async ({ login }) => {
    const res = fakeRes();
    await login({
      body: { username: "alice", password: CURRENT_PASSWORD },
      get: (name) => name === "X-Client" ? "extension" : "",
      session: {},
    }, res);

    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.body, { error: "Not authenticated" });
    assert.deepStrictEqual(store.tokens, {});
  }, {
    async update(handler) {
      if (firstUpdate) {
        firstUpdate = false;
        store.users.alice = {
          ...store.users.alice,
          authVersion: crypto.randomUUID(),
        };
      }
      return handler(store);
    },
  });
});

test("logout revokes the presented bearer token and destroys the session", async () => {
  const store = emptyStore();
  const current = "c".repeat(64);
  const other = "d".repeat(64);
  const currentDigest = crypto.createHash("sha256").update(current).digest("hex");
  const otherDigest = crypto.createHash("sha256").update(other).digest("hex");
  store.tokens[currentDigest] = { userKey: "alice", createdAt: new Date().toISOString() };
  store.tokens[otherDigest] = { userKey: "alice", createdAt: new Date().toISOString() };

  await withFakeDb(store, async ({ logout }) => {
    let destroyed = false;
    const res = fakeRes();
    await logout({
      get: (name) => name === "Authorization" ? `Bearer ${current}` : "",
      session: { destroy: (callback) => { destroyed = true; callback(); } },
    }, res);

    assert.strictEqual(destroyed, true);
    assert.strictEqual(store.tokens[currentDigest], undefined);
    assert.ok(store.tokens[otherDigest]);
    assert.deepStrictEqual(res.body, { ok: true });
  });
});

test("logout succeeds without a bearer token or browser session", async () => {
  const store = emptyStore();
  await withFakeDb(store, async ({ logout }) => {
    const res = fakeRes();
    await logout({ get: () => "" }, res);
    assert.deepStrictEqual(res.body, { ok: true });

    const noTokenStore = emptyStore();
    delete noTokenStore.tokens;
    await withFakeDb(noTokenStore, async ({ logout: logoutWithoutTokenStore }) => {
      const second = fakeRes();
      await logoutWithoutTokenStore({ get: () => `Bearer ${"e".repeat(64)}` }, second);
      assert.deepStrictEqual(second.body, { ok: true });
      assert.strictEqual(noTokenStore.tokens, undefined);
    });
  });
});

test("logout with an unknown bearer remains idempotent without taking the mutation path", async () => {
  const store = emptyStore();
  const unknown = "e".repeat(64);
  let reads = 0;
  let writes = 0;
  await withFakeDb(store, async ({ logout }) => {
    const res = fakeRes();
    await logout({
      get: (name) => name === "Authorization" ? `Bearer ${unknown}` : "",
    }, res);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(reads, 1);
    assert.strictEqual(writes, 0);
  }, {
    async load() {
      reads++;
      return store;
    },
    async update() {
      writes++;
      throw new Error("unknown token must not acquire the mutation path");
    },
  });
});

test("concurrent logout requests coalesce one valid-token mutation", async () => {
  const store = emptyStore();
  const token = "f".repeat(64);
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  const authVersion = crypto.randomUUID();
  store.users.alice = { username: "Alice", authVersion };
  store.tokens[digest] = {
    userKey: "alice",
    authVersion,
    createdAt: new Date().toISOString(),
  };
  let reads = 0;
  let writes = 0;

  await withFakeDb(store, async ({
    initializeTokenCache,
    isKnownBearerToken,
    logout,
  }) => {
    await initializeTokenCache();
    assert.strictEqual(isKnownBearerToken(`Bearer ${token}`), true);

    const responses = new Array(12).fill(null).map(() => fakeRes());
    await Promise.all(responses.map((res) => logout({
      get: (name) => name === "Authorization" ? `Bearer ${token}` : "",
    }, res)));

    assert.strictEqual(reads, 1);
    assert.strictEqual(writes, 1);
    assert.strictEqual(store.tokens[digest], undefined);
    assert.strictEqual(isKnownBearerToken(`Bearer ${token}`), false);
    for (const res of responses) assert.deepStrictEqual(res.body, { ok: true });
  }, {
    async load() {
      reads++;
      return structuredClone(store);
    },
    async update(handler) {
      writes++;
      await new Promise((resolve) => setImmediate(resolve));
      return handler(store);
    },
  });
});

test("pending logout fails bearer admission closed and recovers after a failed mutation", async () => {
  const store = emptyStore();
  const token = "9".repeat(64);
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  const authVersion = crypto.randomUUID();
  store.users.alice = { username: "Alice", authVersion };
  store.tokens[digest] = {
    userKey: "alice",
    authVersion,
    createdAt: new Date().toISOString(),
  };
  let reads = 0;
  let writes = 0;
  let markMutationStarted;
  const mutationStarted = new Promise((resolve) => { markMutationStarted = resolve; });
  let rejectMutation;
  const mutationGate = new Promise((resolve, reject) => { rejectMutation = reject; });
  const authorization = `Bearer ${token}`;

  await withFakeDb(store, async ({
    initializeTokenCache,
    isKnownBearerToken,
    logout,
    requireAuth,
  }) => {
    await initializeTokenCache();
    assert.strictEqual(isKnownBearerToken(authorization), true);

    const logoutRejected = assert.rejects(
      logout({
        get: (name) => name === "Authorization" ? authorization : "",
      }, fakeRes()),
      /revocation failed/,
    );
    await mutationStarted;

    const knownWhilePending = isKnownBearerToken(authorization);
    const pendingResponse = fakeRes();
    let pendingNext = 0;
    await requireAuth({
      get: (name) => name === "Authorization" ? authorization : "",
    }, pendingResponse, () => { pendingNext++; });

    rejectMutation(new Error("revocation failed"));
    await logoutRejected;

    const knownAfterFailure = isKnownBearerToken(authorization);
    const recoveredResponse = fakeRes();
    let recoveredNext = 0;
    await requireAuth({
      get: (name) => name === "Authorization" ? authorization : "",
    }, recoveredResponse, () => { recoveredNext++; });

    assert.strictEqual(knownWhilePending, false);
    assert.strictEqual(pendingResponse.statusCode, 401);
    assert.strictEqual(pendingNext, 0);
    assert.strictEqual(knownAfterFailure, true);
    assert.strictEqual(recoveredResponse.statusCode, 200);
    assert.strictEqual(recoveredNext, 1);
    assert.strictEqual(reads, 2);
    assert.strictEqual(writes, 1);
    assert.ok(store.tokens[digest]);
  }, {
    async load() {
      reads++;
      return structuredClone(store);
    },
    async update(handler) {
      writes++;
      markMutationStarted();
      await mutationGate;
      return handler(store);
    },
  });
});

test("malformed bearer values are rejected without loading application state", async () => {
  let reads = 0;
  await withFakeDb(emptyStore(), async ({ logout, requireAuth }) => {
    const request = {
      get: (name) => name === "Authorization" ? "Bearer malformed" : "",
    };
    const logoutResponse = fakeRes();
    await logout(request, logoutResponse);
    assert.deepStrictEqual(logoutResponse.body, { ok: true });

    const authResponse = fakeRes();
    await requireAuth(request, authResponse, () => assert.fail("malformed token reached next"));
    assert.strictEqual(authResponse.statusCode, 401);
    assert.strictEqual(reads, 0);
  }, {
    async load() {
      reads++;
      return emptyStore();
    },
  });
});

test("logout never reports success when session revocation fails", async () => {
  await withFakeDb(emptyStore(), async ({ logout }) => {
    const res = fakeRes();
    await assert.rejects(
      logout({
        get: () => "",
        session: { destroy: (callback) => callback(new Error("session store unavailable")) },
      }, res),
      /session store unavailable/,
    );
    assert.strictEqual(res.body, null);
  });
});

test("requireAuth accepts sessions and fresh bearer tokens but rejects expired tokens", async () => {
  const store = emptyStore();
  const authVersion = crypto.randomUUID();
  const fresh = "f".repeat(64);
  const expired = "e".repeat(64);
  store.users.alice = { username: "Alice", authVersion };
  const freshDigest = crypto.createHash("sha256").update(fresh).digest("hex");
  const expiredDigest = crypto.createHash("sha256").update(expired).digest("hex");
  store.tokens[freshDigest] = { userKey: "alice", authVersion, createdAt: new Date().toISOString() };
  store.tokens[expiredDigest] = {
    userKey: "alice",
    authVersion,
    createdAt: new Date(Date.now() - 31 * 86400000).toISOString(),
  };

  await withFakeDb(store, async ({ requireAuth }) => {
    const sessionReq = { session: { user: "alice", authVersion }, get: () => "" };
    let sessionNext = 0;
    await requireAuth(sessionReq, fakeRes(), () => { sessionNext += 1; });
    assert.strictEqual(sessionReq.userKey, "alice");
    assert.strictEqual(sessionReq.authVersion, authVersion);
    assert.strictEqual(sessionNext, 1);

    const bearerReq = {
      get: (name) => name === "Authorization" ? `Bearer ${fresh}` : "",
    };
    let bearerNext = 0;
    await requireAuth(bearerReq, fakeRes(), () => { bearerNext += 1; });
    assert.strictEqual(bearerReq.userKey, "alice");
    assert.strictEqual(bearerReq.authVersion, authVersion);
    assert.strictEqual(bearerNext, 1);

    const expiredReq = {
      get: (name) => name === "Authorization" ? `Bearer ${expired}` : "",
    };
    const expiredRes = fakeRes();
    await requireAuth(expiredReq, expiredRes, () => assert.fail("expired token reached next"));
    assert.strictEqual(expiredRes.statusCode, 401);
    assert.deepStrictEqual(expiredRes.body, { error: "Not authenticated" });

    const staleReq = {
      session: { user: "alice", authVersion: crypto.randomUUID() },
      get: () => "",
    };
    const staleRes = fakeRes();
    await requireAuth(staleReq, staleRes, () => assert.fail("stale session reached next"));
    assert.strictEqual(staleRes.statusCode, 401);

    delete store.users.alice;
    const deletedRes = fakeRes();
    await requireAuth(sessionReq, deletedRes, () => assert.fail("deleted account reached next"));
    assert.strictEqual(deletedRes.statusCode, 401);
  });
});

test("requireAuth rejects malformed, unknown, deleted-user, and stale-version bearer tokens", async () => {
  const store = emptyStore();
  const authVersion = crypto.randomUUID();
  store.users.alice = { username: "Alice", authVersion };
  const records = [
    ["a".repeat(64), { userKey: "missing", authVersion, createdAt: new Date().toISOString() }],
    ["b".repeat(64), { userKey: "alice", authVersion: crypto.randomUUID(), createdAt: new Date().toISOString() }],
    ["c".repeat(64), { userKey: "alice", authVersion }],
  ];
  for (const [token, record] of records) {
    store.tokens[crypto.createHash("sha256").update(token).digest("hex")] = record;
  }

  await withFakeDb(store, async ({ requireAuth }) => {
    for (const authorization of [
      "",
      "Basic abc",
      "Bearer absent",
      `Bearer ${"a".repeat(64)}`,
      `Bearer ${"b".repeat(64)}`,
      `Bearer ${"c".repeat(64)}`,
    ]) {
      const res = fakeRes();
      await requireAuth(
        { get: (name) => name === "Authorization" ? authorization : "" },
        res,
        () => assert.fail(`${authorization || "empty"} reached next`),
      );
      assert.strictEqual(res.statusCode, 401);
    }
  });
});

test("requireSession permits cookie sessions and blocks bearer clients", async () => {
  await withFakeDb(emptyStore(), async ({ requireSession }) => {
    let nextCalls = 0;
    requireSession({ authType: "session" }, fakeRes(), () => { nextCalls += 1; });
    assert.strictEqual(nextCalls, 1);

    const res = fakeRes();
    requireSession({ authType: "bearer" }, res, () => assert.fail("bearer client reached next"));
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: "Browser session required" });
  });
});

test("me returns only the authenticated user's public profile", async () => {
  const store = emptyStore();
  store.users.alice = {
    username: "Alice",
    email: "alice@example.com",
    mobile: "1234567890",
    budget: 1000,
    vpa: "alice@upi",
    displayName: "Alice A",
    passwordHash: "secret",
  };

  await withFakeDb(store, async ({ me }) => {
    const res = fakeRes();
    await me({ userKey: "alice" }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.user.username, "Alice");
    assert.strictEqual(res.body.user.passwordHash, undefined);
  });
});

test("profile and export endpoints reject an account deleted after authentication", async () => {
  await withFakeDb(emptyStore(), async ({ me, updateMe, exportMe }) => {
    for (const run of [
      (res) => me({ userKey: "missing" }, res),
      (res) => updateMe({ userKey: "missing", body: {} }, res),
      (res) => exportMe({ userKey: "missing" }, res),
    ]) {
      const res = fakeRes();
      await run(res);
      assert.strictEqual(res.statusCode, 401);
      assert.deepStrictEqual(res.body, { error: "Not authenticated" });
    }
  });
});

test("updateMe requires the same current-password proof for missing and wrong VPA changes", async () => {
  const store = emptyStore();
  const authVersion = crypto.randomUUID();
  store.users.alice = {
    username: "Alice",
    email: "alice@example.com",
    mobile: "1234567890",
    budget: 1000,
    vpa: "",
    displayName: "",
    authVersion,
    passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4),
  };

  await withFakeDb(store, async ({ updateMe }) => {
    let expectedError;
    for (const currentPassword of [undefined, "wrong password"]) {
      const res = fakeRes();
      await updateMe({
        userKey: "alice",
        authVersion,
        body: { vpa: "alice@upi", currentPassword },
      }, res);
      assert.strictEqual(res.statusCode, 403);
      expectedError ||= res.body;
      assert.deepStrictEqual(res.body, expectedError);
      assert.strictEqual(store.users.alice.vpa, "");
    }

    const unrelated = fakeRes();
    await updateMe({
      userKey: "alice",
      authVersion,
      body: { displayName: "Alice A" },
    }, unrelated);
    assert.strictEqual(unrelated.statusCode, 200);

    const verified = fakeRes();
    await updateMe({
      userKey: "alice",
      authVersion,
      body: { vpa: "alice@upi", currentPassword: CURRENT_PASSWORD },
    }, verified);
    assert.strictEqual(verified.statusCode, 200);
    assert.strictEqual(store.users.alice.vpa, "alice@upi");
  });
});

test("updateMe cannot mutate a re-created account after reauthentication", async () => {
  const store = emptyStore();
  const authenticatedVersion = crypto.randomUUID();
  store.users.alice = {
    username: "Alice",
    vpa: "",
    displayName: "",
    authVersion: authenticatedVersion,
    passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4),
  };
  let firstUpdate = true;

  await withFakeDb(store, async ({ updateMe }) => {
    const res = fakeRes();
    await updateMe({
      userKey: "alice",
      authVersion: authenticatedVersion,
      body: { vpa: "alice@upi", currentPassword: CURRENT_PASSWORD },
    }, res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(store.users.alice.vpa, "");
  }, {
    async update(handler) {
      if (firstUpdate) {
        firstUpdate = false;
        store.users.alice = {
          ...store.users.alice,
          authVersion: crypto.randomUUID(),
        };
      }
      return handler(store);
    },
  });
});

test("updateMe validates profile fields and persists only allowed updates", async () => {
  const store = emptyStore();
  const authVersion = crypto.randomUUID();
  store.users.alice = {
    username: "Alice",
    email: "alice@example.com",
    mobile: "1234567890",
    budget: 1000,
    vpa: "",
    displayName: "",
    authVersion,
    passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4),
  };
  const invalidBodies = [
    [{ vpa: "bad" }, /Invalid UPI/],
    [{ budget: "many" }, /Invalid budget/],
    [{ budget: -1 }, /Invalid budget/],
    [{ displayName: "a".repeat(65) }, /too long/],
  ];

  await withFakeDb(store, async ({ updateMe }) => {
    for (const [body, expectedError] of invalidBodies) {
      const res = fakeRes();
      await updateMe({ userKey: "alice", authVersion, body }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.match(res.body.error, expectedError);
    }
    assert.strictEqual(store.users.alice.budget, 1000);

    const res = fakeRes();
    await updateMe({
      userKey: "alice",
      authVersion,
      body: {
        budget: "2500.5",
        vpa: "alice@upi",
        displayName: "Alice A",
        email: "ignored@example.com",
        currentPassword: CURRENT_PASSWORD,
      },
    }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(
      { budget: res.body.user.budget, vpa: res.body.user.vpa, displayName: res.body.user.displayName },
      { budget: 2500.5, vpa: "alice@upi", displayName: "Alice A" },
    );
    assert.strictEqual(store.users.alice.email, "alice@example.com");
    assert.strictEqual(res.body.user.passwordHash, undefined);
  });
});

test("exportMe returns the user's data without password hashes or bearer tokens", async () => {
  const authVersion = crypto.randomUUID();
  const store = {
    users: {
      a: {
        username: "A",
        email: "a@example.com",
        mobile: "1",
        authVersion,
        passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4),
      },
    },
    receipts: { r: { id: "r", userKey: "a", amount: 20, operationKey: "receipt-secret" } },
    households: {
      h: {
        id: "h",
        members: ["a"],
        recurring: [{ id: "rr", createdBy: "a", operationKey: "recurring-secret" }],
      },
    },
    expenses: {
      e: { id: "e", householdId: "h", operationKey: "expense-secret" },
    },
    settlements: {
      s: { id: "s", from: "a", to: "b", operationKey: "settlement-secret" },
    },
    tokens: { token: { userKey: "a" } },
  };
  await withFakeDb(store, async ({ exportMe }) => {
    let expectedError;
    for (const currentPassword of [undefined, "wrong password"]) {
      const denied = fakeRes();
      await exportMe({ userKey: "a", authVersion, body: { currentPassword } }, denied);
      assert.strictEqual(denied.statusCode, 403);
      expectedError ||= denied.body;
      assert.deepStrictEqual(denied.body, expectedError);
      assert.strictEqual(denied.body.receipts, undefined);
    }

    const res = fakeRes();
    await exportMe({
      userKey: "a",
      authVersion,
      body: { currentPassword: CURRENT_PASSWORD },
    }, res);
    assert.strictEqual(res.body.user.passwordHash, undefined);
    assert.strictEqual(res.body.tokens, undefined);
    assert.strictEqual(res.body.receipts.length, 1);
    assert.strictEqual(res.body.receipts[0].operationKey, undefined);
    assert.strictEqual(res.body.households[0].recurring[0].operationKey, undefined);
    assert.strictEqual(res.body.expenses[0].operationKey, undefined);
    assert.strictEqual(res.body.settlements[0].operationKey, undefined);
  });
});

test("deleteMe rejects missing and wrong current passwords without changing account data", async () => {
  const store = {
    users: {
      a: {
        username: "A",
        authVersion: crypto.randomUUID(),
        passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4),
      },
    },
    receipts: { r: { id: "r", userKey: "a" } },
    households: {},
    expenses: {},
    settlements: {},
    tokens: {},
  };

  await withFakeDb(store, async ({ deleteMe }) => {
    const authVersion = store.users.a.authVersion;
    let expectedError;
    for (const currentPassword of [undefined, "wrong password"]) {
      const res = fakeRes();
      await deleteMe({ userKey: "a", authVersion, body: { currentPassword } }, res);
      assert.strictEqual(res.statusCode, 403);
      expectedError ||= res.body;
      assert.deepStrictEqual(res.body, expectedError);
      assert.ok(store.users.a);
      assert.ok(store.receipts.r);
    }
  });
});

test("deleteMe cannot delete a re-created account after reauthentication", async () => {
  const store = {
    users: {
      a: {
        username: "A",
        authVersion: crypto.randomUUID(),
        passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4),
      },
    },
    receipts: {},
    households: {},
    expenses: {},
    settlements: {},
    tokens: {},
  };
  const authenticatedVersion = store.users.a.authVersion;
  let firstUpdate = true;

  await withFakeDb(store, async ({ deleteMe }) => {
    const res = fakeRes();
    await deleteMe({
      userKey: "a",
      authVersion: authenticatedVersion,
      body: { currentPassword: CURRENT_PASSWORD },
    }, res);
    assert.strictEqual(res.statusCode, 401);
    assert.ok(store.users.a);
  }, {
    async update(handler) {
      if (firstUpdate) {
        firstUpdate = false;
        store.users.a = {
          ...store.users.a,
          authVersion: crypto.randomUUID(),
        };
      }
      return handler(store);
    },
  });
});

test("deleteMe rotates shared invites and removes households with no active members", async () => {
  const authVersion = crypto.randomUUID();
  const store = {
    users: {
      a: {
        username: "A",
        authVersion,
        passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4),
      },
      b: { username: "B", authVersion: crypto.randomUUID(), passwordHash: "secret" },
    },
    receipts: {},
    households: {
      shared: {
        id: "shared",
        code: "ABC234",
        ownerKey: "a",
        members: ["a", "b"],
        recurring: [],
      },
      orphan: {
        id: "orphan",
        code: "DEF234",
        ownerKey: "a",
        members: ["a", "deleted-old"],
        recurring: [],
      },
      unrelated: {
        id: "unrelated",
        code: "GHJ234",
        ownerKey: "b",
        members: ["b"],
        recurring: [],
      },
    },
    expenses: {
      shared: { id: "shared", householdId: "shared", paidBy: "a", splitAmong: ["a", "b"] },
      orphan: { id: "orphan", householdId: "orphan", paidBy: "a", splitAmong: ["a"] },
    },
    settlements: {
      shared: { id: "shared", householdId: "shared", from: "a", to: "b" },
      orphan: { id: "orphan", householdId: "orphan", from: "a", to: "a" },
    },
    tokens: {},
  };

  await withFakeDb(store, async ({ deleteMe }) => {
    const res = fakeRes();
    await deleteMe({
      userKey: "a",
      authVersion,
      body: { currentPassword: CURRENT_PASSWORD },
    }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.match(store.households.shared.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.notStrictEqual(store.households.shared.code, "ABC234");
    assert.ok(store.expenses.shared);
    assert.ok(store.settlements.shared);
    assert.strictEqual(store.households.orphan, undefined);
    assert.strictEqual(store.expenses.orphan, undefined);
    assert.strictEqual(store.settlements.orphan, undefined);
    assert.strictEqual(store.households.unrelated.code, "GHJ234");
  });
});

test("deleteMe aborts without mutation when invite rotation cannot allocate a unique code", async () => {
  const authVersion = crypto.randomUUID();
  const store = {
    users: {
      a: {
        username: "A",
        authVersion,
        passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4),
      },
      b: { username: "B", passwordHash: "secret" },
    },
    receipts: { r: { id: "r", userKey: "a" } },
    households: {
      h: { id: "h", code: "AAAAAA", ownerKey: "a", members: ["a", "b"], recurring: [] },
    },
    expenses: {},
    settlements: {},
    tokens: {},
  };
  const realRandomBytes = crypto.randomBytes;
  crypto.randomBytes = () => Buffer.alloc(6);
  try {
    await withFakeDb(store, async ({ deleteMe }) => {
      await assert.rejects(
        deleteMe({
          userKey: "a",
          authVersion,
          body: { currentPassword: CURRENT_PASSWORD },
        }, fakeRes()),
        (error) => error.code === "CODE_BUSY",
      );
      assert.ok(store.users.a);
      assert.ok(store.receipts.r);
      assert.deepStrictEqual(store.households.h.members, ["a", "b"]);
      assert.strictEqual(store.households.h.code, "AAAAAA");
    });
  } finally {
    crypto.randomBytes = realRandomBytes;
  }
});

test("deleteMe removes credentials and personal receipts while anonymizing shared records", async () => {
  const authVersion = crypto.randomUUID();
  const token = "e".repeat(64);
  const tokenDigest = crypto.createHash("sha256").update(token).digest("hex");
  const store = {
    users: {
      a: { username: "A", authVersion, passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4) },
      b: { username: "B", passwordHash: "secret" },
    },
    receipts: { r: { id: "r", userKey: "a", amount: 20 } },
    households: { h: { id: "h", ownerKey: "a", members: ["a", "b"] } },
    expenses: { e: { id: "e", householdId: "h", paidBy: "a", splitAmong: ["a", "b"], amount: 20 } },
    settlements: {},
    tokens: {
      [tokenDigest]: {
        userKey: "a",
        authVersion,
        createdAt: new Date().toISOString(),
      },
    },
  };
  await withFakeDb(store, async ({ deleteMe, initializeTokenCache, isKnownBearerToken }) => {
    await initializeTokenCache();
    assert.strictEqual(isKnownBearerToken(`Bearer ${token}`), true);
    const res = fakeRes();
    await deleteMe({
      userKey: "a",
      authVersion,
      body: { currentPassword: CURRENT_PASSWORD },
      session: { destroy: (cb) => cb() },
    }, res);
    assert.strictEqual(store.users.a, undefined);
    assert.strictEqual(store.receipts.r, undefined);
    assert.strictEqual(store.tokens[tokenDigest], undefined);
    assert.strictEqual(isKnownBearerToken(`Bearer ${token}`), false);
    const anon = store.households.h.members.find((m) => m !== "b");
    assert.match(anon, /^deleted-/);
    assert.strictEqual(store.expenses.e.paidBy, anon);
    assert.ok(store.expenses.e.splitAmong.includes(anon));
  });
});

test("deleteMe removes a sole-owner household and settlement without a session", async () => {
  const authVersion = crypto.randomUUID();
  const store = {
    users: {
      a: { username: "A", authVersion, passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4) },
    },
    receipts: {},
    households: { h: { id: "h", ownerKey: "a", members: ["a"] } },
    expenses: {},
    settlements: { s: { id: "s", householdId: "h", from: "a", to: "a", amount: 5 } },
    tokens: {},
  };
  await withFakeDb(store, async ({ deleteMe }) => {
    const res = fakeRes();
    await deleteMe({
      userKey: "a",
      authVersion,
      body: { currentPassword: CURRENT_PASSWORD },
    }, res);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(store.households.h, undefined);
    assert.strictEqual(store.settlements.s, undefined);

    const missing = fakeRes();
    await deleteMe({
      userKey: "a",
      authVersion,
      body: { currentPassword: CURRENT_PASSWORD },
    }, missing);
    assert.strictEqual(missing.statusCode, 401);
  });
});

test("deleteMe scrubs private state and durably retries a failed upload removal", async () => {
  const authVersion = crypto.randomUUID();
  const store = {
    users: {
      a: {
        username: "A",
        email: "private@example.com",
        authVersion,
        passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4),
      },
      b: { username: "B", authVersion: crypto.randomUUID(), passwordHash: "secret" },
    },
    receipts: {
      r: { id: "r", userKey: "a", supplier: "Private merchant", image: "receipt.jpg" },
    },
    households: {
      h: {
        id: "h",
        ownerKey: "a",
        members: ["a", "b"],
        recurring: [{
          id: "monthly",
          createdBy: "a",
          splitAmong: ["a", "b"],
          amount: 10,
        }],
      },
    },
    expenses: {},
    settlements: {},
    tokens: { token: { userKey: "a" } },
  };
  const realRm = fs.promises.rm;
  const events = [];
  let backup;
  fs.promises.rm = async (_target, options) => {
    events.push("rm");
    assert.deepStrictEqual(options, { recursive: true, force: true });
    if (events.filter((event) => event === "rm").length === 1) {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    }
  };
  try {
    await withFakeDb(store, async ({ deleteMe }) => {
      const res = fakeRes();
      await deleteMe({
        userKey: "a",
        authVersion,
        body: { currentPassword: CURRENT_PASSWORD },
        session: { destroy: (callback) => callback() },
      }, res);

      assert.deepStrictEqual(res.body, { ok: true });
      assert.strictEqual(store.users.a, undefined);
      assert.strictEqual(store.receipts.r, undefined);
      assert.strictEqual(store.tokens.token, undefined);
      assert.strictEqual(backup.users.a, undefined);
      assert.strictEqual(backup.receipts.r, undefined);
      const deletedKey = store.households.h.members.find((member) => member !== "b");
      assert.match(deletedKey, /^deleted-/);
      assert.strictEqual(store.households.h.recurring[0].createdBy, deletedKey);
      assert.deepStrictEqual(store.households.h.recurring[0].splitAmong, [deletedKey, "b"]);
      assert.deepStrictEqual(events, ["scrub"]);
      assert.strictEqual(Object.keys(store.pendingUploadDeletes).length, 1);

      await require("./uploads").retryPendingDeletes();
      assert.strictEqual(Object.keys(store.pendingUploadDeletes).length, 1);

      const blockedReuse = fakeRes();
      await require("./auth").register({
        body: {
          username: "A",
          email: "new@example.com",
          mobile: "1234567890",
          budget: 100,
          password: NEW_PASSWORD,
        },
        get: () => "",
        session: {},
      }, blockedReuse);
      assert.strictEqual(blockedReuse.statusCode, 409);
      assert.strictEqual(store.users.a, undefined);

      await require("./uploads").retryPendingDeletes();
      assert.strictEqual(store.pendingUploadDeletes, undefined);
      assert.deepStrictEqual(events, ["scrub", "rm", "rm"]);

      const allowedReuse = fakeRes();
      await require("./auth").register({
        body: {
          username: "A",
          email: "new@example.com",
          mobile: "1234567890",
          budget: 100,
          password: NEW_PASSWORD,
        },
        get: (name) => name === "X-Client" ? "extension" : "",
        session: {},
      }, allowedReuse);
      assert.strictEqual(allowedReuse.statusCode, 200);
      assert.ok(store.users.a);
      assert.strictEqual(store.households.h.recurring[0].createdBy, deletedKey);
    }, {
      scrubBackup: async () => {
        events.push("scrub");
        backup = structuredClone(store);
      },
    });
  } finally {
    fs.promises.rm = realRm;
  }
});

test("session handling never starts or awaits a wedged cleanup retry", async () => {
  const authPath = require.resolve("./auth");
  const dbPath = require.resolve("./db");
  const uploadsPath = require.resolve("./uploads");
  const sqliteStorePath = require.resolve("./sqlite-session-store");
  const sessionPath = require.resolve("express-session");
  const real = new Map([
    [authPath, require.cache[authPath]],
    [dbPath, require.cache[dbPath]],
    [uploadsPath, require.cache[uploadsPath]],
    [sqliteStorePath, require.cache[sqliteStorePath]],
    [sessionPath, require.cache[sessionPath]],
  ]);
  let started = 0;
  let stopped = 0;
  let retryCalls = 0;
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { dir: "unused", file: path.join(os.tmpdir(), "moneyminder.sqlite3"), kind: "sqlite" },
  };
  require.cache[sqliteStorePath] = {
    id: sqliteStorePath,
    filename: sqliteStorePath,
    loaded: true,
    exports: { createSqliteSessionStore: () => ({ close() {} }) },
  };
  require.cache[uploadsPath] = {
    id: uploadsPath,
    filename: uploadsPath,
    loaded: true,
    exports: {
      startDeleteRetries() { started++; },
      async stopDeleteRetries() { stopped++; },
      retryPendingDeletes() {
        retryCalls++;
        return new Promise(() => {});
      },
    },
  };
  require.cache[sessionPath] = {
    id: sessionPath,
    filename: sessionPath,
    loaded: true,
    exports: () => (_req, _res, next) => next(),
  };
  delete require.cache[authPath];
  try {
    const auth = require("./auth");
    const middleware = auth.sessionMiddleware();
    let nextCalls = 0;
    middleware({}, {}, () => { nextCalls++; });

    assert.strictEqual(started, 0);
    assert.strictEqual(retryCalls, 0);
    assert.strictEqual(nextCalls, 1);
    await auth.closeSessionStore();
    assert.strictEqual(stopped, 1);
  } finally {
    for (const [modulePath, cached] of real) {
      if (cached) require.cache[modulePath] = cached;
      else delete require.cache[modulePath];
    }
  }
});

test("deleteMe stays successful when post-commit session cleanup fails", async () => {
  const authVersion = crypto.randomUUID();
  const durabilityEvents = [];
  const cleanupLogs = [];
  const store = {
    users: {
      alice: { username: "Alice", authVersion, passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4) },
    },
    receipts: {},
    households: {},
    expenses: {},
    settlements: {},
    tokens: {},
  };
  const modulePaths = [
    require.resolve("./auth"),
    require.resolve("./db"),
    require.resolve("./uploads"),
    require.resolve("./sqlite-session-store"),
    require.resolve("express-session"),
  ];
  const real = new Map(modulePaths.map((modulePath) => [modulePath, require.cache[modulePath]]));
  const fakeSessionStore = {
    deleted: [],
    async deleteUserSessions(userKey) {
      durabilityEvents.push("sessions-deleted");
      this.deleted.push(userKey);
      const error = new Error("session cleanup failed");
      error.code = "SQLITE_IOERR";
      throw error;
    },
  };
  require.cache[require.resolve("./db")] = {
    id: require.resolve("./db"),
    filename: require.resolve("./db"),
    loaded: true,
    exports: {
      dir: "unused",
      file: path.join(os.tmpdir(), "moneyminder.sqlite3"),
      kind: "sqlite",
      load: () => store,
      update: async (handler) => handler(store),
      scrubBackup: async () => {
        durabilityEvents.push("checkpoint");
        throw new Error("checkpoint failed");
      },
    },
  };
  require.cache[require.resolve("./uploads")] = {
    id: require.resolve("./uploads"),
    filename: require.resolve("./uploads"),
    loaded: true,
    exports: {
      queueUserDelete() {},
      async stopDeleteRetries() {},
    },
  };
  require.cache[require.resolve("./sqlite-session-store")] = {
    id: require.resolve("./sqlite-session-store"),
    filename: require.resolve("./sqlite-session-store"),
    loaded: true,
    exports: {
      createSqliteSessionStore(file) {
        assert.match(file, /moneyminder\.sqlite3$/);
        return fakeSessionStore;
      },
    },
  };
  require.cache[require.resolve("express-session")] = {
    id: require.resolve("express-session"),
    filename: require.resolve("express-session"),
    loaded: true,
    exports: () => (_req, _res, next) => next(),
  };
  delete require.cache[require.resolve("./auth")];
  const oldConsoleError = console.error;
  console.error = (message) => cleanupLogs.push(String(message));
  try {
    const auth = require("./auth");
    auth.sessionMiddleware();
    const res = fakeRes();
    await auth.deleteMe({
      userKey: "alice",
      authVersion,
      body: { currentPassword: CURRENT_PASSWORD },
      session: { destroy: (callback) => callback(new Error("destroy failed")) },
    }, res);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.equal(store.users.alice, undefined);
    assert.deepStrictEqual(fakeSessionStore.deleted, ["alice"]);
    assert.deepStrictEqual(durabilityEvents, ["sessions-deleted", "checkpoint"]);
    assert.equal(cleanupLogs.length, 3);
    assert.equal(cleanupLogs.some((entry) => entry.includes("alice")), false);
  } finally {
    console.error = oldConsoleError;
    for (const [modulePath, cached] of real) {
      if (cached) require.cache[modulePath] = cached;
      else delete require.cache[modulePath];
    }
    delete require.cache[require.resolve("./auth")];
  }
});

test("production sessions use a __Host cookie with host-only attributes", async () => {
  const oldEnv = {
    NODE_ENV: process.env.NODE_ENV,
    SESSION_SECRET: process.env.SESSION_SECRET,
    SQLITE_FILE: process.env.SQLITE_FILE,
    APP_ORIGIN: process.env.APP_ORIGIN,
    DATA_DIR: process.env.DATA_DIR,
    TRUST_PROXY: process.env.TRUST_PROXY,
  };
  const modulePaths = [
    require.resolve("./auth"),
    require.resolve("./config"),
    require.resolve("./db"),
    require.resolve("./uploads"),
    require.resolve("./sqlite-session-store"),
    require.resolve("express-session"),
  ];
  const real = new Map(modulePaths.map((modulePath) => [modulePath, require.cache[modulePath]]));
  let options;
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "x".repeat(32);
  delete process.env.DATABASE_URL;
  delete process.env.SQLITE_FILE;
  process.env.APP_ORIGIN = "https://moneyminder.example.com";
  process.env.DATA_DIR = path.resolve("data-prod");
  process.env.TRUST_PROXY = "loopback";
  delete require.cache[require.resolve("./config")];
  require.cache[require.resolve("./db")] = {
    id: require.resolve("./db"),
    filename: require.resolve("./db"),
    loaded: true,
    exports: { dir: "unused", file: path.join(os.tmpdir(), "moneyminder.sqlite3"), kind: "sqlite" },
  };
  require.cache[require.resolve("./uploads")] = {
    id: require.resolve("./uploads"),
    filename: require.resolve("./uploads"),
    loaded: true,
    exports: {
      startDeleteRetries() {},
      async stopDeleteRetries() {},
    },
  };
  require.cache[require.resolve("express-session")] = {
    id: require.resolve("express-session"),
    filename: require.resolve("express-session"),
    loaded: true,
    exports: (value) => {
      options = value;
      return () => {};
    },
  };
  require.cache[require.resolve("./sqlite-session-store")] = {
    id: require.resolve("./sqlite-session-store"),
    filename: require.resolve("./sqlite-session-store"),
    loaded: true,
    exports: { createSqliteSessionStore: () => ({ close() {} }) },
  };
  delete require.cache[require.resolve("./auth")];
  try {
    const auth = require("./auth");
    auth.sessionMiddleware();
    assert.strictEqual(options.name, "__Host-moneyminder.sid");
    assert.strictEqual(options.cookie.secure, true);
    assert.strictEqual(options.cookie.path, "/");
    assert.strictEqual(Object.hasOwn(options.cookie, "domain"), false);
    await auth.closeSessionStore();
  } finally {
    for (const [name, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const [modulePath, cached] of real) {
      if (cached) require.cache[modulePath] = cached;
      else delete require.cache[modulePath];
    }
  }
});

test("legacy login creates an auth version and prunes expired and excess extension tokens", async () => {
  const store = emptyStore();
  store.users.alice = {
    username: "Alice",
    email: "alice@example.com",
    mobile: "1234567890",
    budget: 1000,
    passwordHash: await bcrypt.hash("secret123", 4),
  };
  store.tokens.expired = { userKey: "bob" };
  store.tokens.other = { userKey: "bob", createdAt: new Date().toISOString() };
  for (let i = 0; i < 6; i++) {
    store.tokens[`alice-${i}`] = {
      userKey: "alice",
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    };
  }

  await withFakeDb(store, async ({ login }) => {
    const req = {
      body: { username: "alice", password: "secret123" },
      get: (name) => name === "X-Client" ? "extension" : "",
      session: { regenerate: (callback) => callback() },
    };
    const res = fakeRes();
    await login(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.match(store.users.alice.authVersion, /^[0-9a-f-]{36}$/);
    assert.strictEqual(store.tokens.expired, undefined);
    assert.ok(store.tokens.other);
    assert.ok(Object.values(store.tokens).filter((record) => record.userKey === "alice").length <= 5);
  });
});

test("extension token rotation removes pruned digests from the limiter cache", async () => {
  const store = emptyStore();
  const authVersion = crypto.randomUUID();
  store.users.alice = {
    username: "Alice",
    authVersion,
    passwordHash: await bcrypt.hash(CURRENT_PASSWORD, 4),
  };
  const rawTokens = ["1", "2", "3", "4", "5"].map((value) => value.repeat(64));
  for (const [index, token] of rawTokens.entries()) {
    const digest = crypto.createHash("sha256").update(token).digest("hex");
    store.tokens[digest] = {
      userKey: "alice",
      authVersion,
      createdAt: new Date(Date.now() - index * 1000).toISOString(),
    };
  }
  const oldest = rawTokens.at(-1);
  const oldestDigest = crypto.createHash("sha256").update(oldest).digest("hex");

  await withFakeDb(store, async ({
    initializeTokenCache,
    isKnownBearerToken,
    login,
  }) => {
    await initializeTokenCache();
    assert.strictEqual(isKnownBearerToken(`Bearer ${oldest}`), true);

    const response = fakeRes();
    await login({
      body: { username: "alice", password: CURRENT_PASSWORD },
      get: (name) => name === "X-Client" ? "extension" : "",
      session: {},
    }, response);

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(store.tokens[oldestDigest], undefined);
    assert.strictEqual(isKnownBearerToken(`Bearer ${oldest}`), false);
    assert.strictEqual(isKnownBearerToken(`Bearer ${response.body.token}`), true);
    assert.strictEqual(
      Object.values(store.tokens).filter((record) => record.userKey === "alice").length,
      5,
    );
  });
});

test("registration and login report session regeneration failures", async () => {
  const store = emptyStore();
  const valid = {
    username: "Alice",
    email: "alice@example.com",
    mobile: "1234567890",
    budget: 1000,
    password: NEW_PASSWORD,
  };
  await withFakeDb(store, async ({ register, login }) => {
    const registerRes = fakeRes();
    await register({
      body: valid,
      get: () => "",
      session: { regenerate: (callback) => callback(new Error("store unavailable")) },
    }, registerRes);
    assert.strictEqual(registerRes.statusCode, 500);
    assert.deepStrictEqual(registerRes.body, { error: "Session error" });

    const loginRes = fakeRes();
    await login({
      body: { username: "alice", password: NEW_PASSWORD },
      get: () => "",
      session: { regenerate: (callback) => callback(new Error("store unavailable")) },
    }, loginRes);
    assert.strictEqual(loginRes.statusCode, 500);
    assert.deepStrictEqual(loginRes.body, { error: "Session error" });
  });
});

test("sessionMiddleware initializes in development and with a strong production secret", async () => {
  const oldEnv = process.env.NODE_ENV;
  const oldSecret = process.env.SESSION_SECRET;
  const oldSqliteFile = process.env.SQLITE_FILE;
  const oldAppOrigin = process.env.APP_ORIGIN;
  const oldDataDir = process.env.DATA_DIR;
  const oldTrustProxy = process.env.TRUST_PROXY;
  const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-auth-prod-"));
  const oldWarn = console.warn;
  try {
    delete process.env.NODE_ENV;
    delete process.env.SESSION_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.SQLITE_FILE;
    console.warn = () => {};
    delete require.cache[require.resolve("./config")];
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./auth")];
    let auth = require("./auth");
    assert.strictEqual(typeof auth.sessionMiddleware(), "function");
    await auth.closeSessionStore();

    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "x".repeat(32);
    delete process.env.DATABASE_URL;
    delete process.env.SQLITE_FILE;
    process.env.APP_ORIGIN = "https://moneyminder.example.com";
    process.env.DATA_DIR = prodDir;
    process.env.TRUST_PROXY = "loopback";
    delete require.cache[require.resolve("./config")];
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./auth")];
    auth = require("./auth");
    assert.strictEqual(typeof auth.sessionMiddleware(), "function");
    await auth.closeSessionStore();
  } finally {
    console.warn = oldWarn;
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
    if (oldSqliteFile === undefined) delete process.env.SQLITE_FILE; else process.env.SQLITE_FILE = oldSqliteFile;
    delete process.env.DATABASE_URL;
    if (oldAppOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = oldAppOrigin;
    if (oldDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDataDir;
    if (oldTrustProxy === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = oldTrustProxy;
    delete require.cache[require.resolve("./config")];
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./auth")];
    fs.rmSync(prodDir, { recursive: true, force: true });
  }
});

test("sessionMiddleware refuses to start production without SESSION_SECRET", () => {
  const oldEnv = process.env.NODE_ENV;
  const oldSecret = process.env.SESSION_SECRET;
  const oldSqliteFile = process.env.SQLITE_FILE;
  const oldAppOrigin = process.env.APP_ORIGIN;
  const oldDataDir = process.env.DATA_DIR;
  const oldTrustProxy = process.env.TRUST_PROXY;
  const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-auth-prod-"));
  process.env.NODE_ENV = "production";
  delete process.env.DATABASE_URL;
  delete process.env.SQLITE_FILE;
  process.env.APP_ORIGIN = "https://moneyminder.example.com";
  process.env.DATA_DIR = prodDir;
  process.env.TRUST_PROXY = "loopback";
  process.env.SESSION_SECRET = "";
  delete require.cache[require.resolve("./config")];
  delete require.cache[require.resolve("./db")];
  delete require.cache[require.resolve("./auth")];
  try {
    assert.throws(() => require("./auth"), /SESSION_SECRET/);
  } finally {
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
    if (oldSqliteFile === undefined) delete process.env.SQLITE_FILE; else process.env.SQLITE_FILE = oldSqliteFile;
    delete process.env.DATABASE_URL;
    if (oldAppOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = oldAppOrigin;
    if (oldDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDataDir;
    if (oldTrustProxy === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = oldTrustProxy;
    delete require.cache[require.resolve("./config")];
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./auth")];
    fs.rmSync(prodDir, { recursive: true, force: true });
  }
});

test("sessionMiddleware refuses a weak production SESSION_SECRET", () => {
  const oldEnv = process.env.NODE_ENV;
  const oldSecret = process.env.SESSION_SECRET;
  const oldSqliteFile = process.env.SQLITE_FILE;
  const oldAppOrigin = process.env.APP_ORIGIN;
  const oldDataDir = process.env.DATA_DIR;
  const oldTrustProxy = process.env.TRUST_PROXY;
  const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-auth-prod-"));
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "short";
  delete process.env.DATABASE_URL;
  delete process.env.SQLITE_FILE;
  process.env.APP_ORIGIN = "https://moneyminder.example.com";
  process.env.DATA_DIR = prodDir;
  process.env.TRUST_PROXY = "loopback";
  delete require.cache[require.resolve("./config")];
  delete require.cache[require.resolve("./db")];
  delete require.cache[require.resolve("./auth")];
  try {
    assert.throws(() => require("./auth"), /32/);
  } finally {
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
    if (oldSqliteFile === undefined) delete process.env.SQLITE_FILE; else process.env.SQLITE_FILE = oldSqliteFile;
    delete process.env.DATABASE_URL;
    if (oldAppOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = oldAppOrigin;
    if (oldDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDataDir;
    if (oldTrustProxy === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = oldTrustProxy;
    delete require.cache[require.resolve("./config")];
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./auth")];
    fs.rmSync(prodDir, { recursive: true, force: true });
  }
});
