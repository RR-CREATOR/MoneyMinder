const test = require("node:test");
const assert = require("node:assert");
const { asyncRoute, idempotencyKey, isCurrentUser } = require("./http");

test("asyncRoute forwards rejected handlers to Express error middleware", async () => {
  const failure = new Error("disk full");
  let forwarded;
  await new Promise((resolve) => {
    asyncRoute(async () => { throw failure; })({}, {}, (error) => {
      forwarded = error;
      resolve();
    });
  });
  assert.strictEqual(forwarded, failure);
});

test("idempotencyKey accepts bounded opaque keys and rejects malformed values", () => {
  const req = (value) => ({ get: (name) => name === "Idempotency-Key" ? value : "" });
  assert.strictEqual(idempotencyKey(req("")), "");
  assert.strictEqual(
    idempotencyKey(req("7a45d4b1-b073-4cb5-83fe-52aa6a550a57")),
    "7a45d4b1-b073-4cb5-83fe-52aa6a550a57",
  );
  assert.strictEqual(idempotencyKey(req("short")), null);
  assert.strictEqual(idempotencyKey(req("x".repeat(81))), null);
  assert.strictEqual(idempotencyKey(req("invalid key with spaces")), null);
});

test("transaction user checks reject deleted or re-created identities", () => {
  const data = { users: { alice: { authVersion: "current" } } };
  assert.strictEqual(isCurrentUser(data, { userKey: "alice", authVersion: "current" }), true);
  assert.strictEqual(isCurrentUser(data, { userKey: "alice", authVersion: "old" }), false);
  assert.strictEqual(isCurrentUser({ users: {} }, { userKey: "alice", authVersion: "current" }), false);
  assert.strictEqual(isCurrentUser(data, { userKey: "alice" }), true);
  const environment = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.strictEqual(isCurrentUser(data, { userKey: "alice" }), false);
  } finally {
    process.env.NODE_ENV = environment;
  }
});
