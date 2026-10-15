"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const requiredFiles = [
  "deploy/oci/.gitattributes",
  "deploy/oci/README.md",
  "deploy/oci/compose.yaml",
  "deploy/oci/Caddyfile.example",
  "deploy/oci/app.env.example",
  "deploy/oci/deploy.env.example",
  "deploy/oci/moneyminder-compose.service",
  "deploy/oci/verify-oci-retention.sh",
  "deploy/oci/backup.sh",
  "deploy/oci/restore-drill.sh",
  "deploy/oci/check.sh",
];

test("OCI pilot package contains the complete operator surface", () => {
  for (const file of requiredFiles) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), file);
  }
  assert.match(read("deploy/oci/.gitattributes"), /^\*\.sh text eol=lf$/m);
});

test("OCI image source includes the SQLite maintenance CLI used by recovery scripts", () => {
  const maintenanceFile = path.join(root, "server", "sqlite-maintenance.js");

  assert.ok(fs.statSync(maintenanceFile).isFile(), "server/sqlite-maintenance.js");
  const maintenance = fs.readFileSync(maintenanceFile, "utf8");
  assert.match(maintenance, /backup/);
  assert.match(maintenance, /restore/);
  assert.match(read("Dockerfile"), /COPY server \.\/server/);
});

test("OCI system service validates configuration and owns stack lifecycle", () => {
  const service = read("deploy/oci/moneyminder-compose.service");

  assert.match(service, /RequiresMountsFor=\/srv\/moneyminder/);
  assert.match(service, /After=.*docker\.service/);
  assert.match(service, /EnvironmentFile=\/etc\/moneyminder\/deploy\.env/);
  assert.match(service, /ExecStartPre=.*docker compose.*config --quiet/);
  assert.match(service, /ExecStart=.*docker compose.*up --detach --remove-orphans/);
  assert.match(service, /ExecStop=.*docker compose.*stop --timeout 30/);
  assert.match(service, /RemainAfterExit=yes/);
  assert.match(service, /UMask=0077/);
});

test("OCI compose topology runs one bounded app replica with embedded SQLite", () => {
  const compose = read("deploy/oci/compose.yaml");

  assert.strictEqual((compose.match(/^  [a-z][a-z0-9_-]*:\s*$/gm) || []).length, 1);
  assert.match(compose, /^  app:\s*$/m);
  assert.strictEqual((compose.match(/pull_policy:\s*never/g) || []).length, 1);
  assert.match(compose, /network_mode:\s*host/);
  assert.doesNotMatch(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /\/srv\/moneyminder\/app-data:\/var\/lib\/moneyminder/);
  assert.match(compose, /set -eu/);
  assert.match(compose, /umask 077/);
  assert.match(compose, /chmod 0700 \/var\/lib\/moneyminder/);
  assert.match(compose, /chmod 0600 "\$\$\{file\}"/);
  assert.match(compose, /\/readyz/);
  assert.match(compose, /restart:\s*unless-stopped/g);
  assert.match(compose, /mem_limit:/);
  assert.match(compose, /cpus:/);
  assert.match(compose, /pids_limit:/);
  assert.match(compose, /max-size:\s*"10m"/);
  assert.match(compose, /max-file:\s*"5"/);
  assert.doesNotMatch(compose, /replicas:\s*[2-9]/);
  assert.doesNotMatch(compose, /postgres|5432|DATABASE_URL/i);
  assert.doesNotMatch(compose, /(?:^|\s)(?:0\.0\.0\.0:)?3000:/m);
});

