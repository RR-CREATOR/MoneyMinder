#!/usr/bin/env bash
set -Eeuo pipefail

OCI_NAMESPACE="${OCI_NAMESPACE:-}"
OCI_BUCKET_NAME="${OCI_BUCKET_NAME:-}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

need jq
need oci
[[ "$OCI_NAMESPACE" =~ ^[A-Za-z0-9._-]{1,256}$ ]] ||
  fail "OCI_NAMESPACE is missing or malformed"
[[ "$OCI_BUCKET_NAME" =~ ^[A-Za-z0-9._-]{1,256}$ ]] ||
  fail "OCI_BUCKET_NAME is missing or malformed"

bucket_json="$(oci --auth instance_principal os bucket get \
  --namespace-name "$OCI_NAMESPACE" \
  --bucket-name "$OCI_BUCKET_NAME")" ||
  fail "could not inspect the OCI backup bucket"

jq --exit-status '
  .data["public-access-type"] == "NoPublicAccess"
  and .data.versioning == "Disabled"
' <<<"$bucket_json" >/dev/null ||
  fail "backup bucket must be private with versioning Disabled"

policy_json="$(oci --auth instance_principal os object-lifecycle-policy get \
  --namespace-name "$OCI_NAMESPACE" \
  --bucket-name "$OCI_BUCKET_NAME")" ||
  fail "could not inspect the OCI backup-bucket lifecycle policy"

jq --exit-status '
  any(.data.items[]?;
    .action == "DELETE"
    and .["is-enabled"] == true
    and .target == "objects"
    and .["time-unit"] == "DAYS"
    and ((.["time-amount"] | type) == "number")
    and .["time-amount"] <= 30
    and .["object-name-filter"] == null
  )
' <<<"$policy_json" >/dev/null ||
  fail "OCI backup bucket needs an enabled, unfiltered DELETE objects rule at <= 30 DAYS"

printf 'OK: private, unversioned OCI backup bucket expires every object within 30 days\n'
