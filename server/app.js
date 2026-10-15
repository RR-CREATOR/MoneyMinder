const path = require("path");
const crypto = require("crypto");

const express = require("express");
const multer = require("multer");
const auth = require("./auth");
const ocr = require("./ocr");
const receipts = require("./api");
const households = require("./households");
const promotions = require("./promotions");
const recurring = require("./recurring");
const db = require("./db");
const uploads = require("./uploads");
const { asyncRoute } = require("./http");
const config = require("./config");

const app = express();
app.disable("x-powered-by");
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
});
const PORT = config.port;
app.set("trust proxy", config.trustProxy);

// ponytail: tiny fixed-window per-IP rate limiter, capped at 10k active IPs.
// Use a shared store when one process or one-minute windows stop being enough.
function rateLimit(max, windowMs, keyOf) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = String(keyOf
      ? keyOf(req)
      : req.ip || (req.socket && req.socket.remoteAddress) || "?");
    for (const [key, value] of hits) {
      if (value.reset >= now) break;
      hits.delete(key);
    }
    const rec = hits.get(key);
    if (!rec) {
      if (hits.size >= 10000) return res.status(429).json({ error: "Too many requests, slow down" });
      hits.set(key, { n: 1, reset: now + windowMs });
    } else if (rec.n >= max) {
      return res.status(429).json({ error: "Too many requests, slow down" });
    } else {
      hits.set(key, { n: rec.n + 1, reset: rec.reset });
    }
    next();
  };
}

function createBearerAuthLimiter({
  perIpMax = 60,
  processMax = 180,
  windowMs = 60000,
  isKnownToken = auth.isKnownBearerToken,
} = {}) {
  const perIpLimit = rateLimit(perIpMax, windowMs);
  const processLimit = rateLimit(processMax, windowMs, () => "bearer-auth-process");
  return (req, res, next) => {
    const authorization = req.get("Authorization") || "";
    if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) return next();
    return perIpLimit(req, res, () => (
      isKnownToken(authorization) ? next() : processLimit(req, res, next)
    ));
  };
}

const bearerAuthLimit = createBearerAuthLimiter();

app.use((req, res, next) => {
  const suppliedRequestId = String(req.get("X-Request-ID") || "");
  const requestId = /^[A-Za-z0-9._:-]{1,80}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : crypto.randomUUID();
  const started = process.hrtime.bigint();
  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  if (config.production) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  res.on("finish", () => {
    if (!config.production) return;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(JSON.stringify({
      type: "http_request",
      requestId,
      method: req.method,
      route: req.route && req.route.path ? String(req.route.path) : "unmatched",
      status: res.statusCode,
      durationMs: Math.round(elapsedMs * 10) / 10,
    }));
  });
  next();
});
app.use("/api", rateLimit(600, 60000));
app.use("/api", express.json({ limit: "64kb" }));

// Allow the MoneyMinder browser extension (chrome-extension:// origin) to call
// the API with a bearer token. Cookieless, so there's no CSRF surface.
function allowedExtensionOrigin(origin, runtime = config) {
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin || "")) return false;
  if (runtime.extensionOrigin) return origin === runtime.extensionOrigin;
  return !runtime.production;
}

function mutationOriginAllowed(origin, authorization, runtime = config) {
  if (origin) return origin === runtime.appOrigin || allowedExtensionOrigin(origin, runtime);
  return /^Bearer [a-f0-9]{64}$/.test(authorization || "") || !runtime.production;
}

app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (allowedExtensionOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Client,Idempotency-Key");
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  next();
});

function createReadinessCheck(ping, ttlMs = 2000, clock = Date.now) {
  let cached;
  let expires = 0;
  let pending;
  return async () => {
    if (cached !== undefined && clock() < expires) return cached;
    if (!pending) {
      let probe;
      try {
        probe = ping();
      } catch (error) {
        probe = Promise.reject(error);
      }
      pending = Promise.resolve(probe)
        .then(() => true, () => false)
        .then((ready) => {
          cached = ready;
          expires = clock() + ttlMs;
          pending = undefined;
          return ready;
        });
    }
    return pending;
  };
}

app.get("/livez", (_req, res) => res.json({ ok: true }));
const checkReadiness = createReadinessCheck(() => db.ping());
const readiness = async (_req, res) => {
  const ready = await checkReadiness();
  res.status(ready ? 200 : 503).json({ ok: ready });
};
const readinessLimit = rateLimit(120, 60000);
app.get("/readyz", readinessLimit, readiness);
app.get("/healthz", readinessLimit, readiness);

