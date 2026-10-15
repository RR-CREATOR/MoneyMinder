#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/compose.yaml}"
APP_ENV="${APP_ENV:-/etc/moneyminder/app.env}"
DEPLOY_ENV="${DEPLOY_ENV:-/etc/moneyminder/deploy.env}"
DATA_MOUNT="${DATA_MOUNT:-/srv/moneyminder}"
BACKUP_DIR="${BACKUP_DIR:-/srv/moneyminder/backups}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/etc/moneyminder/backup-passphrase}"
MODE="${1:-static}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

note() {
  printf 'OK: %s\n' "$*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

check_root_secret() {
  local file="$1"
  [[ -f "$file" ]] || fail "missing root-owned secret/config file: $file"
  local owner mode
  owner="$(stat -c '%U:%G' "$file")"
  mode="$(stat -c '%a' "$file")"
  [[ "$owner" == "root:root" ]] || fail "$file must be owned by root:root"
  [[ "$mode" == "600" || "$mode" == "400" ]] ||
    fail "$file must use mode 0600 or 0400, found $mode"
}

env_value() {
  local name="$1" file="$2"
  awk -F= -v key="$name" '
    $1 == key { sub(/^[^=]*=/, ""); value=$0; count++ }
    END { if (count != 1) exit 1; print value }
  ' "$file"
}

compose() {
  docker compose --env-file "$DEPLOY_ENV" --file "$COMPOSE_FILE" "$@"
}

static_checks() {
  local required
  need grep
  for required in \
    README.md compose.yaml Caddyfile.example app.env.example deploy.env.example \
    moneyminder-compose.service \
    backup.sh restore-drill.sh verify-oci-retention.sh check.sh; do
    [[ -s "$SCRIPT_DIR/$required" ]] || fail "missing or empty package file: $required"
  done

  [[ "$(grep -Ec '^  [a-z][a-z0-9_-]*:$' "$COMPOSE_FILE")" == "1" ]] ||
    fail "Compose must define exactly one service"
  grep -q '^  app:$' "$COMPOSE_FILE" ||
    fail "Compose must define the app service"
  ! grep -Eqi 'postgres|5432|DATABASE_URL' "$COMPOSE_FILE" ||
    fail "Compose must not contain an external database service"
  grep -q 'network_mode: host' "$COMPOSE_FILE" ||
    fail "the app must share host loopback with same-host Caddy"
  ! grep -q '127.0.0.1:3000:3000' "$COMPOSE_FILE" ||
    fail "port publishing would break the exact loopback trust boundary"
  grep -q '/srv/moneyminder/app-data:/var/lib/moneyminder' "$COMPOSE_FILE" ||
    fail "durable SQLite and upload mount is missing"
  grep -q 'SQLITE_FILE=/var/lib/moneyminder/moneyminder.sqlite3' \
    "$SCRIPT_DIR/app.env.example" ||
    fail "embedded SQLite path is missing"
  grep -q 'LISTEN_HOST=127.0.0.1' "$SCRIPT_DIR/app.env.example" ||
    fail "the production listener must bind only to IPv4 loopback"
  grep -q 'REGISTRATION_ENABLED=false' "$SCRIPT_DIR/app.env.example" ||
    fail "registration must default closed"
  grep -q 'PROMOTIONS_ENABLED=false' "$SCRIPT_DIR/app.env.example" ||
    fail "promotions must default closed"
  grep -q 'reverse_proxy 127.0.0.1:3000' "$SCRIPT_DIR/Caddyfile.example" ||
    fail "Caddy must proxy only to the private Node listener"
  grep -q 'RequiresMountsFor=/srv/moneyminder' "$SCRIPT_DIR/moneyminder-compose.service" ||
    fail "systemd must wait for the durable data mount"

  note "static OCI single-container package contract"
}

runtime_checks() {
  [[ "$EUID" -eq 0 ]] || fail "runtime checks must run as root"
  need curl
  need docker
  need findmnt
  need readlink
  need stat
  need awk
  need ss

  check_root_secret "$APP_ENV"
  check_root_secret "$DEPLOY_ENV"

  grep -q '<[^>]*>' "$APP_ENV" && fail "$APP_ENV still contains placeholders"
  grep -q '<[^>]*>' "$DEPLOY_ENV" && fail "$DEPLOY_ENV still contains placeholders"
  [[ "$(env_value NODE_ENV "$APP_ENV")" == "production" ]] ||
    fail "NODE_ENV must be production"
  [[ "$(env_value TRUST_PROXY "$APP_ENV")" == "loopback" ]] ||
    fail "TRUST_PROXY must be loopback behind same-host Caddy"
  [[ "$(env_value LISTEN_HOST "$APP_ENV")" == "127.0.0.1" ]] ||
    fail "LISTEN_HOST must be 127.0.0.1 behind same-host Caddy"
  [[ "$(env_value REGISTRATION_ENABLED "$APP_ENV")" == "false" ]] ||
    fail "REGISTRATION_ENABLED must be false"
  [[ "$(env_value PROMOTIONS_ENABLED "$APP_ENV")" == "false" ]] ||
    fail "PROMOTIONS_ENABLED must remain false for the controlled pilot"
  [[ "$(env_value DATA_DIR "$APP_ENV")" == "/var/lib/moneyminder" ]] ||
    fail "DATA_DIR must be the durable container mount"
  [[ "$(env_value SQLITE_FILE "$APP_ENV")" == "/var/lib/moneyminder/moneyminder.sqlite3" ]] ||
    fail "SQLITE_FILE must be inside DATA_DIR"
  ! grep -Eq '^(DATABASE_URL|DATABASE_POOL_MAX|PG_POOL_MAX)=' "$APP_ENV" ||
    fail "legacy external-database settings are prohibited"
  [[ "$(env_value APP_ORIGIN "$APP_ENV")" == https://* ]] ||
    fail "APP_ORIGIN must be HTTPS"

  findmnt --mountpoint "$DATA_MOUNT" >/dev/null ||
    fail "$DATA_MOUNT is not a dedicated mounted filesystem"
  data_dir="$DATA_MOUNT/app-data"
  data_real="$(readlink -f -- "$data_dir")"
  [[ -d "$data_real" && ! -L "$data_dir" && "$data_real" == "/srv/moneyminder/app-data" ]] ||
    fail "application data path must be the real controlled directory"
  compose config --quiet

  local configured_services running_app listeners database_file database_bytes
  configured_services="$(compose config --services)"
  [[ "$configured_services" == "app" ]] ||
    fail "exactly the app service may be configured"
  running_app="$(compose ps --status running --services | grep -c '^app$' || true)"
  [[ "$running_app" == "1" ]] || fail "exactly one app service must be running"
  listeners="$(ss -H -ltn 'sport = :3000' | awk '{ print $4 }')"
  [[ "$listeners" == "127.0.0.1:3000" ]] ||
    fail "application must listen only on 127.0.0.1:3000"

  curl --fail --silent --show-error http://127.0.0.1:3000/livez >/dev/null
  curl --fail --silent --show-error http://127.0.0.1:3000/readyz >/dev/null

  [[ "$(stat -c '%u:%g' "$data_real")" == "1000:1000" ]] ||
    fail "application data directory must be owned by 1000:1000"
  [[ "$(stat -c '%a' "$data_real")" == "700" ]] ||
    fail "application data directory must use mode 0700"
  database_file="$data_real/moneyminder.sqlite3"
  [[ -f "$database_file" && ! -L "$database_file" ]] ||
    fail "embedded SQLite database is missing or indirect"
  [[ "$(readlink -f -- "$database_file")" == "$database_file" ]] ||
    fail "embedded SQLite database path is indirect"
  database_bytes="$(stat -c '%s' "$database_file")"
  [[ "$database_bytes" =~ ^[1-9][0-9]*$ ]] ||
    fail "embedded SQLite database is empty"
  for sqlite_file in "$database_file" "$database_file-wal" "$database_file-shm"; do
    [[ ! -e "$sqlite_file" ]] && continue
    [[ -f "$sqlite_file" && ! -L "$sqlite_file" ]] ||
      fail "SQLite main/WAL/SHM paths must be regular files"
    [[ "$(stat -c '%u:%g' "$sqlite_file")" == "1000:1000" ]] ||
      fail "$sqlite_file must be owned by 1000:1000"
    [[ "$(stat -c '%a' "$sqlite_file")" == "600" ]] ||
      fail "$sqlite_file must use mode 0600"
  done

  note "root:root 0600 production configuration"
  note "one app replica, embedded SQLite, livez and readyz"
  note "SQLite database bytes: $database_bytes"
}

release_checks() {
  runtime_checks
  for command in sha256sum find sort head cut date basename dirname; do
    need "$command"
  done
  check_root_secret "$BACKUP_PASSPHRASE_FILE"
  local newest now modified age
  newest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'moneyminder-*.tar.gpg' \
    -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)"
  [[ -n "$newest" ]] || fail "no encrypted paired backup found in $BACKUP_DIR"
  [[ -f "$newest.sha256" ]] || fail "backup checksum sidecar missing: $newest.sha256"
  (
    cd -- "$(dirname -- "$newest")"
    sha256sum --check "$(basename -- "$newest.sha256")"
  )
  now="$(date +%s)"
  modified="$(stat -c '%Y' "$newest")"
  age=$((now - modified))
  (( age <= 93600 )) || fail "latest backup is older than 26 hours"
  "$SCRIPT_DIR/verify-oci-retention.sh"
  note "fresh encrypted paired backup: $newest"
}

case "$MODE" in
  static) static_checks ;;
  runtime) static_checks; runtime_checks ;;
  release) static_checks; release_checks ;;
  *) fail "usage: $0 [static|runtime|release]" ;;
esac
