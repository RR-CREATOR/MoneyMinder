#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_TABLES = Object.freeze({
  app_state: Object.freeze(["id", "data", "revision", "updated_at"]),
  user_sessions: Object.freeze(["sid", "sess", "expire", "user_key"]),
  schema_migrations: Object.freeze(["name", "applied_at"]),
});
const MAX_STATE_BYTES = 64 * 1024 * 1024;

function loadSqlite() {
  return require("node:sqlite");
}

function comparable(file) {
  return process.platform === "win32" ? file.toLowerCase() : file;
}

function absoluteFile(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute file path`);
  }
  if (path.normalize(value) !== value) {
    throw new Error(`${label} must be a normalized absolute file path`);
  }
  return value;
}

function validatePaths(sourceValue, targetValue) {
  const source = absoluteFile(sourceValue, "source");
  const target = absoluteFile(targetValue, "target");
  if (comparable(source) === comparable(target)) {
    throw new Error("source and target must be different files");
  }
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("source must be a direct regular file");
  }
  if (fs.realpathSync.native(source) !== source) {
    throw new Error("source must not use an indirect path");
  }
  const parent = path.dirname(target);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("target parent must be a direct directory");
  }
  if (fs.realpathSync.native(parent) !== parent) {
    throw new Error("target parent must not use an indirect path");
  }
  try {
    fs.lstatSync(target);
    throw new Error("target already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { source, target };
}

function openDatabase(DatabaseSync, file, readOnly) {
  return new DatabaseSync(file, {
    readOnly,
    timeout: 5000,
    enableForeignKeyConstraints: true,
    allowExtension: false,
    defensive: true,
  });
}

function verifyIntegrity(database) {
  const rows = database.prepare("PRAGMA integrity_check").all();
  if (rows.length !== 1 || String(Object.values(rows[0])[0]).toLowerCase() !== "ok") {
    throw new Error("SQLite integrity check failed");
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length) {
    throw new Error("SQLite foreign-key check failed");
  }
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_xinfo(${table})`).all()
    .map((column) => column.name));
}

function verifySchema(database) {
  const names = Object.keys(REQUIRED_TABLES);
  const objects = database.prepare(
    "SELECT name, type FROM sqlite_schema WHERE name IN (?, ?, ?)",
  ).all(...names);
  const types = new Map(objects.map((object) => [object.name, object.type]));
  for (const [table, requiredColumns] of Object.entries(REQUIRED_TABLES)) {
    if (types.get(table) !== "table") {
      throw new Error(`database is missing required ${table} table`);
    }
    const columns = tableColumns(database, table);
    for (const column of requiredColumns) {
      if (!columns.has(column)) throw new Error(`${table} is missing required ${column} column`);
    }
    if (columns.size !== requiredColumns.length) {
      throw new Error(`${table} has unexpected columns`);
    }
  }
  const triggers = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN (?, ?)",
  ).all("app_state", "user_sessions");
  if (triggers.length) throw new Error("credential tables must not have triggers");
}

function reserveTemporary(target) {
  const temporary = `${target}.tmp-${crypto.randomUUID()}`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  fs.closeSync(descriptor);
  return temporary;
}