app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("Origin");
  if (!mutationOriginAllowed(origin, req.get("Authorization"))) return res.status(403).json({ error: "Cross-origin request blocked" });
  next();
});
app.use("/api", auth.sessionMiddleware());
// Open auth endpoints.
const authIpLimit = rateLimit(60, 60000);
const authAccountLimit = rateLimit(
  10,
  60000,
  (req) => String(req.body && req.body.username || "").trim().toLowerCase(),
);
app.post(
  "/api/register",
  (req, res, next) => config.registrationEnabled ? next() : res.status(403).json({ error: "Registration is closed" }),
  authIpLimit,
  authAccountLimit,
  asyncRoute(auth.register),
);
app.post("/api/login", authIpLimit, authAccountLimit, asyncRoute(auth.login));
app.post("/api/logout", rateLimit(30, 60000), bearerAuthLimit, asyncRoute(auth.logout));

// Everything else under /api needs a logged-in session.
app.use("/api", bearerAuthLimit, asyncRoute(auth.requireAuth));
const EXTENSION_EXPENSE_PATH = /^\/api\/households\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/expenses$/;
app.use((req, res, next) => {
  if (req.authType !== "bearer") return next();
  const allowed =
    (req.method === "GET" && ["/api/summary", "/api/households"].includes(req.path))
    || (req.method === "POST" && req.path === "/api/receipts")
    || (req.method === "POST" && EXTENSION_EXPENSE_PATH.test(req.path));
  return allowed ? next() : res.status(403).json({ error: "Bearer token scope does not allow this action" });
});
app.get("/api/me", asyncRoute(auth.me));
const profileLimit = rateLimit(30, 60000, (req) => req.userKey);
const sensitiveAccountLimit = rateLimit(10, 60000, (req) => req.userKey);
const profileMutationLimit = (req, res, next) => (
  Object.hasOwn(req.body || {}, "vpa") ? sensitiveAccountLimit : profileLimit
)(req, res, next);
app.patch("/api/me", auth.requireSession, profileMutationLimit, asyncRoute(auth.updateMe));
app.post("/api/me/export", auth.requireSession, sensitiveAccountLimit, asyncRoute(auth.exportMe));
app.delete("/api/me", auth.requireSession, sensitiveAccountLimit, asyncRoute(auth.deleteMe));
const promotionEventIpLimit = rateLimit(30, 60000);
const promotionEventUserLimit = rateLimit(10, 60000, (req) => req.userKey);
let promotionRepository;
function sqlitePromotions() {
  promotionRepository ||= promotions.createSqlitePromotionRepository(db.database);
  return promotionRepository;
}
promotions.mount(app, {
  enabled: config.promotionsEnabled,
  repository: {
    current: (...args) => sqlitePromotions().current(...args),
    recordEvent: (...args) => sqlitePromotions().recordEvent(...args),
  },
  currentLimit: rateLimit(120, 60000),
  eventLimit: (req, res, next) => promotionEventIpLimit(
    req,
    res,
    () => promotionEventUserLimit(req, res, next),
  ),
});
app.post(
  "/api/parse-receipt",
  rateLimit(1, 60000, (req) => req.userKey),
  rateLimit(2, 60000, () => "ocr-process"),
  upload.single("input"),
  asyncRoute(ocr.parseReceipt),
);
receipts.mount(app);
app.use(
  "/api/households/join",
  rateLimit(10, 60000, (req) => req.userKey),
  rateLimit(20, 60000),
);
households.mount(app);

app.get("/register.html", (_req, res, next) => {
  if (config.registrationEnabled) return next();
  res.status(404).send("Registration is closed");
});
app.use(express.static(path.join(__dirname, "..", "public")));

