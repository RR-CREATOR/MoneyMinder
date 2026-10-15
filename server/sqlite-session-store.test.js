const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createSqliteSessionStore } = require("./sqlite-session-store");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-sqlite-sessions-"));
  return { dir, file: path.join(dir, "moneyminder.sqlite3") };
}

function call(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

test("SQLite session store persists sessions, touches expiry, and survives restart", async () => {
  const { dir, file } = tempFile();
  let store;
  try {
    store = createSqliteSessionStore(file);
    assert.equal(store.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(store.database.prepare("PRAGMA trusted_schema").get().trusted_schema, 0);
    assert.equal(store.database.prepare("PRAGMA secure_delete").get().secure_delete, 1);
    await call(store, "set", "sid-1", {
      user: "alice",
      cookie: { expires: new Date(Date.now() + 60000).toISOString() },
    });
    await store.close();
    store = undefined;

    store = createSqliteSessionStore(file);
    const schema = store.database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'user_sessions'",
    ).get().sql;
    assert.match(
      schema,
      /CHECK \(json_valid\(sess\) AND json_type\(sess\) = 'object'\)/,
    );
    assert.match(schema, /\) STRICT$/);
    assert.equal(
      store.database.prepare(
        "SELECT strict FROM pragma_table_list WHERE name = 'user_sessions'",
      ).get().strict,
      1,
    );
    assert.equal((await call(store, "get", "sid-1")).user, "alice");
    await call(store, "touch", "sid-1", {
      cookie: { expires: new Date(Date.now() + 120000).toISOString() },
    });
    assert.equal(await call(store, "length"), 1);
    await store.close();
    store = undefined;
  } finally {
    if (store) await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite session store rejects a non-file database target", () => {
  const { dir, file } = tempFile();
  fs.mkdirSync(file);
  try {
    assert.throws(
      () => createSqliteSessionStore(file),
      /SQLITE_FILE must be a direct regular file/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite session store prunes expired rows and fails closed on corrupt JSON", async () => {
  const { dir, file } = tempFile();
  try {
    const store = createSqliteSessionStore(file);
    await call(store, "set", "expired", {
      user: "alice",
      cookie: { expires: new Date(Date.now() - 1000).toISOString() },
    });
    assert.equal(await call(store, "get", "expired"), undefined);
    assert.equal(await call(store, "length"), 0);

    store.database.exec("PRAGMA ignore_check_constraints = ON");
    store.database.prepare(
      "INSERT INTO user_sessions (sid, sess, expire, user_key) VALUES (?, ?, ?, ?)",
    ).run("corrupt", "{bad json", Date.now() + 60000, "alice");
    store.database.exec("PRAGMA ignore_check_constraints = OFF");
    await assert.rejects(
      call(store, "get", "corrupt"),
      (error) => error.code === "SESSION_CORRUPT" && !error.message.includes("corrupt-bob"),
    );
    await store.close();
    await store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite session store deletes one user's sessions by indexed user key", async () => {
  const { dir, file } = tempFile();
  try {
    const store = createSqliteSessionStore(file);
    await call(store, "set", "alice-1", { user: "alice", cookie: {} });
    await call(store, "set", "alice-2", { user: "alice", cookie: {} });
    await call(store, "set", "bob-1", { user: "bob", cookie: {} });
    store.database.exec("PRAGMA ignore_check_constraints = ON");
    store.database.prepare(
      "INSERT INTO user_sessions (sid, sess, expire, user_key) VALUES (?, ?, ?, ?)",
    ).run("corrupt-bob", "{bad json", Date.now() + 60000, "bob");
    store.database.exec("PRAGMA ignore_check_constraints = OFF");

    assert.equal(await store.deleteUserSessions("alice"), 2);
    assert.equal(await call(store, "get", "alice-1"), undefined);
    assert.equal((await call(store, "get", "bob-1")).user, "bob");
    await call(store, "clear");
    assert.equal(await call(store, "length"), 0);
    await store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
