const fs = require("fs");
const path = require("path");

const MIGRATION_DIR = path.join(__dirname, "migrations");

function readMigrations(dir = MIGRATION_DIR) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), "utf8") }));
}

module.exports = { readMigrations };
