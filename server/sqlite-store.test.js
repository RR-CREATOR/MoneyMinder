const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { readMigrations } = require("./migrations");
const {
  EMPTY,
  LEGACY_IMPORT_MARKER,
  assertDirectRegularFile,
  createSqliteStore,
  validateLegacyState,
} = require("./sqlite-store");

function harness({ maxBytes = 1024 * 1024, legacy } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-sqlite-"));
  const file = path.join(dir, "moneyminder.sqlite3");
  const legacyFile = path.join(dir, "db.json");
  if (legacy !== undefined) {
    fs.writeFileSync(
      legacyFile,
      typeof legacy === "string" ? legacy : JSON.stringify(legacy, null, 2),
    );
  }
  const store = createSqliteStore({
    file,
    maxBytes,
    migrations: readMigrations(),
  });
  return {
    dir,
    file,
    legacyFile,
    store,
    async cleanup() {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("init creates a hardened WAL database with the complete schema", async () => {
  const h = harness();
  try {
    await h.store.init();
    assert.deepEqual(await h.store.load(), EMPTY);
    assert.equal(h.store.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(h.store.database.prepare("PRAGMA synchronous").get().synchronous, 2);
    assert.equal(h.store.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(h.store.database.prepare("PRAGMA trusted_schema").get().trusted_schema, 0);
    assert.equal(h.store.database.prepare("PRAGMA secure_delete").get().secure_delete, 1);

    const tables = new Set(h.store.database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table'",
    ).all().map(({ name }) => name));
    for (const table of [
      "app_state",
      "schema_migrations",
      "user_sessions",
      "promotion_campaigns",
      "promotion_daily_metrics",
      "promotion_event_dedup",
    ]) {
      assert(tables.has(table), `missing ${table}`);
    }
  } finally {
    await h.cleanup();
  }
});

test("updates are atomic and persist across a clean restart", async () => {
  const h = harness();
  try {
    await h.store.init();
    assert.equal(await h.store.update((data) => {
      data.users.alice = { username: "Alice" };
      return "saved";
    }), "saved");
    await h.store.close();

    const reopened = createSqliteStore({
      file: h.file,
      maxBytes: 1024 * 1024,
      migrations: readMigrations(),
    });
    await reopened.init();
    assert.deepEqual((await reopened.load()).users.alice, { username: "Alice" });
    await reopened.close();
  } finally {
    await h.cleanup();
  }
});

test("concurrent updates are serialized without losing writes", async () => {
  const h = harness();
  try {
    await h.store.init();
    await Promise.all(Array.from({ length: 50 }, (_, index) => (
      h.store.update(async (data) => {
        await new Promise((resolve) => setImmediate(resolve));
        data.receipts[`r${index}`] = { id: `r${index}` };
      })
    )));
    assert.equal(Object.keys((await h.store.load()).receipts).length, 50);
  } finally {
    await h.cleanup();
  }
});

test("revision compare-and-swap rejects an out-of-process conflict", async () => {
  const h = harness();
  try {
    await h.store.init();
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const update = h.store.update(async (data) => {
      data.users.alice = { username: "Alice" };
      entered();
      await gate;
    });
    await started;

    const other = new DatabaseSync(h.file, { defensive: true, timeout: 5000 });
    other.prepare(
      "UPDATE app_state SET revision = revision + 1 WHERE id = 1",
    ).run();
    other.close();
    release();

    await assert.rejects(update, (error) => error.code === "DB_BUSY");
    assert.equal((await h.store.load()).users.alice, undefined);
  } finally {
    await h.cleanup();
  }
});

test("the write queue rejects the sixty-fifth pending mutation", async () => {
  const h = harness();
  try {
    await h.store.init();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = [h.store.update(async () => gate)];
    for (let index = 1; index < 64; index++) {
      queued.push(h.store.update(() => {}));
    }
    await assert.rejects(
      h.store.update(() => {}),
      (error) => error.code === "DB_BUSY",
    );
    release();
    await Promise.all(queued);
  } finally {
    await h.cleanup();
  }
});

test("failed and oversized mutations never change durable state", async () => {
  const h = harness({ maxBytes: 512 });
  try {
    await h.store.init();
    await assert.rejects(
      h.store.update((data) => {
        data.users.alice = { secret: "x" };
        throw new Error("callback failed");
      }),
      /callback failed/,
    );
    await assert.rejects(
      h.store.update((data) => { data.large = "x".repeat(600); }),
      (error) => error.code === "DB_FULL",
    );
    assert.deepEqual(await h.store.load(), EMPTY);
  } finally {
    await h.cleanup();
  }
});

test("SQLite disk-full failures use the public DB_FULL error", async () => {
  const h = harness({ maxBytes: 4 * 1024 * 1024 });
  try {
    await h.store.init();
    const pages = h.store.database.prepare("PRAGMA page_count").get().page_count;
    h.store.database.exec(`PRAGMA max_page_count = ${pages}`);
    await assert.rejects(
      h.store.update((data) => { data.large = "x".repeat(1024 * 1024); }),
      (error) => error.code === "DB_FULL",
    );
    assert.deepEqual(await h.store.load(), EMPTY);
  } finally {
    await h.cleanup();
  }
});

test("legacy JSON imports once and leaves both legacy files untouched", async () => {
  const legacy = {
    users: { alice: { username: "Alice" } },
    receipts: {},
    households: {},
    expenses: {},
    settlements: {},
    tokens: {},
  };
  const h = harness({ legacy });
  const backup = `${h.legacyFile}.bak`;
  fs.writeFileSync(backup, "legacy-backup");
  const original = fs.readFileSync(h.legacyFile, "utf8");
  try {
    await h.store.init();
    assert.deepEqual((await h.store.load()).users.alice, { username: "Alice" });
    assert(h.store.database.prepare(
      "SELECT 1 FROM schema_migrations WHERE name = ?",
    ).get(LEGACY_IMPORT_MARKER));
    assert.equal(fs.readFileSync(h.legacyFile, "utf8"), original);
    assert.equal(fs.readFileSync(backup, "utf8"), "legacy-backup");

    await h.store.update((data) => { delete data.users.alice; });
    await h.store.close();
    const reopened = createSqliteStore({
      file: h.file,
      maxBytes: 1024 * 1024,
      migrations: readMigrations(),
    });
    await reopened.init();
    assert.equal((await reopened.load()).users.alice, undefined);
    await reopened.close();
  } finally {
    await h.cleanup();
  }
});

test("invalid legacy JSON fails closed and remains untouched", async () => {
  const h = harness({ legacy: "{not-json" });
  const original = fs.readFileSync(h.legacyFile, "utf8");
  try {
    await assert.rejects(h.store.init(), /Legacy JSON store is invalid/);
    assert.equal(fs.readFileSync(h.legacyFile, "utf8"), original);
  } finally {
    await h.cleanup();
  }
});

test("legacy validation rejects wrong shapes and compact data above the limit", () => {
  assert.throws(
    () => validateLegacyState("[]", 1024),
    /must contain an object/,
  );
  assert.throws(
    () => validateLegacyState(JSON.stringify({ ...EMPTY, users: [] }), 1024),
    /invalid users collection/,
  );
  assert.throws(
    () => validateLegacyState(
      JSON.stringify({ ...EMPTY, metadata: "x".repeat(1024) }),
      256,
    ),
    (error) => error.code === "DB_FULL",
  );
});

test("direct-file validation rejects symlinks and non-files on every platform", () => {
  const directFile = {
    isSymbolicLink: () => false,
    isFile: () => true,
  };
  const symlink = {
    isSymbolicLink: () => true,
    isFile: () => true,
  };
  const directory = {
    isSymbolicLink: () => false,
    isFile: () => false,
  };

  assert.doesNotThrow(() => assertDirectRegularFile(directFile, "rejected"));
  assert.throws(
    () => assertDirectRegularFile(symlink, "must be a direct regular file"),
    /direct regular file/,
  );
  assert.throws(
    () => assertDirectRegularFile(directory, "must be a direct regular file"),
    /direct regular file/,
  );
});

test("ping, checkpoint, and close report the store lifecycle", async () => {
  const h = harness();
  try {
    await assert.rejects(h.store.ping(), (error) => error.code === "DB_NOT_READY");
    await h.store.init();
    await h.store.update((data) => {
      data.users.alice = { username: "Alice" };
    });
    await h.store.ping();
    await h.store.scrubBackup();
    const checkpoint = h.store.database.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    assert.equal(checkpoint.busy, 0);
    await h.store.close();
    await assert.rejects(h.store.ping(), (error) => error.code === "DB_NOT_READY");
  } finally {
    await h.cleanup();
  }
});
