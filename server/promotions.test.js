const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const {
  createSqlitePromotionRepository,
  createPromotions,
  mount,
  normalizePromotion,
} = require("./promotions");

const PROMOTION_ID = "3d8c2e12-f3d7-4ea2-9bed-87e6b7b52f08";
const OTHER_PROMOTION_ID = "6c2c56fb-581d-4d90-8456-32a766defd44";
const EVENT_KEY = "event-key-1234567890";

function rawPromotion(overrides = {}) {
  return {
    id: PROMOTION_ID,
    merchant_name: "Example merchant",
    title: "Save on groceries",
    description: "A useful discount for MoneyMinder users.",
    cta_label: "View offer",
    destination_url: "https://merchant.co.in/offers/student",
    internal_notes: "must never leave the server",
    ...overrides,
  };
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function request({ id = PROMOTION_ID, eventType = "impression", key = EVENT_KEY } = {}) {
  return {
    params: { id },
    body: { eventType },
    userKey: "must-not-reach-storage",
    ip: "203.0.113.8",
    get(name) {
      return name === "Idempotency-Key" ? key : "";
    },
  };
}

test("promotion responses expose only bounded plain text and an HTTPS destination", () => {
  assert.deepStrictEqual(normalizePromotion(rawPromotion()), {
    id: PROMOTION_ID,
    title: "Save on groceries",
    description: "A useful discount for MoneyMinder users.",
    ctaLabel: "View offer",
    url: "https://merchant.co.in/offers/student",
  });

  for (const invalid of [
    rawPromotion({ id: "not-a-uuid" }),
    rawPromotion({ title: "x".repeat(81) }),
    rawPromotion({ description: "unsafe\u0000text" }),
    rawPromotion({ cta_label: "<strong>Open</strong>" }),
    rawPromotion({ destination_url: "http://merchant.example/offer" }),
    rawPromotion({ destination_url: "https://user:pass@merchant.example/offer" }),
    rawPromotion({ destination_url: "https://a%" }),
    rawPromotion({ destination_url: "https://merchant.example/" + "x".repeat(2048) }),
    rawPromotion({ destination_url: "https://localhost/offer" }),
    rawPromotion({ destination_url: "https://127.0.0.1/offer" }),
    rawPromotion({ destination_url: "https://[::1]/offer" }),
    rawPromotion({ destination_url: "https://merchant.local/offer" }),
    rawPromotion({ destination_url: "https://merchant.example/offer" }),
    rawPromotion({ destination_url: "https://merchant.co.in:8443/offer" }),
  ]) {
    assert.strictEqual(normalizePromotion(invalid), null);
  }
});

test("disabled promotions fail closed without touching storage", async () => {
  const repository = {
    async current() {
      assert.fail("disabled current offer queried storage");
    },
    async recordEvent() {
      assert.fail("disabled event wrote storage");
    },
  };
  const handlers = createPromotions({ repository });
  const currentResponse = response();
  await handlers.current(request(), currentResponse);
  assert.deepStrictEqual(currentResponse.body, { promotion: null });

  const eventResponse = response();
  await handlers.event(request(), eventResponse);
  assert.strictEqual(eventResponse.statusCode, 404);
  assert.deepStrictEqual(eventResponse.body, { error: "Promotion not found" });
});

test("current promotion is identical for every authenticated user and strips internal data", async () => {
  const repository = {
    current: async () => rawPromotion(),
    recordEvent: async () => "recorded",
  };
  const handlers = createPromotions({ enabled: true, repository });
  const first = response();
  const second = response();

  await handlers.current({ userKey: "alice", query: { category: "food" } }, first);
  await handlers.current({ userKey: "bob", query: { budget: "100000" } }, second);

  assert.deepStrictEqual(first.body, second.body);
  assert.deepStrictEqual(first.body, {
    promotion: {
      id: PROMOTION_ID,
      title: "Save on groceries",
      description: "A useful discount for MoneyMinder users.",
      ctaLabel: "View offer",
      url: "https://merchant.co.in/offers/student",
    },
  });
  assert.strictEqual(JSON.stringify(first.body).includes("merchant_name"), false);
  assert.strictEqual(JSON.stringify(first.body).includes("internal_notes"), false);
});

test("event handler sends only aggregate dimensions and a hashed idempotency key", async () => {
  let recorded;
  const repository = {
    async current() {
      return null;
    },
    async recordEvent(event) {
      recorded = event;
      return "recorded";
    },
  };
  const handlers = createPromotions({
    enabled: true,
    repository,
    clock: () => new Date("2026-07-27T23:59:59.000Z"),
  });
  const res = response();

  await handlers.event(request({ eventType: "click" }), res);

  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.ended, true);
  assert.deepStrictEqual(recorded, {
    promotionId: PROMOTION_ID,
    eventType: "click",
    eventKeyHash: crypto.createHash("sha256").update(EVENT_KEY).digest("hex"),
    metricDate: "2026-07-27",
    pruneBefore: "2026-07-25T23:59:59.000Z",
  });
  assert.strictEqual(JSON.stringify(recorded).includes("must-not-reach-storage"), false);
  assert.strictEqual(JSON.stringify(recorded).includes("203.0.113.8"), false);
});

