const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const EMPTY = Object.freeze({
  users: {},
  receipts: {},
  households: {},
  expenses: {},
  settlements: {},
  tokens: {},
});
const LEGACY_IMPORT_MARKER = "legacy-json-import-v1";
const MAX_PENDING_WRITES = 64;

function assertDirectRegularFile(stat, message) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(message);
  }
}

function databaseError(error) {
  const message = String(error && error.message || "");
  const code = String(error && error.code || "");
  const errcode = Number(error && error.errcode);
  if (code === "SQLITE_FULL" || errcode === 13 || /database or disk is full/i.test(message)) {
    const full = new Error("Database size limit reached", { cause: error });
    full.code = "DB_FULL";
    return full;
  }
  if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(code)
      || [5, 6].includes(errcode)
      || /database (?:is )?(?:locked|busy)/i.test(message)) {
    const busy = new Error("Database is temporarily unavailable", { cause: error });
    busy.code = "DB_BUSY";
    return busy;
  }
  return error;
}

function stateRow(database) {
  const row = database.prepare(
    "SELECT data, revision FROM app_state WHERE id = 1",
  ).get();
  if (!row) {
    const error = new Error("SQLite application state is not initialized");
    error.code = "DB_NOT_READY";
    throw error;
  }
  let data;
  try {
    data = JSON.parse(row.data);
  } catch (cause) {
    const error = new Error("SQLite application state is corrupt", { cause });
    error.code = "DB_NOT_READY";
    throw error;
  }
  if (!data || Array.isArray(data) || typeof data !== "object") {
    const error = new Error("SQLite application state is corrupt");
    error.code = "DB_NOT_READY";
    throw error;
  }
  return { data, revision: row.revision };
}

function isEmptyState(data) {
  const expected = Object.keys(EMPTY);
  return data
    && !Array.isArray(data)
    && typeof data === "object"
    && Object.keys(data).length === expected.length
    && expected.every((name) => {
      const value = data[name];
      return value
        && !Array.isArray(value)
        && typeof value === "object"
        && Object.keys(value).length === 0;
    });
}

function validateLegacyState(raw, maxBytes) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (cause) {
    throw new Error("Legacy JSON store is invalid", { cause });
  }
  if (!data || Array.isArray(data) || typeof data !== "object") {
    throw new Error("Legacy JSON store must contain an object");
  }
  for (const name of Object.keys(EMPTY)) {
    const value = data[name];
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error(`Legacy JSON store has an invalid ${name} collection`);
    }
  }
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > maxBytes) {
    const error = new Error("Legacy JSON store exceeds the configured size limit");
    error.code = "DB_FULL";
    throw error;
  }
  return serialized;
}

