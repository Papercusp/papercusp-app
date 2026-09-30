#!/usr/bin/env bash
# Emit the fixed workspace-host bootstrap entrypoints into an assembled Server
# sidecar.  The generated files are deliberately thin: the bundled Node,
# serve.mjs, and scripts/psu.mjs remain the only runtime/agent implementations.
#
# Usage: install-workspace-host-entrypoints.sh --release-root SIDEcar_DIR
set -Eeuo pipefail

die() {
  printf 'install-workspace-host-entrypoints: ERROR: %s\n' "$1" >&2
  exit 1
}

release_root=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-root)
      [[ $# -ge 2 && -n "$2" ]] || die "--release-root needs a directory"
      release_root="$2"
      shift 2
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$release_root" ]] || die "--release-root is required"
[[ -d "$release_root" ]] || die "release root is not a directory: $release_root"
release_root="$(cd "$release_root" && pwd -P)"
bin_dir="$release_root/bin"

[[ -x "$bin_dir/node" ]] || die "bundled Node is missing or not executable: bin/node"
[[ -s "$release_root/serve.mjs" ]] || die "Server runtime is missing or empty: serve.mjs"
[[ -s "$release_root/scripts/psu.mjs" ]] || die "agent launcher is missing or empty: scripts/psu.mjs"
[[ -x "$bin_dir/pui" ]] || die "pui is missing or not executable: bin/pui"
[[ -s "$release_root/pui-companion.wasm" ]] || die "pui companion is missing or empty: pui-companion.wasm"
[[ -s "$release_root/pui-install.json" ]] || die "pui generation manifest is missing or empty: pui-install.json"
[[ -d "$release_root/db-sql" ]] || die "migration payload is missing: db-sql/"
[[ -x "$bin_dir/papercusp-remote-initializer" ]] \
  || die "remote initializer is missing or not executable"
# D-215: credential-material delivery is its OWN program on its own protocol. It is a REQUIRED
# release material, and without it the git/agent channels throw at bind on every real host.
[[ -x "$bin_dir/papercusp-deliver-material" ]] \
  || die "credential-material delivery entrypoint is missing or not executable"

# EI-21548386804468550: the pinned vm-release PostgreSQL tree includes real
# client binaries, and the builder historically exposed them through absolute
# symlinks into sidecar.tmp.<pid>. They passed the pre-publish verifier, then
# broke when the staging directory was atomically renamed. Normalize every
# internal client link from the release tree we are actually qualifying. This
# also repairs a copied admitted r6 tree without touching its preserved source.
normalized_pg_links=0
for tool in pg_dump psql pg_dumpall pg_restore; do
  if [[ -L "$bin_dir/$tool" ]]; then
    pg_candidates=()
    for candidate in \
      "$release_root"/node_modules/@papercusp/embedded-postgres-server/node_modules/@embedded-postgres/*/native/bin/"$tool"; do
      [[ -f "$candidate" && -x "$candidate" ]] || continue
      pg_candidates+=("$candidate")
    done
    [[ "${#pg_candidates[@]}" -eq 1 ]] \
      || die "$tool symlink needs exactly one bundled native target (found ${#pg_candidates[@]})"
    pg_rel_src="${pg_candidates[0]#"$release_root"/}"
    ln -sfn "../$pg_rel_src" "$bin_dir/$tool"
    normalized_pg_links=$((normalized_pg_links + 1))
  fi
  [[ -x "$bin_dir/$tool" ]] || die "PostgreSQL client is missing or not executable: bin/$tool"
done

stage="$(mktemp -d "$release_root/.workspace-host-entrypoints.XXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

cat > "$stage/papercusp-install" <<'ENTRYPOINT'
#!/usr/bin/env bash
set -Eeuo pipefail
die() { printf 'papercusp-install: ERROR: %s\n' "$1" >&2; exit 1; }
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$BIN/.." && pwd -P)"
action=""; release_root=""; state_root=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --action) [[ $# -ge 2 ]] || die "--action needs a value"; action="$2"; shift 2 ;;
    --release-root) [[ $# -ge 2 ]] || die "--release-root needs a value"; release_root="$2"; shift 2 ;;
    --state-root) [[ $# -ge 2 ]] || die "--state-root needs a value"; state_root="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$action" in install|upgrade|rollback) ;; *) die "--action must be install, upgrade, or rollback" ;; esac
[[ -d "$release_root" ]] || die "release root is not a directory"
release_root="$(cd "$release_root" && pwd -P)"
[[ "$release_root" == "$ROOT" ]] || die "release root does not name this immutable release"
[[ "$state_root" == /* && -d "$state_root" && -w "$state_root" ]] \
  || die "state root must be an existing writable absolute directory"
for entrypoint in papercusp-install papercusp-rollback node papercusp-migrate \
  papercusp-server papercusp-health psu pui claude codex omp papercusp-remote-initializer \
  papercusp-deliver-material; do
  [[ -x "$BIN/$entrypoint" ]] || die "missing executable release entrypoint: bin/$entrypoint"
done
[[ -s "$ROOT/pui-companion.wasm" ]] || die "pui-companion.wasm is missing or empty"
[[ -s "$ROOT/pui-install.json" ]] || die "pui-install.json is missing or empty"
[[ -s "$ROOT/serve.mjs" ]] || die "serve.mjs is missing or empty"
[[ -s "$ROOT/scripts/psu.mjs" ]] || die "scripts/psu.mjs is missing or empty"
[[ -d "$ROOT/db-sql" ]] || die "db-sql migration payload is missing"
[[ -x "$BIN/papercusp-content-bootstrap" ]] \
  || die "content bootstrap entrypoint is missing or not executable"
"$BIN/papercusp-content-bootstrap" --state-root "$state_root"
ENTRYPOINT

cat > "$stage/papercusp-content-bootstrap" <<'ENTRYPOINT'
#!/usr/bin/env bash
set -Eeuo pipefail
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$BIN/.." && pwd -P)"
[[ -x "$BIN/node" && -s "$ROOT/serve.mjs" ]] \
  || { echo "papercusp-content-bootstrap: bundled Server runtime is incomplete" >&2; exit 1; }
exec "$BIN/node" "$ROOT/serve.mjs" --content-bootstrap "$@"
ENTRYPOINT

cat > "$stage/papercusp-rollback" <<'ENTRYPOINT'
#!/usr/bin/env bash
set -Eeuo pipefail
die() { printf 'papercusp-rollback: ERROR: %s\n' "$1" >&2; exit 1; }
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$BIN/.." && pwd -P)"
from=""; to=""; state_root=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) [[ $# -ge 2 ]] || die "--from needs a value"; from="$2"; shift 2 ;;
    --to) [[ $# -ge 2 ]] || die "--to needs a value"; to="$2"; shift 2 ;;
    --state-root) [[ $# -ge 2 ]] || die "--state-root needs a value"; state_root="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$from" == /* && -d "$from" ]] || die "--from must name an existing absolute release directory"
[[ "$to" == /* && -d "$to" ]] || die "--to must name an existing absolute release directory"
to="$(cd "$to" && pwd -P)"
[[ "$to" == "$ROOT" ]] || die "--to does not name this immutable release"
[[ "$state_root" == /* && -d "$state_root" && -w "$state_root" ]] \
  || die "state root must be an existing writable absolute directory"
[[ -x "$from/bin/papercusp-server" ]] || die "previous release has no executable Server entrypoint"
ENTRYPOINT

cat > "$stage/papercusp-migrate" <<'ENTRYPOINT'
#!/usr/bin/env bash
# The Server's existing embedded-Postgres boot path owns migration execution.
# This phase is its fail-closed readiness check; the later health-green service
# proves that the real migration runner completed before the bootstrap attests.
set -Eeuo pipefail
die() { printf 'papercusp-migrate: ERROR: %s\n' "$1" >&2; exit 1; }
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$BIN/.." && pwd -P)"
database_root=""; migration_id=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-root) [[ $# -ge 2 ]] || die "--database-root needs a value"; database_root="$2"; shift 2 ;;
    --migration-id) [[ $# -ge 2 ]] || die "--migration-id needs a value"; migration_id="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$database_root" == /* && -d "$database_root" && -w "$database_root" ]] \
  || die "database root must be an existing writable absolute directory"
[[ "$migration_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] \
  || die "migration id is missing or unsafe"
[[ -x "$BIN/node" && -s "$ROOT/serve.mjs" ]] || die "bundled Server runtime is incomplete"
set -- "$ROOT"/db-sql/*.sql
[[ -f "$1" ]] || die "db-sql contains no migration files"
ENTRYPOINT

cat > "$stage/papercusp-server" <<'ENTRYPOINT'
#!/usr/bin/env bash
set -Eeuo pipefail
die() { printf 'papercusp-server: ERROR: %s\n' "$1" >&2; exit 1; }
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$BIN/.." && pwd -P)"
NODE="$BIN/node"
PROVENANCE="$ROOT/build-provenance.json"
[[ -x "$NODE" ]] || die "bundled Node is missing or not executable"
[[ -s "$ROOT/serve.mjs" ]] || die "serve.mjs is missing or empty"
[[ -s "$PROVENANCE" ]] || die "build-provenance.json is missing or empty"
for arg in "$@"; do
  case "$arg" in
    # EI-21546899007927487: serve.mjs handles help before sidecar dispatch,
    # lock acquisition, Postgres, or migrations. Delegate before this wrapper's
    # runtime-only provenance/port/data-root validation so help stays usable on
    # an otherwise unconfigured installation.
    -h|--help) exec "$NODE" "$ROOT/serve.mjs" "$@" ;;
  esac
done
read_provenance_field() {
  "$NODE" -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (typeof value !== "string" || value.length === 0) process.exit(2);
    process.stdout.write(value);
  ' "$PROVENANCE" "$1"
}
PAPERCUSP_BUILD_VERSION="$(read_provenance_field version)" \
  || die "provenance has no exact version"
PAPERCUSP_BUILD_SHA="$(read_provenance_field buildSha)" \
  || die "provenance has no exact buildSha"
[[ -n "${PAPERCUSP_PORT:-}" ]] || die "PAPERCUSP_PORT is required"
[[ -n "${PAPERCUSP_EMBEDDED_PG_ROOT:-}" ]] || die "PAPERCUSP_EMBEDDED_PG_ROOT is required"
if [[ -n "${PAPERCUSP_HONO_PORT:-}" && "$PAPERCUSP_HONO_PORT" != "$PAPERCUSP_PORT" ]]; then
  die "PAPERCUSP_HONO_PORT conflicts with PAPERCUSP_PORT"
fi
export PAPERCUSP_HONO_PORT="$PAPERCUSP_PORT"
export PAPERCUSP_PG_DATA_DIR="$PAPERCUSP_EMBEDDED_PG_ROOT"
export PAPERCUSP_PG_SQL_DIR="$ROOT/db-sql"
export PAPERCUSP_SIDECAR_BIN="$BIN"
export PUI_COMPANION_WASM="$ROOT/pui-companion.wasm"
export PUI_INSTALL_MANIFEST="$ROOT/pui-install.json"
# P-309 CONTENT ROOTS. papercusp-install materializes the official Cupboard
# bundle into the persistent machine-local home before this process starts.
# Only code/static UI/docs remain release-pinned; prompts, blueprints,
# templates and rubrics survive release replacement and offline restart here.
STATE_ROOT="$(cd "$(dirname "$PAPERCUSP_EMBEDDED_PG_ROOT")" && pwd -P)"
export PAPERCUSP_HOME="${PAPERCUSP_HOME:-$STATE_ROOT/.papercusp}"
export PAPERCUSP_PROMPTS_DIR="$PAPERCUSP_HOME/blueprints/base/prompts"
export PAPERCUSP_SPA_DIST="$ROOT/spa"
export PAPERCUSP_DOCS_ROOT="$ROOT/internal-docs"
export PAPERCUSP_TEMPLATES_DIR="$PAPERCUSP_HOME/templates"
export PAPERCUSP_RUBRICS_DIR="$PAPERCUSP_HOME/rubrics"
for content_dir in "$PAPERCUSP_PROMPTS_DIR" "$PAPERCUSP_HOME/blueprints" \
  "$PAPERCUSP_TEMPLATES_DIR" "$PAPERCUSP_RUBRICS_DIR"; do
  [[ -d "$content_dir" ]] || die "installed Cupboard content is missing: $content_dir"
done
export PAPERCUSP_BUILD_VERSION PAPERCUSP_BUILD_SHA
export PAPERCUSP_DISTRIBUTION_PROFILE=vm-release
export PAPERCUSP_PROVISION_ENV_OPERATORS=0
exec "$NODE" "$ROOT/serve.mjs" "$@"
ENTRYPOINT

cat > "$stage/papercusp-health" <<'ENTRYPOINT'
#!/usr/bin/env bash
set -Eeuo pipefail
die() { printf 'papercusp-health: ERROR: %s\n' "$1" >&2; exit 1; }
host=""; port=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) [[ $# -ge 2 ]] || die "--host needs a value"; host="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || die "--port needs a value"; port="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$host" == "127.0.0.1" ]] || die "health probes are restricted to 127.0.0.1"
[[ "$port" =~ ^[0-9]+$ && "$port" -ge 1024 && "$port" -le 65535 ]] \
  || die "port must be an unprivileged TCP port"
timeout_sec="${PAPERCUSP_HEALTH_TIMEOUT_SEC:-120}"
[[ "$timeout_sec" =~ ^[0-9]+$ && "$timeout_sec" -ge 1 && "$timeout_sec" -le 600 ]] \
  || die "PAPERCUSP_HEALTH_TIMEOUT_SEC must be 1..600"
command -v curl >/dev/null 2>&1 || die "curl is required for the health probe"
started="$SECONDS"
url="http://127.0.0.1:$port/api/health"
while (( SECONDS - started < timeout_sec )); do
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 "$url" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done
die "operator did not become healthy at $url within ${timeout_sec}s"
ENTRYPOINT

cat > "$stage/psu" <<'ENTRYPOINT'
#!/usr/bin/env bash
set -Eeuo pipefail
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$BIN/.." && pwd -P)"
[[ -x "$BIN/node" && -s "$ROOT/scripts/psu.mjs" ]] \
  || { echo "psu: bundled launcher is incomplete" >&2; exit 1; }
export PAPERCUSP_SIDECAR_BIN="$BIN"
exec "$BIN/node" "$ROOT/scripts/psu.mjs" "$@"
ENTRYPOINT

for backend in claude codex omp; do
  cat > "$stage/$backend" <<'ENTRYPOINT'
#!/usr/bin/env bash
set -Eeuo pipefail
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$BIN/.." && pwd -P)"
BACKEND="$(basename "${BASH_SOURCE[0]}")"
[[ -x "$BIN/node" && -s "$ROOT/scripts/psu.mjs" ]] \
  || { echo "$BACKEND: bundled psu launcher is incomplete" >&2; exit 1; }
for arg in "$@"; do
  case "$arg" in --agent|--agent=*) echo "$BACKEND: --agent cannot override this pinned backend" >&2; exit 1 ;; esac
done
export PAPERCUSP_SIDECAR_BIN="$BIN"
exec "$BIN/node" "$ROOT/scripts/psu.mjs" "--agent=$BACKEND" "$@"
ENTRYPOINT
done

for entrypoint in papercusp-install papercusp-content-bootstrap papercusp-rollback papercusp-migrate \
  papercusp-server papercusp-health psu claude codex omp; do
  chmod 755 "$stage/$entrypoint"
  mv -f "$stage/$entrypoint" "$bin_dir/$entrypoint"
done

for entrypoint in papercusp-install papercusp-content-bootstrap papercusp-rollback node papercusp-migrate \
  papercusp-server papercusp-health psu pui claude codex omp papercusp-remote-initializer \
  papercusp-deliver-material; do
  [[ -x "$bin_dir/$entrypoint" ]] || die "failed to emit executable bin/$entrypoint"
done

printf 'install-workspace-host-entrypoints: emitted 10 wrappers (including Cupboard content bootstrap); all 13 bootstrap entrypoints executable; pui companion + generation manifest present; normalized %s PostgreSQL link(s)\n' "$normalized_pg_links"