test("event handler strictly validates the route, body, and idempotency key", async () => {
  let writes = 0;
  const handlers = createPromotions({
    enabled: true,
    repository: {
      async current() {
        return null;
      },
      async recordEvent() {
        writes++;
        return "recorded";
      },
    },
  });
  const invalidRequests = [
    request({ id: "not-a-uuid" }),
    request({ eventType: "view" }),
    request({ key: "" }),
    request({ key: "too-short" }),
    { ...request(), body: { eventType: "click", userId: "alice" } },
    { ...request(), body: null },
  ];

  for (const req of invalidRequests) {
    const res = response();
    await handlers.event(req, res);
    assert.strictEqual(res.statusCode, 400);
  }
  assert.strictEqual(writes, 0);
});

test("event handler maps absent campaigns and conflicting retries without leaking details", async () => {
  for (const [result, expectedStatus, expectedBody] of [
    ["not-found", 404, { error: "Promotion not found" }],
    ["conflict", 409, { error: "Idempotency-Key was already used for another promotion event" }],
  ]) {
    const handlers = createPromotions({
      enabled: true,
      repository: {
        current: async () => null,
        recordEvent: async () => result,
      },
    });
    const res = response();
    await handlers.event(request(), res);
    assert.strictEqual(res.statusCode, expectedStatus);
    assert.deepStrictEqual(res.body, expectedBody);
  }
});

test("enabled promotions fail startup without the complete repository contract", () => {
  assert.throws(
    () => createPromotions({ enabled: true }),
    /Enabled promotions require a repository/,
  );
  assert.throws(
    () => mount(
      { get() {}, post() {} },
      {
        enabled: true,
        pool: {
          async query() {},
          async connect() {},
        },
      },
    ),
    /Enabled promotions require a repository/,
  );
  assert.throws(
    () => createSqlitePromotionRepository({ prepare() {} }),
    /requires a node:sqlite database/,
  );
});

test("mount registers only the current-offer and aggregate-event routes", () => {
  const routes = [];
  const app = {
    get(path, limit, handler) {
      routes.push({ method: "GET", path, limit, handler });
    },
    post(path, limit, handler) {
      routes.push({ method: "POST", path, limit, handler });
    },
  };
  mount(app);
  assert.deepStrictEqual(
    routes.map(({ method, path }) => ({ method, path })),
    [
      { method: "GET", path: "/api/promotions/current" },
      { method: "POST", path: "/api/promotions/:id/events" },
    ],
  );
  for (const route of routes) {
    let passed = false;
    route.limit({}, {}, () => { passed = true; });
    assert.strictEqual(passed, true);
  }
});

function createSqliteFixture({
  now = "2026-07-27T18:00:00.000Z",
  campaigns = [{
    ...rawPromotion(),
    starts_at: "2026-07-27T00:00:00.000Z",
    ends_at: "2026-07-29T00:00:00.000Z",
    status: "active",
  }],
} = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE promotion_campaigns (
      id TEXT PRIMARY KEY,
      merchant_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      cta_label TEXT NOT NULL,
      destination_url TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE promotion_daily_metrics (
      campaign_id TEXT NOT NULL
        REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
      metric_date TEXT NOT NULL,
      impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
      clicks INTEGER NOT NULL DEFAULT 0
        CHECK (clicks >= 0 AND clicks <= impressions),
      PRIMARY KEY (campaign_id, metric_date)
    ) STRICT;
    CREATE TABLE promotion_event_dedup (
      event_key_hash TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL
        REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'click')),
      created_at TEXT NOT NULL
    ) STRICT;
  `);
  const insertCampaign = database.prepare(`
    INSERT INTO promotion_campaigns (
      id,
      merchant_name,
      title,
      description,
      cta_label,
      destination_url,
      starts_at,
      ends_at,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const campaign of campaigns) {
    insertCampaign.run(
      campaign.id,
      campaign.merchant_name,
      campaign.title,
      campaign.description,
      campaign.cta_label,
      campaign.destination_url,
      campaign.starts_at,
      campaign.ends_at,
      campaign.status,
    );
  }
  return {
    database,
    repository: createSqlitePromotionRepository(database, {
      clock: () => new Date(now),
    }),
  };
}

