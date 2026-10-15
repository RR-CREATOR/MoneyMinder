const bcrypt = require("bcryptjs");
const session = require("express-session");
const crypto = require("crypto");
const db = require("./db");
const config = require("./config");
const { parseMoney } = require("./money");
const uploads = require("./uploads");
const { isCurrentUser } = require("./http");
const { uniqueCode } = require("./households");
const { createSqliteSessionStore } = require("./sqlite-session-store");

let activeSessionStore;

function sessionMiddleware() {
  let secret = config.sessionSecret;
  if (!secret) {
    console.warn("SESSION_SECRET not set — using a random per-boot secret (logs everyone out on restart).");
    secret = crypto.randomBytes(32).toString("hex");
  }
  const store = createSqliteSessionStore(db.file);
  activeSessionStore = store;
  return session({
    store,
    name: config.production ? "__Host-moneyminder.sid" : "moneyminder.sid",
    secret,
    resave: false,
    saveUninitialized: false,
    // rolling: every authenticated response refreshes the cookie's 30-day window,
    // so an active user stays logged in across browser/app restarts and devices.
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  });
}

async function closeSessionStore() {
  const store = activeSessionStore;
  activeSessionStore = undefined;
  await uploads.stopDeleteRetries();
  if (store && typeof store.close === "function") await store.close();
}