function cleanupTemporary(temporary) {
  for (const file of [
    temporary,
    `${temporary}-journal`,
    `${temporary}-shm`,
    `${temporary}-wal`,
  ]) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function publish(temporary, target) {
  fs.chmodSync(temporary, 0o600);
  const descriptor = fs.openSync(temporary, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.linkSync(temporary, target);
  try {
    fs.chmodSync(target, 0o600);
    fs.unlinkSync(temporary);
  } catch (error) {
    try { fs.unlinkSync(target); } catch {}
    throw error;
  }
}

async function copyCheckedDatabase(source, temporary, sqlite) {
  let database;
  try {
    database = openDatabase(sqlite.DatabaseSync, source, true);
    verifyIntegrity(database);
    verifySchema(database);
    return await sqlite.backup(database, temporary, { rate: 100 });
  } finally {
    if (database) database.close();
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function parseState(serialized) {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
    throw new Error("app_state data is invalid or too large");
  }
  let state;
  try {
    state = object(JSON.parse(serialized), "app_state data");
  } catch (cause) {
    throw new Error("app_state data is invalid", { cause });
  }
  const users = object(state.users, "app_state users");
  const tokens = state.tokens === undefined ? {} : object(state.tokens, "app_state tokens");
  for (const user of Object.values(users)) object(user, "active user record");
  return { state, users, tokens };
}

function sanitizedState(serialized) {
  const { state, users, tokens } = parseState(serialized);
  const versions = new Set();
  const rotatedUsers = Object.fromEntries(Object.entries(users).map(([key, user]) => {
    let authVersion;
    do {
      authVersion = crypto.randomUUID();
    } while (versions.has(authVersion));
    versions.add(authVersion);
    return [key, { ...user, authVersion }];
  }));
  return {
    data: JSON.stringify({ ...state, users: rotatedUsers, tokens: {} }),
    tokensCleared: Object.keys(tokens).length,
    usersRotated: Object.keys(rotatedUsers).length,
  };
}

function sanitizeRestore(database) {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA trusted_schema = OFF;
    PRAGMA foreign_keys = ON;
  `);
  verifySchema(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const rows = database.prepare(
      "SELECT data, revision FROM app_state WHERE id = 1",
    ).all();
    const rowCount = database.prepare("SELECT COUNT(*) AS count FROM app_state").get().count;
    if (rows.length !== 1 || rowCount !== 1) {
      throw new Error("app_state must contain only row 1");
    }
    const revision = rows[0].revision;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
      throw new Error("app_state revision is invalid");
    }
    const next = sanitizedState(rows[0].data);
    const sessionsCleared = database.prepare(
      "SELECT COUNT(*) AS count FROM user_sessions",
    ).get().count;
    const deleted = database.prepare("DELETE FROM user_sessions").run();
    const updated = database.prepare(`
      UPDATE app_state
      SET data = ?, revision = revision + 1, updated_at = ?
      WHERE id = 1
    `).run(next.data, new Date().toISOString());
    if (deleted.changes !== sessionsCleared || updated.changes !== 1) {
      throw new Error("credential sanitization did not update every row");
    }
    if (database.prepare("SELECT COUNT(*) AS count FROM user_sessions").get().count !== 0) {
      throw new Error("browser sessions remain after sanitization");
    }
    const checked = database.prepare(
      "SELECT data, revision FROM app_state WHERE id = 1",
    ).get();
    const verified = parseState(checked.data);
    if (checked.revision !== revision + 1 || Object.keys(verified.tokens).length) {
      throw new Error("credential sanitization verification failed");
    }
    const authVersions = new Set();
    for (const user of Object.values(verified.users)) {
      const value = String(user.authVersion || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
          || authVersions.has(value)) {
        throw new Error("an active user authVersion was not rotated");
      }
      authVersions.add(value);
    }
    database.exec("COMMIT");
    return {
      sessionsCleared,
      tokensCleared: next.tokensCleared,
      usersRotated: next.usersRotated,
    };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

async function backupDatabase(sourceValue, targetValue, sqlite = loadSqlite()) {
  const { source, target } = validatePaths(sourceValue, targetValue);
  const temporary = reserveTemporary(target);
  let published = false;
  try {
    const pages = await copyCheckedDatabase(source, temporary, sqlite);
    const checked = openDatabase(sqlite.DatabaseSync, temporary, true);
    try {
      verifyIntegrity(checked);
      verifySchema(checked);
    } finally {
      checked.close();
    }
    publish(temporary, target);
    published = true;
    return { pages };
  } finally {
    if (!published) cleanupTemporary(temporary);
  }
}

async function restoreDatabase(sourceValue, targetValue, sqlite = loadSqlite()) {
  const { source, target } = validatePaths(sourceValue, targetValue);
  const temporary = reserveTemporary(target);
  let database;
  let published = false;
  try {
    const pages = await copyCheckedDatabase(source, temporary, sqlite);
    database = openDatabase(sqlite.DatabaseSync, temporary, false);
    verifyIntegrity(database);
    const sanitized = sanitizeRestore(database);
    verifyIntegrity(database);
    database.close();
    database = undefined;
    publish(temporary, target);
    published = true;
    return { pages, ...sanitized };
  } finally {
    if (database) {
      try { database.close(); } catch {}
    }
    if (!published) cleanupTemporary(temporary);
  }
}

function usage() {
  return "Usage: node server/sqlite-maintenance.js <backup|restore> <absolute-source.sqlite3> <absolute-new-target.sqlite3>";
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || !["backup", "restore"].includes(args[0])) {
    throw new Error(usage());
  }
  const result = args[0] === "backup"
    ? await backupDatabase(args[1], args[2])
    : await restoreDatabase(args[1], args[2]);
  process.stdout.write(`${JSON.stringify({ ok: true, operation: args[0], ...result })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`SQLite maintenance failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  backup: backupDatabase,
  restore: restoreDatabase,
  backupDatabase,
  restoreDatabase,
  main,
};
