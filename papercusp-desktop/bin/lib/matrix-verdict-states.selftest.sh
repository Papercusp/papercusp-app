#!/usr/bin/env bash
# matrix-verdict-states.selftest.sh — regression test for the three-state scenario
# verdict in bin/deb-hetzner-matrix.sh (WI-6046).
#
# WHY: the matrix used to classify every scenario as PASS (rc=0) or FAIL (anything
# else). A scenario that RAN but could not hold its own PRECONDITION therefore
# scored as a product FAIL — a false-FAIL indistinguishable from a real break. It
# red-pinned the gate on a rig-side setup problem, and in release evidence it read
# as a defect in the feature the leg never actually exercised. Observed on
# attestation_unattested_device, whose own log said "PRECONDITION UNHOLDABLE ...
# NOT a product defect" while the matrix row above it said FAIL.
#
# rc=2 = "not measured" was already ratified for the discovery layer
# (federation-asserts.selftest.sh, WI-6012 / EI-18687938054040755: "no OVERALL
# scores unmeasured discovery as FAIL") but was never wired at the scenario/runner
# layer. This guards the wiring.
#
# THE INVARIANT, in three parts, because the failure has three distinct shapes:
#   1. rc=2 must NOT be a FAIL      — else a rig problem reads as a product defect
#   2. rc=2 must NOT be a PASS      — else the run claims coverage it never measured
#   3. rc=1 must STILL be a FAIL    — else the fix has disarmed the gate entirely
# (3) is the one a careless "just stop failing on preconditions" patch breaks, and
# it is the only one whose breakage is silent.
#
# HOW: this does not paraphrase the logic — a paraphrase passes happily while the
# shipped file is broken, which is exactly the class of bug being fixed here. It
# slices the REAL verdict block out of the subject file and runs it against stubbed
# scenario results. Same reason local-matrix-bank.selftest.sh drives the real script.
#
#   bash bin/lib/matrix-verdict-states.selftest.sh   # exit 0 = PASS
#
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable subject, like local-matrix-bank.selftest.sh's LOCAL_MATRIX_SCRIPT —
# it is what makes a falsifiability probe possible against a COPY, without ever
# mutating the shared tree (scripts/mutation-probe.sh tier 2).
SCRIPT="${MATRIX_SCRIPT:-$DIR/../deb-hetzner-matrix.sh}"

fails=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fails=$((fails + 1)); }

echo "── matrix-verdict-states.selftest: WI-6046 PASS/FAIL/UNMEASURED ──"
[ -f "$SCRIPT" ] || { echo "FAIL — subject not found: $SCRIPT" >&2; exit 1; }

# Slice the real verdict block: from the counter init to the terminal FAIL exit.
slice() {
  local first last
  first="$(grep -n '^fails=0; passes=0' "$SCRIPT" | head -1 | cut -d: -f1)"
  last="$(grep -n '^echo "OVERALL: FAIL — see per-scenario logs' "$SCRIPT" | head -1 | cut -d: -f1)"
  if [ -z "$first" ] || [ -z "$last" ]; then
    echo "SLICE_ANCHOR_LOST" >&2; return 1
  fi
  sed -n "${first},$((last + 1))p" "$SCRIPT"
}

# run <body> <spec...> -> "<exit>|<stdout>"; spec = id:rc:line, or id:skip:reason
run_block() {
  local body="$1"; shift
  local pre="declare -a RUN_IDS=() SKIP_IDS=() MATRIX_IDS=(); declare -A SCN_RC SCN_LINE SKIP_REASON MATRIX_ORDER; RIG_WORK=/tmp/matrix-verdict-selftest;"
  local spec id rc line
  for spec in "$@"; do
    IFS=: read -r id rc line <<<"$spec"
    if [ "$rc" = "skip" ]; then
      pre="$pre SKIP_IDS+=($id); SKIP_REASON[$id]='$line'; MATRIX_IDS+=($id);"
    else
      pre="$pre RUN_IDS+=($id); SCN_RC[$id]=$rc; SCN_LINE[$id]='$line'; MATRIX_IDS+=($id);"
    fi
  done
  local out ec
  out="$(bash -c "$pre
$body" 2>&1)"; ec=$?
  printf '%s|%s' "$ec" "$out"
}