test("OCI environment template fails closed for a 30-account pilot", () => {
  const env = read("deploy/oci/app.env.example");

  for (const line of [
    "NODE_ENV=production",
    "LISTEN_HOST=127.0.0.1",
    "APP_ORIGIN=https://<CONTROLLED_APP_HOST>",
    "SESSION_SECRET=<AT_LEAST_32_RANDOM_BYTES>",
    "DATA_DIR=/var/lib/moneyminder",
    "SQLITE_FILE=/var/lib/moneyminder/moneyminder.sqlite3",
    "TRUST_PROXY=loopback",
    "REGISTRATION_ENABLED=false",
    "DATA_MAX_BYTES=26214400",
    "UPLOAD_TOTAL_MAX_BYTES=4294967296",
    "UPLOAD_TOTAL_MAX_FILES=10000",
  ]) {
    assert.ok(env.includes(line), line);
  }

  assert.match(env, /30 active accounts/i);
  assert.doesNotMatch(env, /DATABASE_URL|DATABASE_POOL_MAX|PG_POOL_MAX/);
  assert.doesNotMatch(env, /SESSION_SECRET=(?:[A-Za-z0-9+/]{32,}|[a-f0-9]{32,})$/m);
});

test("OCI backup creates a consistent SQLite snapshot plus uploads in one encrypted recovery artifact", () => {
  const backup = read("deploy/oci/backup.sh");

  assert.match(backup, /set -Eeuo pipefail/);
  assert.match(backup, /docker compose[\s\S]*stop[\s\S]*app/);
  assert.match(backup, /findmnt --mountpoint \/srv\/moneyminder/);
  assert.match(backup, /root_secret "\$DEPLOY_ENV"/);
  assert.match(
    backup,
    /node[\s\S]*server\/sqlite-maintenance\.js[\s\S]*backup[\s\S]*moneyminder\.sqlite3[\s\S]*database\.sqlite3/,
  );
  assert.ok(
    backup.lastIndexOf("recheck_sqlite_source_after_stop") > backup.indexOf("app did not stop"),
    "SQLite source must be revalidated after the app has fully stopped",
  );
  assert.match(backup, /sqlite_source_identity=.*stat -c '%d:%i'/);
  assert.match(backup, /current_identity.*sqlite_source_identity/);
  assert.match(backup, /--network none/);
  assert.match(backup, /"\$data_real:\/source:ro"/);
  assert.match(backup, /"\$snapshot_dir:\/snapshot:rw"/);
  assert.match(backup, /uploads\.tar/);
  assert.match(backup, /unsafe upload tree member/);
  assert.match(backup, /safe_tar_members "\$stage\/uploads\.tar"/);
  assert.match(backup, /upload archive contains unsafe filesystem entries/);
  assert.match(backup, /find "\$uploads_source" -xdev/);
  assert.match(backup, /manifest\.txt/);
  assert.match(backup, /format_version=2/);
  assert.match(backup, /credentials_sanitized_on_restore=required/);
  assert.match(backup, /sha256sum/);
  assert.match(backup, /sha256\.partial/);
  assert.match(backup, /gpg[\s\S]*--symmetric[\s\S]*AES256/);
  assert.match(backup, /UPLOAD_TO_OCI/);
  assert.match(backup, /oci --auth instance_principal os object put/);
  assert.match(backup, /--no-overwrite/);
  assert.match(backup, /--verify-checksum/);
  assert.doesNotMatch(backup, /--if-none-match/);
  assert.match(backup, /restore_requires_deletion_reconciliation=true/);
  assert.doesNotMatch(backup, /pg_dump|pg_dump_custom|data-dir\.tar/i);
  assert.doesNotMatch(backup, /(?:cp|install|tar)[^\n]*(?:moneyminder\.sqlite3|sqlite-(?:wal|shm))/i);
});

