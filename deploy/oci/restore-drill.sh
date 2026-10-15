#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/etc/moneyminder/backup-passphrase}"
RESTORE_IMAGE="${RESTORE_IMAGE:-}"
RESTORE_CONFIRM="${RESTORE_CONFIRM:-}"
RESTORE_MANUAL_REVIEW="${RESTORE_MANUAL_REVIEW:-0}"
DRILL_ROOT="${DRILL_ROOT:-/var/tmp/moneyminder-restore-drills}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

manifest_value() {
  local key="$1" file="$2"
  awk -F= -v key="$key" '
    $1 == key { sub(/^[^=]*=/, ""); value=$0; count++ }
    END { if (count != 1) exit 1; print value }
  ' "$file"
}

safe_tar_members() {
  local archive="$1" listing member type
  tar --list --file "$archive" >/dev/null
  while IFS= read -r listing; do
    type="${listing:0:1}"
    [[ "$type" == "-" || "$type" == "d" ]] ||
      fail "unsafe archive member type: $listing"
  done < <(LC_ALL=C tar --list --verbose --file "$archive")
  while IFS= read -r member; do
    case "$member" in
      /*|..|../*|*/../*|*/..) fail "unsafe archive member: $member" ;;
    esac
  done < <(tar --list --file "$archive")
}

valid_outer_checksum() {
  local file="$1" expected_name="$2"
  awk -v expected="$expected_name" '
    length($1) == 64 && $1 ~ /^[a-f0-9]+$/ && NF == 2 && $2 !~ /\// {
      if ($2 == expected) valid++
      next
    }
    { invalid=1 }
    END { exit !(valid == 1 && !invalid && NR == 1) }
  ' "$file"
}

valid_artifact_inventory() {
  local file="$1"
  awk '
    length($1) == 64 && $1 ~ /^[a-f0-9]+$/ && NF == 2 &&
      $2 ~ /^(database\.sqlite3|uploads\.tar|manifest\.txt)$/ {
      seen[$2]++
      next
    }
    { invalid=1 }
    END {
      exit !(NR == 3 && !invalid
        && seen["database.sqlite3"] == 1
        && seen["uploads.tar"] == 1
        && seen["manifest.txt"] == 1)
    }
  ' "$file"
}

[[ "$EUID" -eq 0 ]] || fail "run the restore drill as root"
[[ "$RESTORE_CONFIRM" == "isolated-drill" ]] ||
  fail "set RESTORE_CONFIRM=isolated-drill; this script never restores production"
