const crypto = require("node:crypto");

const { asyncRoute, idempotencyKey } = require("./http");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_TYPES = new Set(["impression", "click"]);
const DEDUP_RETENTION_MS = 48 * 60 * 60 * 1000;

function boundedPlainText(value, maxLength) {
  return typeof value === "string"
    && value === value.trim()
    && Array.from(value).length > 0
    && Array.from(value).length <= maxLength
    && !/[\u0000-\u001f\u007f-\u009f<>]/u.test(value);
}

function safeDestination(value) {
  if (typeof value !== "string"
      || value.length > 2048
      || !/^https:\/\/[A-Za-z0-9]/.test(value)
      || /[\s\u0000-\u001f\u007f-\u009f<>]/u.test(value)) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname)
      && !/(^|\.)(localhost|local|internal|test|example|invalid|onion)$/i.test(hostname)
      && !hostname.endsWith(".home.arpa");
  } catch {
    return false;
  }
}

function normalizePromotion(row) {
  if (!row
      || !UUID.test(String(row.id || ""))
      || !boundedPlainText(row.title, 80)
      || !boundedPlainText(row.description, 240)
      || !boundedPlainText(row.cta_label, 40)
      || !safeDestination(row.destination_url)) return null;
  return {
    id: String(row.id).toLowerCase(),
    title: row.title,
    description: row.description,
    ctaLabel: row.cta_label,
    url: row.destination_url,
  };
}

function operationalDatabaseError(cause) {
  const code = String(cause && cause.code || "");
  const sqliteCode = Number(cause && cause.errcode);
  const primaryCode = Number.isInteger(sqliteCode) ? sqliteCode & 0xff : -1;
  if (code === "SQLITE_FULL" || primaryCode === 13) {
    const error = new Error("Promotion database storage is full", { cause });
    error.code = "DB_FULL";
    return error;
  }
  if (!/^SQLITE_(?:BUSY|LOCKED|READONLY|IOERR|CANTOPEN)/.test(code)
      && ![5, 6, 8, 10, 14].includes(primaryCode)) return cause;
  const error = new Error("Promotion database is temporarily unavailable", { cause });
  error.code = "DB_BUSY";
  return error;
}

function validRepositoryEvent(event) {
  if (!event
      || typeof event !== "object"
      || Array.isArray(event)
      || Object.keys(event).length !== 5
      || !UUID.test(String(event.promotionId || ""))
      || !EVENT_TYPES.has(event.eventType)
      || !/^[0-9a-f]{64}$/.test(String(event.eventKeyHash || ""))
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(event.metricDate || ""))) return false;
  const metricInstant = new Date(`${event.metricDate}T00:00:00.000Z`);
  const pruneInstant = new Date(event.pruneBefore);
  return Number.isFinite(metricInstant.getTime())
    && metricInstant.toISOString().slice(0, 10) === event.metricDate
    && Number.isFinite(pruneInstant.getTime())
    && pruneInstant.toISOString() === event.pruneBefore;
}

