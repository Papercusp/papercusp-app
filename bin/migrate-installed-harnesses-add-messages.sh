#!/usr/bin/env bash
# Idempotently provisions multi-harness-spawning support tables on every
# installed harness:
#   - per-harness messages, supervisor_notes, executed_actions, config_token
#   - generates a harness_token if missing, mirrors to harness_shared.token_index
#   - merges harness_token into <project_path>/.papercusp/config.json (mode 0600)
#
# Skips registry rows whose project path doesn't exist on disk (orphaned).
# Logs a summary at the end: provisioned: N, skipped: M, errors: K.
#
# Usage:
#   bin/migrate-installed-harnesses-add-messages.sh        # all installed
#   bin/migrate-installed-harnesses-add-messages.sh <slug> # one harness

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TEMPLATE="$ROOT/libs/papercusp/libs/db/sql/002-per-harness-template.sql"
OPERATOR_BASE="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"

: "${PGUSER:=postgres_app}"
: "${PGPASSWORD:=postgres}"
: "${PGHOST:=localhost}"
: "${PGDATABASE:=papercusp}"
export PGUSER PGPASSWORD PGHOST PGDATABASE

slug_to_schema() {
  local s="${1//-/_}"
  echo "harness_${s,,}"
}

# Generate a 256-bit token, base64url-encoded (no padding).
gen_token() {
  python3 -c 'import secrets, base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode())'
}

provisioned=0
skipped=0
errors=0
errored_slugs=()

provision_one() {
  local slug="$1"
  local path="$2"
  local schema; schema="$(slug_to_schema "$slug")"

  if [[ ! -d "$path" ]]; then
    echo "  skip $slug: project path '$path' does not exist (orphaned registry row)"
    skipped=$((skipped+1))
    return 0
  fi

  # 1. Apply the per-harness template (idempotent — IF NOT EXISTS).
  local rendered; rendered="$(mktemp)"
  sed "s/{{SCHEMA}}/$schema/g" "$TEMPLATE" > "$rendered"
  if ! psql -v ON_ERROR_STOP=1 -q -f "$rendered" 2>&1 | tail -3; then
    rm -f "$rendered"
    echo "  ERROR provisioning $slug → $schema"
    errors=$((errors+1))
    errored_slugs+=("$slug")
    return 0
  fi
  rm -f "$rendered"

  # 2. Token: read from filesystem if present, else generate + persist.
  local config_path="$path/.papercusp/config.json"
  local existing_token=""
  if [[ -f "$config_path" ]]; then
    existing_token="$(jq -r '.harness_token // empty' "$config_path" 2>/dev/null || true)"
  fi

  local token=""
  if [[ -n "$existing_token" ]]; then
    token="$existing_token"
  else
    token="$(gen_token)"
    # Atomic merge into config.json
    if [[ -f "$config_path" ]]; then
      local tmp; tmp="$(mktemp)"
      jq --arg t "$token" '. + {harness_token: $t}' "$config_path" > "$tmp"
      mv "$tmp" "$config_path"
    else
      mkdir -p "$path/.papercusp"
      echo "{\"harness_token\":\"$token\"}" > "$config_path"
    fi
    chmod 0600 "$config_path"
  fi

  # 3. Mirror into per-harness config_token + shared token_index (both idempotent on conflict).
  psql -v ON_ERROR_STOP=1 -q <<SQL >/dev/null
INSERT INTO ${schema}.config_token (token) VALUES ('${token}')
  ON CONFLICT (token) DO NOTHING;
INSERT INTO harness_shared.token_index (token, harness_slug) VALUES ('${token}', '${slug}')
  ON CONFLICT (token) DO UPDATE SET harness_slug = EXCLUDED.harness_slug;
SQL

  echo "  ✓ $slug → $schema (token: ${token:0:8}…)"
  provisioned=$((provisioned+1))
}

if [[ -n "${1:-}" ]]; then
  # Single harness mode: query operator for path
  slug="$1"
  path="$(curl -sS "$OPERATOR_BASE/api/harness/projects" | jq -r --arg s "$slug" '.projects[]? | select(.slug == $s) | .path')"
  if [[ -z "$path" ]]; then
    echo "ERROR: harness '$slug' not found in operator registry" >&2
    exit 1
  fi
  provision_one "$slug" "$path"
else
  # All-installed mode: enumerate via operator API
  rows="$(curl -sS "$OPERATOR_BASE/api/harness/projects" | jq -r '.projects[] | "\(.slug)\t\(.path)"')"
  if [[ -z "$rows" ]]; then
    echo "No harnesses registered. Done." >&2
    exit 0
  fi
  while IFS=$'\t' read -r slug path; do
    [[ -z "$slug" ]] && continue
    provision_one "$slug" "$path"
  done <<< "$rows"
fi

echo
echo "──────────────────────────────────────"
echo "provisioned: $provisioned"
echo "skipped:     $skipped (orphaned registry rows)"
echo "errors:      $errors"
if [[ "$errors" -gt 0 ]]; then
  echo "errored:     ${errored_slugs[*]}"
  exit 1
fi
