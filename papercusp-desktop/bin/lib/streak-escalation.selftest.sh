#!/usr/bin/env bash
# streak-escalation.selftest.sh — regression test for the WI-39354 detector-gap
# fix in bin/live-federation-gate.sh: _streak_scan() / check_streak_escalation().
#
# WHY: the gate's per-reason filings (RED_REFILE_H / find_open_duplicate, WI-39604's
# conditionKey refresh) are correct to go quiet on a REPEAT of the same reason — but
# that also meant NOTHING computed the streak's own length, so 50 consecutive
# non-GREEN verdicts over 2.5 days (2026-08-13..08-16, all four legs "?") produced
# exactly one quiet, already-seen work item and zero escalation. This test exercises
# the REAL shipped functions (extracted + eval'd from the gate source, per the
# established local-matrix-starvation.selftest.sh pattern) against synthetic
# verdicts.jsonl fixtures, with file_ei() stubbed so no network call or real
# work_items:create fires.
#
#   bash bin/lib/streak-escalation.selftest.sh   # exit 0 = PASS, 1 = FAIL
#
# Why a bash self-test and not Vitest: the unit under test is bash + an embedded
# python3 heredoc. Mirrors federation-asserts.selftest.sh /
# local-matrix-starvation.selftest.sh — the four canonical TS/Cargo/LLM frameworks
# don't host shell units.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$DIR/../live-federation-gate.sh"

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

[ -f "$GATE" ] || { echo "SKIP: gate script not found at $GATE"; exit 0; }

# ── Extract the real functions + their defaults from the shipping gate source and
#    eval them, so this test exercises the shipping code, not a copy. ──
FN_SRC="$(sed -n \
  '/^GATE_STREAK_RUNGS=/,/^GATE_STREAK_SCAN=/p;/^_streak_scan() {/,/^}/p;/^check_streak_escalation() {/,/^}/p' \
  "$GATE")"
if ! grep -q '^_streak_scan() {' <<<"$FN_SRC" \
  || ! grep -q '^check_streak_escalation() {' <<<"$FN_SRC" \
  || ! grep -q '^GATE_STREAK_RUNGS=' <<<"$FN_SRC"; then
  echo "SKIP: could not extract streak-escalation functions from $GATE (refactored/renamed?)"
  echo "      → if they were intentionally reshaped, update this selftest to match."
  exit 0
fi
eval "$FN_SRC"

WORK="$(mktemp -d /tmp/streak-selftest.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
STATE_DIR="$WORK/state"; mkdir -p "$STATE_DIR"
GATE_VERDICT_LOG="$WORK/verdicts.jsonl"
GATE_STREAK_SCAN=200

# leg helper: all-"?" vs a real result
DARK_LEGS='{"content_matrix":"?","from_repo":"?","from_repo_witness":"?","local_matrix":"?"}'
RAN_LEGS='{"content_matrix":"PASS","from_repo":"PASS","from_repo_witness":"PASS","local_matrix":"SKIPPED"}'
line() { # <verdict> <legs-json>
  printf '{"ts":"2026-08-30T00:00:00Z","verdict":"%s","legs":%s}\n' "$1" "$2"
}

# ── Case 1: nongreen streak counts back to (but not past) the last GREEN ──
: >"$GATE_VERDICT_LOG"
{ line GREEN "$RAN_LEGS"; line RED "$DARK_LEGS"; line RED "$DARK_LEGS"; line BLOCKED "$DARK_LEGS"; } >>"$GATE_VERDICT_LOG"
got="$(_streak_scan nongreen)"
[ "$got" = 3 ] && ok "nongreen streak counts back to the last GREEN (got 3)" \
  || bad "nongreen streak should be 3, got '$got'"

# ── Case 2: a GREEN resets it to 0 ──
{ line RED "$DARK_LEGS"; line GREEN "$RAN_LEGS"; } >>"$GATE_VERDICT_LOG"
got="$(_streak_scan nongreen)"
[ "$got" = 0 ] && ok "nongreen streak resets to 0 immediately after a GREEN" \
  || bad "nongreen streak should be 0 right after GREEN, got '$got'"

