#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/compose.yaml}"
DEPLOY_ENV="${DEPLOY_ENV:-/etc/moneyminder/deploy.env}"
DATA_HOST_DIR="${DATA_HOST_DIR:-/srv/moneyminder/app-data}"
BACKUP_OUTPUT_DIR="${BACKUP_OUTPUT_DIR:-/srv/moneyminder/backups}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/etc/moneyminder/backup-passphrase}"
UPLOAD_TO_OCI="${UPLOAD_TO_OCI:-0}"
OCI_NAMESPACE="${OCI_NAMESPACE:-}"
OCI_BUCKET_NAME="${OCI_BUCKET_NAME:-}"
RELEASE_COMMIT="${RELEASE_COMMIT:-unknown}"
LOCAL_RETENTION_MINUTES=43200

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

compose() {
  docker compose --env-file "$DEPLOY_ENV" --file "$COMPOSE_FILE" "$@"
}

root_secret() {
  local file="$1" owner mode
  [[ -f "$file" ]] || fail "missing secret file: $file"
  owner="$(stat -c '%U:%G' "$file")"
  mode="$(stat -c '%a' "$file")"
  [[ "$owner" == "root:root" ]] || fail "$file must be owned by root:root"
  [[ "$mode" == "600" || "$mode" == "400" ]] ||
    fail "$file must use mode 0600 or 0400"
}

safe_tar_members() {
  local archive="$1" listing member type
  tar --list --file "$archive" >/dev/null
  while IFS= read -r listing; do
    type="${listing:0:1}"
    [[ "$type" == "-" || "$type" == "d" ]] ||
      fail "unsafe upload tree member type: $listing"
  done < <(LC_ALL=C tar --list --verbose --file "$archive")
  while IFS= read -r member; do
    case "$member" in
      /*|..|../*|*/../*|*/..) fail "unsafe upload tree member: $member" ;;
    esac
  done < <(tar --list --file "$archive")
}

prune_expired_local_recovery_points() {
  local candidate resolved base
  while IFS= read -r -d '' candidate; do
    resolved="$(readlink -f -- "$candidate")"
    [[ -f "$resolved" && "$resolved" == "$candidate" ]] ||
      fail "refusing unsafe recovery-point prune candidate: $candidate"
    [[ "$(dirname -- "$resolved")" == "$backup_real" ]] ||
      fail "refusing recovery-point prune outside $backup_real"
    base="$(basename -- "$resolved")"
    [[ "$base" =~ ^moneyminder-[0-9]{8}T[0-9]{6}Z\.tar\.gpg(\.sha256)?$ ]] ||
      fail "refusing unexpected recovery-point filename: $base"
    rm -- "$resolved"
  done < <(
    find "$backup_real" -xdev -maxdepth 1 -type f \
      \( -name 'moneyminder-????????T??????Z.tar.gpg' \
      -o -name 'moneyminder-????????T??????Z.tar.gpg.sha256' \) \
      -mmin "+$((LOCAL_RETENTION_MINUTES - 1))" -print0
  )
}

[[ "$EUID" -eq 0 ]] || fail "run this backup as root"
for command in docker find findmnt gpg sha256sum stat tar awk date mktemp readlink \
  wc install mv chmod seq curl sleep mkdir flock rm chown dirname basename cat; do
  need "$command"
done
[[ "$UPLOAD_TO_OCI" == "0" || "$UPLOAD_TO_OCI" == "1" ]] ||
  fail "UPLOAD_TO_OCI must be 0 or 1"
[[ -s "$DEPLOY_ENV" ]] || fail "missing deployment environment: $DEPLOY_ENV"
root_secret "$DEPLOY_ENV"
root_secret "$BACKUP_PASSPHRASE_FILE"
(( $(wc -c < "$BACKUP_PASSPHRASE_FILE") >= 32 )) ||
  fail "backup passphrase file must contain at least 32 bytes"
findmnt --mountpoint /srv/moneyminder >/dev/null ||
  fail "/srv/moneyminder is not a dedicated mounted filesystem"

data_real="$(readlink -f -- "$DATA_HOST_DIR")"
[[ -d "$data_real" && ! -L "$DATA_HOST_DIR" ]] ||
  fail "DATA_HOST_DIR must be a real directory, not a symlink"
[[ "$data_real" == "/srv/moneyminder/app-data" ]] ||
  fail "refusing to back up unexpected DATA_HOST_DIR: $data_real"
sqlite_source="$data_real/moneyminder.sqlite3"
[[ -f "$sqlite_source" && ! -L "$sqlite_source" ]] ||
  fail "live SQLite database must be a regular file: $sqlite_source"
