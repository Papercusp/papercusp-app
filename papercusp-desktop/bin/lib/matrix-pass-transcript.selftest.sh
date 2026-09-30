#!/usr/bin/env bash
# matrix-pass-transcript.selftest.sh — regression test for the PASS-path scenario
# transcript in bin/deb-hetzner-matrix.sh (WI-40593).
#
# WHY: on PASS the matrix surfaced only lines whose first non-space character was `·`.
# But `·` is an OPT-IN marker a scenario puts on DIAGNOSTIC rows — a scenario's own
# VERDICT lines (`✓`, `⚠`, `✗`, `OVERALL:`) do not carry it. Those were discarded and
# survived only in $RIG_WORK/scn.$id.log, which is torn down without --keep-up.
#
# That silently defeated a deliberately fail-CLOSED instrument one layer down.
# restart-settle-barrier.sh's _rsb_owner_self_classification (D-044 / WI-40534) states
# the property in its own block comment: "the query failed" and "the owner classified
# itself correctly" must never render the same way. Its ZERO-pot_members NOT-MEASURED
# branch returns 0 BEFORE printing any `·` row, so under the old filter a PASSING
# barrier rendered it as nothing at all — indistinguishable from "the instrument never
# ran". Fail-closed in source, fail-open in the artifact anyone actually reads.
#
# THE INVARIANT, in the shapes its breakage actually takes:
#   1. a PASSING scenario's `⚠ NOT MEASURED` line MUST reach the run log even when the
#      scenario emitted NO `·` row at all — the total-silence case, the serious one
#   2. it must reach it even when LATER output owns the last line, so the `✓ PASS … —
#      <last line>` channel cannot be mistaken for the fix (this is what the real
#      barrier does: it prints OVERALL: PASS after the instrument)
#   3. `·` rows must STILL be surfaced — else this "fix" silently undid WI-6057
#   4. the scenario's own line ORDER must survive (one grep pass, not several)
#   5. a `✗` sub-assertion under rc=0 must be surfaced — a scenario that passes overall
#      while one of its own checks failed is precisely what must not be hidden
#   6. the FAIL path must STILL fail loudly — (6) is what a careless "just print more"
#      patch breaks, and it is the only one whose breakage is silent
#
# HOW: this does not paraphrase the filter — a paraphrase passes happily while the
# shipped file is broken, which is the exact class of bug being fixed. It slices the
# REAL per-scenario dispatch loop out of the subject file and runs it against a stubbed
# scenario, hermetically: no VM, SSH, PG, Docker, or network. Same method as
# matrix-verdict-states.selftest.sh.
#
#   bash bin/lib/matrix-pass-transcript.selftest.sh   # exit 0 = PASS, 1 = FAIL
#
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable subject, like matrix-verdict-states.selftest.sh's MATRIX_SCRIPT — it is
# what makes a falsifiability probe possible against a COPY, without ever mutating the
# shared tree (scripts/mutation-probe.sh tier 2; git-sync sweeps the tree every few
# minutes and would commit an in-tree mutant even when nothing goes wrong).
SCRIPT="${MATRIX_SCRIPT:-$DIR/../deb-hetzner-matrix.sh}"

fails=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fails=$((fails + 1)); }

echo "── matrix-pass-transcript.selftest: WI-40593 PASS-path verdict lines ──"
[ -f "$SCRIPT" ] || { echo "FAIL — subject not found: $SCRIPT" >&2; exit 1; }

# Slice the real dispatch loop: from the verdict-array declaration to the line before
# the matrix header. Anchors are load-bearing — if either moves, this test must FAIL
# rather than silently measure nothing, so a lost anchor is a hard error.
slice() {
  local first last
  first="$(grep -n '^declare -A SCN_RC SCN_LINE$' "$SCRIPT" | head -1 | cut -d: -f1)"
  last="$(grep -n '^# ── the PASS/FAIL matrix' "$SCRIPT" | head -1 | cut -d: -f1)"
  if [ -z "$first" ] || [ -z "$last" ] || [ "$last" -le "$first" ]; then
    echo "SLICE_ANCHOR_LOST first='$first' last='$last'" >&2; return 1
  fi
  sed -n "${first},$((last - 1))p" "$SCRIPT"
}

BODY="$(slice)" || { echo "  ✗ could not slice the dispatch loop out of $SCRIPT"; echo "FAIL"; exit 1; }
case "$BODY" in
  *'for id in "${RUN_IDS[@]}"'*) : ;;
  *) echo "  ✗ slice does not contain the dispatch loop — anchors drifted"; echo "FAIL"; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# run_dispatch <rc> <scenario stdout line>... -> the dispatcher's own stdout+stderr