# ── Case 3: FRESH (plain) is treated as green-equivalent — no false alarm on the
#    gate's healthiest, cheapest path (a cached-green early exit). ──
: >"$GATE_VERDICT_LOG"
{ line RED "$DARK_LEGS"; line RED "$DARK_LEGS"; line GREEN "$RAN_LEGS"; line FRESH "$DARK_LEGS"; line FRESH "$DARK_LEGS"; } >>"$GATE_VERDICT_LOG"
got="$(_streak_scan nongreen)"
[ "$got" = 0 ] && ok "FRESH after a GREEN does not manufacture a nongreen streak (got 0)" \
  || bad "FRESH after GREEN should read nongreen=0 (healthy, just cached), got '$got'"

# ── Case 4: FRESH-RED / lock-contention skips are uninformative — they neither
#    count NOR reset a real streak sitting behind them (mirrors green-checkpoint's
#    own noop-exclusion precedent, EI-19405864032365760 / EI-21462211894072863). ──
: >"$GATE_VERDICT_LOG"
{ line RED "$DARK_LEGS"; line RED "$DARK_LEGS"; line RED "$DARK_LEGS"; \
  line FRESH-RED "$DARK_LEGS"; line SKIPPED-GATE-IN-FLIGHT "$DARK_LEGS"; \
  line SKIPPED-RIG-BUSY "$DARK_LEGS"; } >>"$GATE_VERDICT_LOG"
got="$(_streak_scan nongreen)"
[ "$got" = 3 ] && ok "FRESH-RED/lock-contention skips are invisible to the streak (still 3, not 6 and not 0)" \
  || bad "nongreen streak should skip-not-count-not-reset on FRESH-RED/lock-contention, expected 3 got '$got'"

# ── Case 5: dark streak only counts genuinely all-'?' attempts, excluding FRESH* ──
: >"$GATE_VERDICT_LOG"
{ line RED "$DARK_LEGS"; line BLOCKED "$DARK_LEGS"; line FRESH-RED "$DARK_LEGS"; line TERMINATED "$DARK_LEGS"; } >>"$GATE_VERDICT_LOG"
got="$(_streak_scan dark)"
[ "$got" = 3 ] && ok "dark streak counts genuine all-'?' attempts, skipping FRESH-RED (got 3)" \
  || bad "dark streak should be 3 (FRESH-RED excluded), got '$got'"

# ── Case 6: dark streak stops at the first tick where at least one real leg ran —
#    a from-repo/content-matrix PASS/FAIL means the gate did NOT abort before the
#    merits that tick, even if the overall verdict was still non-green (e.g. RED on
#    a different leg). ──
: >"$GATE_VERDICT_LOG"
{ line RED "$RAN_LEGS"; line RED "$DARK_LEGS"; line RED "$DARK_LEGS"; } >>"$GATE_VERDICT_LOG"
got="$(_streak_scan dark)"
[ "$got" = 2 ] && ok "dark streak stops the moment a real leg result appears further back (got 2)" \
  || bad "dark streak should stop at 2 once a real-leg tick is hit walking backward, got '$got'"

# ── Case 7: check_streak_escalation files exactly once per newly-crossed rung, via
#    the real file_ei()+conditionKey contract, and does not re-file on a later tick
#    that has not crossed a NEW rung. ──
file_ei() { # stub: record (title, body, conditionKey) instead of a real curl/EI
  echo "FILED::${1}::${3:-<no-conditionKey>}" >>"$WORK/filed.log"
  return 0
}
: >"$GATE_VERDICT_LOG"
GATE_STREAK_RUNGS="3 5"
for _ in 1 2; do line RED "$DARK_LEGS"; done >>"$GATE_VERDICT_LOG"   # streak=2, below rung 3
: >"$WORK/filed.log"
check_streak_escalation
[ ! -s "$WORK/filed.log" ] && ok "no filing below the first rung (streak=2, rung=3)" \
  || bad "unexpected filing below the first rung: $(cat "$WORK/filed.log")"

line RED "$DARK_LEGS" >>"$GATE_VERDICT_LOG"   # streak=3, crosses rung 3
: >"$WORK/filed.log"
check_streak_escalation
filed_count="$(wc -l <"$WORK/filed.log" | tr -d ' ')"
[ "$filed_count" = 2 ] && ok "crossing rung 3 files exactly 2 (nongreen + dark) with distinct conditionKeys" \
  || bad "expected exactly 2 filings crossing rung 3 (nongreen+dark), got $filed_count: $(cat "$WORK/filed.log" 2>/dev/null)"