[[ "$RESTORE_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] ||
  fail "RESTORE_IMAGE must be an immutable image digest"
[[ "$RESTORE_MANUAL_REVIEW" == "0" || "$RESTORE_MANUAL_REVIEW" == "1" ]] ||
  fail "RESTORE_MANUAL_REVIEW must be 0 or 1"
[[ $# -eq 1 ]] ||
  fail "usage: RESTORE_CONFIRM=isolated-drill RESTORE_IMAGE=<digest> $0 <backup.tar.gpg>"
for command in docker gpg sha256sum tar curl mktemp readlink stat awk find \
  wc mkdir rm chown chmod seq sleep sed basename dirname ss; do
  need "$command"
done
if [[ "$RESTORE_MANUAL_REVIEW" == "1" ]]; then
  need openssl
fi
[[ -z "$(ss -H -ltn 'sport = :13000')" ]] ||
  fail "restore HTTP port 13000 is already in use"
if [[ "$RESTORE_MANUAL_REVIEW" == "1" ]]; then
  [[ -z "$(ss -H -ltn 'sport = :13443')" ]] ||
    fail "restore TLS port 13443 is already in use"
fi

[[ ! -L "$1" ]] || fail "backup path must not be a symlink"
archive="$(readlink -f -- "$1")"
[[ -f "$archive" ]] || fail "backup not found: $1"
checksum="$archive.sha256"
[[ -f "$checksum" && ! -L "$checksum" ]] ||
  fail "checksum sidecar is missing or indirect: $checksum"
valid_outer_checksum "$checksum" "$(basename -- "$archive")" ||
  fail "checksum sidecar must name exactly this recovery archive"
[[ -f "$BACKUP_PASSPHRASE_FILE" ]] || fail "backup passphrase file is missing"
[[ "$(stat -c '%U:%G' "$BACKUP_PASSPHRASE_FILE")" == "root:root" ]] ||
  fail "backup passphrase must be owned by root:root"
passphrase_mode="$(stat -c '%a' "$BACKUP_PASSPHRASE_FILE")"
[[ "$passphrase_mode" == "600" || "$passphrase_mode" == "400" ]] ||
  fail "backup passphrase must use mode 0600 or 0400"
docker image inspect "$RESTORE_IMAGE" >/dev/null

mkdir -p -- "$DRILL_ROOT"
drill_root="$(readlink -f -- "$DRILL_ROOT")"
[[ "$drill_root" == "/var/tmp/moneyminder-restore-drills" ]] ||
  fail "refusing unexpected DRILL_ROOT: $drill_root"
work="$(mktemp -d "$drill_root/drill.XXXXXXXX")"
suffix="${BASHPID:-$$}"
app_name="moneyminder-restore-app-$suffix"
proxy_name="moneyminder-restore-proxy-$suffix"

cleanup() {
  local status=$?
  docker rm --force "$proxy_name" >/dev/null 2>&1 || true
  docker rm --force "$app_name" >/dev/null 2>&1 || true
  case "$work" in
    "$drill_root"/drill.*) rm -rf -- "$work" ;;
    *) printf 'ERROR: refusing unsafe drill cleanup: %s\n' "$work" >&2 ;;
  esac
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(
  cd -- "$(dirname -- "$archive")"
  sha256sum --check "$(basename -- "$checksum")"
)

gpg --batch --yes --pinentry-mode loopback \
  --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
  --decrypt --output "$work/recovery-set.tar" "$archive"
safe_tar_members "$work/recovery-set.tar"
mkdir -- "$work/package"
tar --extract --no-same-owner --no-same-permissions \
  --file "$work/recovery-set.tar" --directory "$work/package"
[[ "$(find "$work/package" -mindepth 1 -maxdepth 1 -type f | wc -l)" == "4" ]] ||
  fail "recovery package must contain exactly four regular files"
[[ -z "$(find "$work/package" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ]] ||
  fail "recovery package contains an unexpected entry"
valid_artifact_inventory "$work/package/artifacts.sha256" ||
  fail "recovery artifact inventory is invalid"
(
  cd -- "$work/package"
  sha256sum --check artifacts.sha256
)

manifest="$work/package/manifest.txt"
format_version="$(manifest_value format_version "$manifest")" ||
  fail "backup manifest must contain one format_version"
[[ "$format_version" == "2" ]] || fail "unsupported backup format: $format_version"
recorded_image="$(manifest_value application_image "$manifest")" ||
  fail "backup manifest must contain one application_image"
[[ "$recorded_image" =~ @sha256:[a-f0-9]{64}$ ]] ||
  fail "backup manifest contains an invalid application image"
[[ "${recorded_image##*@}" == "${RESTORE_IMAGE##*@}" ]] ||
  fail "RESTORE_IMAGE digest does not match the recovery manifest"
database_format="$(manifest_value database_format "$manifest")" ||
  fail "backup manifest must contain one database_format"
[[ "$database_format" == "sqlite3_maintenance_snapshot" ]] ||
  fail "backup database format is not supported"
sanitization_guard="$(manifest_value credentials_sanitized_on_restore "$manifest")" ||
  fail "backup manifest must contain the credential-sanitization guard"
[[ "$sanitization_guard" == "required" ]] ||
  fail "backup manifest does not require credential sanitization"
deletion_guard="$(manifest_value restore_requires_deletion_reconciliation "$manifest")" ||
  fail "backup manifest must contain the deletion-reconciliation guard"
[[ "$deletion_guard" == "true" ]] ||
  fail "backup manifest does not require deletion reconciliation"

[[ -f "$work/package/database.sqlite3" && ! -L "$work/package/database.sqlite3" ]] ||
  fail "recovery package database is not a regular file"
safe_tar_members "$work/package/uploads.tar"
mkdir -- "$work/restored-data" "$work/restored-data/uploads"
tar --extract --no-same-owner --no-same-permissions --file "$work/package/uploads.tar" \
  --directory "$work/restored-data/uploads"

app_uid="$(docker run --rm --network none --entrypoint /usr/bin/id "$RESTORE_IMAGE" -u)"
app_gid="$(docker run --rm --network none --entrypoint /usr/bin/id "$RESTORE_IMAGE" -g)"
[[ "$app_uid" =~ ^[0-9]+$ && "$app_gid" =~ ^[0-9]+$ ]] ||
  fail "could not determine application image UID/GID"
chown "$app_uid:$app_gid" "$work/package" "$work/package/database.sqlite3"
chmod 0500 "$work/package"
chmod 0400 "$work/package/database.sqlite3"
chown -R "$app_uid:$app_gid" "$work/restored-data"
chmod 0700 "$work/restored-data"

docker run --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 64 \
  --memory 256m \
  --cpus 0.50 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --user "$app_uid:$app_gid" \
  --volume "$work/package:/restore-input:ro" \
  --volume "$work/restored-data:/restore-output:rw" \
  --entrypoint node \
  "$RESTORE_IMAGE" \
  server/sqlite-maintenance.js \
  restore \
  /restore-input/database.sqlite3 \
  /restore-output/moneyminder.sqlite3

[[ -f "$work/restored-data/moneyminder.sqlite3" \
  && ! -L "$work/restored-data/moneyminder.sqlite3" ]] ||
  fail "credential-sanitized SQLite restore was not created"
chmod 0600 "$work/restored-data/moneyminder.sqlite3"
printf 'Restored credentials were sanitized: sessions and tokens cleared; every active user authVersion rotated.\n'

session_secret="$(docker run --rm \
  --network none \
  --read-only \
  --entrypoint node \
  "$RESTORE_IMAGE" \
  -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"

docker run --detach \
  --name "$app_name" \
  --network host \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 256 \
  --memory 1g \
  --cpus 1.0 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  --env NODE_ENV=production \
  --env PORT=13000 \
  --env LISTEN_HOST=127.0.0.1 \
  --env APP_ORIGIN=https://restore.invalid:13443 \
  --env SESSION_SECRET="$session_secret" \
  --env DATA_DIR=/var/lib/moneyminder \
  --env SQLITE_FILE=/var/lib/moneyminder/moneyminder.sqlite3 \
  --env TRUST_PROXY=loopback \
  --env REGISTRATION_ENABLED=false \
  --env PROMOTIONS_ENABLED=false \
  --env DATA_MAX_BYTES=26214400 \
  --env UPLOAD_TOTAL_MAX_BYTES=4294967296 \
  --env UPLOAD_TOTAL_MAX_FILES=10000 \
  --volume "$work/restored-data:/var/lib/moneyminder:rw" \
  "$RESTORE_IMAGE" >/dev/null

app_ready=0
for _ in $(seq 1 45); do
  if curl --fail --silent --show-error http://127.0.0.1:13000/readyz >/dev/null 2>&1; then
    app_ready=1
    break
  fi
  sleep 2
done
[[ "$app_ready" == "1" ]] || {
  docker logs "$app_name" >&2
  fail "isolated application did not become ready"
}
app_running="$(docker inspect --format '{{.State.Running}}' "$app_name" 2>/dev/null || true)"
[[ "$app_running" == "true" ]] || {
  docker logs "$app_name" >&2
  fail "isolated application exited after a conflicting or failed startup"
}
app_listeners="$(ss -H -ltn 'sport = :13000' | awk '{ print $4 }')"
[[ "$app_listeners" == "127.0.0.1:13000" ]] ||
  fail "restore application must listen only on 127.0.0.1:13000"
curl --fail --silent --show-error http://127.0.0.1:13000/livez >/dev/null

if [[ "$RESTORE_MANUAL_REVIEW" == "1" ]]; then
  openssl req \
    -x509 \
    -newkey rsa:2048 \
    -sha256 \
    -nodes \
    -days 1 \
    -subj "/CN=restore.invalid" \
    -addext "subjectAltName=DNS:restore.invalid" \
    -keyout "$work/review-key.pem" \
    -out "$work/review-cert.pem" >/dev/null 2>&1
  chown "$app_uid:$app_gid" "$work/review-key.pem" "$work/review-cert.pem"
  chmod 0400 "$work/review-key.pem" "$work/review-cert.pem"

  review_proxy_code='
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const tls = Object.freeze({
  key: fs.readFileSync("/review-key.pem"),
  cert: fs.readFileSync("/review-cert.pem"),
});

const server = https.createServer(tls, (request, response) => {
  const headers = Object.freeze({
    ...request.headers,
    host: "restore.invalid:13443",
    connection: "close",
    "x-forwarded-for": "127.0.0.1",
    "x-forwarded-host": "restore.invalid:13443",
    "x-forwarded-proto": "https",
  });
  const upstream = http.request({
    host: "127.0.0.1",
    port: 13000,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("restore proxy failure");
  });
  request.pipe(upstream);
});

server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
server.listen(13443, "127.0.0.1");
'

  docker run --detach \
    --name "$proxy_name" \
    --network host \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory 128m \
    --cpus 0.25 \
    --volume "$work/review-key.pem:/review-key.pem:ro" \
    --volume "$work/review-cert.pem:/review-cert.pem:ro" \
    --entrypoint node \
    "$RESTORE_IMAGE" \
    --input-type=module \
    --eval "$review_proxy_code" >/dev/null

  proxy_ready=0
  for _ in $(seq 1 30); do
    if curl \
      --fail \
      --silent \
      --show-error \
      --resolve "restore.invalid:13443:127.0.0.1" \
      --cacert "$work/review-cert.pem" \
      https://restore.invalid:13443/readyz >/dev/null 2>&1; then
      proxy_ready=1
      break
    fi
    sleep 1
  done
  [[ "$proxy_ready" == "1" ]] || {
    docker logs "$proxy_name" >&2
    fail "loopback TLS review proxy did not become ready"
  }
  proxy_listeners="$(ss -H -ltn 'sport = :13443' | awk '{ print $4 }')"
  [[ "$proxy_listeners" == "127.0.0.1:13443" ]] ||
    fail "restore TLS proxy must listen only on 127.0.0.1:13443"

  review_spki="$(
    openssl x509 -in "$work/review-cert.pem" -pubkey -noout |
      openssl pkey -pubin -outform der |
      openssl dgst -sha256 -binary |
      openssl base64 -A
  )"
  [[ -n "$review_spki" ]] || fail "could not calculate the review certificate SPKI"

  printf 'Manual review mode is available only through loopback TLS.\n'
  printf 'From a separate workstation terminal, keep this tunnel open:\n'
  printf '  ssh -N -L 13443:127.0.0.1:13443 <ssh-user>@<instance-address>\n'
  printf 'Launch an empty temporary Chromium profile and visit no other site in it:\n'
  printf '  chromium --user-data-dir=/path/to/new-empty-profile --host-resolver-rules="MAP restore.invalid 127.0.0.1" --ignore-certificate-errors-spki-list=%s https://restore.invalid:13443\n' "$review_spki"
  printf 'Verify login, a known receipt image, household balances, scan/save/delete, and pending deletion retry.\n'
  printf 'Record evidence outside this recovery set; all drill changes are discarded.\n'
  printf 'Press Enter after evidence is recorded to destroy the isolated drill: '
  IFS= read -r _
fi

printf 'Automated isolated restore checks passed.\n'
printf 'Recovery manifest:\n'
sed 's/^/  /' "$work/package/manifest.txt"
printf 'MANDATORY: complete deletion reconciliation before any restored data can replace production.\n'
if [[ "$RESTORE_MANUAL_REVIEW" == "0" ]]; then
  printf 'This automated run does not claim manual product-flow evidence; rerun with RESTORE_MANUAL_REVIEW=1 when that evidence is due.\n'
fi