run_dispatch() {
  local rc="$1"; shift
  printf '%s\n' "$@" >"$WORK/payload.txt"
  local pre="declare -a RUN_IDS=(demo)
declare -A MATRIX_FN=([demo]=scn_demo) MATRIX_LABEL=([demo]='demo scenario') MATRIX_ORDER=([demo]=42)
fed_log() { :; }
rig_bank_logs() { :; }
RIG_WORK='$WORK'
scn_demo() { cat '$WORK/payload.txt'; return $rc; }
"
  bash -c "$pre
$BODY" 2>&1
}

# line_no <needle> <<<"$out" -> the 1-based line number of the first match, or empty
line_no() { grep -nF -- "$1" <<<"$2" | head -1 | cut -d: -f1; }

# ── 1+2. The total-silence case: a fail-closed NOT-MEASURED verdict, no `·` row at
#         all, and LATER output owning the last line so the `✓ PASS … — <last>` channel
#         cannot stand in for the fix. This is the shipped restart-settle-barrier shape.
out="$(run_dispatch 0 \
  '  ⚠ NOT MEASURED — ZERO pot_members rows on frame a (query ran, returned nothing)' \
  'OVERALL: PASS — settled after 26s')"
if grep -Fq '⚠ NOT MEASURED — ZERO pot_members rows' <<<"$out"; then
  ok "a PASSING scenario's NOT-MEASURED verdict reaches the run log with no '·' row present"
else
  bad "NOT-MEASURED verdict was DISCARDED on PASS — the fail-closed instrument renders silent (out='$out')"
fi
if grep -Fq 'OVERALL: PASS — settled after 26s' <<<"$out"; then
  ok "the scenario's own OVERALL: verdict is surfaced on PASS"
else
  bad "the scenario's OVERALL: verdict was discarded on PASS (out='$out')"
fi

# ── 3+4. `·` rows still surfaced (WI-6057 must not be undone), coexisting with the
#         verdict lines IN THE SCENARIO'S OWN ORDER — one grep pass, not several.
out="$(run_dispatch 0 \
  '  · a: hello-world-pot|0|AAAA=|local' \
  '  · a: hello-world-pot|1|BBBB=|local' \
  '  ✓ 0 rows origin=remote' \
  '  · settle: converged after 26s' \
  'OVERALL: PASS — settled after 26s')"
if grep -Fq '· a: hello-world-pot|0|AAAA=|local' <<<"$out" \
  && grep -Fq '· settle: converged after 26s' <<<"$out"; then
  ok "'·' diagnostic rows are still surfaced on PASS (WI-6057 not regressed)"
else
  bad "'·' rows were lost — WI-6057 regressed (out='$out')"
fi
if grep -Fq '✓ 0 rows origin=remote' <<<"$out"; then
  ok "a scenario's own '✓' verdict is surfaced on PASS"
else
  bad "a scenario's own '✓' verdict was discarded on PASS (out='$out')"
fi
n1="$(line_no '· a: hello-world-pot|1|BBBB=|local' "$out")"
n2="$(line_no '✓ 0 rows origin=remote' "$out")"
n3="$(line_no '· settle: converged after 26s' "$out")"
if [ -n "$n1" ] && [ -n "$n2" ] && [ -n "$n3" ] && [ "$n1" -lt "$n2" ] && [ "$n2" -lt "$n3" ]; then
  ok "the scenario's own line ORDER is preserved (single-pass filter)"
else
  bad "line order was reshuffled — the filter is grepping in several passes (n1=$n1 n2=$n2 n3=$n3; out='$out')"
fi

# ── 5. A '✗' sub-assertion under rc=0 — passes overall, one own check failed. Hiding
#       this is how a partially-broken scenario reads as unqualified green.
out="$(run_dispatch 0 \
  '  ✗ sub-assertion: replica lag 4s exceeds soft budget' \
  'OVERALL: PASS — 9/10 probe legs')"
if grep -Fq '✗ sub-assertion: replica lag 4s exceeds soft budget' <<<"$out"; then
  ok "a '✗' sub-assertion under rc=0 is surfaced, not hidden behind the PASS row"
else
  bad "a failing sub-assertion was hidden on a PASSING scenario (out='$out')"
fi

# ── 6. The FAIL path is untouched: it must still render ✗ FAIL and its tail dump.
#       This is the one a careless "surface more on PASS" patch breaks silently.
out="$(run_dispatch 1 \
  '  ✓ assert-one' \
  '  ✗ assert-two: roster missing device' \
  'OVERALL: INCOMPLETE — 1 assertion failed')"
if grep -Fq '✗ FAIL demo (rc=1)' <<<"$out" \
  && grep -Fq 'OVERALL: INCOMPLETE — 1 assertion failed' <<<"$out" \
  && grep -Fq '── last 12 lines of demo ──' <<<"$out"; then
  ok "the FAIL path still fails loudly, with its OVERALL: message and tail dump"
else
  bad "the FAIL path changed shape — the gate may no longer fail visibly (out='$out')"
fi

echo
if [ "$fails" -eq 0 ]; then echo "PASS — matrix-pass-transcript.selftest"; exit 0; fi
echo "FAIL — $fails assertion(s) failed"; exit 1
