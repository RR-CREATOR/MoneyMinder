const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { loadConfig } = require("./config");

const productionEnv = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://money.example",
  DATA_DIR: path.resolve("persistent-data"),
  SESSION_SECRET: "s".repeat(32),
  TRUST_PROXY: "loopback",
};

test("production config requires HTTPS, durable SQLite storage, and a strong secret", () => {
  for (const [key, value, expected] of [
    ["APP_ORIGIN", undefined, /APP_ORIGIN/],
    ["APP_ORIGIN", "http://money.example", /HTTPS/],
    ["DATA_DIR", undefined, /DATA_DIR/],
    ["DATA_DIR", "relative-data", /absolute/],
    ["SESSION_SECRET", "short", /32 bytes/],
    ["SESSION_COOKIE_SECURE", "false", /secure cookies/],
    ["TRUST_PROXY", undefined, /TRUST_PROXY/],
    ["LISTEN_HOST", "0.0.0.0", /LISTEN_HOST/],
    ["LISTEN_HOST", "::", /LISTEN_HOST/],
    ["SQLITE_FILE", "relative.sqlite3", /absolute/],
    ["SQLITE_FILE", path.resolve("outside-data", "moneyminder.sqlite3"), /inside DATA_DIR/],
    ["SQLITE_FILE", path.dirname(productionEnv.DATA_DIR), /inside DATA_DIR/],
    ["SQLITE_FILE", productionEnv.DATA_DIR, /inside DATA_DIR/],
  ]) {
    const env = { ...productionEnv };
    if (value === undefined) delete env[key]; else env[key] = value;
    assert.throws(() => loadConfig(env), expected);
  }
});

test("production config normalizes validated deployment settings", () => {
  const config = loadConfig({
    ...productionEnv,
    PORT: "8080",
    DATA_MAX_BYTES: "1024",
    UPLOAD_TOTAL_MAX_BYTES: "4096",
    UPLOAD_TOTAL_MAX_FILES: "12",
    SQLITE_FILE: path.join(productionEnv.DATA_DIR, "state", "money.sqlite3"),
    EXTENSION_ORIGIN: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });

  assert.strictEqual(config.production, true);
  assert.strictEqual(config.store, "sqlite");
  assert.strictEqual(config.port, 8080);
  assert.strictEqual(config.listenHost, "127.0.0.1");
  assert.strictEqual(config.trustProxy, "loopback");
  assert.strictEqual(config.dataMaxBytes, 1024);
  assert.strictEqual(config.uploadTotalMaxBytes, 4096);
  assert.strictEqual(config.uploadTotalMaxFiles, 12);
  assert.strictEqual(config.registrationEnabled, false);
  assert.strictEqual(config.appOrigin, "https://money.example");
  assert.ok(path.isAbsolute(config.dataDir));
  assert.strictEqual(config.sqliteFile, path.join(productionEnv.DATA_DIR, "state", "money.sqlite3"));
  assert.strictEqual(config.file, config.sqliteFile);
  assert.ok(Object.isFrozen(config));
});

test("development config uses SQLite under the durable data directory", () => {
  const config = loadConfig({ NODE_ENV: "test", PORT: "3456" });
  assert.strictEqual(config.production, false);
  assert.strictEqual(config.store, "sqlite");
  assert.strictEqual(config.sqliteFile, path.join(config.dataDir, "moneyminder.sqlite3"));
  assert.strictEqual(config.file, config.sqliteFile);
  assert.strictEqual(config.appOrigin, "http://localhost:3456");
  assert.strictEqual(config.listenHost, "127.0.0.1");
  assert.strictEqual(config.trustProxy, false);
  assert.strictEqual(config.registrationEnabled, true);
  assert.ok(path.isAbsolute(config.dataDir));
});

test("development resolves a relative SQLite filename inside DATA_DIR", () => {
  const dataDir = path.resolve("test-data");
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    SQLITE_FILE: path.join("isolated", "test.sqlite3"),
  });
  assert.strictEqual(config.sqliteFile, path.join(dataDir, "isolated", "test.sqlite3"));
  assert.throws(
    () => loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      SQLITE_FILE: path.join("..", "outside.sqlite3"),
    }),
    /inside DATA_DIR/,
  );
});

test("legacy PostgreSQL and JSON-store settings fail closed", () => {
  for (const key of ["DATABASE_URL", "DATABASE_POOL_MAX", "PG_POOL_MAX", "DATA_FILE"]) {
    assert.throws(
      () => loadConfig({ NODE_ENV: "test", [key]: "legacy-value" }),
      new RegExp(key),
    );
  }
});

test("production registration can only be opened explicitly", () => {
  assert.strictEqual(loadConfig({ ...productionEnv, REGISTRATION_ENABLED: "true" }).registrationEnabled, true);
  assert.throws(
    () => loadConfig({ ...productionEnv, REGISTRATION_ENABLED: "yes" }),
    /REGISTRATION_ENABLED/,
  );
});

test("merchant promotions are disabled by default and accept only explicit booleans", () => {
  assert.strictEqual(loadConfig({ NODE_ENV: "test" }).promotionsEnabled, false);
  assert.strictEqual(
    loadConfig({ ...productionEnv, PROMOTIONS_ENABLED: "true" }).promotionsEnabled,
    true,
  );
  assert.throws(
    () => loadConfig({ ...productionEnv, PROMOTIONS_ENABLED: "yes" }),
    /PROMOTIONS_ENABLED/,
  );
});

test("config rejects spoofable proxy modes and unsafe numeric or origin values", () => {
  for (const [key, value, expected] of [
    ["PORT", "0", /PORT/],
    ["PORT", "65536", /PORT/],
    ["TRUST_PROXY", "1", /TRUST_PROXY/],
    ["TRUST_PROXY", "-1", /TRUST_PROXY/],
    ["TRUST_PROXY", "all", /TRUST_PROXY/],
    ["LISTEN_HOST", "localhost", /LISTEN_HOST/],
    ["DATA_MAX_BYTES", "nope", /DATA_MAX_BYTES/],
    ["UPLOAD_TOTAL_MAX_BYTES", "0", /UPLOAD_TOTAL_MAX_BYTES/],
    ["UPLOAD_TOTAL_MAX_FILES", "0", /UPLOAD_TOTAL_MAX_FILES/],
    ["APP_ORIGIN", "https://money.example/path", /origin/],
    ["EXTENSION_ORIGIN", "chrome-extension://not-an-id", /EXTENSION_ORIGIN/],
  ]) {
    assert.throws(() => loadConfig({ ...productionEnv, [key]: value }), expected);
  }
});

test("production rejects direct proxy mode because the app does not terminate TLS", () => {
  assert.throws(
    () => loadConfig({ ...productionEnv, TRUST_PROXY: "0" }),
    /loopback/,
  );
  assert.strictEqual(
    loadConfig({ NODE_ENV: "development", TRUST_PROXY: "0" }).trustProxy,
    false,
  );
});
