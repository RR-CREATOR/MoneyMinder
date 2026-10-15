const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-app-"));
process.env.NODE_ENV = "test";
process.env.DATA_DIR = temp;
process.env.SQLITE_FILE = path.join(temp, "moneyminder.sqlite3");
process.env.SESSION_SECRET = "app-test-secret-app-test-secret-app-test";
delete process.env.DATA_FILE;
delete process.env.DATABASE_URL;

const config = require("./config");
const {
  app,
  start,
  createBearerAuthLimiter,
  configureServer,
  createReadinessCheck,
  errorHandler,
  mutationOriginAllowed,
  rateLimit,
  shutdown,
} = require("./app");
const db = require("./db");
const auth = require("./auth");

test.before(() => db.init());
test.after(async () => {
  await auth.closeSessionStore();
  await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test("health endpoints expose process liveness and dependency readiness", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const live = await fetch(`${base}/livez`, { headers: { "X-Request-ID": "check-123" } });
    const ready = await fetch(`${base}/readyz`);
    assert.strictEqual(live.status, 200);
    assert.strictEqual(ready.status, 200);
    assert.strictEqual(live.headers.get("x-request-id"), "check-123");
    assert.strictEqual(live.headers.get("x-powered-by"), null);
    assert.match(live.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.strictEqual(
      live.headers.get("permissions-policy"),
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );

    const invalidRequestId = await fetch(`${base}/livez`, {
      headers: { "X-Request-ID": "contains spaces" },
    });
    assert.match(invalidRequestId.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);

    const blocked = await fetch(`${base}/api/logout`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    assert.strictEqual(blocked.status, 403);

    const nonApiJson = await fetch(`${base}/livez`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid-json",
    });
    assert.strictEqual(nonApiJson.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("promotion routes require authentication, fail closed, and rate-limit telemetry", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const unauthenticated = await fetch(`${base}/api/promotions/current`);
    assert.strictEqual(unauthenticated.status, 401);

    const registered = await fetch(`${base}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "promotion-route-user",
        email: "promotion-route-user@example.com",
        mobile: "9000000199",
        budget: 1000,
        password: "correct horse battery",
      }),
    });
    assert.strictEqual(registered.status, 200);
    const cookie = registered.headers.get("set-cookie").split(";")[0];

    const extensionLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client": "extension",
      },
      body: JSON.stringify({
        username: "promotion-route-user",
        password: "correct horse battery",
      }),
    });
    assert.strictEqual(extensionLogin.status, 200);
    const token = (await extensionLogin.json()).token;
    const bearerCurrent = await fetch(`${base}/api/promotions/current`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(bearerCurrent.status, 403);

    const current = await fetch(`${base}/api/promotions/current`, {
      headers: { Cookie: cookie },
    });
    assert.strictEqual(current.status, 200);
    assert.deepStrictEqual(await current.json(), { promotion: null });

    const statuses = [];
    for (let index = 0; index < 11; index++) {
      const event = await fetch(
        `${base}/api/promotions/3d8c2e12-f3d7-4ea2-9bed-87e6b7b52f08/events`,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
            "Idempotency-Key": `promotion-event-${String(index).padStart(4, "0")}`,
          },
          body: JSON.stringify({ eventType: "impression" }),
        },
      );
      statuses.push(event.status);
    }
    assert.deepStrictEqual(statuses.slice(0, 10), Array(10).fill(404));
    assert.strictEqual(statuses[10], 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("per-user OCR and join rejection does not spend shared client capacity", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const register = async (username) => {
    const response = await fetch(`${base}/api/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client": "extension",
      },
      body: JSON.stringify({
        username,
        email: `${username}@example.com`,
        mobile: username === "limit-a" ? "9000000101" : "9000000102",
        budget: 1000,
        password: "correct horse battery",
      }),
    });
    assert.strictEqual(response.status, 200);
    return (await response.json()).token;
  };
  const login = async (username) => {
    const response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "correct horse battery" }),
    });
    assert.strictEqual(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const post = (route, cookie, body) => fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  try {
    const tokenA = await register("limit-a");
    const tokenB = await register("limit-b");
    const cookieA = await login("limit-a");
    const cookieB = await login("limit-b");

    assert.strictEqual(
      (await post("/api/households", cookieA, { name: "Bearer-safe home" })).status,
      200,
    );
    const sessionHouseholds = await (await fetch(`${base}/api/households`, {
      headers: { Cookie: cookieA },
    })).json();
    const bearerHouseholds = await (await fetch(`${base}/api/households`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    })).json();
    assert.strictEqual(
      typeof sessionHouseholds.households.find((item) => item.name === "Bearer-safe home").code,
      "string",
    );
    assert.strictEqual(
      Object.hasOwn(
        bearerHouseholds.households.find((item) => item.name === "Bearer-safe home"),
        "code",
      ),
      false,
    );

    for (const [route, method, body] of [
      ["/api/me", "PATCH", { displayName: "Blocked" }],
      ["/api/me/export", "POST", { currentPassword: "correct horse battery" }],
      ["/api/me", "DELETE", { currentPassword: "correct horse battery" }],
      ["/api/receipts", "GET"],
      ["/api/parse-receipt", "POST"],
      ["/api/households", "POST", { name: "Blocked" }],
      ["/api/households/join", "POST", { code: "ABC234" }],
      ["/api/households/00000000-0000-4000-8000-000000000001", "GET"],
      ["/api/households/00000000-0000-4000-8000-000000000001/settle", "POST", {}],
      ["/api/households/00000000-0000-4000-8000-000000000001/recurring", "POST", {}],
    ]) {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${tokenA}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.strictEqual(response.status, 403);
    }

    assert.strictEqual((await fetch(`${base}/api/summary`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    })).status, 200);
    assert.strictEqual((await fetch(`${base}/api/households`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    })).status, 200);
    assert.strictEqual((await fetch(`${base}/api/receipts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    })).status, 400);
    assert.strictEqual((await fetch(
      `${base}/api/households/00000000-0000-4000-8000-000000000001/expenses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    )).status, 400);

    assert.strictEqual((await post("/api/parse-receipt", cookieA)).status, 400);
    assert.strictEqual((await post("/api/parse-receipt", cookieA)).status, 429);
    assert.strictEqual((await post("/api/parse-receipt", cookieB)).status, 400);

    for (let attempt = 0; attempt < 10; attempt++) {
      assert.notStrictEqual(
        (await post("/api/households/join", cookieA, { code: "ABC234" })).status,
        429,
      );
    }
    assert.strictEqual(
      (await post("/api/households/join", cookieA, { code: "ABC234" })).status,
      429,
    );
    assert.notStrictEqual(
      (await post("/api/households/join", cookieB, { code: "ABC234" })).status,
      429,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("VPA reauthentication shares the sensitive account budget without throttling ordinary profile edits", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const registered = await fetch(`${base}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "limit-vpa",
        email: "limit-vpa@example.com",
        mobile: "9000000103",
        budget: 1000,
        password: "correct horse battery",
        vpa: "limit-vpa@upi",
      }),
    });
    assert.strictEqual(registered.status, 200);
    const cookie = registered.headers.get("set-cookie").split(";")[0];
    const statuses = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      const response = await fetch(`${base}/api/me`, {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vpa: "changed-vpa@upi",
          currentPassword: `wrong-password-${attempt}`,
        }),
      });
      statuses.push(response.status);
    }
    assert.deepStrictEqual(statuses.slice(0, 10), Array(10).fill(403));
    assert.strictEqual(statuses[10], 429);

    const ordinaryEdit = await fetch(`${base}/api/me`, {
      method: "PATCH",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "Still allowed" }),
    });
    assert.strictEqual(ordinaryEdit.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("coarse API limiter leaves pilot NAT capacity and still rejects abuse", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = require("./db");
  const originalLoad = db.load;
  let authStateLoads = 0;
  db.load = async () => {
    authStateLoads++;
    return originalLoad();
  };
  const statuses = [];
  try {
    for (let index = 0; index < 610; index++) {
      const response = await fetch(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${"f".repeat(64)}` },
      });
      statuses.push(response.status);
    }
    const originalProduction = config.production;
    const originalLog = console.log;
    config.production = true;
    console.log = () => {};
    try {
      const rejectedBeforeParsing = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": "rate-limit-429",
        },
        body: "{invalid-json",
      });
      assert.strictEqual(rejectedBeforeParsing.status, 429);
      assert.strictEqual(rejectedBeforeParsing.headers.get("x-request-id"), "rate-limit-429");
      assert.strictEqual(rejectedBeforeParsing.headers.get("cache-control"), "no-store");
      assert.match(rejectedBeforeParsing.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.match(rejectedBeforeParsing.headers.get("strict-transport-security"), /includeSubDomains/);
    } finally {
      config.production = originalProduction;
      console.log = originalLog;
    }
  } finally {
    db.load = originalLoad;
    await new Promise((resolve) => server.close(resolve));
  }
  assert.strictEqual(statuses[0], 401);
  assert.ok(statuses.includes(429));
  assert.ok(authStateLoads > 0);
  assert.ok(authStateLoads <= 60, `unknown bearer caused ${authStateLoads} state loads`);
});