// UPI VPA like name@bank. Loose on purpose — banks use varied handles.
const VPA_RE = /^[\w.\-]{2,64}@[\w.\-]{2,64}$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{1,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^\+?[0-9][0-9 -]{7,19}$/;
const RESERVED_USER_KEYS = new Set([".", "..", "__proto__", "prototype", "constructor"]);
const MIN_PASSWORD_CODE_POINTS = 15;
const MAX_PASSWORD_BYTES = 72;
const DUMMY_PASSWORD_HASH = "$2b$10$C6UzMDM.H6dfI/f/IKcEe.3KE0Yy3ZFZEmrqQVQH8pVMnY3nJtKSa";
const REAUTH_ERROR = { error: "Current password verification failed" };

function publicUser(u) {
  return {
    username: u.username,
    email: u.email,
    mobile: u.mobile,
    budget: u.budget,
    vpa: u.vpa || "",
    displayName: u.displayName || "",
  };
}

// Bearer tokens let the browser extension authenticate without cookies (the
// session cookie is httpOnly/sameSite=lax and won't flow to a
// chrome-extension:// origin). Kept internal — issued on login/register only
// when X-Client: extension is present.
// Bearer tokens expire after 30 days, and we keep at most this many per user so
// the store doesn't grow without bound across many logins.
const TOKEN_TTL_MS = 30 * 86400000;
const MAX_TOKENS_PER_USER = 5;
const BEARER_TOKEN_RE = /^Bearer ([a-f0-9]{64})$/;
const TOKEN_DIGEST_RE = /^[a-f0-9]{64}$/;
let knownBearerTokenDigests = new Map();
let pendingTokenRevocations = new Map();

function tokenDigest(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function tokenCacheEntry(data, digest, now = Date.now()) {
  if (!TOKEN_DIGEST_RE.test(digest)) return null;
  const record = data?.tokens?.[digest];
  const user = record && data?.users?.[record.userKey];
  const createdAt = record?.createdAt ? new Date(record.createdAt).getTime() : NaN;
  if (!Number.isFinite(createdAt)
      || now - createdAt > TOKEN_TTL_MS
      || !user?.authVersion
      || record.authVersion !== user.authVersion) {
    return null;
  }
  return Object.freeze({
    userKey: record.userKey,
    authVersion: record.authVersion,
    expiresAt: createdAt + TOKEN_TTL_MS,
  });
}

function rememberKnownToken(digest, entry) {
  if (pendingTokenRevocations.has(digest)) return false;
  const next = new Map(knownBearerTokenDigests);
  next.set(digest, entry);
  knownBearerTokenDigests = next;
  return true;
}

function forgetKnownTokenDigests(digests) {
  const next = new Map(knownBearerTokenDigests);
  let changed = false;
  for (const digest of digests) changed = next.delete(digest) || changed;
  if (changed) knownBearerTokenDigests = next;
}

function forgetKnownTokensForUser(userKey) {
  const next = new Map(
    [...knownBearerTokenDigests].filter(([, entry]) => entry.userKey !== userKey),
  );
  if (next.size !== knownBearerTokenDigests.size) knownBearerTokenDigests = next;
}

function isKnownTokenDigest(digest, now = Date.now()) {
  if (pendingTokenRevocations.has(digest)) return false;
  const entry = knownBearerTokenDigests.get(digest);
  if (!entry) return false;
  if (now <= entry.expiresAt) return true;
  forgetKnownTokenDigests([digest]);
  return false;
}

function isKnownBearerToken(authorization, now = Date.now()) {
  const match = String(authorization || "").match(BEARER_TOKEN_RE);
  return Boolean(match && isKnownTokenDigest(tokenDigest(match[1]), now));
}

async function initializeTokenCache() {
  const data = await db.load();
  const now = Date.now();
  const next = new Map();
  for (const digest of Object.keys(data.tokens || {})) {
    const entry = tokenCacheEntry(data, digest, now);
    if (entry) next.set(digest, entry);
  }
  knownBearerTokenDigests = next;
  return next.size;
}

async function issueToken(userKey, authVersion) {
  const token = crypto.randomBytes(32).toString("hex");
  const digest = tokenDigest(token);
  const removedDigests = new Set();
  let entry;
  const issued = await db.update((d) => {
    if (d.users?.[userKey]?.authVersion !== authVersion) return false;
    if (!d.tokens) d.tokens = {};
    const now = Date.now();
    const mine = [];
    for (const [t, rec] of Object.entries(d.tokens)) {
      const created = rec.createdAt ? new Date(rec.createdAt).getTime() : 0;
      if (now - created > TOKEN_TTL_MS) {
        removedDigests.add(t);
        delete d.tokens[t]; // drop anyone's expired token while we're here
        continue;
      }
      if (rec.userKey === userKey) mine.push([t, created]);
    }
    // Keep the newest few; the brand-new token below brings us to the cap.
    mine.sort((a, b) => b[1] - a[1]);
    for (const [t] of mine.slice(MAX_TOKENS_PER_USER - 1)) {
      removedDigests.add(t);
      delete d.tokens[t];
    }
    const createdAt = new Date(now).toISOString();
    d.tokens[digest] = { userKey, authVersion, createdAt };
    entry = Object.freeze({ userKey, authVersion, expiresAt: now + TOKEN_TTL_MS });
    return true;
  });
  if (issued) {
    forgetKnownTokenDigests(removedDigests);
    rememberKnownToken(digest, entry);
  }
  return issued ? token : null;
}

function destroySession(req, res) {
  if (!req.session) return res.json({ ok: true });
  return new Promise((resolve, reject) => req.session.destroy((error) => {
    if (error) return reject(error);
    res.json({ ok: true });
    resolve();
  }));
}

function logPostDeleteCleanup(stage, error) {
  console.error(JSON.stringify({
    type: "account_deletion_cleanup_error",
    stage,
    code: error?.code ? String(error.code) : "",
  }));
}

async function completeAuthentication(req, res, key, user) {
  if (req.get("X-Client") === "extension") {
    const token = await issueToken(key, user.authVersion);
    if (!token) return res.status(401).json({ error: "Not authenticated" });
    return res.json({ ok: true, user: publicUser(user), token });
  }
  return new Promise((resolve) => req.session.regenerate((error) => {
    if (error) {
      res.status(500).json({ error: "Session error" });
      return resolve();
    }
    req.session.user = key;
    req.session.authVersion = user.authVersion;
    res.json({ ok: true, user: publicUser(user) });
    resolve();
  }));
}

async function register(req, res) {
  const { username, email, mobile, budget, password, vpa } = req.body || {};
  if (!username || !password || !email || !mobile || budget === undefined || budget === "") {
    return res.status(400).json({ error: "All fields are required" });
  }
  const key = String(username).toLowerCase();
  if (!USERNAME_RE.test(String(username)) || RESERVED_USER_KEYS.has(key)) {
    return res.status(400).json({ error: "Username may only use letters, numbers, dot, underscore, hyphen (max 32)" });
  }
  const passwordValue = String(password);
  const passwordBytes = Buffer.byteLength(passwordValue);
  if (Array.from(passwordValue).length < MIN_PASSWORD_CODE_POINTS) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_CODE_POINTS} characters` });
  }
  if (passwordBytes > MAX_PASSWORD_BYTES) {
    return res.status(400).json({ error: `Password must be at most ${MAX_PASSWORD_BYTES} bytes` });
  }
  if (String(username).length > 64 || String(email).length > 254 || String(mobile).length > 20) {
    return res.status(400).json({ error: "One of the fields is too long" });
  }
  if (!EMAIL_RE.test(String(email))) {
    return res.status(400).json({ error: "Invalid email address" });
  }
  if (!MOBILE_RE.test(String(mobile))) {
    return res.status(400).json({ error: "Invalid mobile number" });
  }
  const parsedBudget = parseMoney(budget, { allowZero: true });
  if (parsedBudget === null) {
    return res.status(400).json({ error: "Invalid budget" });
  }
  if (vpa !== undefined && vpa !== "" && (String(vpa).length > 130 || !VPA_RE.test(String(vpa)))) {
    return res.status(400).json({ error: "Invalid UPI ID" });
  }
  const passwordHash = await bcrypt.hash(passwordValue, 10);
  const authVersion = crypto.randomUUID();
  let createdUser;
  const taken = await db.update((data) => {
    if (Object.hasOwn(data.users, key) || uploads.userDeletionPending(data, key)) return true;
    createdUser = {
      username: String(username),
      email: String(email),
      mobile: String(mobile),
      budget: parsedBudget,
      vpa: vpa ? String(vpa) : "",
      displayName: "",
      passwordHash,
      authVersion,
      createdAt: new Date().toISOString(),
    };
    data.users[key] = createdUser;
    return false;
  });
  if (taken) return res.status(409).json({ error: "Username already taken" });
  return completeAuthentication(req, res, key, createdUser);
}

async function login(req, res) {
  const { username, password } = req.body || {};
  const key = String(username || "").toLowerCase();
  const safeKey = USERNAME_RE.test(key) && !RESERVED_USER_KEYS.has(key);
  let user = safeKey ? (await db.load()).users[key] : undefined;
  // Always run a compare, even for unknown users, so response time doesn't
  // reveal which usernames exist.
  const hash = user ? user.passwordHash : DUMMY_PASSWORD_HASH;
  const ok = await bcrypt.compare(String(password || ""), hash);
  if (!user || !ok) return res.status(401).json({ error: "Invalid username or password" });
  if (!user.authVersion) {
    user = await db.update((d) => {
      if (!d.users[key]) return null;
      d.users[key].authVersion ||= crypto.randomUUID();
      return d.users[key];
    });
  }
  if (!user) return res.status(401).json({ error: "Invalid username or password" });
  return completeAuthentication(req, res, key, user);
}

async function revokeTokenDigest(digest) {
  const pending = pendingTokenRevocations.get(digest);
  if (pending) return pending;
  const operation = Promise.resolve()
    .then(() => db.update((d) => {
      if (!d.tokens || !Object.hasOwn(d.tokens, digest)) return false;
      delete d.tokens[digest];
      return true;
    }))
    .then((removed) => {
      forgetKnownTokenDigests([digest]);
      return removed;
    });
  const next = new Map(pendingTokenRevocations);
  next.set(digest, operation);
  pendingTokenRevocations = next;
  try {
    return await operation;
  } finally {
    if (pendingTokenRevocations.get(digest) === operation) {
      const remaining = new Map(pendingTokenRevocations);
      remaining.delete(digest);
      pendingTokenRevocations = remaining;
    }
  }
}

async function logout(req, res) {
  const m = (req.get("Authorization") || "").match(BEARER_TOKEN_RE);
  if (m) {
    const digest = tokenDigest(m[1]);
    if (pendingTokenRevocations.has(digest) || isKnownTokenDigest(digest)) {
      await revokeTokenDigest(digest);
    } else {
      const data = await db.load();
      if (data.tokens && Object.hasOwn(data.tokens, digest)) await revokeTokenDigest(digest);
    }
  }
  return destroySession(req, res);
}

async function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    const user = (await db.load()).users[req.session.user];
    if (user && user.authVersion && user.authVersion === req.session.authVersion) {
      req.userKey = req.session.user;
      req.authVersion = user.authVersion;
      req.authType = "session";
      return next();
    }
  }
  const m = (req.get("Authorization") || "").match(BEARER_TOKEN_RE);
  if (m) {
    const digest = tokenDigest(m[1]);
    if (pendingTokenRevocations.has(digest)) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const data = await db.load();
    if (pendingTokenRevocations.has(digest)) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const entry = tokenCacheEntry(data, digest);
    if (entry && rememberKnownToken(digest, entry)) {
      req.userKey = entry.userKey;
      req.authVersion = entry.authVersion;
      req.authType = "bearer";
      return next();
    }
    forgetKnownTokenDigests([digest]);
  }
  return res.status(401).json({ error: "Not authenticated" });
}

function requireSession(req, res, next) {
  if (req.authType === "session") return next();
  return res.status(403).json({ error: "Browser session required" });
}

async function me(req, res) {
  const user = (await db.load()).users[req.userKey];
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json({ user: publicUser(user) });
}

function currentUser(data, req) {
  return isCurrentUser(data, req) ? data.users?.[req.userKey] : null;
}

async function verifyCurrentPassword(req, user) {
  return user?.passwordHash
    ? bcrypt.compare(String(req.body?.currentPassword || ""), user.passwordHash)
    : false;
}

function scrubOperationKeys(value) {
  if (Array.isArray(value)) return value.map(scrubOperationKeys);
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "operationKey") copy[key] = scrubOperationKeys(item);
  }
  return copy;
}

// Edit your own profile only. Only fields present in the body change.
async function updateMe(req, res) {
  const body = req.body || {};
  if ("vpa" in body && body.vpa !== "" && (String(body.vpa).length > 130 || !VPA_RE.test(String(body.vpa)))) {
    return res.status(400).json({ error: "Invalid UPI ID" });
  }
  if ("budget" in body) {
    if (parseMoney(body.budget, { allowZero: true }) === null) {
      return res.status(400).json({ error: "Invalid budget" });
    }
  }
  if ("displayName" in body && String(body.displayName).length > 64) {
    return res.status(400).json({ error: "Display name is too long" });
  }
  const before = currentUser(await db.load(), req);
  if (!before) return res.status(401).json({ error: "Not authenticated" });
  const nextVpa = body.vpa ? String(body.vpa) : "";
  if ("vpa" in body && nextVpa !== (before.vpa || "") && !await verifyCurrentPassword(req, before)) {
    return res.status(403).json(REAUTH_ERROR);
  }
  const updated = await db.update((d) => {
    const u = currentUser(d, req);
    if (!u) return null;
    if ("vpa" in body) u.vpa = nextVpa;
    if ("budget" in body) u.budget = parseMoney(body.budget, { allowZero: true });
    if ("displayName" in body) u.displayName = String(body.displayName);
    return u;
  });
  if (!updated) return res.status(401).json({ error: "Not authenticated" });
  res.json({ ok: true, user: publicUser(updated) });
}

async function exportMe(req, res) {
  const data = await db.load();
  const user = currentUser(data, req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  if (!await verifyCurrentPassword(req, user)) {
    return res.status(403).json(REAUTH_ERROR);
  }
  const householdIds = new Set(Object.values(data.households || {})
    .filter((h) => h.members.includes(req.userKey)).map((h) => h.id));
  res.json({
    exportedAt: new Date().toISOString(),
    user: publicUser(user),
    receipts: scrubOperationKeys(Object.values(data.receipts || {}).filter((r) => r.userKey === req.userKey)),
    households: scrubOperationKeys(Object.values(data.households || {}).filter((h) => householdIds.has(h.id))),
    expenses: scrubOperationKeys(Object.values(data.expenses || {}).filter((e) => householdIds.has(e.householdId))),
    settlements: scrubOperationKeys(Object.values(data.settlements || {}).filter((s) => s.from === req.userKey || s.to === req.userKey)),
  });
}

async function deleteMe(req, res) {
  const userKey = req.userKey;
  const deletedKey = "deleted-" + crypto.randomUUID();
  const before = currentUser(await db.load(), req);
  if (!before) return res.status(401).json({ error: "Not authenticated" });
  if (!await verifyCurrentPassword(req, before)) {
    return res.status(403).json(REAUTH_ERROR);
  }
  const removed = await db.update((d) => {
    if (!currentUser(d, req)) return false;
    const orphanedHouseholds = new Set();
    const rotatedCodes = new Map();
    const reservedCodes = { ...d.households };
    let rotationIndex = 0;
    for (const h of Object.values(d.households || {})) {
      if (!h.members.includes(userKey)) continue;
      const remaining = h.members.filter((member) => member !== userKey && d.users[member]);
      if (!remaining.length) {
        orphanedHouseholds.add(h.id);
        continue;
      }
      const code = uniqueCode(reservedCodes);
      if (!code) throw Object.assign(new Error("Could not rotate household invite"), { code: "CODE_BUSY" });
      rotatedCodes.set(h.id, code);
      reservedCodes[`rotation-${rotationIndex++}`] = { code };
    }
    for (const h of Object.values(d.households || {})) {
      if (orphanedHouseholds.has(h.id)) {
        delete d.households[h.id];
        continue;
      }
      for (const recurring of h.recurring || []) {
        if (recurring.createdBy === userKey) recurring.createdBy = deletedKey;
        recurring.splitAmong = (recurring.splitAmong || [])
          .map((member) => member === userKey ? deletedKey : member);
      }
      if (!h.members.includes(userKey)) continue;
      h.code = rotatedCodes.get(h.id);
      const nextOwner = h.members.find((m) => m !== userKey && d.users[m]);
      h.members = h.members.map((m) => m === userKey ? deletedKey : m);
      if (h.ownerKey === userKey) h.ownerKey = nextOwner || deletedKey;
    }
    for (const [id, e] of Object.entries(d.expenses || {})) {
      if (orphanedHouseholds.has(e.householdId)) {
        delete d.expenses[id];
        continue;
      }
      if (e.paidBy === userKey) e.paidBy = deletedKey;
      e.splitAmong = (e.splitAmong || []).map((m) => m === userKey ? deletedKey : m);
    }
    for (const [id, s] of Object.entries(d.settlements || {})) {
      if (orphanedHouseholds.has(s.householdId)) {
        delete d.settlements[id];
        continue;
      }
      if (s.from === userKey) s.from = deletedKey;
      if (s.to === userKey) s.to = deletedKey;
    }
    for (const [id, receipt] of Object.entries(d.receipts || {})) {
      if (receipt.userKey === userKey) delete d.receipts[id];
    }
    for (const [token, record] of Object.entries(d.tokens || {})) {
      if (record.userKey === userKey) delete d.tokens[token];
    }
    uploads.queueUserDelete(d, userKey);
    delete d.users[userKey];
    return true;
  });
  if (!removed) return res.status(401).json({ error: "Not authenticated" });
  forgetKnownTokensForUser(userKey);
  try {
    if (activeSessionStore?.deleteUserSessions) {
      await activeSessionStore.deleteUserSessions(userKey);
    }
  } catch (error) {
    logPostDeleteCleanup("sessions", error);
  }
  try {
    await db.scrubBackup();
  } catch (error) {
    logPostDeleteCleanup("checkpoint", error);
  }
  try {
    return await destroySession(req, res);
  } catch (error) {
    logPostDeleteCleanup("current_session", error);
    if (typeof res.clearCookie === "function") {
      res.clearCookie(
        config.production ? "__Host-moneyminder.sid" : "moneyminder.sid",
        {
          httpOnly: true,
          sameSite: "lax",
          secure: config.cookieSecure,
          path: "/",
        },
      );
    }
    return res.json({ ok: true });
  }
}

module.exports = {
  sessionMiddleware,
  closeSessionStore,
  register,
  login,
  logout,
  initializeTokenCache,
  isKnownBearerToken,
  requireAuth,
  requireSession,
  me,
  updateMe,
  exportMe,
  deleteMe,
};
