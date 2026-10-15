const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-test-"));
process.env.DATA_DIR = dataDir;
process.env.SQLITE_FILE = path.join(dataDir, "moneyminder.sqlite3");
delete process.env.DATABASE_URL;
delete process.env.DATA_FILE;
process.env.APP_ORIGIN = "";
process.env.TRUST_PROXY = "0";
process.env.SESSION_SECRET = "test-only-secret-test-only-secret";
