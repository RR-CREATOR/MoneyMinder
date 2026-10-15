CREATE TABLE IF NOT EXISTS promotion_campaigns (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  merchant_name TEXT NOT NULL
    CHECK (
      merchant_name = trim(merchant_name)
      AND length(merchant_name) BETWEEN 1 AND 80
      AND merchant_name NOT GLOB '*[<>]*'
    ),
  title TEXT NOT NULL
    CHECK (
      title = trim(title)
      AND length(title) BETWEEN 1 AND 80
      AND title NOT GLOB '*[<>]*'
    ),
  description TEXT NOT NULL
    CHECK (
      description = trim(description)
      AND length(description) BETWEEN 1 AND 240
      AND description NOT GLOB '*[<>]*'
    ),
  cta_label TEXT NOT NULL
    CHECK (
      cta_label = trim(cta_label)
      AND length(cta_label) BETWEEN 1 AND 40
      AND cta_label NOT GLOB '*[<>]*'
    ),
  destination_url TEXT NOT NULL
    CHECK (
      destination_url = trim(destination_url)
      AND length(destination_url) BETWEEN 9 AND 2048
      AND destination_url LIKE 'https://%'
      AND destination_url NOT GLOB '*[ <>]*'
    ),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (ends_at > starts_at),
  CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS promotion_campaigns_active_window_idx
  ON promotion_campaigns (starts_at DESC, id, ends_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS promotion_daily_metrics (
  campaign_id TEXT NOT NULL
    REFERENCES promotion_campaigns (id) ON DELETE CASCADE,
  metric_date TEXT NOT NULL
    CHECK (length(metric_date) = 10 AND metric_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  CHECK (clicks <= impressions),
  PRIMARY KEY (campaign_id, metric_date)
) STRICT;

CREATE INDEX IF NOT EXISTS promotion_daily_metrics_date_idx
  ON promotion_daily_metrics (metric_date DESC);

CREATE TABLE IF NOT EXISTS promotion_event_dedup (
  event_key_hash TEXT PRIMARY KEY
    CHECK (length(event_key_hash) = 64 AND event_key_hash NOT GLOB '*[^0-9a-f]*'),
  campaign_id TEXT NOT NULL
    REFERENCES promotion_campaigns (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('impression', 'click')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS promotion_event_dedup_created_idx
  ON promotion_event_dedup (created_at);

CREATE INDEX IF NOT EXISTS promotion_event_dedup_campaign_idx
  ON promotion_event_dedup (campaign_id);
