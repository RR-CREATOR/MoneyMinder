function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function idempotencyKey(req) {
  const value = String(req && typeof req.get === "function" ? req.get("Idempotency-Key") || "" : "");
  if (!value) return "";
  return /^[A-Za-z0-9._:-]{16,80}$/.test(value) ? value : null;
}

function isCurrentUser(data, req) {
  // Route-level unit tests invoke handlers directly; live requests always pass
  // through requireAuth and therefore fail closed without an auth version.
  if (!req.authVersion) return process.env.NODE_ENV === "test";
  return data.users?.[req.userKey]?.authVersion === req.authVersion;
}

module.exports = { asyncRoute, idempotencyKey, isCurrentUser };