[[ "$(readlink -f -- "$sqlite_source")" == "$sqlite_source" ]] ||
  fail "refusing an indirect SQLite source path"
sqlite_source_identity="$(stat -c '%d:%i' -- "$sqlite_source")"

recheck_sqlite_source_after_stop() {
  local current_identity
  [[ -f "$sqlite_source" && ! -L "$sqlite_source" ]] ||
    fail "live SQLite database changed while stopping the app: $sqlite_source"
  [[ "$(readlink -f -- "$sqlite_source")" == "$sqlite_source" ]] ||
    fail "refusing an indirect SQLite source path after stopping the app"
  current_identity="$(stat -c '%d:%i' -- "$sqlite_source")"
  [[ "$current_identity" == "$sqlite_source_identity" ]] ||
    fail "live SQLite database identity changed while stopping the app"
}

mkdir -p -- "$BACKUP_OUTPUT_DIR"
backup_real="$(readlink -f -- "$BACKUP_OUTPUT_DIR")"
[[ "$backup_real" == "/srv/moneyminder/backups" && ! -L "$BACKUP_OUTPUT_DIR" ]] ||
  fail "refusing unexpected BACKUP_OUTPUT_DIR: $backup_real"
exec 9>"$backup_real/.backup.lock"
flock --nonblock 9 || fail "another backup is already running"

image_ref="$(awk -F= '$1 == "MONEYMINDER_IMAGE" { sub(/^[^=]*=/, ""); print }' "$DEPLOY_ENV")"
[[ "$image_ref" =~ @sha256:[a-f0-9]{64}$ ]] ||
  fail "MONEYMINDER_IMAGE must be an immutable digest"
[[ "$RELEASE_COMMIT" == "unknown" || "$RELEASE_COMMIT" =~ ^[a-f0-9]{40}$ ]] ||
  fail "RELEASE_COMMIT must be unknown or a 40-character Git commit"
docker image inspect "$image_ref" >/dev/null

stage="$(mktemp -d "$backup_real/.backup.XXXXXXXX")"
was_running=0
cleanup() {
  local status=$?
  if [[ "$was_running" == "1" ]]; then
    compose start app >/dev/null 2>&1 || printf 'ERROR: app restart failed during cleanup\n' >&2
  fi
  case "$stage" in
    "$backup_real"/.backup.*) rm -rf -- "$stage" ;;
    *) printf 'ERROR: refusing unsafe staging cleanup: %s\n' "$stage" >&2 ;;
  esac
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

app_id="$(compose ps --quiet app 2>/dev/null || true)"
if [[ -n "$app_id" && "$(docker inspect --format '{{.State.Running}}' "$app_id")" == "true" ]]; then
  running_image="$(docker inspect --format '{{.Config.Image}}' "$app_id")"
  [[ "$running_image" == "$image_ref" ]] ||
    fail "running app image differs from MONEYMINDER_IMAGE"
  was_running=1
  docker compose --env-file "$DEPLOY_ENV" --file "$COMPOSE_FILE" stop --timeout 30 app
fi
[[ -z "$(compose ps --quiet --status running app 2>/dev/null || true)" ]] ||
  fail "app did not stop; no paired recovery point was created"
recheck_sqlite_source_after_stop

app_uid="$(docker run --rm --network none --entrypoint /usr/bin/id "$image_ref" -u)"
app_gid="$(docker run --rm --network none --entrypoint /usr/bin/id "$image_ref" -g)"
[[ "$app_uid" =~ ^[0-9]+$ && "$app_gid" =~ ^[0-9]+$ ]] ||
  fail "could not determine application image UID/GID"
snapshot_dir="$stage/snapshot"
mkdir -- "$snapshot_dir"
chown "$app_uid:$app_gid" "$snapshot_dir"

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
  --volume "$data_real:/source:ro" \
  --volume "$snapshot_dir:/snapshot:rw" \
  --entrypoint node \
  "$image_ref" \
  server/sqlite-maintenance.js \
  backup \
  /source/moneyminder.sqlite3 \
  /snapshot/database.sqlite3

[[ -f "$snapshot_dir/database.sqlite3" && ! -L "$snapshot_dir/database.sqlite3" ]] ||
  fail "SQLite maintenance command did not create a regular snapshot"
install -o root -g root -m 0600 \
  "$snapshot_dir/database.sqlite3" "$stage/database.sqlite3"

