const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn } = require("node:child_process");

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(
    (error) => error ? reject(error) : resolve(),
  ));
  return port;
}

async function startApp({ port, dataDir, registrationEnabled }) {
  const runner = `
    const { start } = require("./server/app");
    start().then((server) => {
      process.on("message", (message) => {
        if (message !== "shutdown") return;
        server.shutdown().then(
          () => process.exit(0),
          (error) => {
            process.stderr.write(String(error && error.stack || error));
            process.exit(1);
          },
        );
      });
    }).catch((error) => {
      process.stderr.write(String(error && error.stack || error));
      process.exit(1);
    });
  `;
  const child = spawn(process.execPath, ["-e", runner], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      SQLITE_FILE: path.join(dataDir, "moneyminder.sqlite3"),
      DATA_DIR: dataDir,
      APP_ORIGIN: "https://moneyminder.test",
      SESSION_SECRET: "sqlite-integration-secret-".repeat(3),
      REGISTRATION_ENABLED: String(registrationEnabled),
      PROMOTIONS_ENABLED: "false",
      TRUST_PROXY: "loopback",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`App exited during startup:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return { child, output: () => output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`App startup timed out:\n${output}`);
}

async function stopApp(running) {
  if (running.child.exitCode !== null) return;
  const exited = once(running.child, "exit");
  running.child.send("shutdown");
  const timeout = setTimeout(() => running.child.kill("SIGKILL"), 12000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(running.child.exitCode, 0, running.output());
}

async function appRequest(port, route, { method = "GET", body, cookie } = {}) {
  const headers = {
    Origin: "https://moneyminder.test",
    "X-Forwarded-Proto": "https",
    Connection: "close",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const signal = AbortSignal.timeout(10000);
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const payload = await response.json();
  return { response, payload };
}

test("production state and browser sessions survive a SQLite restart", {
  timeout: 45000,
}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-sqlite-http-"));
  let running;
  try {
    const port = await freePort();
    running = await startApp({ port, dataDir, registrationEnabled: true });
    const registration = await appRequest(port, "/api/register", {
      method: "POST",
      body: {
        username: "restartuser",
        password: "correct horse battery staple",
        email: "restart@example.test",
        mobile: "+919876543210",
        budget: 5000,
      },
    });
    assert.equal(registration.response.status, 200, JSON.stringify(registration.payload));
    const cookie = registration.response.headers.get("set-cookie")?.split(";", 1)[0];
    assert.match(cookie || "", /^__Host-moneyminder\.sid=/);

    const created = await appRequest(port, "/api/receipts", {
      method: "POST",
      cookie,
      body: { amount: 12.34, supplier: "Restart Cafe" },
    });
    assert.equal(created.response.status, 200, JSON.stringify(created.payload));
    await stopApp(running);
    running = undefined;

    assert.equal(fs.existsSync(path.join(dataDir, "moneyminder.sqlite3")), true);
    running = await startApp({ port, dataDir, registrationEnabled: false });
    const me = await appRequest(port, "/api/me", { cookie });
    assert.equal(me.response.status, 200, JSON.stringify(me.payload));
    assert.equal(me.payload.user.username, "restartuser");
    const receipts = await appRequest(port, "/api/receipts", { cookie });
    assert.equal(receipts.response.status, 200, JSON.stringify(receipts.payload));
    assert.equal(receipts.payload.receipts.length, 1);
    assert.equal(receipts.payload.receipts[0].supplier, "Restart Cafe");
  } finally {
    if (running) await stopApp(running);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
