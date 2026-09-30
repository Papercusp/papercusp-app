#!/usr/bin/env bash
# matrix-scenario-adapters.selftest.sh — regression test for the sibling live-matrix
# adapters' failure transcripts (EI-21116501794646084).
#
# A failed adapter run contains useful passing and failing assertions. The three
# sibling adapters used to retain only the ✗/verdict projection, throwing away every
# ✓ line before the matrix's per-scenario log could capture it. This test sources the
# shipping adapters and stubs the live scenarios, so it is hermetic: no VM, SSH, PG,
# Docker, or network access.
#
#   bash bin/lib/matrix-scenario-adapters.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCEN_DIR="$DIR/scenarios"
for scen in reconnect_catchup.sh b6-concurrent.sh b7-coord-controlplane.sh; do
  [ -f "$SCEN_DIR/$scen" ] || { echo "SKIP: scenario file not found at $SCEN_DIR/$scen"; exit 0; }
done

# The production adapters expect the matrix to seed DESKTOP_DIR before sourcing;
# provide that same root explicitly so nounset turns missing test setup into a
# readable failure instead of terminating during the source.
DESKTOP_DIR="$(cd "$DIR/../.." && pwd)"

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

# Each adapter registers itself at source time; avoid requiring the real matrix
# runner while still sourcing the exact production files under test.
matrix_register() { :; }
# shellcheck disable=SC1090
source "$SCEN_DIR/reconnect_catchup.sh" >/dev/null 2>&1
# shellcheck disable=SC1090
source "$SCEN_DIR/b6-concurrent.sh" >/dev/null 2>&1
# shellcheck disable=SC1090
source "$SCEN_DIR/b7-coord-controlplane.sh" >/dev/null 2>&1

assert_failure_transcript() {
  local fn="$1" label="$2" verdict="$3" diagnostic="${4:-}" out rc
  out="$("$fn" a b 2>&1)"
  rc=$?
  if [ "$rc" != 1 ] && [ "$rc" != 6 ]; then
    bad "$label: stubbed failure returned rc=$rc (out='$out')"
    return
  fi
  if grep -Fq '── full assert transcript (all ✓/✗) ──' <<<"$out" \
    && grep -Fq '✓ assert-one' <<<"$out" \
    && grep -Fq '✓ assert-three' <<<"$out" \
    && grep -Fq '✗ assert-two' <<<"$out" \
    && { [ -z "$diagnostic" ] || grep -Fq "$diagnostic" <<<"$out"; } \
    && grep -Fq "$verdict" <<<"$out"; then
    ok "$label: failure retains every passing assertion and its verdict"
  else
    bad "$label: failure lost transcript lines (out='$out')"
  fi
}

# ── 1. Every sibling adapter keeps both passing and failing assertions ───────
scenario_reconnect_catchup() {
  printf '%s\n' '  ✓ assert-one' '  ✓ assert-three' '  ✗ assert-two' 'OVERALL: INCOMPLETE'
  return 1
}
scenario_concurrent_lww() {
  printf '%s\n' '  ✓ assert-one' '  ✓ assert-three' '  ✗ assert-two' 'PHASE2 timing: samples=4 matches=2 mismatches=2 max_streak=2' 'OVERALL: INCOMPLETE'
  return 6
}
scenario_coord_controlplane() {
  printf '%s\n' '  ✓ assert-one' '  ✓ assert-three' '  ✗ assert-two' 'BRIEF 7 MATRIX: FAIL'
  return 1
}

assert_failure_transcript scn_reconnect_catchup "reconnect/catch-up" 'OVERALL: INCOMPLETE'
assert_failure_transcript scn_concurrent_lww "concurrent writes / LWW" 'OVERALL: INCOMPLETE' 'PHASE2 timing: samples=4 matches=2 mismatches=2 max_streak=2'
assert_failure_transcript scn_coord_controlplane "coord control-plane" 'BRIEF 7 MATRIX: FAIL'

# ── 2. Success remains terse and does not leak the captured raw transcript ───
scenario_reconnect_catchup() { printf '%s\n' '  ✓ assert-one' 'OVERALL: PASS'; return 0; }
out="$(scn_reconnect_catchup a b 2>&1)"; rc=$?
if [ "$rc" = 0 ] && grep -Fq 'reconnect/catch-up OK' <<<"$out" && ! grep -Fq 'assert-one' <<<"$out"; then
  ok "reconnect/catch-up: success remains concise"
else
  bad "reconnect/catch-up: success changed unexpectedly (rc=$rc out='$out')"
fi

scenario_concurrent_lww() { printf '%s\n' '  ✓ assert-one' 'OVERALL: PASS'; return 0; }
out="$(scn_concurrent_lww a b 2>&1)"; rc=$?
if [ "$rc" = 0 ] && grep -Fq 'concurrent writes OK' <<<"$out" && ! grep -Fq 'assert-one' <<<"$out"; then
  ok "concurrent writes / LWW: success remains concise"
else
  bad "concurrent writes / LWW: success changed unexpectedly (rc=$rc out='$out')"
fi

scenario_coord_controlplane() { printf '%s\n' '  ✓ assert-one' 'BRIEF 7 MATRIX: PASS'; return 0; }
out="$(scn_coord_controlplane a b 2>&1)"; rc=$?
if [ "$rc" = 0 ] && grep -Fq 'coord control-plane boundary OK' <<<"$out" && ! grep -Fq 'assert-one' <<<"$out"; then
  ok "coord control-plane: success remains concise"
else
  bad "coord control-plane: success changed unexpectedly (rc=$rc out='$out')"
fi

echo "── matrix-scenario-adapters.selftest: $((6 - FAILS))/6 passed ──"
if [ "$FAILS" = 0 ]; then
  echo "OVERALL: PASS"
  exit 0
fi
echo "OVERALL: FAIL ($FAILS failing)"
exit 1