function createSqlitePromotionRepository(database, { clock = Date.now } = {}) {
  if (!database
      || typeof database.prepare !== "function"
      || typeof database.exec !== "function") {
    throw new TypeError("SQLite promotion repository requires a node:sqlite database");
  }
  if (typeof clock !== "function") {
    throw new TypeError("SQLite promotion repository requires a clock function");
  }

  const statements = Object.freeze({
    current: database.prepare(`
      SELECT id, title, description, cta_label, destination_url
      FROM promotion_campaigns
      WHERE status = ?
        AND starts_at <= ?
        AND ends_at > ?
      ORDER BY starts_at DESC, id
      LIMIT 1
    `),
    pruneDedup: database.prepare(`
      DELETE FROM promotion_event_dedup
      WHERE created_at < ?
    `),
    activeCampaign: database.prepare(`
      SELECT id
      FROM promotion_campaigns
      WHERE id = ?
        AND status = ?
        AND starts_at <= ?
        AND ends_at > ?
      LIMIT 1
    `),
    insertDedup: database.prepare(`
      INSERT INTO promotion_event_dedup (
        event_key_hash,
        campaign_id,
        event_type,
        created_at
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT (event_key_hash) DO NOTHING
    `),
    priorEvent: database.prepare(`
      SELECT campaign_id, event_type
      FROM promotion_event_dedup
      WHERE event_key_hash = ?
    `),
    impression: database.prepare(`
      INSERT INTO promotion_daily_metrics (
        campaign_id,
        metric_date,
        impressions,
        clicks
      )
      VALUES (?, ?, 1, 0)
      ON CONFLICT (campaign_id, metric_date) DO UPDATE
      SET impressions = promotion_daily_metrics.impressions + 1
    `),
    click: database.prepare(`
      INSERT INTO promotion_daily_metrics (
        campaign_id,
        metric_date,
        impressions,
        clicks
      )
      VALUES (?, ?, 1, 1)
      ON CONFLICT (campaign_id, metric_date) DO UPDATE
      SET impressions = MAX(
            promotion_daily_metrics.impressions,
            promotion_daily_metrics.clicks + 1
          ),
          clicks = promotion_daily_metrics.clicks + 1
    `),
  });

  function nowIso() {
    const now = new Date(clock());
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Promotion repository clock returned an invalid date");
    }
    return now.toISOString();
  }

  async function current() {
    try {
      const instant = nowIso();
      const row = statements.current.get("active", instant, instant);
      return row ? { ...row } : null;
    } catch (error) {
      throw operationalDatabaseError(error);
    }
  }

  async function recordEvent(event) {
    if (!validRepositoryEvent(event)) {
      throw new TypeError("Invalid promotion repository event");
    }
    const recordedAt = nowIso();
    let transaction = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      transaction = true;
      statements.pruneDedup.run(event.pruneBefore);
      const prior = statements.priorEvent.get(event.eventKeyHash);
      if (prior) {
        database.exec("COMMIT");
        transaction = false;
        return String(prior.campaign_id) === event.promotionId
            && prior.event_type === event.eventType
          ? "duplicate"
          : "conflict";
      }
      const active = statements.activeCampaign.get(
        event.promotionId,
        "active",
        recordedAt,
        recordedAt,
      );
      if (!active) {
        database.exec("COMMIT");
        transaction = false;
        return "not-found";
      }

      const inserted = statements.insertDedup.run(
        event.eventKeyHash,
        event.promotionId,
        event.eventType,
        recordedAt,
      );
      if (Number(inserted.changes) === 0) {
        const racedEvent = statements.priorEvent.get(event.eventKeyHash);
        database.exec("COMMIT");
        transaction = false;
        if (!racedEvent) return "not-found";
        return String(racedEvent.campaign_id) === event.promotionId
            && racedEvent.event_type === event.eventType
          ? "duplicate"
          : "conflict";
      }

      const aggregate = event.eventType === "impression"
        ? statements.impression
        : statements.click;
      aggregate.run(event.promotionId, event.metricDate);
      database.exec("COMMIT");
      transaction = false;
      return "recorded";
    } catch (error) {
      if (transaction) {
        try { database.exec("ROLLBACK"); } catch {}
      }
      throw operationalDatabaseError(error);
    }
  }

  return Object.freeze({ current, recordEvent });
}

function createPromotions({
  enabled = false,
  repository,
  clock = Date.now,
} = {}) {
  if (enabled && (!repository
      || typeof repository.current !== "function"
      || typeof repository.recordEvent !== "function")) {
    throw new TypeError("Enabled promotions require a repository");
  }

  async function current(_req, res) {
    if (!enabled) return res.json({ promotion: null });
    const promotion = normalizePromotion(await repository.current());
    return res.json({ promotion });
  }

  async function event(req, res) {
    if (!enabled) return res.status(404).json({ error: "Promotion not found" });
    const promotionId = String(req.params && req.params.id || "").toLowerCase();
    const body = req.body;
    const operationKey = idempotencyKey(req);
    if (!UUID.test(promotionId)
        || !body
        || typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).length !== 1
        || !EVENT_TYPES.has(body.eventType)
        || !operationKey) {
      return res.status(400).json({ error: "Invalid promotion event" });
    }

    const now = new Date(clock());
    if (!Number.isFinite(now.getTime())) throw new Error("Promotion clock returned an invalid date");
    const result = await repository.recordEvent({
      promotionId,
      eventType: body.eventType,
      eventKeyHash: crypto.createHash("sha256").update(operationKey).digest("hex"),
      metricDate: now.toISOString().slice(0, 10),
      pruneBefore: new Date(now.getTime() - DEDUP_RETENTION_MS).toISOString(),
    });
    if (result === "not-found") {
      return res.status(404).json({ error: "Promotion not found" });
    }
    if (result === "conflict") {
      return res.status(409).json({
        error: "Idempotency-Key was already used for another promotion event",
      });
    }
    return res.status(204).end();
  }

  return { current, event };
}

function mount(app, {
  enabled = false,
  repository,
  currentLimit = (_req, _res, next) => next(),
  eventLimit = (_req, _res, next) => next(),
  clock,
} = {}) {
  const handlers = createPromotions({ enabled, repository, clock });
  app.get("/api/promotions/current", currentLimit, asyncRoute(handlers.current));
  app.post("/api/promotions/:id/events", eventLimit, asyncRoute(handlers.event));
  return handlers;
}

module.exports = {
  createSqlitePromotionRepository,
  createPromotions,
  mount,
  normalizePromotion,
};
