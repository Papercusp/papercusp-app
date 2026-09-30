#!/usr/bin/env bash
# roster-scope.selftest.sh — regression test for EI-18656746187879489: the
# federation rigs' roster reads (rig_read_roster in deb-hetzner-rig.sh,
# _cl_roster_ids in deb-hetzner-concurrent.sh, _rv_roster_empty in
# deb-hetzner-revocation.sh) used to query harness_shared.pot_members with NO
# workspace_id/pot_home_slug predicate at all — so on a frame hosting more than
# one pot (a reused frame across scenario runs, e.g.), any UNRELATED pot's
# members could be counted as THIS pot's roster. Several callers gate PASS/FAIL
# directly on the roster (deb-hetzner-concurrent.sh's ROSTER-POPULATED GATE,
# deb-hetzner-restart.sh/deb-hetzner-reconnect.sh's post-restart roster-intact
# checks, deb-hetzner-revocation.sh's WI-1378 empty-roster branch) — an
# unscoped read is a false PASS (or a misdiagnosis) available from any other
# pot on the frame.
#
# Lives in bin/lib/ (not bin/lib/scenarios/) for the same reason
# restart-settle-barrier.selftest.sh / rig-wait-converged.selftest.sh do:
# deb-hetzner-matrix.sh's source_scenarios() sources EVERY bin/lib/scenarios/*.sh
# at the top of a real run, so a selftest living there would be swept in and its
# stubbed drv_psql would silently clobber the real one for the whole live run.
#
# Sources the REAL scenario files (the shipping code, not a copy) and exercises
# the three roster functions against a STUBBED drv_psql that just echoes back
# the SQL it was asked to run — so this never touches a real rig/SSH/PG, purely
# local, <1s. We assert on the SHAPE of the generated SQL (does it carry the
# workspace_id / pot_home_slug predicate), not on any real roster data.
#
#   bash bin/lib/roster-scope.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONCURRENT="$DIR/../deb-hetzner-concurrent.sh"
REVOCATION="$DIR/../deb-hetzner-revocation.sh"
[ -f "$CONCURRENT" ] || { echo "SKIP: $CONCURRENT not found"; exit 0; }
[ -f "$REVOCATION" ] || { echo "SKIP: $REVOCATION not found"; exit 0; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

fed_log() { : ; }

# shellcheck disable=SC1090
source "$CONCURRENT" >/dev/null 2>&1 || true
# shellcheck disable=SC1090
source "$REVOCATION" >/dev/null 2>&1 || true

# ── stub MUST come after the source: the rig lib (sourced transitively by both
# scenario files above) defines the real drv_psql. ──
SQL_LOG="$(mktemp)"
trap 'rm -f "$SQL_LOG"' EXIT
drv_psql() {
  printf '%s\n' "$2" >>"$SQL_LOG"
  printf '%s\n' "${STUB_ROWS:-}"
}
fed_log() { : ; }

reset_env() {
  RIG_HIVE_ID="hello-world-pot"
  RIG_WORKSPACE_ID="workspace-rigdeadbeef"
  STUB_ROWS=""
  : >"$SQL_LOG"
}

# ── rig_read_roster ───────────────────────────────────────────────────────────
reset_env
rig_read_roster a >/dev/null 2>&1
sql="$(cat "$SQL_LOG")"
if grep -q "workspace_id='workspace-rigdeadbeef'" <<<"$sql" && grep -q "pot_home_slug='hello-world-pot'" <<<"$sql"; then
  ok "rig_read_roster scopes by BOTH workspace_id and pot_home_slug when both are in scope"
else
  bad "rig_read_roster: expected workspace_id+pot_home_slug predicate, got: $sql"
fi

reset_env; RIG_WORKSPACE_ID=""
rig_read_roster a >/dev/null 2>&1
sql="$(cat "$SQL_LOG")"
if ! grep -q "workspace_id=" <<<"$sql" && grep -q "pot_home_slug='hello-world-pot'" <<<"$sql"; then
  ok "rig_read_roster: empty RIG_WORKSPACE_ID → no workspace predicate, pot predicate still applied"
else
  bad "rig_read_roster with empty workspace: got: $sql"
fi

reset_env; RIG_HIVE_ID=""
rig_read_roster a >/dev/null 2>&1
sql="$(cat "$SQL_LOG")"
if grep -q "workspace_id='workspace-rigdeadbeef'" <<<"$sql" && ! grep -q "pot_home_slug=''" <<<"$sql"; then
  ok "rig_read_roster: empty RIG_HIVE_ID → no unsatisfiable pot_home_slug='' (still workspace-scoped)"
else
  bad "rig_read_roster with empty pot: got: $sql"
fi

# ── _cl_roster_ids (deb-hetzner-concurrent.sh) ───────────────────────────────
reset_env
_cl_roster_ids a >/dev/null 2>&1
sql="$(cat "$SQL_LOG")"
if grep -q "workspace_id='workspace-rigdeadbeef'" <<<"$sql" && grep -q "pot_home_slug='hello-world-pot'" <<<"$sql"; then
  ok "_cl_roster_ids scopes the roster-gate query by workspace_id + pot_home_slug"
else
  bad "_cl_roster_ids: expected workspace_id+pot_home_slug predicate, got: $sql"
fi

# ── _rv_roster_empty (deb-hetzner-revocation.sh) ─────────────────────────────
reset_env; STUB_ROWS="0"
_rv_roster_empty a; rc=$?
sql="$(cat "$SQL_LOG")"
if [ "$rc" = 0 ] && grep -q "workspace_id='workspace-rigdeadbeef'" <<<"$sql" && grep -q "pot_home_slug='hello-world-pot'" <<<"$sql"; then
  ok "_rv_roster_empty scopes the WI-1378 empty-roster check by workspace_id + pot_home_slug"
else
  bad "_rv_roster_empty: rc=$rc, SQL='$sql'"
fi

reset_env; STUB_ROWS="3"
_rv_roster_empty a; rc=$?
[ "$rc" = 1 ] \
  && ok "_rv_roster_empty: a non-zero scoped count reports NOT empty" \
  || bad "_rv_roster_empty: expected rc=1 for a non-zero count, got rc=$rc"

echo
if [ "$FAILS" = 0 ]; then echo "PASS — roster-scope selftest"; exit 0; fi
echo "FAIL — $FAILS check(s) failed"; exit 1
