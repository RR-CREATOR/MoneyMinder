const fs = require("fs");
const path = require("path");

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "data");

function loadDotEnv(file = path.join(__dirname, "..", ".env"), env = process.env) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!(key in env)) env[key] = val;
    }
  } catch {
    /* no .env file */
  }
}

function positiveInt(value, name, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new Error(`${name} must be a positive integer no greater than ${max}`);
  }
  return n;
}

function boolean(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function trustedProxy(value, production) {
  if (value === undefined) {
    if (production) throw new Error("TRUST_PROXY is required in production");
    return false;
  }
  if (value === "loopback") return "loopback";
  if (!production && value === "0") return false;
  throw new Error(`TRUST_PROXY must be ${production ? "loopback in production" : "0 or loopback"}`);
}

function listenHost(value) {
  if (value === undefined || value === "127.0.0.1") return "127.0.0.1";
  throw new Error("LISTEN_HOST must be 127.0.0.1");
}

function origin(value, name) {
  if (!value) return "";
  if (name === "EXTENSION_ORIGIN") {
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(value)) throw new Error("EXTENSION_ORIGIN must be a chrome-extension origin");
    return value;
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be an origin`); }
  if (parsed.origin !== value.replace(/\/$/, "")) throw new Error(`${name} must be an origin without a path`);
  return parsed.origin;
}

function rejectLegacyStorageSettings(env) {
  for (const name of ["DATABASE_URL", "DATABASE_POOL_MAX", "PG_POOL_MAX", "DATA_FILE"]) {
    if (env[name]) {
      throw new Error(`${name} is not supported; MoneyMinder uses SQLite under DATA_DIR`);
    }
  }
}

function sqlitePath(dataDir, value, production) {
  if (value && production && !path.isAbsolute(value)) {
    throw new Error("SQLITE_FILE must be absolute in production");
  }
  const file = value
    ? path.resolve(dataDir, value)
    : path.join(dataDir, "moneyminder.sqlite3");
  const relative = path.relative(dataDir, file);
  if (!relative || relative === ".." || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
    throw new Error("SQLITE_FILE must resolve inside DATA_DIR");
  }
  return file;
}

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  rejectLegacyStorageSettings(env);
  const dataDir = env.DATA_DIR
    ? path.resolve(env.DATA_DIR)
    : DEFAULT_DATA_DIR;
  const file = sqlitePath(dataDir, env.SQLITE_FILE || "", production);
  const port = positiveInt(env.PORT || 3000, "PORT", 65535);
  const bindHost = listenHost(env.LISTEN_HOST);
  const appOrigin = origin(env.APP_ORIGIN || (production ? "" : `http://localhost:${port}`), "APP_ORIGIN");
  const extensionOrigin = origin(env.EXTENSION_ORIGIN || "", "EXTENSION_ORIGIN");
  const sessionSecret = env.SESSION_SECRET || "";
  const maxBytes = positiveInt(env.DATA_MAX_BYTES || 25 * 1024 * 1024, "DATA_MAX_BYTES");
  const uploadTotalMaxBytes = positiveInt(env.UPLOAD_TOTAL_MAX_BYTES || 4 * 1024 * 1024 * 1024, "UPLOAD_TOTAL_MAX_BYTES");
  const uploadTotalMaxFiles = positiveInt(env.UPLOAD_TOTAL_MAX_FILES || 10000, "UPLOAD_TOTAL_MAX_FILES");
  const registrationEnabled = boolean(env.REGISTRATION_ENABLED, "REGISTRATION_ENABLED", !production);
  const promotionsEnabled = boolean(env.PROMOTIONS_ENABLED, "PROMOTIONS_ENABLED", false);
  const trustProxy = trustedProxy(env.TRUST_PROXY, production);
  const cookieSecure = env.SESSION_COOKIE_SECURE === undefined ? production : env.SESSION_COOKIE_SECURE === "true";
  if (production) {
    if (!/^https:\/\/[^/]+$/.test(appOrigin)) throw new Error("APP_ORIGIN must be a production HTTPS origin");
    if (!env.DATA_DIR || !path.isAbsolute(env.DATA_DIR)) throw new Error("DATA_DIR must be an absolute durable directory in production");
    if (Buffer.byteLength(sessionSecret) < 32) throw new Error("SESSION_SECRET must be at least 32 bytes in production");
    if (!cookieSecure) throw new Error("Production requires secure cookies");
  }
  return Object.freeze({
    production,
    store: "sqlite",
    dataDir,
    file,
    sqliteFile: file,
    appOrigin,
    sessionSecret,
    cookieSecure,
    maxBytes,
    dataMaxBytes: maxBytes,
    uploadTotalMaxBytes,
    uploadTotalMaxFiles,
    registrationEnabled,
    promotionsEnabled,
    trustProxy,
    extensionOrigin,
    port,
    listenHost: bindHost,
  });
}

loadDotEnv();

module.exports = { ...loadConfig(), loadConfig, loadDotEnv };