function errorHandler(err, req, res, next) {
  console.error(JSON.stringify({
    type: "request_error",
    requestId: req.requestId || "",
    code: err && err.code ? String(err.code) : "",
    error: err && err.name ? String(err.name) : "Error",
  }));
  if (res.headersSent) return next(err);
  if (err && err.code === "AUTH_STALE") {
    return res.status(401).json({ error: "Not authenticated" });
  }
  if (err && err.code === "OCR_BUSY") {
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ error: "Receipt scanner is busy; retry shortly" });
  }
  if (err && (err.code === "LIMIT_FILE_SIZE" || err.type === "entity.too.large")) {
    return res.status(413).json({ error: "Upload is too large" });
  }
  if (err && err.code === "UPLOAD_QUOTA") {
    return res.status(507).json({ error: "Receipt image storage limit reached" });
  }
  if (err && ["LIMIT_PART_COUNT", "LIMIT_FIELD_COUNT", "LIMIT_FILE_COUNT", "LIMIT_UNEXPECTED_FILE"].includes(err.code)) {
    return res.status(400).json({ error: "Invalid multipart upload" });
  }
  if (err && err.code === "DB_BUSY") {
    return res.status(503).json({ error: "Server is busy; retry shortly" });
  }
  if (err && err.code === "DB_NOT_READY") {
    return res.status(503).json({ error: "Server is starting; retry shortly" });
  }
  if (err && err.code === "DB_FULL") {
    return res.status(507).json({ error: "Storage limit reached; delete old data first" });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  if (req.path.startsWith("/api/")) return res.status(500).json({ error: "Something went wrong" });
  res.status(500).send("Something went wrong");
}
app.use(errorHandler);

async function closeDependencies() {
  const ocrCleanup = ocr.shutdown();
  const storage = (async () => {
    const errors = [];
    try { await auth.closeSessionStore(); } catch (error) { errors.push(error); }
    try { await db.close(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Storage cleanup failed");
  })();
  const results = await Promise.allSettled([
    ocrCleanup,
    storage,
  ]);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Dependency cleanup failed");
}

function configureServer(server) {
  server.headersTimeout = 10000;
  server.requestTimeout = 70000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  return server;
}

function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), Math.max(1, timeoutMs));
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

async function shutdown(server, recurringTimer, graceMs = 10000) {
  clearInterval(recurringTimer);
  const deadline = Date.now() + graceMs;
  const closed = new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const httpResult = await settleWithin(closed, Math.max(1, Math.floor(graceMs * 0.8)));
  if (httpResult.timeout && server.closeAllConnections) server.closeAllConnections();

  const cleanupResult = await settleWithin(closeDependencies(), deadline - Date.now());
  const errors = [];
  if (httpResult.error) errors.push(httpResult.error);
  if (cleanupResult.error) errors.push(cleanupResult.error);
  if (cleanupResult.timeout) {
    const error = new Error("Shutdown timed out");
    error.code = "SHUTDOWN_TIMEOUT";
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Shutdown failed");
}

async function start() {
  let recurringTimer;
  let server;
  try {
    await db.init();
    await auth.initializeTokenCache();
    await ocr.verifyLanguageData();
    await ocr.startOrphanSweeps();
    uploads.startDeleteRetries();
    recurringTimer = recurring.start();
    server = await new Promise((resolve, reject) => {
      const listening = configureServer(app.listen(PORT, config.listenHost, () => resolve(listening)));
      listening.once("error", reject);
    });
  } catch (error) {
    clearInterval(recurringTimer);
    try {
      await closeDependencies();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Startup failed and dependency cleanup did not complete",
        { cause: error },
      );
    }
    throw error;
  }
  console.log(config.production
    ? JSON.stringify({ type: "startup", message: "MoneyMinder running", port: PORT })
    : `MoneyMinder running at http://localhost:${PORT}`);
  let stopping;
  const stop = () => {
    if (!stopping) stopping = shutdown(server, recurringTimer);
    return stopping;
  };
  const exit = () => {
    stop().then(() => process.exit(0), (error) => {
      console.error(JSON.stringify({ type: "shutdown_error", message: String(error.message || error).slice(0, 200) }));
      process.exit(1);
    });
  };
  process.once("SIGTERM", exit);
  process.once("SIGINT", exit);
  server.once("close", () => {
    process.removeListener("SIGTERM", exit);
    process.removeListener("SIGINT", exit);
  });
  server.shutdown = stop;
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error(JSON.stringify({
      type: "startup_error",
      message: err && err.message ? String(err.message).slice(0, 200) : "unknown error",
    }));
    process.exit(1);
  });
}

module.exports = {
  app,
  start,
  createBearerAuthLimiter,
  shutdown,
  allowedExtensionOrigin,
  createReadinessCheck,
  configureServer,
  errorHandler,
  mutationOriginAllowed,
  rateLimit,
};
