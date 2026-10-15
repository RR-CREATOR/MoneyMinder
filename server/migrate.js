const db = require("./db");

Promise.resolve()
  .then(() => db.init())
  .then(() => db.close())
  .catch(async (err) => {
    console.error("migration failed:", err && err.message ? err.message : "unknown error");
    await db.close().catch(() => {});
    process.exit(1);
  });
