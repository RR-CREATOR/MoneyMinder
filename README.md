# MoneyMinder

A phone-first budgeting web app for tracking personal spending and splitting shared
costs with roommates. Scan a receipt, watch it land in the right category, see where
your money goes against a monthly budget, and settle up with the people you live with.

Built with a Node/Express backend, a vanilla HTML/CSS/JS frontend, and embedded
SQLite for application state and browser sessions. No separate database service,
OCR service, frontend build step, client-side framework, or third-party auth
service is required.

Current release status: **release-candidate source, not externally launched**. Do not
enroll an external or live cohort until the host, legal, monitoring, restore,
Android signing, and final device-validation gates in
[production readiness](docs/PRODUCTION-READINESS.md) are complete.

> MoneyMinder is designed for narrow screens. View it in a mobile viewport: use your
> browser's device toolbar (responsive mode) or open it on a phone.

## Features

- **Accounts**: register and log in with bcrypt-hashed passwords and signed session
  cookies.
- **Receipt scanning**: upload a receipt photo; the server reads it with local
  Tesseract.js OCR and extracts the merchant, total, and date. Manual entry works too.
- **Budget dashboard**: spending broken down by category against a monthly budget.
- **Receipts**: a running list of receipts with a detail view for each one.
- **Households**: create or join a household by code, log shared expenses, split
  them across members, see simplified balances, and settle up.
- **Data controls**: export your data or delete your account; shared ledger entries
  are anonymized so deletion does not corrupt roommates' balances.
- **Partner page**: open `/pilot.html` for the residence-pilot proposition.

## Documentation

- [Complete documentation index](docs/README.md)
- [Product guide](docs/product/PRODUCT-GUIDE.md) and
  [how it works](docs/product/HOW-IT-WORKS.md)
- [Architecture](docs/engineering/ARCHITECTURE.md),
  [codebase guide](docs/engineering/CODEBASE-GUIDE.md), and
  [API reference](docs/engineering/API-REFERENCE.md)
- [Google Play](docs/release/GOOGLE-PLAY-UPLOAD.md) and
  [Chrome Web Store](docs/release/CHROME-WEB-STORE-UPLOAD.md) upload guides
- [Deployment and distribution](docs/release/DEPLOYMENT-AND-DISTRIBUTION.md)
- [Pitch](docs/PITCH.md), [innovation thesis](docs/INNOVATION.md), and
  [pilot proposal](docs/PILOT-PROPOSAL.md)
- [Production readiness](docs/PRODUCTION-READINESS.md)

## Project structure

```text
server/
  app.js             Entry point: security headers, rate limiting, routing, startup
  auth.js            Registration/login (bcrypt + express-session)
  db.js              Embedded SQLite datastore
  migrations/        Ordered SQLite schema migrations
  sqlite-maintenance.js  Verified backup/restore operations
  api.js             Receipts, budget summary, and image serving
  households.js      Household split, settle-up, and balance math
  ocr.js             Local receipt OCR (tesseract.js) + field parsers
public/
  login.html  register.html  index.html  scan.html
  receipts.html  receipt.html  household.html  profile.html
  css/app.css        Design system and page styles
  js/api.js          Fetch helpers for the JSON API
  js/nav.js          Bottom navigation
  images/            Public product screenshot
data/                Local runtime store (gitignored): SQLite DB and uploads
```

## Getting started

Requires Node.js 24.18.0 provisionally and npm 10.9.8. The release workflow
currently blocks publication on Node 24.18.0 after the 2026-07-27 security
advisory; repin the Docker image, package engine, and CI to the published patched
Node 24.x release before producing a release artifact.

1. Install locked dependencies:

   ```text
   npm ci --ignore-scripts
   ```