test("production mutation origins are exact and missing browser origins are rejected", () => {
  const runtime = {
    production: true,
    appOrigin: "https://money.example",
    extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  assert.strictEqual(mutationOriginAllowed("https://money.example", "", runtime), true);
  assert.strictEqual(
    mutationOriginAllowed("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "", runtime),
    true,
  );
  assert.strictEqual(mutationOriginAllowed("", "", runtime), false);
  assert.strictEqual(mutationOriginAllowed("https://evil.example", "", runtime), false);
  assert.strictEqual(mutationOriginAllowed("", `Bearer ${"a".repeat(64)}`, runtime), true);
  assert.strictEqual(mutationOriginAllowed("", "Bearer malformed", runtime), false);
});

test("rate limiter bounds distinct active client state", () => {
  const middleware = rateLimit(1, 60000);
  const call = (ip) => {
    const outcome = { passed: false, status: 200 };
    const response = {
      status(code) {
        outcome.status = code;
        return this;
      },
      json() {
        return this;
      },
    };
    middleware({ ip }, response, () => { outcome.passed = true; });
    return outcome;
  };
  for (let index = 0; index < 10000; index++) {
    assert.strictEqual(call(`client-${index}`).passed, true);
  }
  assert.deepStrictEqual(call("one-client-too-many"), { passed: false, status: 429 });
});

test("rate limiter can protect accounts independently behind one shared IP", () => {
  const middleware = rateLimit(1, 60000, (req) => req.account);
  const call = (account) => {
    const outcome = { passed: false, status: 200 };
    const response = {
      status(code) { outcome.status = code; return this; },
      json() { return this; },
    };
    middleware({ ip: "shared-nat", account }, response, () => { outcome.passed = true; });
    return outcome;
  };
  assert.strictEqual(call("alice").passed, true);
  assert.strictEqual(call("bob").passed, true);
  assert.strictEqual(call("alice").status, 429);
});

test("bearer authentication limiter enforces per-IP and process-global budgets", () => {
  const middleware = createBearerAuthLimiter({
    perIpMax: 2,
    processMax: 3,
    windowMs: 60000,
  });
  const call = (ip, authorization = `Bearer ${"a".repeat(64)}`) => {
    const outcome = { passed: false, status: 200 };
    const response = {
      status(code) { outcome.status = code; return this; },
      json() { return this; },
    };
    middleware({
      ip,
      get: (name) => name === "Authorization" ? authorization : "",
    }, response, () => { outcome.passed = true; });
    return outcome;
  };

  assert.strictEqual(call("client-a").passed, true);
  assert.strictEqual(call("client-a").passed, true);
  assert.strictEqual(call("client-a").status, 429);
  assert.strictEqual(call("client-b").passed, true);
  assert.strictEqual(call("client-c").status, 429);
  assert.strictEqual(call("client-c", "Bearer malformed").passed, true);
  assert.strictEqual(call("client-c", "").passed, true);
});

test("unknown bearer floods cannot spend cached valid-token capacity", () => {
  const valid = `Bearer ${"a".repeat(64)}`;
  const middleware = createBearerAuthLimiter({
    perIpMax: 2,
    processMax: 1,
    windowMs: 60000,
    isKnownToken: (authorization) => authorization === valid,
  });
  const call = (ip, authorization) => {
    const outcome = { passed: false, status: 200 };
    const response = {
      status(code) { outcome.status = code; return this; },
      json() { return this; },
    };
    middleware({
      ip,
      get: (name) => name === "Authorization" ? authorization : "",
    }, response, () => { outcome.passed = true; });
    return outcome;
  };

  assert.strictEqual(call("attacker-a", `Bearer ${"b".repeat(64)}`).passed, true);
  assert.strictEqual(call("attacker-b", `Bearer ${"c".repeat(64)}`).status, 429);
  assert.strictEqual(call("legitimate", valid).passed, true);
  assert.strictEqual(call("legitimate", valid).passed, true);
  assert.strictEqual(call("legitimate", valid).status, 429);
});

test("readiness checks coalesce and briefly cache dependency probes", async () => {
  let now = 1000;
  let calls = 0;
  let release;
  const check = createReadinessCheck(
    () => {
      calls++;
      return new Promise((resolve) => { release = resolve; });
    },
    2000,
    () => now,
  );

  const first = check();
  const concurrent = check();
  assert.strictEqual(calls, 1);
  release();
  assert.strictEqual(await first, true);
  assert.strictEqual(await concurrent, true);
  assert.strictEqual(await check(), true);
  assert.strictEqual(calls, 1);

  now += 2001;
  const expired = check();
  assert.strictEqual(calls, 2);
  release();
  assert.strictEqual(await expired, true);
});

test("HTTP server deadlines bound slow headers, bodies, and idle sockets", () => {
  const server = {};
  assert.strictEqual(configureServer(server), server);
  assert.deepStrictEqual(server, {
    headersTimeout: 10000,
    requestTimeout: 70000,
    keepAliveTimeout: 5000,
    maxHeadersCount: 50,
  });
});

test("OCR saturation returns a retryable service response", () => {
  const headers = {};
  const response = {
    headersSent: false,
    statusCode: 200,
    setHeader(name, value) { headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const oldError = console.error;
  console.error = () => {};
  try {
    errorHandler(
      Object.assign(new Error("busy"), { code: "OCR_BUSY" }),
      { requestId: "ocr-test", path: "/api/parse-receipt" },
      response,
      () => {},
    );
  } finally {
    console.error = oldError;
  }
  assert.strictEqual(response.statusCode, 503);
  assert.strictEqual(headers["Retry-After"], "30");
});

test("stale authentication failures return an unauthenticated response", () => {
  const response = {
    headersSent: false,
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const oldError = console.error;
  console.error = () => {};
  try {
    errorHandler(
      Object.assign(new Error("stale"), { code: "AUTH_STALE" }),
      { requestId: "auth-stale-test", path: "/api/parse-receipt" },
      response,
      () => {},
    );
  } finally {
    console.error = oldError;
  }
  assert.strictEqual(response.statusCode, 401);
  assert.deepStrictEqual(response.body, { error: "Not authenticated" });
});

test("shutdown stops HTTP intake before awaiting OCR and database cleanup", async () => {
  const ocr = require("./ocr");
  const db = require("./db");
  const auth = require("./auth");
  const originalOcrShutdown = ocr.shutdown;
  const originalSessionShutdown = auth.closeSessionStore;
  const originalDbClose = db.close;
  const events = [];
  const timer = setInterval(() => events.push("recurring-fired"), 60000);
  const server = {
    close(callback) {
      events.push("http");
      callback();
    },
    closeAllConnections() {
      events.push("forced");
    },
  };
  ocr.shutdown = async () => { events.push("ocr"); };
  auth.closeSessionStore = async () => { events.push("sessions"); };
  db.close = async () => { events.push("database"); };
  try {
    await shutdown(server, timer, 100);
    assert.deepStrictEqual(events, ["http", "ocr", "sessions", "database"]);
  } finally {
    clearInterval(timer);
    ocr.shutdown = originalOcrShutdown;
    auth.closeSessionStore = originalSessionShutdown;
    db.close = originalDbClose;
  }
});

test("startup failure closes initialized process dependencies", async () => {
  const ocr = require("./ocr");
  const db = require("./db");
  const auth = require("./auth");
  const originals = {
    init: db.init,
    ocr: ocr.shutdown,
    sessions: auth.closeSessionStore,
    database: db.close,
  };
  const events = [];
  db.init = async () => {
    events.push("init");
    throw new Error("migration failed");
  };
  ocr.shutdown = async () => { events.push("ocr"); };
  auth.closeSessionStore = async () => { events.push("sessions"); };
  db.close = async () => { events.push("database"); };
  try {
    await assert.rejects(start(), /migration failed/);
    assert.deepStrictEqual(events, ["init", "ocr", "sessions", "database"]);
  } finally {
    db.init = originals.init;
    ocr.shutdown = originals.ocr;
    auth.closeSessionStore = originals.sessions;
    db.close = originals.database;
  }
});

test("startup verifies the bundled OCR model before accepting traffic", async () => {
  const ocr = require("./ocr");
  const db = require("./db");
  const auth = require("./auth");
  const uploads = require("./uploads");
  const originals = {
    init: db.init,
    seedTokens: auth.initializeTokenCache,
    verify: ocr.verifyLanguageData,
    ocr: ocr.shutdown,
    sessions: auth.closeSessionStore,
    database: db.close,
    startDeletes: uploads.startDeleteRetries,
  };
  const events = [];
  db.init = async () => { events.push("database-init"); };
  auth.initializeTokenCache = async () => { events.push("token-cache"); };
  ocr.verifyLanguageData = async () => {
    events.push("model-verify");
    throw new Error("model corrupt");
  };
  uploads.startDeleteRetries = () => { events.push("delete-worker"); };
  ocr.shutdown = async () => { events.push("ocr-close"); };
  auth.closeSessionStore = async () => { events.push("sessions-close"); };
  db.close = async () => { events.push("database-close"); };
  try {
    await assert.rejects(start(), /model corrupt/);
    assert.deepStrictEqual(events, [
      "database-init",
      "token-cache",
      "model-verify",
      "ocr-close",
      "sessions-close",
      "database-close",
    ]);
  } finally {
    db.init = originals.init;
    auth.initializeTokenCache = originals.seedTokens;
    ocr.verifyLanguageData = originals.verify;
    ocr.shutdown = originals.ocr;
    auth.closeSessionStore = originals.sessions;
    db.close = originals.database;
    uploads.startDeleteRetries = originals.startDeletes;
  }
});

test("startup begins orphan sweeps after model verification and before background workers", async () => {
  const ocr = require("./ocr");
  const db = require("./db");
  const auth = require("./auth");
  const uploads = require("./uploads");
  const originals = {
    init: db.init,
    seedTokens: auth.initializeTokenCache,
    verify: ocr.verifyLanguageData,
    startOrphans: ocr.startOrphanSweeps,
    ocr: ocr.shutdown,
    sessions: auth.closeSessionStore,
    database: db.close,
    startDeletes: uploads.startDeleteRetries,
  };
  const events = [];
  db.init = async () => { events.push("database-init"); };
  auth.initializeTokenCache = async () => { events.push("token-cache"); };
  ocr.verifyLanguageData = async () => { events.push("model-verify"); };
  ocr.startOrphanSweeps = async () => { events.push("orphan-sweeps"); };
  uploads.startDeleteRetries = () => {
    events.push("delete-worker");
    throw new Error("delete worker failed");
  };
  ocr.shutdown = async () => { events.push("ocr-close"); };
  auth.closeSessionStore = async () => { events.push("sessions-close"); };
  db.close = async () => { events.push("database-close"); };
  try {
    await assert.rejects(start(), /delete worker failed/);
    assert.deepStrictEqual(events, [
      "database-init",
      "token-cache",
      "model-verify",
      "orphan-sweeps",
      "delete-worker",
      "ocr-close",
      "sessions-close",
      "database-close",
    ]);
  } finally {
    db.init = originals.init;
    auth.initializeTokenCache = originals.seedTokens;
    ocr.verifyLanguageData = originals.verify;
    ocr.startOrphanSweeps = originals.startOrphans;
    ocr.shutdown = originals.ocr;
    auth.closeSessionStore = originals.sessions;
    db.close = originals.database;
    uploads.startDeleteRetries = originals.startDeletes;
  }
});

test("shutdown stops upload/session work before closing its database", async () => {
  const ocr = require("./ocr");
  const db = require("./db");
  const auth = require("./auth");
  const originals = {
    ocr: ocr.shutdown,
    sessions: auth.closeSessionStore,
    database: db.close,
  };
  const events = [];
  let releaseSessions;
  const timer = setInterval(() => {}, 60000);
  const server = { close: (callback) => callback() };
  ocr.shutdown = async () => { events.push("ocr"); };
  auth.closeSessionStore = () => new Promise((resolve) => {
    events.push("sessions-start");
    releaseSessions = () => {
      events.push("sessions-done");
      resolve();
    };
  });
  db.close = async () => { events.push("database"); };
  try {
    const stopping = shutdown(server, timer, 500);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(events, ["ocr", "sessions-start"]);
    releaseSessions();
    await stopping;
    assert.deepStrictEqual(events, ["ocr", "sessions-start", "sessions-done", "database"]);
  } finally {
    clearInterval(timer);
    ocr.shutdown = originals.ocr;
    auth.closeSessionStore = originals.sessions;
    db.close = originals.database;
  }
});

test("shutdown still closes sessions and database after OCR cleanup fails", async () => {
  const ocr = require("./ocr");
  const db = require("./db");
  const auth = require("./auth");
  const originals = {
    ocr: ocr.shutdown,
    sessions: auth.closeSessionStore,
    database: db.close,
  };
  const events = [];
  const timer = setInterval(() => {}, 60000);
  const server = { close: (callback) => callback() };
  ocr.shutdown = async () => {
    events.push("ocr");
    throw new Error("OCR cleanup failed");
  };
  auth.closeSessionStore = async () => { events.push("sessions"); };
  db.close = async () => { events.push("database"); };
  try {
    await assert.rejects(shutdown(server, timer, 100), /OCR cleanup failed/);
    assert.deepStrictEqual(events, ["ocr", "sessions", "database"]);
  } finally {
    clearInterval(timer);
    ocr.shutdown = originals.ocr;
    auth.closeSessionStore = originals.sessions;
    db.close = originals.database;
  }
});

test("shutdown has an overall deadline even when dependency cleanup wedges", async () => {
  const ocr = require("./ocr");
  const db = require("./db");
  const auth = require("./auth");
  const originals = {
    ocr: ocr.shutdown,
    sessions: auth.closeSessionStore,
    database: db.close,
  };
  const events = [];
  const timer = setInterval(() => {}, 60000);
  const server = { close: (callback) => callback() };
  ocr.shutdown = () => new Promise(() => {});
  auth.closeSessionStore = async () => { events.push("sessions"); };
  db.close = async () => { events.push("database"); };
  const started = Date.now();
  try {
    await assert.rejects(shutdown(server, timer, 50), /Shutdown timed out/);
    assert.ok(Date.now() - started < 500);
    assert.deepStrictEqual(events, ["sessions", "database"]);
  } finally {
    clearInterval(timer);
    ocr.shutdown = originals.ocr;
    auth.closeSessionStore = originals.sessions;
    db.close = originals.database;
  }
});
