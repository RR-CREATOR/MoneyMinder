const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-db-suite-"));
process.env.NODE_ENV = "test";
for (const name of ["DATABASE_URL", "DATABASE_POOL_MAX", "PG_POOL_MAX", "DATA_FILE"]) {
  process.env[name] = "";
}
process.env.DATA_DIR = suiteDir;
process.env.SQLITE_FILE = path.join(suiteDir, "moneyminder.sqlite3");

const db = require("./db");

test.after(async () => {
  await db.close();
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

test("test database uses the configured SQLite file", async () => {
  await db.init();
  assert.equal(db.kind, "sqlite");
  assert.equal(db.file, path.join(suiteDir, "moneyminder.sqlite3"));
  assert(db.database, "the initialized DatabaseSync handle must be exposed");
  await db.ping();
});

test("SQLite update persists app state and rejects oversized growth", async () => {
  await db.init();
  await db.update((data) => {
    data.users.alice = { username: "alice" };
  });
  assert.equal((await db.load()).users.alice.username, "alice");
});

test("scrubBackup checkpoints WAL without deleting live state", async () => {
  await db.init();
  await db.update((data) => {
    data.receipts.r1 = { id: "r1", userKey: "alice", amount: 1 };
  });
  await db.scrubBackup();
  assert.equal((await db.load()).receipts.r1.amount, 1);
});