function repositoryEvent(overrides = {}) {
  return {
    promotionId: PROMOTION_ID,
    eventType: "impression",
    eventKeyHash: "a".repeat(64),
    metricDate: "2026-07-27",
    pruneBefore: "2026-07-25T18:00:00.000Z",
    ...overrides,
  };
}

test("SQLite repository selects the newest currently active campaign without targeting", async (t) => {
  const newestId = OTHER_PROMOTION_ID;
  const { database, repository } = createSqliteFixture({
    campaigns: [
      {
        ...rawPromotion(),
        starts_at: "2026-07-20T00:00:00.000Z",
        ends_at: "2026-08-01T00:00:00.000Z",
        status: "active",
      },
      {
        ...rawPromotion({ id: newestId, title: "Newest active offer" }),
        starts_at: "2026-07-27T12:00:00.000Z",
        ends_at: "2026-07-28T00:00:00.000Z",
        status: "active",
      },
      {
        ...rawPromotion({ id: "8bbad5fd-67dc-4de0-9798-d78e64d00537" }),
        starts_at: "2026-07-28T00:00:00.000Z",
        ends_at: "2026-07-30T00:00:00.000Z",
        status: "active",
      },
      {
        ...rawPromotion({ id: "dc1dba67-09e0-40c7-a2fe-a2873970bd95" }),
        starts_at: "2026-07-27T13:00:00.000Z",
        ends_at: "2026-07-28T00:00:00.000Z",
        status: "paused",
      },
    ],
  });
  t.after(() => database.close());

  assert.deepStrictEqual(await repository.current(), {
    id: newestId,
    title: "Newest active offer",
    description: "A useful discount for MoneyMinder users.",
    cta_label: "View offer",
    destination_url: "https://merchant.co.in/offers/student",
  });
});

test("SQLite repository records only aggregate UTC metrics and deduplicates retries", async (t) => {
  const { database, repository } = createSqliteFixture();
  t.after(() => database.close());
  const event = repositoryEvent();

  assert.strictEqual(await repository.recordEvent(event), "recorded");
  assert.strictEqual(await repository.recordEvent(event), "duplicate");
  assert.deepStrictEqual(
    { ...database.prepare(`
      SELECT campaign_id, metric_date, impressions, clicks
      FROM promotion_daily_metrics
    `).get() },
    {
      campaign_id: PROMOTION_ID,
      metric_date: "2026-07-27",
      impressions: 1,
      clicks: 0,
    },
  );
  assert.deepStrictEqual(
    { ...database.prepare(`
      SELECT event_key_hash, campaign_id, event_type
      FROM promotion_event_dedup
    `).get() },
    {
      event_key_hash: event.eventKeyHash,
      campaign_id: PROMOTION_ID,
      event_type: "impression",
    },
  );
});

test("SQLite click aggregation always preserves clicks less than or equal to impressions", async (t) => {
  const { database, repository } = createSqliteFixture();
  t.after(() => database.close());

  assert.strictEqual(await repository.recordEvent(repositoryEvent({
    eventType: "click",
    eventKeyHash: "b".repeat(64),
  })), "recorded");
  assert.strictEqual(await repository.recordEvent(repositoryEvent({
    eventType: "click",
    eventKeyHash: "c".repeat(64),
  })), "recorded");
  assert.deepStrictEqual(
    { ...database.prepare(`
      SELECT impressions, clicks
      FROM promotion_daily_metrics
      WHERE campaign_id = ? AND metric_date = ?
    `).get(PROMOTION_ID, "2026-07-27") },
    { impressions: 2, clicks: 2 },
  );
});

