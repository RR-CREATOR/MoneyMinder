# Merchant promotions — TDD and verification record

Date: 2026-07-27

## Scope

MoneyMinder can later fund free user access through merchant-sponsored campaigns.
The feature is disabled by default and has no campaign administration API.

Verified user journeys:

1. An authenticated web user receives either one active campaign or `null`.
2. A valid offer is visibly labelled `Sponsored`, can be dismissed, and never blocks the dashboard.
3. An impression is counted once the card is at least 50% visible.
4. A trusted link click reports best-effort aggregate telemetry without delaying navigation.
5. Unsafe, malformed, local, IP-literal, reserved-domain, credential-bearing, or nonstandard-port destinations are not displayed.
6. Extension bearer tokens cannot read or report promotions.
7. Disabled campaigns expose no UI and store no events.

## RED → GREEN evidence

| Change | RED evidence | GREEN evidence |
|---|---|---|
| Configuration gate | `promotionsEnabled` was absent | `server/config.test.js` |
| SQLite schema | `002_promotions.sql must exist` | `server/migrations.test.js` |
| Backend | `Cannot find module './promotions'` | `server/promotions.test.js`, `server/app.test.js` |
| UI visibility threshold | Test required `intersectionRatio >= 0.5` | `public/ui.test.js` |
| Navigation-safe telemetry and destination hardening | Focused UI/backend test failed | `public/ui.test.js`, `server/promotions.test.js` |
| Database userinfo constraint | Migration assertion failed | `server/migrations.test.js` |
| Per-user telemetry limit | Eleventh event returned the wrong status | `server/app.test.js` |

## Final automated evidence

Command:

```powershell
npm run verify
```

The release gate must finish with zero failures/skips and at least 80% line,
function, and branch coverage.

Additional checks:

```powershell
npm audit --omit=dev --audit-level=low
git diff --check
npm run test:sqlite
```

Record the exact outputs against the release commit. The SQLite
restart/session integration requires no external database or Docker daemon.

## Required embedded-database gate

Before deployment, run the disposable embedded-database gate:

```powershell
npm run test:sqlite
```

The test creates its own temporary SQLite file. Passing proves migrations,
constraints, transaction locking, HTTP restart persistence, and durable browser
sessions against the same database engine used in production.

## Deliberate limits

- Deduplication receipts older than 48 hours are removed opportunistically by later events; strict retention requires an operator cleanup job.
- Aggregate metric retention has no automatic expiry.
- Metrics are approximate and must not be used for billing; merchant-confirmed redemption or conversion is the billing source of truth.
- The current singleton application-state row is suitable only for the documented
  single-instance controlled pilot. Normalize the financial state and move
  uploads/rate limits/jobs to shared services before unrestricted enrollment or
  replicas.
