# OCI Always Free controlled-pilot package

This package is MoneyMinder's smallest defensible zero-cost backend topology:
one OCI Ampere A1 VM, one durable block volume, one MoneyMinder container with
embedded SQLite, and host-level Caddy HTTPS. It is limited to a supervised pilot
of at most **30 active accounts**.

This is not an HA topology and carries **no SLA**. Oracle states that idle
Always Free compute may be reclaimed and that A1 capacity can be unavailable in
a home region. Do not manufacture traffic to evade reclamation. Keep verified
off-instance backups, a rebuild runbook, and an approved paid escape route.

Official references:

- [OCI Always Free limits and reclamation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [OCI Object Storage](https://docs.oracle.com/en-us/iaas/Content/Object/Concepts/objectstorageoverview.htm)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [SQLite backup API](https://www.sqlite.org/backup.html)

The backend can remain within OCI's free resource allowance. An owned domain
and Google Play/Chrome developer-account fees remain external costs.

## Fixed topology

```text
Internet
  -> OCI public IPv4 :80/:443
  -> Caddy on the host
  -> 127.0.0.1:3000 MoneyMinder (one container)
       -> /var/lib/moneyminder/moneyminder.sqlite3
       -> /var/lib/moneyminder/uploads

/srv/moneyminder on the attached block volume
  /app-data -> container /var/lib/moneyminder
  /backups  -> encrypted recovery artifacts before off-instance upload
```

The SQLite main file, WAL, SHM, and uploads all remain under the durable
`/srv/moneyminder/app-data` mount. Do not add a second app replica: SQLite
writes, receipt quota scans, OCR, retry workers, recurring work, and process
rate limits are intentionally single-process responsibilities.

## OCI resources

Create these resources in the tenancy's intentionally selected home region:

1. One `VM.Standard.A1.Flex` Ubuntu ARM64 VM with 2 OCPU and 12 GB RAM.
2. A 50 GB boot volume.
3. A 100 GB attached block volume mounted by filesystem UUID at
   `/srv/moneyminder`; retain the remaining free-tier block allowance as
   recovery headroom.
4. One stable public IP and public DNS A record for an operator-controlled
   domain.
5. A network security group allowing 80/443 publicly. Use OCI Bastion, or allow
   port 22 only from the operator's fixed address. Never allow public port 3000.
6. One dedicated private, versioning-disabled Object Storage bucket. Give the
   instance principal only the object read/write and bucket/lifecycle inspect
   permissions required by these scripts. Configure an enabled, unfiltered
   `DELETE`-objects lifecycle rule at 30 days or less.
7. OCI Monitoring/Notifications alarms for VM availability, disk capacity,
   TLS expiry, application readiness, and backup failure/age.

The home region affects capacity, latency, and data residency. Record the
region and Oracle as a processor in the hosted privacy material.

## Host preparation

Install Docker Engine with Compose, Caddy, GnuPG, the OCI CLI, and normal Ubuntu
security updates from controlled repositories. Mount the data volume before
starting Docker.

Install this reviewed package at the fixed path used by the system service:

```bash
sudo install -d -o root -g root -m 0755 /opt/moneyminder/deploy/oci
sudo install -o root -g root -m 0644 \
  compose.yaml Caddyfile.example app.env.example deploy.env.example README.md moneyminder-compose.service \
  /opt/moneyminder/deploy/oci/
sudo install -o root -g root -m 0755 \
  check.sh backup.sh restore-drill.sh verify-oci-retention.sh \
  /opt/moneyminder/deploy/oci/
sudo install -o root -g root -m 0644 \
  moneyminder-compose.service \
  /etc/systemd/system/moneyminder-compose.service
```

Create the exact directories:

```bash
sudo install -d -o root -g root -m 0750 /etc/moneyminder
sudo install -d -o root -g root -m 0750 /srv/moneyminder
sudo install -d -o 1000 -g 1000 -m 0700 /srv/moneyminder/app-data
sudo install -d -o root -g root -m 0700 /srv/moneyminder/backups
```

UID/GID 1000 is the `node` account in the reviewed image. Reconfirm it before
each image-family change:

```bash
docker run --rm --network none --entrypoint /usr/bin/id <IMMUTABLE_IMAGE> -u
docker run --rm --network none --entrypoint /usr/bin/id <IMMUTABLE_IMAGE> -g
```

Verify `/srv/moneyminder` is a separate mount after every reboot:

```bash
findmnt --mountpoint /srv/moneyminder
```

## Secrets and configuration

Generate values without placing them directly in shell history:

```bash
sudo sh -c 'umask 077; gpg --gen-random 2 48 | base64 -w0 > /etc/moneyminder/backup-passphrase'
```

Copy `app.env.example` to `/etc/moneyminder/app.env` and
`deploy.env.example` to `/etc/moneyminder/deploy.env`. Replace every
placeholder. Generate `SESSION_SECRET` with at least 32 random bytes. Then
enforce:

```bash
sudo chown root:root \
  /etc/moneyminder/app.env \
  /etc/moneyminder/deploy.env \
  /etc/moneyminder/backup-passphrase
sudo chmod 0600 \
  /etc/moneyminder/app.env \
  /etc/moneyminder/deploy.env \
  /etc/moneyminder/backup-passphrase
```

The production storage contract is:

```text
LISTEN_HOST=127.0.0.1
DATA_DIR=/var/lib/moneyminder
SQLITE_FILE=/var/lib/moneyminder/moneyminder.sqlite3
```

Do not set legacy `DATABASE_URL`, `DATABASE_POOL_MAX`, `PG_POOL_MAX`, or
`DATA_FILE`. `LISTEN_HOST=127.0.0.1` and `TRUST_PROXY=loopback` are mandatory
for same-host Caddy. The explicit bind keeps the raw HTTP listener off public
interfaces; numeric proxy hop counts are rejected because they can trust
forged forwarding headers.

Keep `REGISTRATION_ENABLED=false`. Open enrollment only for a recorded,
bounded window and close it immediately afterward. Keep
`PROMOTIONS_ENABLED=false` unless the merchant destination, retention,
privacy/Data safety/Play Ads answers, security, and accessibility gates have
all been completed for the exact public flow.

Replace `app.example.invalid` in `Caddyfile.example`, install it as
`/etc/caddy/Caddyfile`, and validate before reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy owns public HTTPS. The app shares the host network namespace but is
required to bind only `127.0.0.1:3000`; the OCI network security group and host
firewall must also deny public port 3000 as defense in depth.

## ARM64 release gate

The OCI A1 host is ARM64. An AMD64 CI build is insufficient. After pinning the
reviewed patched Node release, build and execute an ARM64 image:

```bash
docker buildx build --platform linux/arm64 --load --tag moneyminder:arm64-smoke .
docker image inspect moneyminder:arm64-smoke
```

Run the production-container readiness, maintenance CLI, and graceful-stop
smokes against that image. Publish the reviewed image to the
operator-controlled registry and put its immutable `@sha256:<digest>`
reference in `deploy.env`. Never deploy `latest`.

## Start and verify

Pre-pull the reviewed image so the system service never needs registry
credentials:

```bash
cd /opt/moneyminder/deploy/oci
sudo bash ./check.sh static
sudo docker compose \
  --env-file /etc/moneyminder/deploy.env \
  --file ./compose.yaml \
  config --quiet
image_ref="$(sudo awk -F= '$1 == "MONEYMINDER_IMAGE" { sub(/^[^=]*=/, ""); print }' /etc/moneyminder/deploy.env)"
sudo docker pull "$image_ref"
sudo systemctl daemon-reload
sudo systemctl enable --now moneyminder-compose.service
sudo bash ./check.sh runtime
```

The single container binds only to host loopback and uses a read-only root
filesystem, a bounded temporary filesystem, dropped Linux capabilities,
`no-new-privileges`, CPU/memory/PID limits, graceful shutdown, and bounded JSON
log rotation. Its startup wrapper applies umask `0077`, directory mode `0700`,
and mode `0600` to an existing SQLite main/WAL/SHM set before Node starts.
`pull_policy: never` ensures a missing local digest fails closed.

Use `systemctl reload moneyminder-compose.service` after changing only a
reviewed image digest or Compose configuration. Use
`journalctl -u moneyminder-compose.service` plus `docker compose logs app` for
bounded diagnostics. Never log or paste the environment files.

## Capacity and monitoring

Hard/pilot envelope:

| Boundary | Limit |
| --- | ---: |
| Active pilot accounts | 30 |
| App replicas | 1 |
| Serialized application state | 25 MiB |
| Receipt files globally | 10,000 |
| Receipt bytes globally | 4 GiB |
| One account | 200 files / 100 MiB |
| OCR admission | 1/account/minute and 2/process/minute |

Thirty fully utilized accounts produce at most 6,000 files/3,000 MiB, below
the global upload limits. This is a policy envelope, not load-test evidence.
SQLite serialization and the bounded OCR worker can bind earlier.

Alert at:

- SQLite/app state approaching the configured 25 MiB limit;
- uploads at 3 GiB or 7,500 files warning, 3.6 GiB or 9,000 files critical;
- attached volume at 70% warning and 85% critical, including inode use;
- `/readyz`, container restart, TLS expiry, or backup age over 26 hours; and
- repeated `DB_BUSY`, `OCR_BUSY`, 429, 507, or 5xx responses.

OCI's free synthetic-monitor allowance can check the public `/healthz`
endpoint. `/livez` is process-only; `/readyz` and `/healthz` verify SQLite and
the durable data directory.

## Consistent encrypted backup

SQLite and uploads form one recovery set. `backup.sh` takes a lock and briefly
stops the app so database and receipt files cannot diverge. It then invokes the
exact immutable application image:

```text
node server/sqlite-maintenance.js backup \
  /source/moneyminder.sqlite3 /snapshot/database.sqlite3
```

That command uses SQLite's backup mechanism and integrity checks to create a
new snapshot. The script never copies the live main/WAL/SHM files as a backup.
It separately archives only `uploads/`, restarts and health-checks the app,
writes a manifest and SHA-256 inventory, encrypts the whole recovery set with
GnuPG AES-256, and optionally uploads the ciphertext plus checksum to OCI.

The retention contract is mandatory because recovery sets contain financial
records and receipt images:

- local encrypted recovery points have a maximum age of 30 days;
- the private OCI bucket must have versioning `Disabled` and an enabled,
  unfiltered `DELETE`-objects lifecycle at 30 days or less; and
- a weekly off-tenancy encrypted copy must also expire within 30 days.

Configure the OCI lifecycle policy in an administrator-controlled workflow.
The repository only verifies it. The policy rule should be equivalent to:

```json
{
  "action": "DELETE",
  "isEnabled": true,
  "name": "expire-moneyminder-recovery-points",
  "target": "objects",
  "timeAmount": 30,
  "timeUnit": "DAYS"
}
```

Verify the private/versioning/expiry contract:

```bash
sudo \
  OCI_NAMESPACE=<OCI_OBJECT_STORAGE_NAMESPACE> \
  OCI_BUCKET_NAME=<PRIVATE_BACKUP_BUCKET> \
  bash ./verify-oci-retention.sh
```

Create and upload a recovery point with the instance principal:

```bash
sudo \
  RELEASE_COMMIT=<40_HEX_RELEASE_COMMIT> \
  UPLOAD_TO_OCI=1 \
  OCI_NAMESPACE=<OCI_OBJECT_STORAGE_NAMESPACE> \
  OCI_BUCKET_NAME=<PRIVATE_BACKUP_BUCKET> \
  bash ./backup.sh
```

After the new recovery point is encrypted, checksummed, the app is healthy,
and any selected remote uploads succeed, the script prunes matching local
artifacts at the 30-day boundary. It refuses to prune before that success
point or outside `/srv/moneyminder/backups`.

Do not leave the only copy on `/srv/moneyminder`. Keep the Object Storage
repository below a 16 GiB high-water mark inside the free allowance. The
weekly off-tenancy copy is a launch and every-release gate: record evidence
that the newest copy is no more than seven days old and its destination
deletes it within 30 days.

## Loopback-only restore drill

`restore-drill.sh` never writes production directories. It requires
`RESTORE_CONFIRM=isolated-drill`, an immutable image digest matching the
manifest, a root-owned passphrase, and one ciphertext/checksum pair. It:

1. verifies the outer checksum and decrypts into a guarded temporary directory;
2. rejects links, devices, path traversal, extra package entries, and malformed
   checksum inventories;
3. verifies every internal artifact and manifest guard;
4. restores uploads only into a temporary data directory;
5. invokes `node server/sqlite-maintenance.js restore` to create a new database;
6. starts the app only after the restored database has passed integrity/schema
   checks and credential sanitization; and
7. destroys the containers and temporary files on normal and trapped exits.

`SIGKILL` or a host crash can bypass shell cleanup and leave root-only plaintext
staging under `/var/tmp`. Monitor for stale `moneyminder-restore.*` directories,
remove them only after confirming no drill is active, and keep `/var/tmp` on an
encrypted volume.

The maintenance restore clears sessions and tokens and rotates every active
user's `authVersion` in one transaction before the new database is published.
The unsanitized snapshot is read-only and is never served. A fresh
`SESSION_SECRET` adds a second session-invalidating boundary.

Run the automated drill monthly:

```bash
sudo \
  RESTORE_CONFIRM=isolated-drill \
  RESTORE_IMAGE=registry.example/moneyminder@sha256:<64_HEX_DIGEST> \
  bash ./restore-drill.sh /srv/moneyminder/backups/moneyminder-<UTC>.tar.gpg
```

The temporary app uses a loopback-only host network boundary: the script first
requires port 13000 to be unused, then sets `LISTEN_HOST=127.0.0.1` and serves
only on `127.0.0.1:13000` without Docker port publishing. Automated checks
require `/livez` and `/readyz`; no recovered credentials are reusable.

For manual product-flow evidence, rerun with `RESTORE_MANUAL_REVIEW=1`. This
also requires loopback port 13443 to be unused, then adds a one-day self-signed
certificate and loopback TLS proxy bound exactly to `127.0.0.1:13443`:

```bash
sudo \
  RESTORE_CONFIRM=isolated-drill \
  RESTORE_MANUAL_REVIEW=1 \
  RESTORE_IMAGE=registry.example/moneyminder@sha256:<64_HEX_DIGEST> \
  bash ./restore-drill.sh /srv/moneyminder/backups/moneyminder-<UTC>.tar.gpg
```

The script prints an SSH loopback tunnel and a certificate-SPKI-scoped Chromium
command. Use a new empty temporary Chromium profile, visit no other site in
that profile, and delete it after the drill. Verify password login, a known
receipt image, household balances, scan/save/delete, and pending deletion
retry. Store evidence outside the recovery set.

Any restore can resurrect information deleted after the recovery point.
Maintain a deletion register outside the recovery set. Deletion reconciliation
is mandatory before restored data can replace production; credentials being
sanitized does not remove that requirement.

## Release and recovery decisions

- Before launch and every deploy: create the encrypted paired recovery point,
  run `check.sh release` with `OCI_NAMESPACE` and `OCI_BUCKET_NAME`, attach
  current off-tenancy/30-day-expiry evidence, and record the image digest.
- Application-only failure: restart the previous immutable image only when the
  SQLite schema remains backward compatible.
- Data/schema failure: stop public traffic and run the isolated restore drill
  before choosing any recovery point.
- VM reclamation: recreate the host, reattach the retained data volume when
  available, or restore the encrypted off-instance backup. Capacity delay
  makes recovery time best effort.
- Volume loss: rebuild the empty controlled directories, restore only from a
  verified encrypted artifact, reconcile deletions, and issue fresh operator
  secrets.
- Never describe this strict-zero topology as HA, SLA-backed, or suitable for
  an uncontrolled public cohort.