BODY="$(slice)" || { echo "FAIL — could not locate the verdict block in $SCRIPT (anchors moved?)" >&2; exit 1; }

expect() { # <label> <want-exit> <must-contain> <must-not-contain|-> <result>
  local label="$1" xec="$2" want="$3" nwant="$4" res="$5"
  local ec="${res%%|*}" out="${res#*|}" why=""
  [ "$ec" = "$xec" ] || why="exit=$ec want=$xec"
  case "$out" in *"$want"*) ;; *) why="$why; missing '$want'" ;; esac
  [ "$nwant" != "-" ] && case "$out" in *"$nwant"*) why="$why; must NOT contain '$nwant'" ;; esac
  [ -z "$why" ] && ok "$label" || bad "$label — $why"
}

# ── CONTROL FIRST ─────────────────────────────────────────────────────────────
# Prove this guard can actually FAIL before trusting any green below. The mutant
# deletes the rc=2 arm, restoring the exact WI-6046 defect (rc=2 falls through to
# FAIL). Mutating the SLICED TEXT IN MEMORY, never the file: a probe that edits the
# shared tree can be committed by a git-sync sweep even when nothing goes wrong.
MUTANT="$(printf '%s' "$BODY" | grep -v 'elif \[ "${SCN_RC\[\$id\]}" -eq 2 \]')"
if [ "$MUTANT" = "$BODY" ]; then
  bad "CONTROL: could not build the mutant (the rc=2 arm did not match) — every green below is a tautology"
else
  R="$(run_block "$MUTANT" 'alpha:0:fine' 'beta:2:precondition unholdable')"
  if [ "${R%%|*}" = 1 ] && case "${R#*|}" in *"FAIL  beta"*) true ;; *) false ;; esac; then
    ok "CONTROL: removing the rc=2 arm DOES reintroduce the defect (rc=2 → FAIL, exit 1) — this guard is falsifiable"
  else
    bad "CONTROL DID NOT FIRE — the mutant still behaved correctly, so this guard proves nothing (exit=${R%%|*})"
  fi
fi

# ── 1. rc=2 is not a FAIL ─────────────────────────────────────────────────────
expect "rc=2 renders its own UNMS row, not FAIL" \
  0 'UNMS  beta' 'FAIL  beta' \
  "$(run_block "$BODY" 'alpha:0:fine' 'beta:2:precondition unholdable')"
expect "rc=2 alone does not red-pin the run (exit 0)" \
  0 'OVERALL: PASS' '-' \
  "$(run_block "$BODY" 'alpha:0:fine' 'beta:2:precondition unholdable')"

# ── 2. rc=2 is not a PASS either ──────────────────────────────────────────────
expect "rc=2 is NOT counted as a pass" \
  0 '1 passed, 0 failed, 1 unmeasured' '2 passed' \
  "$(run_block "$BODY" 'alpha:0:fine' 'beta:2:precondition unholdable')"
expect "a run with an UNMEASURED scenario must not claim full-matrix coverage" \
  0 'NOT full-matrix coverage' '-' \
  "$(run_block "$BODY" 'alpha:0:fine' 'beta:2:precondition unholdable')"
expect "the unmeasured scenario is NAMED in the verdict, not merely counted" \
  0 'beta' '-' \
  "$(run_block "$BODY" 'alpha:0:fine' 'beta:2:precondition unholdable')"