2. Create your environment file and fill it in:

   ```text
   cp .env.example .env
   ```

   `SESSION_SECRET` is required in production and must be at least 32 bytes.

   ```text
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Production hosts must also configure `NODE_ENV=production`, `APP_ORIGIN`,
   `LISTEN_HOST=127.0.0.1`, `TRUST_PROXY=loopback`, an absolute durable
   `DATA_DIR`, an absolute `SQLITE_FILE` inside that directory, and
   `APP_TIME_ZONE`. Review the `DATA_MAX_BYTES`, `UPLOAD_TOTAL_MAX_BYTES`, and
   `UPLOAD_TOTAL_MAX_FILES` ceilings and, when enabling the browser extension,
   set the exact `EXTENSION_ORIGIN`. Registration is closed by default in
   production; set `REGISTRATION_ENABLED=true` only during controlled
   enrollment. Merchant offers are also disabled by default; keep
   `PROMOTIONS_ENABLED=false` unless every merchant, retention, privacy, and Play
   disclosure gate in `docs/PRODUCTION-READINESS.md` is complete.

3. Start the server:

   ```text
   npm start
   ```

   The app runs at http://localhost:3000.

   The SQLite database and schema are created automatically under `DATA_DIR`.
   Receipt OCR runs in the same server process using the bundled,
   checksum-verified English model; neither feature needs a separate VM, API
   account, or managed service.

## Scripts

- `npm start`: run the server.
- `npm run migrate`: create or migrate the configured SQLite database without
  starting HTTP.
- `npm test`: run the unit tests.
- `npm run test:sqlite`: verify real SQLite restart persistence for production
  state, browser sessions, and receipt metadata. SQLite write serialization is
  covered by `server/sqlite-store.test.js` and the full `npm run verify` gate.
- `npm run test:coverage`: run tests and enforce 80% line, function, and branch
  coverage.
- `npm run check:json`: parse package and application manifests.
- `npm run check:syntax`: syntax-check repository JavaScript with Node.
- `npm run verify`: run manifest, syntax, test, and coverage gates.

## Production container

The private npm package is development metadata, not a release artifact. Deploy
the reproducible container below; do not publish or deploy an `npm pack` tarball.

Build and run one container on a Linux host behind a same-host HTTPS reverse
proxy. The host still needs always-on compute, a controlled HTTPS domain, and a
durable disk, but it does not need a separate database or OCR machine:

```text
docker build -t moneyminder:local .
docker run --init --rm --stop-timeout 30 --network host \
  -e NODE_ENV=production \
  -e APP_ORIGIN='https://moneyminder.example.com' \
  -e LISTEN_HOST=127.0.0.1 \
  -e TRUST_PROXY=loopback \
  -e SESSION_SECRET='replace-with-32-byte-secret' \
  -e DATA_DIR=/var/lib/moneyminder \
  -e SQLITE_FILE=/var/lib/moneyminder/moneyminder.sqlite3 \
  -v moneyminder-data:/var/lib/moneyminder \
  moneyminder:local
```

Startup runs idempotent migrations before listening. `/livez` reports process
liveness; `/readyz` and `/healthz` check SQLite and the durable data directory.
Use the reviewed [OCI pilot runbook](deploy/oci/README.md) for the complete
HTTPS, permissions, monitoring, encrypted-backup, and isolated-restore
procedure.

The checked-in zero-cost topology is deliberately capped at **30 active
accounts**, one application process, 25 MiB of serialized application state,
10,000 receipt files, and 4 GiB of receipt images. This is a controlled-pilot
policy envelope, not evidence of a tested 10,000-user service. SQLite, the
single OCR worker, process-local rate limits, and one upload volume all require
an architecture change before replicas or unrestricted enrollment.

## Security

- Passwords are bcrypt-hashed; plaintext is never stored.
- Production sessions are stored in SQLite and cookies are httpOnly,
  sameSite=lax, and secure by default.
- Every `/api/*` route except registration, login, and logout requires an
  authenticated session or extension bearer token; account updates, exports, and
  deletion additionally require a browser session.
- Server configuration secrets live only in `.env` or the host secret store and
  are never served as client assets.
- Production registration defaults closed. Uploads have per-account limits plus
  configurable global byte/file ceilings and are served only from the owner's folder.
- SQLite writes are transactional and corrupt/unreadable state fails closed.
  Consistent recovery uses `server/sqlite-maintenance.js` through the checked-in
  deployment backup/restore scripts; never copy a live SQLite main/WAL/SHM set
  as a backup.
- Security headers are set on every response, with rate limiting on auth, API,
  household join, and scan endpoints.