grep -q 'live-fed-gate-streak-nongreen-3:papercusp' "$WORK/filed.log" \
  && ok "nongreen filing carries the rung-scoped conditionKey" \
  || bad "nongreen filing missing expected conditionKey live-fed-gate-streak-nongreen-3:papercusp"
grep -q 'live-fed-gate-streak-dark-3:papercusp' "$WORK/filed.log" \
  && ok "dark filing carries the rung-scoped conditionKey" \
  || bad "dark filing missing expected conditionKey live-fed-gate-streak-dark-3:papercusp"

# a REPEAT tick at the same streak length (still 3, rung already escalated) must NOT re-file
: >"$WORK/filed.log"
check_streak_escalation
[ ! -s "$WORK/filed.log" ] && ok "repeat tick at an already-escalated rung does not re-file" \
  || bad "unexpected re-file at an unchanged streak: $(cat "$WORK/filed.log")"

# crossing rung 5 escalates AGAIN, distinctly
for _ in 1 2; do line RED "$DARK_LEGS"; done >>"$GATE_VERDICT_LOG"   # streak=5
: >"$WORK/filed.log"
check_streak_escalation
grep -q 'live-fed-gate-streak-nongreen-5:papercusp' "$WORK/filed.log" \
  && ok "crossing rung 5 escalates again with its own conditionKey" \
  || bad "expected a rung-5 filing, got: $(cat "$WORK/filed.log" 2>/dev/null)"

# ── Case 8: a GREEN clears the escalation markers, so a LATER unrelated bad streak
#    re-escalates from rung 1 instead of finding every rung pre-marked. ──
line GREEN "$RAN_LEGS" >>"$GATE_VERDICT_LOG"
check_streak_escalation   # streak=0 tick: must clear markers, must not file
[ ! -f "$STATE_DIR/streak-escalated-nongreen-3" ] && ok "GREEN clears the nongreen-3 escalation marker" \
  || bad "nongreen-3 marker survived a GREEN — a later streak would silently skip re-escalating it"
for _ in 1 2 3; do line RED "$DARK_LEGS"; done >>"$GATE_VERDICT_LOG"  # fresh streak=3
: >"$WORK/filed.log"
check_streak_escalation
grep -q 'live-fed-gate-streak-nongreen-3:papercusp' "$WORK/filed.log" \
  && ok "a fresh bad streak after a GREEN re-escalates from rung 1" \
  || bad "fresh post-GREEN streak did not re-escalate at rung 3: $(cat "$WORK/filed.log" 2>/dev/null)"

# ── Case 9: an unparsable trailing line ends the scan rather than mis-counting past
#    it (matches the documented behavior — never silently skip over garbage). ──
: >"$GATE_VERDICT_LOG"
{ line GREEN "$RAN_LEGS"; line RED "$DARK_LEGS"; echo 'not-json-garbage'; line RED "$DARK_LEGS"; line RED "$DARK_LEGS"; } >>"$GATE_VERDICT_LOG"
got="$(_streak_scan nongreen)"
[ "$got" = 2 ] && ok "an unparsable line ends the backward scan (got 2, not 3)" \
  || bad "expected the scan to stop at the garbage line (2), got '$got'"

# ── Case 10: check_streak_escalation is a safe no-op when file_ei is not yet
#    defined (the one early verdict() call in the gate, at the REFUSED-PREEMPT
#    path, runs before file_ei() is defined later in the file) — must not error. ──
unset -f file_ei 2>/dev/null || true
: >"$GATE_VERDICT_LOG"
for _ in 1 2 3 4 5; do line RED "$DARK_LEGS"; done >>"$GATE_VERDICT_LOG"
if out="$(check_streak_escalation 2>&1)"; then
  ok "check_streak_escalation no-ops cleanly when file_ei is not yet defined"
else
  bad "check_streak_escalation should return 0 (not error) when file_ei is undefined: $out"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "PASS: streak-escalation selftest (WI-39354)"
  exit 0
else
  echo "FAIL: $FAILS check(s) failed"
  exit 1
fi
