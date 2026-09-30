#!/usr/bin/env bash
# rig-wait-converged.selftest.sh — regression test for the EI-18661870528779127
# pre-scenario join-convergence barrier (rig_wait_converged in deb-hetzner-rig.sh).
#
# Lives in bin/lib/ (not bin/lib/scenarios/) for the same reason
# restart-settle-barrier.selftest.sh does: deb-hetzner-matrix.sh's
# source_scenarios() sources EVERY bin/lib/scenarios/*.sh at the top of a real
# run, so a selftest living there would be swept in and its stubbed
# drv_psql/fed_log would silently clobber the real ones for the whole live run.
#
# Sources the REAL rig lib (the shipping code, not a copy) and exercises
# rig_wait_converged() against a STUBBED drv_psql, so this never touches a real
# rig/SSH/PG — purely local, <1s. Thresholds are driven to 0 rather than waiting,
# and `sleep` is stubbed out, so the slow/never-converge branches cost no wall time.
#
#   bash bin/lib/rig-wait-converged.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$DIR/deb-hetzner-rig.sh"
[ -f "$LIB" ] || { echo "SKIP: rig lib not found at $LIB"; exit 0; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

fed_log() { : ; }

# shellcheck disable=SC1090
source "$LIB" >/dev/null 2>&1 || true

# ── stubs MUST come after the source: the rig lib defines the real drv_psql. ──
SQL_LOG="$(mktemp)"

# STUB_ROWS_SEQ — space-separated values drv_psql returns on successive calls;
# the LAST value repeats once the sequence is exhausted.
#
# The call counter MUST live in a file, not a variable: rig_wait_converged reads
# us as `rows="$(drv_psql ... | tr ...)"`, i.e. a pipeline inside a command
# substitution, so we run two subshells deep and any variable increment is
# discarded on every iteration. A shell-variable counter silently pins the stub
# to seq[0] forever — which, with `sleep` stubbed to a no-op (so wall-clock
# barely advances and the fail deadline is never reached), hangs the test rather
# than failing it.
STUB_IDX_F="$(mktemp)"
trap 'rm -f "$SQL_LOG" "$STUB_IDX_F"' EXIT
drv_psql() {
  printf '%s\n' "$2" >>"$SQL_LOG"
  local -a seq=($STUB_ROWS_SEQ)
  local i n; n="${#seq[@]}"
  i="$(cat "$STUB_IDX_F" 2>/dev/null)"; [ -n "$i" ] || i=0
  printf '%s' "$((i + 1))" >"$STUB_IDX_F"
  [ "$i" -ge "$n" ] && i=$((n - 1))
  printf '%s\n' "${seq[$i]}"
}
sleep() { : ; }
fed_log() { : ; }

reset_env() {
  printf '0' >"$STUB_IDX_F"; STUB_ROWS_SEQ="1"
  RIG_CONVERGE_WARN_S=60; RIG_CONVERGE_FAIL_S=420
  RIG_HIVE_ID="hello-world-pot"
  : >"$SQL_LOG"
}

# ── 1. immediate convergence → PASS, ✓ line, no false SLOW warning ───────────
reset_env; STUB_ROWS_SEQ="1"
out="$(rig_wait_converged b)"; rc=$?
[ "$rc" = 0 ] && grep -q "✓ a→b converged" <<<"$out" && ! grep -q "SLOW" <<<"$out" \
  && ok "immediate convergence → PASS, no spurious SLOW warning" \
  || bad "immediate: rc=$rc out='$out'"

# ── 2. converges only after several polls → still PASS (loop actually loops) ──
reset_env; STUB_ROWS_SEQ="0 0 0 2"
out="$(rig_wait_converged b)"; rc=$?
[ "$rc" = 0 ] && grep -q "✓ a→b converged" <<<"$out" && grep -q "2 membership row" <<<"$out" \
  && ok "converges after N polls → PASS and reports the real row count" \
  || bad "polled convergence: rc=$rc out='$out'"

# ── 3. converged but SLOW → still PASS, but loudly warns (instrument-not-mute) ─
reset_env; STUB_ROWS_SEQ="1"; RIG_CONVERGE_WARN_S=0
out="$(rig_wait_converged b)"; rc=$?
[ "$rc" = 0 ] && grep -q "⚠" <<<"$out" && grep -q "SLOW" <<<"$out" \
  && ok "slow-but-converged → PASS with a loud ⚠ (WI-5444 instrument-not-mute)" \
  || bad "slow case: rc=$rc out='$out'"

# ── 4. never converges → hard FAIL, with triage + the do-NOT-raise guardrail ──
reset_env; STUB_ROWS_SEQ="0"; RIG_CONVERGE_FAIL_S=0
out="$(rig_wait_converged b)"; rc=$?
[ "$rc" = 1 ] && grep -q "NEVER CONVERGED" <<<"$out" \
  && grep -q "Do NOT raise RIG_CONVERGE_FAIL_S" <<<"$out" \
  && grep -q "EI-18661870528779127" <<<"$out" \
  && ok "never converges → hard FAIL carrying triage + the do-not-raise guardrail" \
  || bad "never-converge: rc=$rc out='$out'"

# ── 5. a psql error / empty output must count as 0, never a false PASS ───────
for junk in "" "ERROR:  relation does not exist" "psql: could not connect"; do
  reset_env; STUB_ROWS_SEQ="$junk"; RIG_CONVERGE_FAIL_S=0
  out="$(rig_wait_converged b)"; rc=$?
  [ "$rc" = 1 ] \
    && ok "non-numeric psql output ('${junk:0:24}') → treated as 0, not a false PASS" \
    || bad "junk output '${junk}' produced rc=$rc (expected 1)"
done

# ── 6. no pot slug in scope → must NOT emit an unsatisfiable pot_home_slug='' ─
reset_env; RIG_HIVE_ID=""; STUB_ROWS_SEQ="1"
out="$(rig_wait_converged b)"; rc=$?
if [ "$rc" = 0 ] && ! grep -q "pot_home_slug=''" "$SQL_LOG"; then
  ok "empty pot slug → counts any membership row (no unsatisfiable pot_home_slug='')"
else
  bad "empty pot slug: rc=$rc, SQL='$(head -1 "$SQL_LOG")'"
fi

# ── 7. pot slug in scope → the count IS scoped to that pot ───────────────────
reset_env; RIG_HIVE_ID="hello-world-pot"; STUB_ROWS_SEQ="1"
rig_wait_converged b >/dev/null 2>&1
grep -q "pot_home_slug='hello-world-pot'" "$SQL_LOG" \
  && ok "pot slug in scope → membership count is scoped to that pot" \
  || bad "pot-scoped query missing: SQL='$(head -1 "$SQL_LOG")'"

echo
if [ "$FAILS" = 0 ]; then echo "PASS — rig_wait_converged selftest"; exit 0; fi
echo "FAIL — $FAILS check(s) failed"; exit 1