test("OCI recovery copies have a checked 30-day maximum retention", () => {
  const backup = read("deploy/oci/backup.sh");
  const checks = read("deploy/oci/check.sh");
  const retention = read("deploy/oci/verify-oci-retention.sh");
  const guide = read("deploy/oci/README.md");

  assert.match(backup, /LOCAL_RETENTION_MINUTES=43200/);
  assert.match(backup, /-mmin "\+\$\(\(LOCAL_RETENTION_MINUTES - 1\)\)"/);
  assert.match(backup, /moneyminder-\[0-9\]\{8\}T\[0-9\]\{6\}Z\\\.tar\\\.gpg/);
  assert.ok(
    backup.lastIndexOf("prune_expired_local_recovery_points")
      > backup.lastIndexOf("oci --auth instance_principal os object put"),
    "pruning must happen only after the new local/selected remote recovery point succeeds",
  );
  assert.match(backup, /verify-oci-retention\.sh/);
  assert.match(checks, /verify-oci-retention\.sh/);
  assert.match(retention, /public-access-type/);
  assert.match(retention, /NoPublicAccess/);
  assert.match(retention, /versioning/);
  assert.match(retention, /Disabled/);
  assert.match(retention, /object-lifecycle-policy get/);
  assert.match(retention, /time-amount/);
  assert.match(retention, /<= 30/);
  assert.match(retention, /time-unit/);
  assert.match(retention, /DAYS/);
  assert.match(guide, /local encrypted recovery points.*30 days/is);
  assert.match(guide, /weekly off-tenancy.*30 days/is);
  assert.match(guide, /launch and every-release gate/is);
  assert.doesNotMatch(guide, /five application-consistent OCI volume backups/i);
  assert.match(guide, /deletion reconciliation/is);
});

test("OCI restore drill sanitizes credentials before serving in an isolated container", () => {
  const restore = read("deploy/oci/restore-drill.sh");
  const guide = read("deploy/oci/README.md");

  assert.match(restore, /set -Eeuo pipefail/);
  assert.match(restore, /RESTORE_CONFIRM/);
  assert.match(restore, /isolated-drill/);
  assert.match(restore, /gpg[\s\S]*--decrypt/);
  assert.match(restore, /sha256sum --check/);
  assert.match(restore, /tar --list --verbose/);
  assert.match(restore, /unsafe archive member type/);
  assert.match(restore, /valid_outer_checksum/);
  assert.match(restore, /valid_artifact_inventory/);
  assert.match(restore, /exactly four regular files/);
  assert.match(restore, /application_image/);
  assert.match(restore, /RESTORE_IMAGE digest does not match/);
  assert.match(restore, /mode 0600 or 0400/);
  assert.match(restore, /ss -H -ltn/);
  assert.match(restore, /restore HTTP port 13000 is already in use/);
  assert.match(
    restore,
    /node[\s\S]*server\/sqlite-maintenance\.js[\s\S]*restore[\s\S]*database\.sqlite3[\s\S]*moneyminder\.sqlite3/,
  );
  assert.match(restore, /--network none/);
  assert.match(restore, /credentials_sanitized_on_restore/);
  assert.match(restore, /"\$work\/package:\/restore-input:ro"/);
  assert.match(restore, /"\$work\/restored-data:\/restore-output:rw"/);
  assert.match(restore, /--no-same-permissions/);
  assert.match(restore, /restored credentials were sanitized/i);
  const sanitizeAt = restore.indexOf("server/sqlite-maintenance.js");
  const serveAt = restore.indexOf("docker run --detach", sanitizeAt);
  assert.ok(sanitizeAt >= 0 && serveAt > sanitizeAt, "sanitized database must exist before the app can serve");
  assert.match(restore, /PORT=13000/);
  assert.match(restore, /LISTEN_HOST=127\.0\.0\.1/);
  assert.match(restore, /restore application must listen only on 127\.0\.0\.1:13000/);
  assert.match(restore, /REGISTRATION_ENABLED=false/);
  assert.match(restore, /TRUST_PROXY=loopback/);
  assert.match(restore, /SQLITE_FILE=\/var\/lib\/moneyminder\/moneyminder\.sqlite3/);
  assert.match(restore, /\/readyz/);
  assert.match(restore, /docker inspect --format '\{\{\.State\.Running\}\}' "\$app_name"/);
  assert.match(restore, /RESTORE_MANUAL_REVIEW/);
  assert.match(restore, /https:\/\/restore\.invalid:13443/);
  assert.match(restore, /restore TLS proxy must listen only on 127\.0\.0\.1:13443/);
  assert.match(restore, /ignore-certificate-errors-spki-list/);
  const proxySource = restore.match(/review_proxy_code='([\s\S]*?)'\n\n  docker run/);
  assert.ok(proxySource, "embedded TLS proxy source must be extractable");
  const proxySyntax = spawnSync(
    process.execPath,
    ["--input-type=module", "--check"],
    { input: proxySource[1], encoding: "utf8" },
  );
  assert.strictEqual(proxySyntax.status, 0, proxySyntax.stderr);
  assert.match(restore, /deletion reconciliation/i);
  assert.match(restore, /--network host/);
  assert.doesNotMatch(restore, /--publish/);
  assert.doesNotMatch(restore, /127\.0\.0\.1:15432:5432/);
  assert.doesNotMatch(restore, /postgres|5432|DATABASE_URL/i);
  assert.doesNotMatch(restore, /\/srv\/moneyminder\/app-data/);
  assert.match(guide, /loopback-only host network/i);
  assert.match(guide, /clear(?:s|ed)? sessions and tokens/i);
  assert.match(guide, /rotat(?:e|es|ed|ing)[\s\S]*authVersion/i);
  assert.match(guide, /RESTORE_MANUAL_REVIEW=1/);
  assert.match(guide, /loopback TLS/i);
  assert.match(guide, /temporary Chromium profile/i);
});