# ── 3. a real failure still fails (the silent-disarm guard) ───────────────────
expect "rc=1 still renders FAIL and still exits 1" \
  1 'FAIL  delta' '-' \
  "$(run_block "$BODY" 'alpha:0:fine' 'delta:1:genuinely broken')"
expect "an UNMEASURED scenario never masks a real FAIL in the same run" \
  1 'OVERALL: FAIL' '-' \
  "$(run_block "$BODY" 'beta:2:unholdable' 'delta:1:genuinely broken')"
expect "  …and both rows still render distinctly in that mixed run" \
  1 'UNMS  beta' '-' \
  "$(run_block "$BODY" 'beta:2:unholdable' 'delta:1:genuinely broken')"

# ── 4. no regression in the pre-existing states ───────────────────────────────
expect "an all-green run still reports clean full coverage" \
  0 'every live federation scenario green' 'NOT full-matrix coverage' \
  "$(run_block "$BODY" 'alpha:0:fine' 'gamma:0:fine')"
expect "a pre-run SKIP still renders and is still disclaimed" \
  0 'SKIP  zeta' '-' \
  "$(run_block "$BODY" 'alpha:0:fine' 'zeta:skip:needs 3 frames, have 2')"

# ── 5. the roll-call must not trip on the new state ───────────────────────────
# UNMEASURED scenarios stay in RUN_IDS (they ran), so accounted = RUN+SKIP is still
# correct. Pinned because the tempting implementation — appending them to SKIP_IDS
# to reuse its renderer — double-counts and hard-exits the whole matrix with a
# "runner bug" message, converting one mis-scored leg into a total run failure.
expect "roll-call still reconciles when a scenario is UNMEASURED" \
  0 'OVERALL: PASS' 'ROLL-CALL MISMATCH' \
  "$(run_block "$BODY" 'alpha:0:fine' 'beta:2:unholdable' 'zeta:skip:no frames')"

# ── 6. the scenario side: b9 must actually EMIT rc=2, parseably ───────────────
# The runner arm above is dead code if no scenario ever returns 2. Pin the one
# producer that motivated it, in the shape the runner can actually read.
SCN="$DIR/scenarios/b9-attestation.sh"
if [ -f "$SCN" ]; then
  grep -q 'return 2' "$SCN" \
    && ok "b9-attestation.sh returns 2 (not 1) on the unholdable-precondition path" \
    || bad "b9-attestation.sh no longer returns 2 — the runner's UNMS arm is now unreachable for this leg"
  # deb-hetzner-matrix.sh draws a non-zero row's message from an 'OVERALL:' line,
  # else a '✗' line, else a labelled fallback. The unholdable verdict carried
  # NEITHER, so the row rendered "(rc=1; log has no OVERALL:/✗ line)" — a verdict
  # with no reason attached, which is what hid this for four runs.
  grep -q 'OVERALL: UNMEASURED' "$SCN" \
    && ok "the unholdable verdict is emitted on a parseable OVERALL: line" \
    || bad "the unholdable verdict lost its OVERALL: prefix — the matrix row will fall back to 'log has no OVERALL:/✗ line' and carry no reason"
  # A line that says both "PRECONDITION UNHOLDABLE" and "FAIL" is the original
  # self-contradiction: the prose says not-a-product-defect while the label says FAIL.
  unholdable_lines="$(grep -vE '^[[:space:]]*#' "$SCN" | grep -E 'PRECONDITION UNHOLDABLE' || true)"
  if grep -q 'FAIL' <<<"$unholdable_lines"; then
    bad "a live unholdable verdict line still self-labels FAIL — that is the WI-6046 contradiction returning"
  else
    ok "no live unholdable verdict line self-labels FAIL"
  fi
else
  bad "expected scenario file not found: $SCN"
fi

echo
if [ "$fails" = 0 ]; then
  echo "PASS — matrix-verdict-states selftest (all checks)"
  exit 0
fi
echo "FAIL — matrix-verdict-states selftest: $fails check(s) failed"
exit 1
