#!/usr/bin/env bash
# b6-concurrent.selftest.sh — regression test for the concurrent_lww matrix adapter's
# failure transcript (WI-10003114).
#
# A failing concurrent_lww run prints failure-time diagnostics (PHASE2 final rows, the
# PHASE2-DIAG PG capture, rosters). The adapter used to keep only the ✓/✗/OVERALL
# projection, so every banked FAIL discarded the one capture that could name the column
# re-stamping a contested row. This test sources the shipping adapter and stubs the live
# scenario, so it is hermetic: no VM, SSH, PG, Docker, or network access.
#
#   bash bin/lib/b6-concurrent.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCEN="$DIR/scenarios/b6-concurrent.sh"
[ -f "$SCEN" ] || { echo "SKIP: scenario file not found at $SCEN"; exit 0; }
DESKTOP_DIR="$(cd "$DIR/../.." && pwd)"

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

matrix_register() { :; }
# shellcheck disable=SC1090
source "$SCEN" >/dev/null 2>&1

# ── 1. A failing run keeps the failure-time diagnostics AND ends on the key lines ──
scenario_concurrent_lww() {
  printf '%s\n' \
    '  ✓ PHASE 1 PASS — both peers hold BOTH keys' \
    'PHASE2 final: a=[B-side-write|done|001:00000:aaaa|1] origin=remote count=1' \
    'PHASE2 final: b=[B-side-write|done|002:00000:bbbb|2] origin=local count=1' \
    '  ✗ PHASE 2 FAIL — no convergence (a=[x] b=[y] cnt a=1 b=1)' \
    'PHASE2 timing: samples=100 matches=8' \
    '  ▸ PHASE2-DIAG: failure-time PG capture (row + sender outbox + receiver refusal counters)' \
    'row a: terminal_owner=DIAG-SENTINEL-A authority=committed' \
    '--- b roster ---' \
    'OVERALL: INCOMPLETE'
  return 6
}
out="$(scn_concurrent_lww 2>&1)"
rc=$?
if [ "$rc" = 6 ] \
  && grep -Fq 'failure-time diagnostics:' <<<"$out" \
  && grep -Fq 'DIAG-SENTINEL-A' <<<"$out" \
  && grep -Fq 'PHASE2 final: b=[B-side-write|done|002:00000:bbbb|2]' <<<"$out" \
  && grep -Fq -- '--- b roster ---' <<<"$out"; then
  ok "failing run retains the PHASE2 final rows, PHASE2-DIAG capture and rosters"
else
  bad "failing run lost failure-time diagnostics: rc=$rc out='$out'"
fi

last="$(printf '%s\n' "$out" | tail -n 1)"
if grep -Fq 'OVERALL: INCOMPLETE' <<<"$last" \
  && grep -Fq 'concurrent writes / LWW FAIL — key lines:' <<<"$out" \
  && grep -Fq '✗ PHASE 2 FAIL' <<<"$out"; then
  ok "key lines still close the transcript (matrix tail excerpt unchanged)"
else
  bad "key lines no longer close the transcript: last='$last'"
fi

# ── 2. Success remains terse ──────────────────────────────────────────────────
scenario_concurrent_lww() {
  printf '%s\n' '  ✓ PHASE 2 PASS' 'PHASE2 final: a=[w] origin=local count=1' 'OVERALL: PASS'
  return 0
}
out="$(scn_concurrent_lww 2>&1)"
rc=$?
if [ "$rc" = 0 ] && grep -Fq 'concurrent writes OK' <<<"$out" && ! grep -Fq 'PHASE2 final' <<<"$out"; then
  ok "successful run keeps its concise summary"
else
  bad "successful run changed: rc=$rc out='$out'"
fi

if [ "$FAILS" -eq 0 ]; then echo "PASS b6-concurrent selftest"; exit 0; fi
echo "FAIL b6-concurrent selftest ($FAILS)"; exit 1
