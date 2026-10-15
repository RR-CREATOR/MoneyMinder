const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const { backup, restore } = require("./sqlite-maintenance");

function makeDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL CHECK (json_valid(data)),
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE user_sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire INTEGER NOT NULL,
      user_key TEXT
    ) STRICT;
  `);
  db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES ('001_app_state.sql', 'now')").run();
  db.prepare("INSERT INTO app_state (id, data, revision, updated_at) VALUES (1, ?, 7, 'now')").run(JSON.stringify({
    users: { alice: { username: "alice", authVersion: "old-version" } },
    receipts: {},
    households: {},
    expenses: {},
    settlements: {},
    tokens: { ["a".repeat(64)]: { userKey: "alice", authVersion: "old-version" } },
  }));
  db.prepare("INSERT INTO user_sessions (sid, sess, expire, user_key) VALUES ('sid', '{}', 9999999999999, 'alice')").run();
  db.close();
}

test("SQLite maintenance refuses to overwrite existing targets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-sqlite-maint-"));
  try {
    const source = path.join(dir, "source.sqlite3");
    const target = path.join(dir, "target.sqlite3");
    makeDb(source);
    fs.writeFileSync(target, "keep");
    await assert.rejects(backup(source, target), /target already exists/);
    await assert.rejects(restore(source, target), /target already exists/);
    assert.equal(fs.readFileSync(target, "utf8"), "keep");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite restore clears credential state before publishing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-sqlite-maint-"));
  try {
    const source = path.join(dir, "source.sqlite3");
    const target = path.join(dir, "restored.sqlite3");
    makeDb(source);
    const result = await restore(source, target);
    assert.equal(result.sessionsCleared, 1);
    assert.equal(result.tokensCleared, 1);
    assert.equal(result.usersRotated, 1);

    const db = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS count FROM user_sessions").get().count, 0);
      const row = db.prepare("SELECT data, revision FROM app_state WHERE id = 1").get();
      const data = JSON.parse(row.data);
      assert.equal(row.revision, 8);
      assert.deepEqual(data.tokens, {});
      assert.notEqual(data.users.alice.authVersion, "old-version");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite backup is consistent, leaves its source unchanged, and passes integrity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-sqlite-maint-"));
  try {
    const source = path.join(dir, "source.sqlite3");
    const target = path.join(dir, "backup.sqlite3");
    makeDb(source);
    const before = fs.readFileSync(source);

    const result = await backup(source, target);

    assert.ok(result.pages >= 1);
    assert.deepEqual(fs.readFileSync(source), before);
    const checked = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal(checked.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(checked.prepare("SELECT revision FROM app_state WHERE id = 1").get().revision, 7);
      assert.equal(checked.prepare("SELECT count(*) AS count FROM user_sessions").get().count, 1);
    } finally {
      checked.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup rejects a valid SQLite file with the wrong schema", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-sqlite-maint-"));
  try {
    const source = path.join(dir, "wrong.sqlite3");
    const target = path.join(dir, "backup.sqlite3");
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY) STRICT");
    db.close();

    await assert.rejects(backup(source, target), /app_state/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup rejects unexpected columns in production tables", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-sqlite-maint-"));
  try {
    const source = path.join(dir, "wrong-columns.sqlite3");
    const target = path.join(dir, "backup.sqlite3");
    makeDb(source);
    const db = new DatabaseSync(source);
    db.exec("ALTER TABLE user_sessions ADD COLUMN unsafe_extension TEXT");
    db.close();

    await assert.rejects(backup(source, target), /unexpected columns/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failed restore is unpublished and does not expose a user key in its error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-sqlite-maint-"));
  try {
    const source = path.join(dir, "source.sqlite3");
    const target = path.join(dir, "restored.sqlite3");
    makeDb(source);
    const db = new DatabaseSync(source);
    const state = JSON.parse(db.prepare("SELECT data FROM app_state WHERE id = 1").get().data);
    state.users = { "private-user-key": null };
    db.prepare("UPDATE app_state SET data = ? WHERE id = 1").run(JSON.stringify(state));
    db.close();
    const before = fs.readFileSync(source);

    await assert.rejects(
      restore(source, target),
      (error) => !String(error.message).includes("private-user-key"),
    );
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readFileSync(source), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maintenance rejects relative and identical paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-sqlite-maint-"));
  try {
    const source = path.join(dir, "source.sqlite3");
    makeDb(source);
    await assert.rejects(backup("relative.sqlite3", path.join(dir, "out.sqlite3")), /absolute/);
    await assert.rejects(restore(source, source), /different/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maintenance CLI calls the same checked backup and restore functions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-sqlite-maint-"));
  try {
    const source = path.join(dir, "source.sqlite3");
    const snapshot = path.join(dir, "snapshot.sqlite3");
    const restored = path.join(dir, "restored.sqlite3");
    makeDb(source);
    const script = path.join(__dirname, "sqlite-maintenance.js");

    const backupRun = spawnSync(process.execPath, [script, "backup", source, snapshot], {
      encoding: "utf8",
    });
    assert.equal(backupRun.status, 0, backupRun.stderr);
    const restoreRun = spawnSync(process.execPath, [script, "restore", snapshot, restored], {
      encoding: "utf8",
    });
    assert.equal(restoreRun.status, 0, restoreRun.stderr);
    const checked = new DatabaseSync(restored, { readOnly: true });
    try {
      assert.equal(checked.prepare("SELECT count(*) AS count FROM user_sessions").get().count, 0);
      assert.equal(checked.prepare("SELECT revision FROM app_state WHERE id = 1").get().revision, 8);
    } finally {
      checked.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
