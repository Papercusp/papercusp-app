#!/usr/bin/env bash
# b5-restart.selftest.sh — regression test for the restart_durability matrix
# adapter's failure transcript (EI-21115093867849562).
#
# A failing restart_durability run contains useful passing and failing asserts.
# The adapter used to retain only the ✗/OVERALL projection, throwing away every
# ✓ line before the matrix's per-scenario log could capture it. This test sources
# the shipping adapter and stubs the live scenario, so it is hermetic: no VM,
# SSH, PG, Docker, or network access.
#
#   bash bin/lib/b5-restart.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCEN="$DIR/scenarios/b5-restart.sh"
[ -f "$SCEN" ] || { echo "SKIP: scenario file not found at $SCEN"; exit 0; }
# The production adapter expects the matrix to seed DESKTOP_DIR before sourcing;
# provide that same root explicitly so nounset turns missing test setup into a
# readable failure instead of terminating during the source.
DESKTOP_DIR="$(cd "$DIR/../.." && pwd)"

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

# The scenario adapter registers itself at source time; avoid requiring the real
# matrix runner while still sourcing the exact production file under test.
matrix_register() { :; }
# shellcheck disable=SC1090
source "$SCEN" >/dev/null 2>&1

# ── 1. A failing run keeps both passing and failing assertion lines ───────────
scenario_restart_durability() {
  printf '%s\n' \
    '  ✓ assert-one' \
    '  ✓ assert-three' \
    '  ✗ assert-two' \
    'OVERALL: INCOMPLETE'
  return 1
}
out="$(scn_restart_durability a b 2>&1)"
rc=$?
if [ "$rc" = 1 ] \
  && grep -Fq 'restart durability FAIL — key lines:' <<<"$out" \
  && grep -Fq '✗ assert-two' <<<"$out" \
  && grep -Fq 'OVERALL: INCOMPLETE' <<<"$out"; then
  ok "failing run retains the key failure projection"
else
  bad "failing run lost key lines: rc=$rc out='$out'"
fi

if grep -Fq '── full assert transcript (all ✓/✗) ──' <<<"$out" \
  && grep -Fq '✓ assert-one' <<<"$out" \
  && grep -Fq '✓ assert-three' <<<"$out"; then
  ok "failing run retains every passing assertion in the full transcript"
else
  bad "failing run lost passing assertions: out='$out'"
fi

# ── 2. Success remains terse and does not leak the captured raw transcript ───
scenario_restart_durability() {
  printf '%s\n' '  ✓ assert-one' 'OVERALL: PASS'
  return 0
}
out="$(scn_restart_durability a b 2>&1)"
rc=$?
if [ "$rc" = 0 ] \
  && grep -Fq 'restart durability OK' <<<"$out" \
  && ! grep -Fq 'assert-one' <<<"$out"; then
  ok "successful run keeps its existing concise summary"
else
  bad "successful run changed unexpectedly: rc=$rc out='$out'"
fi

# ── 3. WI-40553 static guards: PostgreSQL must finish its own shutdown ────────
# These checks are intentionally source-level and hermetic.  A live smoke can
# miss the exact regression this item fixes: a fixed-shortcut teardown that
# sends a hard kill or removes postmaster.pid while PostgreSQL is checkpointing.
RIG_LIB="$DIR/deb-hetzner-rig.sh"
static_guard() {
  local label="$1" needle="$2"
  if [ -f "$RIG_LIB" ] && grep -Fq "$needle" "$RIG_LIB"; then
    ok "$label"
  else
    bad "$label (missing '$needle')"
  fi
}

static_guard "postgres stop requests SIGINT on the postmaster PID" \
  'kill -INT "$pg_pid" 2>/dev/null || true'
static_guard "postgres stop waits for the actual postmaster exit" \
  'while kill -0 "$pg_pid" 2>/dev/null; do'
static_guard "postgres stop fails closed without SIGKILL on timeout" \
  'refusing SIGKILL and preserving pgdata'

stop_calls=0
if [ -f "$RIG_LIB" ]; then
  stop_calls="$(grep -Fc 'rig_stop_postgres_gracefully "$ip" || return 1' "$RIG_LIB" || true)"
fi
if [ "$stop_calls" -ge 2 ]; then
  ok "both sidecar stop paths use graceful PostgreSQL shutdown"
else
  bad "both sidecar stop paths use graceful PostgreSQL shutdown (calls=$stop_calls)"
fi

stop_line=""
launch_line=""
if [ -f "$RIG_LIB" ]; then
  stop_line="$(grep -nF 'rig_stop_postgres_gracefully "$ip" || return 1' "$RIG_LIB" | tail -n1 | cut -d: -f1 || true)"
  launch_line="$(grep -nF 'relaunched as pcusp (no wipe)' "$RIG_LIB" | head -n1 | cut -d: -f1 || true)"
fi
if [ -n "$stop_line" ] && [ -n "$launch_line" ] && [ "$stop_line" -lt "$launch_line" ]; then
  ok "restart sidecar stops PostgreSQL before relaunch"
else
  bad "restart sidecar stops PostgreSQL before relaunch (stop=$stop_line launch=$launch_line)"
fi

echo "── b5-restart.selftest: $((8 - FAILS))/8 passed ──"
if [ "$FAILS" = 0 ]; then
  echo "OVERALL: PASS"
  exit 0
fi
echo "OVERALL: FAIL ($FAILS failing)"
exit 1