function configure(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;
    PRAGMA busy_timeout = 5000;
  `);
}

function migrate(database, migrations) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const applied = database.prepare(
    "SELECT 1 FROM schema_migrations WHERE name = ?",
  );
  const record = database.prepare(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
  );
  for (const migration of migrations) {
    if (applied.get(migration.name)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      record.run(migration.name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
}

function importLegacy(database, legacyFile, maxBytes) {
  const marker = database.prepare(
    "SELECT 1 FROM schema_migrations WHERE name = ?",
  );
  if (marker.get(LEGACY_IMPORT_MARKER)) return false;

  let serialized;
  try {
    const stat = fs.lstatSync(legacyFile);
    assertDirectRegularFile(
      stat,
      "Legacy JSON store must be a direct regular file",
    );
    if (stat.size > maxBytes * 2) {
      const error = new Error("Legacy JSON store exceeds the configured size limit");
      error.code = "DB_FULL";
      throw error;
    }
    serialized = validateLegacyState(fs.readFileSync(legacyFile, "utf8"), maxBytes);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = stateRow(database);
    let imported = false;
    if (serialized !== undefined && isEmptyState(current.data)) {
      const result = database.prepare(`
        UPDATE app_state
        SET data = ?, revision = revision + 1, updated_at = ?
        WHERE id = 1 AND revision = ?
      `).run(serialized, new Date().toISOString(), current.revision);
      if (Number(result.changes) !== 1) {
        const error = new Error("SQLite application state changed during legacy import");
        error.code = "DB_BUSY";
        throw error;
      }
      imported = true;
    }
    database.prepare(
      "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
    ).run(LEGACY_IMPORT_MARKER, new Date().toISOString());
    database.exec("COMMIT");
    return imported;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function createSqliteStore({
  file,
  maxBytes,
  migrations,
  legacyFile = path.join(path.dirname(file), "db.json"),
}) {
  let database;
  let queue = Promise.resolve();
  let pendingWrites = 0;

  function ready() {
    if (database) return database;
    const error = new Error("SQLite store is not initialized");
    error.code = "DB_NOT_READY";
    throw error;
  }

  async function init() {
    if (database) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.accessSync(path.dirname(file), fs.constants.R_OK | fs.constants.W_OK);
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      assertDirectRegularFile(
        stat,
        "SQLITE_FILE must be a direct regular file",
      );
    }
    const opened = new DatabaseSync(file, {
      defensive: true,
      timeout: 5000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      configure(opened);
      migrate(opened, migrations);
      importLegacy(opened, legacyFile, maxBytes);
      const check = opened.prepare("PRAGMA quick_check").get();
      if (!check || check.quick_check !== "ok") {
        throw new Error("SQLite integrity check failed");
      }
      try { fs.chmodSync(file, 0o600); } catch (error) {
        if (process.platform !== "win32") throw error;
      }
      database = opened;
    } catch (error) {
      opened.close();
      throw databaseError(error);
    }
  }

  async function load() {
    try {
      return stateRow(ready()).data;
    } catch (error) {
      throw databaseError(error);
    }
  }

  function update(fn) {
    if (pendingWrites >= MAX_PENDING_WRITES) {
      const error = new Error("Database write queue is busy");
      error.code = "DB_BUSY";
      return Promise.reject(error);
    }
    pendingWrites++;
    const run = queue.then(async () => {
      const connection = ready();
      const current = stateRow(connection);
      const before = JSON.stringify(current.data);
      const result = await fn(current.data);
      const after = JSON.stringify(current.data);
      const beforeBytes = Buffer.byteLength(before);
      const afterBytes = Buffer.byteLength(after);
      if (after !== before && afterBytes > maxBytes && afterBytes >= beforeBytes) {
        const error = new Error("Database size limit reached");
        error.code = "DB_FULL";
        throw error;
      }
      if (after !== before) {
        const changed = connection.prepare(`
          UPDATE app_state
          SET data = ?, revision = revision + 1, updated_at = ?
          WHERE id = 1 AND revision = ?
        `).run(after, new Date().toISOString(), current.revision);
        if (Number(changed.changes) !== 1) {
          const error = new Error("Database write conflicted with another process");
          error.code = "DB_BUSY";
          throw error;
        }
      }
      return result;
    }).catch((error) => {
      throw databaseError(error);
    });
    queue = run.catch(() => {});
    return run.finally(() => { pendingWrites--; });
  }

  function scrubBackup() {
    const run = queue.then(() => {
      const result = ready().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (result && Number(result.busy) !== 0) {
        const error = new Error("SQLite checkpoint is busy");
        error.code = "DB_BUSY";
        throw error;
      }
    }).catch((error) => {
      throw databaseError(error);
    });
    queue = run.catch(() => {});
    return run;
  }

  async function ping() {
    try {
      const row = ready().prepare(
        "SELECT json_valid(data) AS valid FROM app_state WHERE id = 1",
      ).get();
      if (!row || Number(row.valid) !== 1) {
        const error = new Error("SQLite application state is not ready");
        error.code = "DB_NOT_READY";
        throw error;
      }
    } catch (error) {
      throw databaseError(error);
    }
  }

  async function close() {
    await queue;
    if (!database) return;
    const closing = database;
    database = undefined;
    try {
      closing.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } finally {
      closing.close();
    }
  }

  return {
    init,
    load,
    update,
    scrubBackup,
    ping,
    close,
    get database() { return database; },
  };
}

module.exports = {
  EMPTY,
  LEGACY_IMPORT_MARKER,
  assertDirectRegularFile,
  createSqliteStore,
  validateLegacyState,
};
