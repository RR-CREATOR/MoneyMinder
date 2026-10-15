# Production readiness

Current status: release-candidate source for the confirmed controlled-pilot
topology: one containerized Node service behind HTTPS, at most 30 active pilot
accounts, and one durable `DATA_DIR` containing the embedded SQLite database and
receipt images. There is no database service, database account, or database
bill. External launch still needs an always-reachable host, real operator/legal
values, monitoring ownership, a restore rehearsal, Android signing, and final
hosted-device validation.

## Automated release gate

Use the repository-pinned Node.js 24.x runtime with npm 10.9.8:

```text
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=low
npm run verify
```

`npm run verify` parses JSON manifests, syntax-checks JavaScript, runs the Node
test suite, and enforces at least 80% line, function, and branch coverage.
CI additionally runs the SQLite restart/concurrency integration gate, a pinned
OSV lockfile scan that fails on known
vulnerabilities across npm and Android dependencies, a compile-only Chrome
package build with exact allowlist/origin/digest verification, the
production-container readiness, closed-enrollment, and graceful-stop smoke test,
and Android API 36 release-URL validation, release
lint/minification/compilation with a disposable CI keystore, JDK 17, and strict
Gradle dependency checksums. The same gates run every Monday so a quiet branch
still detects newly disclosed dependency vulnerabilities. The compile-only
Chrome ZIP is never a store artifact; rebuild it with the controlled production
origin before submission.

The production enrollment probe verifies the fail-closed pilot contract:
`/register.html` is `404`, `POST /api/register` is `403`, the login page states
that access is limited to invited pilot participants, and its registration CTA
is hidden. Run it against the final deployment before giving store reviewers
credentials:

```text
node scripts/verify-production-enrollment.mjs <INTERNAL-BASE-URL> <PUBLIC-APP-ORIGIN>
```

For an Android dependency or plugin update, regenerate
`android/gradle/verification-metadata.xml` with Gradle's
`--write-verification-metadata=sha256` mode on a trusted clean machine, review
the checksum diff, and rerun CI in strict mode. The Gradle distribution checksum
remains pinned separately in `gradle-wrapper.properties`.

Node.js has announced a HIGH-severity security release for 2026-07-27. The
repository deliberately blocks release while 24.18.0 remains the newest
published 24.x build. Deployment stays blocked until the Dockerfile, CI, and
package engine are moved to the published patched Node.js 24.x release and the
complete gate passes again. The Dockerfile also pins the multi-architecture OCI
index digest. Scheduled CI compares that digest with Docker Hub;
when the tag moves, review the base-image change, repin the digest, and rerun all
gates. Apply the same process for every Node security release or Debian base
security rebuild.

`npm run test:sqlite` creates a disposable database, exercises the real HTTP
service, restarts it, and verifies that both app data and browser sessions
survive. It needs no Docker daemon or external database.

## Required production configuration

Production values belong in the host secret/configuration service, not Git.

- `NODE_ENV=production`
- `APP_ORIGIN`: exact public HTTPS origin, no path.
- `SESSION_SECRET`: at least 32 bytes.
- `DATA_DIR`: absolute durable mounted directory for SQLite and receipt uploads.
- `SQLITE_FILE`: optional absolute path inside `DATA_DIR`; defaults to
  `DATA_DIR/moneyminder.sqlite3`.
- `LISTEN_HOST=127.0.0.1`: the only accepted bind address.
- `TRUST_PROXY=loopback`: required behind the same-host TLS reverse proxy. This
  Node process does not terminate TLS; production rejects `0`, numeric hop
  counts, and broader trust modes to prevent insecure cookies and
  forwarding-header spoofing.
- `DATA_MAX_BYTES`: positive integer state ceiling; default is 25 MiB.
- `UPLOAD_TOTAL_MAX_BYTES`: global receipt-upload byte ceiling; default is 4 GiB.
- `UPLOAD_TOTAL_MAX_FILES`: global receipt-upload file ceiling; default is 10,000.
- `APP_TIME_ZONE`: budget/recurring calendar zone; defaults to `Asia/Kolkata`.
- `REGISTRATION_ENABLED`: production registration defaults to `false`; set `true`
  only for a controlled enrollment window.
- `PROMOTIONS_ENABLED`: strict `true`/`false` switch; defaults to `false`.
  Enabling is prohibited until the sponsored-offer release gate below is complete.
- `EXTENSION_ORIGIN`: exact `chrome-extension://` origin for the release extension,
  or omit to disable extension CORS.

