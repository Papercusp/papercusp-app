#!/usr/bin/env bash
# bin/reap-invalid-test-databases.sh
#
# Guarded reaper for INVALID test-fixture Postgres databases
# (plan papercusp-db-backup-invalid-db-2026-09-27 P-002, WI-10003478).
#
# WHY: a DROP DATABASE interrupted mid-flight on PG >= 15 (e.g. the integration
# harness's 20s statement_timeout firing — WI-10003482) commits the "invalid"
# mark (pg_database.datconnlimit = -2) before the slow file phase, then the
# cancel leaves the catalog row behind forever. Nothing can connect to it, so it
# holds no data. The hourly papercusp-db-backup skips such rows (WI-10003455),
# but they accumulate (18 on 2026-09-27) and every backup run logs them. This
# sweeper removes them out of band, with no Vitest hook budget and no
# statement_timeout, so an IO-contended box still makes progress.
#
# SAFETY CONTRACT — a database is dropped ONLY when ALL of these hold, and they
# are checked TWICE (once on the census row, once on a fresh single-row re-read
# immediately before the DROP):
#   1. datconnlimit = -2                 (INVALID: an interrupted DROP; never a live DB)
#   2. name matches NAME_RE              (a test-fixture name: papercusp_it_baseline_<12hex> | org_<12hex>)
#   3. the database comment is a test-harness marker
#        - 'papercusp-test-db-drop-deferred'   (libs/test-config pg-migrate TEST_DB_DEFERRED_MARKER), or
#        - 'papercusp-test-db:<13-digit ms>'  (TEST_DB_MANAGED_MARKER, stamped at creation)
# The census SQL already filters on (1), but the bash checks do NOT trust it:
# a census row that fails any check is logged and left alone. A VALID database
# (datconnlimit <> -2) can therefore never be dropped, whatever the SQL returns.
#
# Usage: reap-invalid-test-databases.sh [--dry-run]    (or REAP_DRY_RUN=1)
# Exit:  0 = nothing failed (including "nothing to do"); 1 = at least one DROP failed.

set -uo pipefail

PGSOCK="${REAP_PG_SOCKET:-/var/run/postgresql}"
DRY_RUN="${REAP_DRY_RUN:-0}"
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

NAME_RE='^(papercusp_it_baseline|org)_[0-9a-f]{12}$'
DEFERRED_MARKER='papercusp-test-db-drop-deferred'
MANAGED_RE='^papercusp-test-db:[0-9]{13}$'

log() { printf '[%s] %s\n' "$(date -Is)" "$*"; }

# One psql invocation; SQL on stdin so psql variables (:'n') are interpolated.
psql_run() {
  sudo -n -u postgres psql -h "$PGSOCK" -d postgres -X -q -tA -F $'\t' -v ON_ERROR_STOP=1 "$@"
}

CENSUS_SQL="SELECT d.datname, d.datconnlimit, coalesce(c.description, '')
  FROM pg_database d
  LEFT JOIN pg_shdescription c ON c.objoid = d.oid AND c.classoid = 'pg_database'::regclass
 WHERE d.datconnlimit = -2
 ORDER BY d.datname;"

RECHECK_SQL="SELECT d.datname, d.datconnlimit, coalesce(c.description, '')
  FROM pg_database d
  LEFT JOIN pg_shdescription c ON c.objoid = d.oid AND c.classoid = 'pg_database'::regclass
 WHERE d.datname = :'n';"

# eligible NAME LIMIT DESCRIPTION -> 0 when every safety condition holds.
eligible() {
  local name="$1" limit="$2" desc="$3"
  [ "$limit" = "-2" ] || return 1
  [[ "$name" =~ $NAME_RE ]] || return 1
  [ "$desc" = "$DEFERRED_MARKER" ] && return 0
  [[ "$desc" =~ $MANAGED_RE ]] && return 0
  return 1
}

# Single-instance: an overlapping timer tick exits quietly.
LOCK="${XDG_RUNTIME_DIR:-/tmp}/papercusp-invalid-db-reaper.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another reaper run holds $LOCK — exiting"
  exit 0
fi

census() { printf '%s\n' "$CENSUS_SQL" | psql_run; }

if ! BEFORE="$(census)"; then
  log "ERROR census query failed — nothing dropped"
  exit 1
fi
BEFORE_N=$(printf '%s' "$BEFORE" | grep -c . || true)
log "census before: $BEFORE_N invalid database(s)"

dropped=0 failed=0 left=0
while IFS=$'\t' read -r name limit desc; do
  [ -n "$name" ] || continue
  if ! eligible "$name" "$limit" "$desc"; then
    log "LEAVE $name (limit=$limit comment='${desc}') — not an invalid test-fixture database"
    left=$((left + 1))
    continue
  fi
  # Re-read this one row immediately before acting on it.
  row="$(printf '%s\n' "$RECHECK_SQL" | psql_run -v n="$name")" || row=""
  IFS=$'\t' read -r r_name r_limit r_desc <<<"$row"
  if [ "${r_name:-}" != "$name" ] || ! eligible "$r_name" "${r_limit:-}" "${r_desc:-}"; then
    log "LEAVE $name — re-check no longer eligible (row='${row}')"
    left=$((left + 1))
    continue
  fi
  if [ "$DRY_RUN" = 1 ]; then
    log "DRY-RUN would drop $name (comment='$r_desc')"
    continue
  fi
  # NAME_RE admits only [a-z0-9_], so double-quoting is a complete identifier quote.
  if printf 'SET statement_timeout = 0;\nDROP DATABASE IF EXISTS "%s";\n' "$name" | psql_run; then
    log "DROPPED $name (comment='$r_desc')"
    dropped=$((dropped + 1))
  else
    log "ERROR drop failed for $name"
    failed=$((failed + 1))
  fi
done <<<"$BEFORE"

AFTER="$(census)" || AFTER="<census failed>"
AFTER_N=$(printf '%s' "$AFTER" | grep -c . || true)
log "census after: $AFTER_N invalid database(s); dropped=$dropped left=$left failed=$failed dry_run=$DRY_RUN"
[ "$failed" -eq 0 ]