test("SQLite repository distinguishes missing campaigns and conflicting idempotency keys", async (t) => {
  const { database, repository } = createSqliteFixture();
  t.after(() => database.close());
  const event = repositoryEvent({ eventKeyHash: "d".repeat(64) });

  assert.strictEqual(await repository.recordEvent(event), "recorded");
  assert.strictEqual(await repository.recordEvent({
    ...event,
    eventType: "click",
  }), "conflict");
  assert.strictEqual(await repository.recordEvent(repositoryEvent({
    promotionId: OTHER_PROMOTION_ID,
    eventKeyHash: "e".repeat(64),
  })), "not-found");
  assert.deepStrictEqual(
    { ...database.prepare(`
      SELECT impressions, clicks
      FROM promotion_daily_metrics
      WHERE campaign_id = ? AND metric_date = ?
    `).get(PROMOTION_ID, "2026-07-27") },
    { impressions: 1, clicks: 0 },
  );
});

test("SQLite retries preserve duplicate and conflict results after a campaign is paused", async (t) => {
  const { database, repository } = createSqliteFixture();
  t.after(() => database.close());
  const event = repositoryEvent({ eventKeyHash: "8".repeat(64) });

  assert.strictEqual(await repository.recordEvent(event), "recorded");
  database.prepare(`
    UPDATE promotion_campaigns
    SET status = 'paused'
    WHERE id = ?
  `).run(PROMOTION_ID);
  assert.strictEqual(await repository.recordEvent(event), "duplicate");
  assert.strictEqual(await repository.recordEvent({
    ...event,
    eventType: "click",
  }), "conflict");
  assert.strictEqual(await repository.recordEvent(repositoryEvent({
    eventKeyHash: "7".repeat(64),
  })), "not-found");
});

test("SQLite repository prunes expired deduplication records before accepting a reused key", async (t) => {
  const { database, repository } = createSqliteFixture();
  t.after(() => database.close());
  const event = repositoryEvent({ eventKeyHash: "f".repeat(64) });
  database.prepare(`
    INSERT INTO promotion_event_dedup (
      event_key_hash,
      campaign_id,
      event_type,
      created_at
    )
    VALUES (?, ?, ?, ?)
  `).run(
    event.eventKeyHash,
    PROMOTION_ID,
    event.eventType,
    "2026-07-24T00:00:00.000Z",
  );

  assert.strictEqual(await repository.recordEvent(event), "recorded");
  assert.strictEqual(
    database.prepare(`
      SELECT created_at
      FROM promotion_event_dedup
      WHERE event_key_hash = ?
    `).get(event.eventKeyHash).created_at,
    "2026-07-27T18:00:00.000Z",
  );
});

test("SQLite repository rolls back the dedup key when aggregate persistence fails", async (t) => {
  const { database, repository } = createSqliteFixture();
  t.after(() => database.close());
  const event = repositoryEvent({ eventKeyHash: "9".repeat(64) });
  database.exec(`
    CREATE TRIGGER reject_promotion_metric
    BEFORE INSERT ON promotion_daily_metrics
    BEGIN
      SELECT RAISE(ABORT, 'simulated aggregate failure');
    END;
  `);

  await assert.rejects(
    repository.recordEvent(event),
    /simulated aggregate failure/,
  );
  assert.strictEqual(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM promotion_event_dedup
      WHERE event_key_hash = ?
    `).get(event.eventKeyHash).count,
    0,
  );
  database.exec("DROP TRIGGER reject_promotion_metric");
  assert.strictEqual(await repository.recordEvent(event), "recorded");
});

test("SQLite repository rejects malformed internal events without writing", async (t) => {
  const { database, repository } = createSqliteFixture();
  t.after(() => database.close());
  for (const event of [
    repositoryEvent({ promotionId: "not-a-uuid" }),
    repositoryEvent({ eventType: "view" }),
    repositoryEvent({ eventKeyHash: "not-a-sha256-hash" }),
    repositoryEvent({ metricDate: "27-07-2026" }),
    repositoryEvent({ pruneBefore: "not-an-instant" }),
  ]) {
    await assert.rejects(
      repository.recordEvent(event),
      /Invalid promotion repository event/,
    );
  }
  assert.strictEqual(
    database.prepare("SELECT COUNT(*) AS count FROM promotion_event_dedup").get().count,
    0,
  );
  assert.strictEqual(
    database.prepare("SELECT COUNT(*) AS count FROM promotion_daily_metrics").get().count,
    0,
  );
});