Production startup rejects non-HTTPS `APP_ORIGIN`, relative/non-durable storage,
weak `SESSION_SECRET`, a public bind address, unsafe proxy trust, invalid numeric
values, and invalid origins. Legacy PostgreSQL/JSON-store variables are rejected.

## Datastore and migration model

- Every environment uses Node's built-in SQLite driver.
- SQLite, durable browser sessions, and receipt images all live under `DATA_DIR`.
- Startup runs idempotent migrations from `server/migrations/` before listening.
- App state remains one bounded JSON document with serialized writes and a
  version check. Campaigns and aggregate campaign metrics use relational tables.
- WAL, full synchronization, foreign keys, a bounded write queue, and atomic
  migrations protect the supported single-process deployment.
- A one-time startup import moves a legacy `DATA_DIR/db.json` into an otherwise
  empty database without deleting the source or its backup.
- This is deliberately single-instance. Do not run replicas against the same
  file or claim high availability.

Manual migration check:

```text
npm run migrate
```

The production backup/restore workflow is in `deploy/oci/`. The low-level
commands accept only absolute, non-existing destination paths:

```text
node server/sqlite-maintenance.js backup <LIVE.sqlite3> <NEW-BACKUP.sqlite3>
node server/sqlite-maintenance.js restore <BACKUP.sqlite3> <NEW-RESTORED.sqlite3>
```

Restore output is credential-sanitized: sessions and bearer tokens are removed
and active account authentication versions are rotated before integrity and
schema checks pass.

## Disabled sponsored-offer capability

The source contains a dashboard merchant-offer capability, but that is not proof
that ads are deployed. `PROMOTIONS_ENABLED` is false by default and the
canonical OCI template keeps it false. When the API supplies no valid offer or
fails, the dashboard leaves the optional card hidden and the rest of the
dashboard continues independently. The authenticated routes are browser-session
only; Chrome bearer tokens are denied. Current-offer reads are limited to 120
requests/minute/IP. Telemetry writes are limited to 30/minute/IP and
10/minute/authenticated user; the coarse 600/minute/IP API ceiling also applies.

The product boundary is non-personalized:

- the same eligible offer is served without receipt, budget, balance,
  household, UPI, browsing, account, or device targeting;
- visible offers carry the exact label **Sponsored**, are dismissible, and link
  only to a bounded credential-free, default-port HTTPS destination on a
  public DNS-style hostname; runtime validation rejects IP literals,
  localhost/private-style names, and special-use suffixes;
- no third-party advertising SDK, tracking pixel, remote script, or ad network
  is used;
- only aggregate impression and click totals may be retained or reported; no
  user-, household-, device-, receipt-, or transaction-level promotion report
  is permitted; and
- the Chrome extension neither fetches nor displays promotions and its website
  content and browsing data cannot be used for offer selection.

The backend stores scheduled, bounded campaign copy separately from the core
financial state. An impression is attempted only after at least 50% of the
card is visible and a click only from a trusted link click. The event request
contains campaign ID, event type, and a fresh random idempotency key. SQLite
stores a SHA-256 hash of that key with campaign/type/timestamp and increments
per-campaign UTC daily counts; it does not store the authenticated user or IP.

The event-key rows currently become eligible for deletion after 48 hours only
when a later event triggers pruning. An idle or final campaign can therefore
retain its last rows longer. Daily aggregate counters also have no implemented
expiry. These are open retention gates: implement and test guaranteed cleanup,
or document and approve a different finite production retention schedule,
before enabling promotions. Do not describe the current code as a guaranteed
48-hour TTL.

Before changing `PROMOTIONS_ENABLED` to `true`, all of the following are hard
release gates:

1. Verify the merchant's identity and control of the destination. Approve the
   copy, schedule, and exact public HTTPS URL; manually test redirects,
   credentials, network destination, port, and age/content fit. There is no
   user-supplied campaign write or campaign-admin HTTP API, so use a controlled,
   reviewed database change procedure.
2. Reconcile the hosted privacy notice, Google Play listing, Data safety form,
   content rating, review notes, and Ads declaration. Set the Console answer
   needed to display the **Contains ads** label before server-side activation.
3. Re-run security, accessibility, failure-path, event-deduplication, and
   physical Android tests against the exact hosted deployment. Prove dismissal,
   exact labelling, safe navigation, and that a failed offer request cannot
   block core functionality.
4. Confirm that reporting is aggregate-only, contains no financial or Chrome
   browsing fields, and cannot be joined to users, households, receipts, or
   devices.
