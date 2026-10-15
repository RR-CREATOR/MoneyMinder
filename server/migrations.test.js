const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readMigrations } = require("./migrations");

test("initial schema constrains the singleton state to a JSON object", () => {
  const sql = fs.readFileSync(path.join(__dirname, "migrations", "001_app_state.sql"), "utf8");
  assert.match(sql, /CHECK\s*\(\s*id\s*=\s*1\s*\)/i);
  assert.match(sql, /CHECK\s*\(\s*json_valid\(data\)\s+AND\s+json_type\(data\)\s*=\s*'object'\s*\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS user_sessions_expire_idx/i);
  assert.match(sql, /STRICT/i);
});

test("promotion schema stores bounded campaigns and anonymous aggregate metrics", () => {
  const file = path.join(__dirname, "migrations", "002_promotions.sql");
  assert.equal(fs.existsSync(file), true, "002_promotions.sql must exist");
  const sql = fs.readFileSync(file, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS promotion_campaigns/i);
  assert.match(sql, /id\s+TEXT\s+PRIMARY KEY/i);
  for (const [column, limit] of [
    ["merchant_name", 80],
    ["title", 80],
    ["description", 240],
    ["cta_label", 40],
    ["destination_url", 2048],
  ]) {
    assert.match(sql, new RegExp(`${column}\\s+TEXT\\s+NOT NULL[\\s\\S]*length\\(${column}\\)\\s+BETWEEN\\s+(?:1|9)\\s+AND\\s+${limit}`, "i"));
  }
  assert.match(sql, /destination_url\s+LIKE\s+'https:\/\/%'/i);
  assert.match(sql, /destination_url\s+NOT\s+GLOB\s+'\*\[\s<>\]\*'/i);
  assert.match(sql, /ends_at\s*>\s*starts_at/i);
  assert.match(sql, /status\s+IN\s*\(\s*'draft'\s*,\s*'active'\s*,\s*'paused'\s*\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS promotion_campaigns_active_window_idx/i);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS promotion_daily_metrics/i);
  assert.match(sql, /PRIMARY KEY\s*\(\s*campaign_id\s*,\s*metric_date\s*\)/i);
  assert.match(sql, /impressions\s+INTEGER\s+NOT NULL\s+DEFAULT 0/i);
  assert.match(sql, /clicks\s+INTEGER\s+NOT NULL\s+DEFAULT 0/i);
  assert.match(sql, /clicks\s*<=\s*impressions/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS promotion_daily_metrics_date_idx/i);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS promotion_event_dedup/i);
  assert.match(sql, /event_key_hash\s+TEXT\s+PRIMARY KEY/i);
  assert.match(sql, /event_type\s+IN\s*\(\s*'impression'\s*,\s*'click'\s*\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS promotion_event_dedup_created_idx/i);
  assert.doesNotMatch(sql, /\b(?:user|device|receipt|household|category)_(?:id|key)\b/i);
});

test("readMigrations returns SQL files in filename order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-migrations-"));
  fs.writeFileSync(path.join(dir, "002_second.sql"), "SELECT 'second migration'");
  fs.writeFileSync(path.join(dir, "001_first.sql"), "SELECT 'first migration'");

  try {
    assert.deepStrictEqual(
      readMigrations(dir).map((migration) => migration.name),
      ["001_first.sql", "002_second.sql"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
