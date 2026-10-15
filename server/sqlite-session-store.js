const fs = require("node:fs");
const path = require("node:path");
const session = require("express-session");
const { DatabaseSync } = require("node:sqlite");
const { assertDirectRegularFile } = require("./sqlite-store");

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function expiry(sess, now = Date.now()) {
  const raw = sess && sess.cookie && sess.cookie.expires;
  const expires = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(expires) ? expires : now + MONTH_MS;
}

function parseSession(value) {
  try {
    return JSON.parse(value);
  } catch (cause) {
    const error = new Error("Corrupt session row", { cause });
    error.code = "SESSION_CORRUPT";
    throw error;
  }
}

function userKey(sess) {
  return typeof sess?.user === "string" ? sess.user : null;
}

class SqliteSessionStore extends session.Store {
  constructor(file) {
    super();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      assertDirectRegularFile(
        fs.lstatSync(file),
        "SQLITE_FILE must be a direct regular file",
      );
    }
    const database = new DatabaseSync(file, {
      defensive: true,
      timeout: 5000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
        PRAGMA secure_delete = ON;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS user_sessions (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL CHECK (json_valid(sess) AND json_type(sess) = 'object'),
          expire INTEGER NOT NULL CHECK (expire > 0),
          user_key TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS user_sessions_expire_idx
          ON user_sessions (expire);
      `);
      const columns = new Set(
        database.prepare("PRAGMA table_info(user_sessions)").all()
          .map((column) => column.name),
      );
      if (!columns.has("user_key")) {
        database.exec("ALTER TABLE user_sessions ADD COLUMN user_key TEXT");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS user_sessions_user_key_idx
          ON user_sessions (user_key);
      `);
      try { fs.chmodSync(file, 0o600); } catch (error) {
        if (process.platform !== "win32") throw error;
      }
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  run(callback, fn) {
    try {
      const value = fn();
      if (callback) queueMicrotask(() => callback(null, value));
      return value;
    } catch (error) {
      if (callback) queueMicrotask(() => callback(error));
      else throw error;
    }
  }

  prune(now = Date.now()) {
    this.database.prepare("DELETE FROM user_sessions WHERE expire <= ?").run(now);
  }

  get(sid, callback) {
    this.run(callback, () => {
      const now = Date.now();
      this.prune(now);
      const row = this.database.prepare(
        "SELECT sess FROM user_sessions WHERE sid = ? AND expire > ?",
      ).get(String(sid), now);
      return row ? parseSession(row.sess) : undefined;
    });
  }

  set(sid, sess, callback) {
    this.run(callback, () => {
      this.database.prepare(`
        INSERT INTO user_sessions (sid, sess, expire, user_key)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (sid) DO UPDATE
        SET sess = excluded.sess,
            expire = excluded.expire,
            user_key = excluded.user_key
      `).run(String(sid), JSON.stringify(sess), expiry(sess), userKey(sess));
    });
  }

  destroy(sid, callback) {
    this.run(callback, () => {
      this.database.prepare("DELETE FROM user_sessions WHERE sid = ?").run(String(sid));
    });
  }

  touch(sid, sess, callback) {
    this.run(callback, () => {
      const now = Date.now();
      this.prune(now);
      const row = this.database.prepare(
        "SELECT sess FROM user_sessions WHERE sid = ? AND expire > ?",
      ).get(String(sid), now);
      if (!row) return;
      const current = parseSession(row.sess);
      const next = { ...current, cookie: sess.cookie };
      this.database.prepare(
        "UPDATE user_sessions SET sess = ?, expire = ?, user_key = ? WHERE sid = ?",
      ).run(JSON.stringify(next), expiry(sess, now), userKey(next), String(sid));
    });
  }

  clear(callback) {
    this.run(callback, () => {
      this.database.prepare("DELETE FROM user_sessions").run();
    });
  }

  length(callback) {
    this.run(callback, () => {
      this.prune();
      return this.database.prepare("SELECT count(*) AS count FROM user_sessions").get().count;
    });
  }

  async deleteUserSessions(userKey) {
    return this.database.prepare(
      "DELETE FROM user_sessions WHERE user_key = ?",
    ).run(String(userKey)).changes;
  }

  async close() {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }
}

function createSqliteSessionStore(file) {
  return new SqliteSessionStore(file);
}

module.exports = { SqliteSessionStore, createSqliteSessionStore };