5. Implement and verify the approved deletion mechanism/retention period for
   event-key receipts and daily aggregates.

Impression/click delivery is best-effort. Do not use the aggregate totals for
billing or claim they prove redemption/conversion; require merchant confirmation
through a separate approved process.

Google treats ads and associated offers as app content and requires current,
accurate disclosures. Review the official
[Ads policy](https://support.google.com/googleplay/android-developer/answer/9857753),
[app-review and Contains ads guidance](https://support.google.com/googleplay/android-developer/answer/9859455),
and [behavior-transparency requirements](https://support.google.com/googleplay/android-developer/answer/13323374)
at every activation or material offer-flow change.

## Container

```text
docker build -t moneyminder:local .
docker run --init --rm --network host --stop-timeout 30 --memory 1g --cpus 1 \
  -e NODE_ENV=production \
  -e APP_ORIGIN='https://moneyminder.example.com' \
  -e LISTEN_HOST=127.0.0.1 \
  -e TRUST_PROXY=loopback \
  -e SESSION_SECRET='replace-with-32-byte-secret' \
  -v moneyminder-data:/var/lib/moneyminder \
  moneyminder:local
```

The Linux image runs as the non-root `node` user. `/livez` reports process liveness;
`/readyz` and `/healthz` check datastore connectivity. Keep the published port
on loopback and terminate public HTTPS at the same-host reverse proxy. The
canonical `deploy/oci/compose.yaml` encodes this host-network contract. Allocate
at least 1 vCPU and 1 GiB RAM, and set the proxy request timeout to at least 75
seconds so bounded OCR requests can finish before the proxy disconnects.

## Safeguards present

- Durable SQLite sessions replace MemoryStore.
- Production startup validates critical environment values before listening.
- CSRF origin checks compare against configured `APP_ORIGIN`.
- Authenticated API and receipt image responses are `Cache-Control: no-store`.
- Passwords are bcrypt-hashed and reject weak/oversized inputs.
- Bearer tokens are SHA-256 digests in storage, capped per user, route-scoped to
  extension reads/creates, and revoked on logout/account deletion.
- Receipt upload type is verified from image bytes. Any image saved for review,
  including a no-text OCR result, becomes an orphan candidate after 24 hours
  unless it is attached to a receipt; an hourly worker and later uploads sweep
  those candidates.
- Production registration is closed unless an operator explicitly opens it.
- Receipt records and upload storage are capped per account; global upload byte
  and file quotas bound the durable volume across all accounts.
- Account deletion removes personal receipts/uploads and securely checkpoints
  the SQLite store so deleted values are not retained in WAL pages.
- Shared household records retain their ledger meaning under a non-login
  deleted-member identifier after account deletion.
- UPI settlement stays pending until the recipient confirms receipt.
- Android release builds reject missing keystore and placeholder/non-HTTPS backend
  URLs.

## External launch gates

- Select a controlled production domain; `moneyminder.app` belongs to an
  unrelated product. Confirm the public product name and immutable Android
  application ID before creating store records.
- Configure real `APP_ORIGIN`, durable `DATA_DIR`, HTTPS proxy, secrets,
  monitoring, backup schedule, and rollback owner.
- Rehearse the encrypted SQLite-plus-uploads restore using a production-like copy.
- Supply real operator/legal identity, address, support and grievance contacts,
  hosting location, processors, retention schedule, privacy notice, and incident
  runbook.
- Remove sample accounts, bearer tokens, runtime receipt images, `.env` values,
  and raw exports from every shared copy.
- Pass one browser and Android picker-to-receipt journey against the final hosted
  environment.
- Build Android release with the real `MONEYMINDER_SERVER_URL` and upload keystore.
- Run `scripts/verify-release-artifact.mjs` on the exact Chrome ZIP and Android
  AAB. Record both SHA-256 values; require the known upload-certificate SHA-256
  plus strict `jarsigner` and `keytool` checks for the AAB. Verify the pinned
  bundletool SHA-256 before execution, run `bundletool validate`, and prove the
  compiled `string/server_url` equals the intended production origin. CI's
  disposable-key AAB is compile-only and must never be uploaded.
- Keep the automated release gate green on the exact release commit.
- Keep `PROMOTIONS_ENABLED=false` unless the sponsored-offer gate above has
  current evidence and Google Play's Ads declaration has been reconciled for
  the deployed behavior.

## Release data rule

No buyer, partner, reviewer, CI artifact, or release archive receives `.env`,
`data/`, `node_modules/`, local agent configuration, local design iterations,
Android signing material, or raw pilot exports.
