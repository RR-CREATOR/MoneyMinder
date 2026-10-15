const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

test("registration to recipient-confirmed settlement works over HTTP", { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-e2e-"));
  const port = 32000 + (process.pid % 1000);
  const runner = `
    const { start } = require("./server/app");
    start().then((server) => {
      process.on("message", (message) => {
        if (message !== "shutdown") return;
        server.shutdown().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
    }).catch(() => process.exit(1));
  `;
  const child = spawn(process.execPath, ["-e", runner], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      SQLITE_FILE: path.join(dir, "moneyminder.sqlite3"),
      SESSION_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e-secret",
      NODE_ENV: "development",
      SESSION_COOKIE_SECURE: "true",
      TRUST_PROXY: "loopback",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server start timed out")), 8000);
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("MoneyMinder running")) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on("data", (chunk) => {
        if (String(chunk).includes("EADDRINUSE")) { clearTimeout(timer); reject(new Error(String(chunk))); }
      });
    });

    const base = `http://127.0.0.1:${port}`;
    const call = async (route, { method = "GET", body, cookie } = {}) => {
      const headers = { "X-Forwarded-Proto": "https" };
      if (body) headers["Content-Type"] = "application/json";
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json();
      const setCookie = res.headers.get("set-cookie") || "";
      return { res, json, setCookie, cookie: setCookie.split(";")[0] };
    };

    assert.strictEqual((await call("/healthz")).res.status, 200);
    const alpha = await call("/api/register", { method: "POST", body: { username: "alpha", email: "a@example.com", mobile: "9000000001", budget: 15000, password: "alpha-secret-123" } });
    const beta = await call("/api/register", { method: "POST", body: { username: "beta", email: "b@example.com", mobile: "9000000002", budget: 15000, password: "beta-secret-234" } });
    assert.ok(alpha.cookie && beta.cookie);
    assert.match(alpha.setCookie, /;\s*Secure/i);

    const invalidMultipart = new FormData();
    invalidMultipart.append("unexpected", "field");
    const invalidUpload = await fetch(`${base}/api/parse-receipt`, {
      method: "POST",
      headers: {
        "X-Forwarded-Proto": "https",
        Cookie: alpha.cookie,
      },
      body: invalidMultipart,
    });
    assert.strictEqual(invalidUpload.status, 400);
    assert.deepStrictEqual(await invalidUpload.json(), { error: "Invalid multipart upload" });

    const created = await call("/api/households", { method: "POST", cookie: alpha.cookie, body: { name: "Flat 3B" } });
    const household = created.json.household;
    await call("/api/households/join", { method: "POST", cookie: beta.cookie, body: { code: household.code } });
    await call(`/api/households/${household.id}/expenses`, { method: "POST", cookie: alpha.cookie, body: { description: "Groceries", amount: 100, category: "food", splitAmong: ["alpha", "beta"] } });

    const debt = await call(`/api/households/${household.id}`, { cookie: beta.cookie });
    assert.strictEqual(debt.json.owes[0].amount, 50);
    await call(`/api/households/${household.id}/settle`, { method: "POST", cookie: beta.cookie, body: { to: "alpha", amount: 50, method: "upi" } });
    const pending = await call(`/api/households/${household.id}`, { cookie: alpha.cookie });
    assert.strictEqual(pending.json.pendingSettlements.length, 1);
    const sid = pending.json.pendingSettlements[0].id;
    await call(`/api/households/${household.id}/settlements/${sid}/confirm`, { method: "POST", cookie: alpha.cookie, body: {} });
    const settled = await call(`/api/households/${household.id}`, { cookie: beta.cookie });
    assert.strictEqual(settled.json.balances.find((b) => b.key === "beta").net, 0);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.send("shutdown");
      const force = setTimeout(() => child.kill("SIGKILL"), 12000);
      try { await exited; } finally { clearTimeout(force); }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