uploads_source="$data_real/uploads"
if [[ -e "$uploads_source" ]]; then
  [[ -d "$uploads_source" && ! -L "$uploads_source" ]] ||
    fail "uploads path must be a real directory"
  [[ "$(readlink -f -- "$uploads_source")" == "$uploads_source" ]] ||
    fail "refusing an indirect uploads path"
else
  uploads_source="$stage/empty-uploads"
  mkdir -- "$uploads_source"
fi
[[ -z "$(find "$uploads_source" -xdev ! \( -type f -o -type d \) -print -quit)" ]] ||
  fail "upload archive contains unsafe filesystem entries: unsafe upload tree member exists"
tar --format=posix --numeric-owner --one-file-system \
  --directory "$uploads_source" --create --file "$stage/uploads.tar" .
safe_tar_members "$stage/uploads.tar"

upload_files="$(find "$uploads_source" -xdev -type f -printf '%p\n' | wc -l)"
upload_bytes="$(find "$uploads_source" -xdev -type f -printf '%s\n' |
  awk '{ total += $1 } END { print total + 0 }')"
database_bytes="$(stat -c '%s' "$stage/database.sqlite3")"
[[ "$database_bytes" =~ ^[1-9][0-9]*$ ]] ||
  fail "consistent SQLite snapshot is empty"

if [[ "$was_running" == "1" ]]; then
  compose start app >/dev/null
  was_running=0
  ready=0
  for _ in $(seq 1 45); do
    if curl --fail --silent --show-error http://127.0.0.1:3000/readyz >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  [[ "$ready" == "1" ]] || fail "snapshot succeeded, but the app did not become ready"
fi

created_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
recovery_point="$(date -u +'%Y%m%dT%H%M%SZ')"
archive_name="moneyminder-$recovery_point.tar.gpg"
archive_path="$backup_real/$archive_name"
[[ ! -e "$archive_path" && ! -e "$archive_path.sha256" ]] ||
  fail "backup output already exists: $archive_path"

cat > "$stage/manifest.txt" <<EOF
format_version=2
recovery_point=$recovery_point
created_at=$created_at
application_image=$image_ref
release_commit=$RELEASE_COMMIT
database_format=sqlite3_maintenance_snapshot
database_archive=database.sqlite3
database_bytes=$database_bytes
uploads_archive=uploads.tar
upload_file_count=$upload_files
upload_bytes=$upload_bytes
credentials_sanitized_on_restore=required
restore_requires_deletion_reconciliation=true
EOF

(
  cd -- "$stage"
  sha256sum database.sqlite3 uploads.tar manifest.txt > artifacts.sha256
  tar --format=posix --create --file recovery-set.tar \
    database.sqlite3 uploads.tar manifest.txt artifacts.sha256
)

gpg --batch --yes --pinentry-mode loopback \
  --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
  --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 \
  --compress-algo none \
  --output "$stage/$archive_name" \
  "$stage/recovery-set.tar"

install -o root -g root -m 0600 "$stage/$archive_name" "$archive_path.partial"
mv -- "$archive_path.partial" "$archive_path"
(
  cd -- "$backup_real"
  sha256sum "$archive_name" > "$archive_name.sha256.partial"
)
chmod 0600 "$archive_path.sha256.partial"
mv -- "$archive_path.sha256.partial" "$archive_path.sha256"
(
  cd -- "$backup_real"
  sha256sum --check "$archive_name.sha256"
)

if [[ "$UPLOAD_TO_OCI" == "1" ]]; then
  need oci
  [[ -n "$OCI_NAMESPACE" && -n "$OCI_BUCKET_NAME" ]] ||
    fail "OCI_NAMESPACE and OCI_BUCKET_NAME are required when UPLOAD_TO_OCI=1"
  "$SCRIPT_DIR/verify-oci-retention.sh"
  oci --auth instance_principal os object put \
    --namespace-name "$OCI_NAMESPACE" \
    --bucket-name "$OCI_BUCKET_NAME" \
    --name "$archive_name" \
    --file "$archive_path" \
    --no-overwrite \
    --verify-checksum
  oci --auth instance_principal os object put \
    --namespace-name "$OCI_NAMESPACE" \
    --bucket-name "$OCI_BUCKET_NAME" \
    --name "$archive_name.sha256" \
    --file "$archive_path.sha256" \
    --no-overwrite \
    --verify-checksum
fi

prune_expired_local_recovery_points

printf 'Recovery point: %s\n' "$recovery_point"
printf 'Encrypted paired backup: %s\n' "$archive_path"
printf 'Checksum: %s\n' "$archive_path.sha256"
printf 'Deletion reconciliation remains mandatory after any restore.\n'