test("OCI checks and documentation expose the remaining pilot caveats", () => {
  const checks = read("deploy/oci/check.sh");
  const caddy = read("deploy/oci/Caddyfile.example");
  const guide = read("deploy/oci/README.md");

  assert.match(checks, /root:root/);
  assert.match(checks, /0600/);
  assert.match(checks, /docker compose[\s\S]*config/);
  assert.match(checks, /sha256sum --check/);
  assert.match(checks, /127\.0\.0\.1:3000/);
  assert.match(checks, /LISTEN_HOST/);
  assert.match(checks, /PROMOTIONS_ENABLED/);
  assert.match(checks, /ss -H -ltn/);
  assert.match(checks, /1000:1000/);
  assert.match(checks, /mode 0700/);
  assert.match(checks, /mode 0600/);
  assert.match(checks, /\/livez/);
  assert.match(checks, /\/readyz/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:3000/);
  assert.match(guide, /docker buildx build --platform linux\/arm64/);
  assert.match(guide, /README\.md moneyminder-compose\.service/);
  assert.match(guide, /docker pull "\$image_ref"/);
  assert.match(guide, /30 active accounts/i);
  assert.match(guide, /reclaim/i);
  assert.match(guide, /no SLA/i);
  assert.match(guide, /deletion reconciliation/i);
  assert.match(guide, /https:\/\/docs\.oracle\.com\/en-us\/iaas\/Content\/FreeTier\/freetier_topic-Always_Free_Resources\.htm/);
});

test("canonical documentation links the OCI pilot without overstating production", () => {
  const index = read("docs/README.md");
  const readiness = read("docs/PRODUCTION-READINESS.md");
  const runbook = read("docs/release/DEPLOYMENT-AND-DISTRIBUTION.md");
  const privacy = read("public/privacy.html");

  assert.match(index, /\.\.\/deploy\/oci\/README\.md/);
  assert.match(runbook, /\.\.\/\.\.\/deploy\/oci\/README\.md/);
  assert.match(runbook, /30 active accounts/i);
  assert.match(runbook, /reclamation/i);
  assert.match(runbook, /no SLA/i);
  assert.match(runbook, /TRUST_PROXY=loopback/);
  assert.match(runbook, /docker buildx build --platform linux\/arm64/);
  assert.match(readiness, /SQLite/i);
  assert.match(privacy, /manual(?:ly)? reconcile.*external deletion register/i);
  assert.match(privacy, /does not automate.*replay/i);
});
