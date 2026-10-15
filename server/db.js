const config = require("./config");
const { readMigrations } = require("./migrations");
const { createSqliteStore } = require("./sqlite-store");

const store = createSqliteStore({
  file: config.sqliteFile,
  maxBytes: config.maxBytes,
  migrations: readMigrations(),
});

module.exports = {
  dir: config.dataDir,
  file: config.sqliteFile,
  kind: "sqlite",
  init: store.init,
  load: store.load,
  update: store.update,
  scrubBackup: store.scrubBackup,
  ping: store.ping,
  close: store.close,
  get database() { return store.database; },
};
