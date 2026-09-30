#!/usr/bin/env bash
# restart-settle-barrier.selftest.sh — regression test for the WI-5444 settle-
# or-repair barrier (bin/lib/scenarios/restart-settle-barrier.sh).
#
# Deliberately lives HERE (bin/lib/, not bin/lib/scenarios/) even though it
# tests a scenarios/ file: bin/deb-hetzner-matrix.sh's source_scenarios()
# sources EVERY bin/lib/scenarios/*.sh at the top of a real run — a selftest
# living inside that directory would itself get swept in and its STUBBED
# matrix_register/fed_log/_rd_origin/_rd_poll_remote would silently clobber
# the real ones for the whole live run. Mirrors
# live-federation-gate-reaper.selftest.sh, which avoids the same trap the
# same way (it tests bin/live-federation-gate.sh from outside its sweep too).
#
# Sources the REAL scenario file (the shipping code, not a copy) and exercises
# scn_restart_settle_barrier() against STUBBED _rd_origin/_rd_poll_remote/fed_log
# so this never touches a real rig/SSH/PG — purely local, <1s. Mirrors the
# live-federation-gate-reaper.selftest.sh convention (the four canonical
# TS/Cargo/LLM frameworks don't host shell units; the live matrix is the
# integration test).
#
#   bash bin/lib/restart-settle-barrier.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail
# EI-21266614790118256: honor the same GATE_SELFTEST_LIB_DIR override as
# federation-asserts.selftest.sh — gate_selftest() now runs this script from an
# untracked $WORK snapshot outside bin/lib/, so its own BASH_SOURCE no longer
# sits beside scenarios/restart-settle-barrier.sh. Without this override the
# scenario file "isn't found" and the selftest SKIPs (exit 0) instead of
# actually running, silently turning a real regression into a false PASS.
DIR="${GATE_SELFTEST_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
SCEN="$DIR/scenarios/restart-settle-barrier.sh"
[ -f "$SCEN" ] || { echo "SKIP: scenario file not found at $SCEN"; exit 0; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

# ── stubs (matrix_register is a top-level call in the sourced file — stub it
#    as a no-op recorder so sourcing doesn't need the real matrix runner) ────
matrix_register() { : ; }
fed_log() { : ; }

# Controllable fakes for the two real helpers the barrier calls:
#   STUB_ORIGIN     — what _rd_origin returns (e.g. "slug|remote" / "slug|local" / "")
#   STUB_POLL_RC    — the exit code _rd_poll_remote returns
_rd_origin() { printf '%s' "${STUB_ORIGIN:-}"; }
_rd_poll_remote() { return "${STUB_POLL_RC:-1}"; }

# D-044 / WI-40534: the post-restart owner-self classifier reads frame a
# directly. Before this stub existed every test below took `drv_psql: command
# not found` -> NOT MEASURED -> return 0, so the suite stayed green while never
# traversing either measurable branch. Keep a healthy all-local owner view as
# the default so the existing scenario cases exercise the positive path too.
STUB_OWNER_QUERY_RC=0
STUB_OWNER_ROWS=$'papercupai|hello-world-pot|local|100\nownerhandle|hello-world-pot|local|101'
# D-067 route-(b) positive control: the instrument also reads frame b (JOINER),
# whose pot_members rows must be origin='remote'. Default healthy so every
# pre-existing case exercises the control-pass path.
STUB_MEMBER_QUERY_RC=0
STUB_MEMBER_ROWS=$'papercupai|hello-world-pot|remote|100\nownerhandle|hello-world-pot|remote|101'
drv_psql() {
  local inst="${1:-}" sql="${2:-}"
  if [ "$inst" = a ] && [[ "$sql" == *"FROM harness_shared.pot_members"* ]]; then
    [ "${STUB_OWNER_QUERY_RC:-0}" -eq 0 ] || return "$STUB_OWNER_QUERY_RC"
    printf '%s\n' "${STUB_OWNER_ROWS:-}"
    return 0
  fi
  if [ "$inst" = b ] && [[ "$sql" == *"FROM harness_shared.pot_members"* ]]; then
    [ "${STUB_MEMBER_QUERY_RC:-0}" -eq 0 ] || return "$STUB_MEMBER_QUERY_RC"
    printf '%s\n' "${STUB_MEMBER_ROWS:-}"
    return 0
  fi
  return 1
}

# shellcheck disable=SC1090
source "$SCEN"

now() { date +%s; }

reset_env() {
  unset RD_LAST_CANARY_FID RD_LAST_MEMBER RD_LAST_CANARY_WRITE_TS RD_LAST_RAN_AT
  RD_SETTLE_WARN_S=120; RD_SETTLE_FAIL_S=900; RD_SETTLE_WARN_IS_FAIL=0
  STUB_ORIGIN=""; STUB_POLL_RC=1
  STUB_OWNER_QUERY_RC=0
  STUB_OWNER_ROWS=$'papercupai|hello-world-pot|local|100\nownerhandle|hello-world-pot|local|101'
  STUB_MEMBER_QUERY_RC=0
  STUB_MEMBER_ROWS=$'papercupai|hello-world-pot|remote|100\nownerhandle|hello-world-pot|remote|101'
}

# ── D-044 / WI-40534: the measure-only W1 leg must distinguish all outcomes ──

# W1a. Healthy owner view: every row remains local after restart.
reset_env
out="$(_rsb_owner_self_classification post-restart)"; rc=$?
[ "$rc" = 0 ] && grep -q "0 rows origin=remote" <<<"$out" \
  && ! grep -q "NOT MEASURED" <<<"$out" && ! grep -q "W1 signal" <<<"$out" \
  && grep -q "positive control" <<<"$out" && grep -q "COUNTABLE toward W1 retirement" <<<"$out" \
  && ok "owner-self all-local → measured healthy, explicit 0 remote, control PASS/countable" \
  || bad "owner-self all-local case: rc=$rc out='$out'"

# W1b. A remote row on the owner frame is the bounded W1 signal, never a
# scenario failure (the instrument is measure-only).
reset_env
STUB_OWNER_ROWS=$'papercupai|hello-world-pot|local|100\nownerhandle|hello-world-pot|remote|101'
out="$(_rsb_owner_self_classification post-restart)"; rc=$?
[ "$rc" = 0 ] && grep -q "1 row(s) origin=remote" <<<"$out" \
  && grep -q "W1 signal" <<<"$out" && grep -q "MEASURE-ONLY" <<<"$out" \
  && ok "owner-self remote row → explicit W1 signal, still measure-only" \
  || bad "owner-self remote-row case: rc=$rc out='$out'"

# W1c. Query failure must render explicit absence-of-evidence, not health.
reset_env
STUB_OWNER_QUERY_RC=42
out="$(_rsb_owner_self_classification post-restart)"; rc=$?
[ "$rc" = 0 ] && grep -q "NOT MEASURED" <<<"$out" \
  && grep -q "query FAILED (rc=42)" <<<"$out" \
  && ! grep -q "0 rows origin=remote" <<<"$out" \
  && ok "owner-self query failure → explicit NOT MEASURED" \
  || bad "owner-self query-failure case: rc=$rc out='$out'"

# W1d. A successful empty query is independently NOT MEASURED.
reset_env
STUB_OWNER_ROWS=""
out="$(_rsb_owner_self_classification post-restart)"; rc=$?
[ "$rc" = 0 ] && grep -q "NOT MEASURED" <<<"$out" \
  && grep -q "ZERO pot_members rows" <<<"$out" \
  && ok "owner-self empty result → explicit NOT MEASURED" \
  || bad "owner-self empty-result case: rc=$rc out='$out'"

# ── D-067 route-(b) positive control: three outcomes must stay distinguishable ──

# W1f. A should-be-remote row reading 'local' on frame b = the WI-39363 class is
# LIVE in the run → CONTROL DEGRADED, the frame-a reading must not count — and
# the instrument stays measure-only (rc 0).
reset_env
STUB_MEMBER_ROWS=$'papercupai|hello-world-pot|remote|100\nownerhandle|hello-world-pot|local|101'
out="$(_rsb_owner_self_classification post-restart)"; rc=$?
[ "$rc" = 0 ] && grep -q "CONTROL DEGRADED" <<<"$out" \
  && grep -q "must NOT count toward W1 retirement" <<<"$out" \
  && ! grep -q "COUNTABLE toward W1 retirement" <<<"$out" \
  && ok "control: local row on frame b → CONTROL DEGRADED, not countable" \
  || bad "control-degraded case: rc=$rc out='$out'"

# W1g. Frame-b query failure must render CONTROL NOT MEASURED (absence of
# evidence), never a pass — and never a countable frame-a reading.
reset_env
STUB_MEMBER_QUERY_RC=7
out="$(_rsb_owner_self_classification post-restart)"; rc=$?
[ "$rc" = 0 ] && grep -q "positive control" <<<"$out" && grep -q "NOT MEASURED" <<<"$out" \
  && grep -q "must NOT count toward W1 retirement" <<<"$out" \
  && ! grep -q "COUNTABLE toward W1 retirement" <<<"$out" \
  && ok "control: frame-b query failure → CONTROL NOT MEASURED, not countable" \
  || bad "control-query-failure case: rc=$rc out='$out'"

# W1h. A successful-but-empty frame-b result is independently NOT MEASURED.
reset_env
STUB_MEMBER_ROWS=""
out="$(_rsb_owner_self_classification post-restart)"; rc=$?
[ "$rc" = 0 ] && grep -q "ZERO pot_members rows" <<<"$out" \
  && grep -q "must NOT count toward W1 retirement" <<<"$out" \
  && ! grep -q "COUNTABLE toward W1 retirement" <<<"$out" \
  && ok "control: frame-b empty result → CONTROL NOT MEASURED, not countable" \
  || bad "control-empty-result case: rc=$rc out='$out'"

# W1e. Placement is load-bearing: this call must remain the first executable
# statement so no future early return can silently bypass the instrument.
first_exec="$(awk '
  /^scn_restart_settle_barrier\(\) \{/ { in_fn=1; next }
  in_fn && /^[[:space:]]*($|#)/ { next }
  in_fn { sub(/^[[:space:]]+/, ""); print; exit }
' "$SCEN")"
[ "$first_exec" = "_rsb_owner_self_classification post-restart" ] \
  && ok "owner-self re-poll remains first executable barrier statement" \
  || bad "owner-self re-poll moved/bypassed: first executable='$first_exec'"

# ── 1. no preceding canary AND order 80 never ran → PASS, no-op, never a forced fail ──
reset_env
out="$(scn_restart_settle_barrier)"; rc=$?
[ "$rc" = 0 ] && grep -q "didn't run this session" <<<"$out" && grep -q "nothing to settle" <<<"$out" \
  && ok "no-canary, order-80-never-ran → PASS/no-op" \
  || bad "no-canary case: rc=$rc out='$out'"

# ── 1b. WI-5772: order 80 RAN (RD_LAST_RAN_AT set) but left no canary (failed/
#       bailed before its final write) → hard FAIL, never the "didn't run" PASS ──
reset_env
RD_LAST_RAN_AT="$(now)"
out="$(scn_restart_settle_barrier)"; rc=$?
[ "$rc" = 1 ] && grep -q "OVERALL: FAIL" <<<"$out" && grep -q "RAN this session" <<<"$out" \
  && ! grep -q "didn't run this session" <<<"$out" \
  && ok "ran-but-no-canary → FAIL, distinguished from didn't-run" \
  || bad "ran-but-no-canary case: rc=$rc out='$out'"

# ── 2. already converged, fast (elapsed well under warn bar) → PASS, no ⚠ ────
reset_env
RD_LAST_CANARY_FID="F-X"; RD_LAST_MEMBER="b"; RD_LAST_CANARY_WRITE_TS="$(($(now) - 5))"
STUB_ORIGIN="slug1|remote"
out="$(scn_restart_settle_barrier)"; rc=$?
[ "$rc" = 0 ] && grep -q "OVERALL: PASS" <<<"$out" && ! grep -q '⚠' <<<"$out" \
  && ok "already-converged fast → PASS, no warn" \
  || bad "already-converged-fast case: rc=$rc out='$out'"

# ── 3. already converged, SLOW (elapsed past warn, under fail) → PASS + ⚠ ────
reset_env
RD_LAST_CANARY_FID="F-X"; RD_LAST_MEMBER="b"; RD_LAST_CANARY_WRITE_TS="$(($(now) - 300))"
STUB_ORIGIN="slug1|remote"
out="$(scn_restart_settle_barrier)"; rc=$?
[ "$rc" = 0 ] && grep -q '⚠' <<<"$out" && grep -q "OVERALL: PASS" <<<"$out" \
  && ok "already-converged slow → PASS + warn" \
  || bad "already-converged-slow case: rc=$rc out='$out'"

# ── 4. same as #3 but RD_SETTLE_WARN_IS_FAIL=1 → hard FAIL ───────────────────
reset_env
RD_LAST_CANARY_FID="F-X"; RD_LAST_MEMBER="b"; RD_LAST_CANARY_WRITE_TS="$(($(now) - 300))"
STUB_ORIGIN="slug1|remote"; RD_SETTLE_WARN_IS_FAIL=1
out="$(scn_restart_settle_barrier)"; rc=$?
[ "$rc" = 1 ] && grep -q "OVERALL: FAIL" <<<"$out" \
  && ok "WARN_IS_FAIL=1 escalates a slow-but-converged case to FAIL" \
  || bad "WARN_IS_FAIL case: rc=$rc out='$out'"

# ── 5. not yet converged, poll succeeds within budget → PASS ─────────────────
reset_env
RD_LAST_CANARY_FID="F-X"; RD_LAST_MEMBER="b"; RD_LAST_CANARY_WRITE_TS="$(($(now) - 30))"
STUB_ORIGIN=""; STUB_POLL_RC=0
out="$(scn_restart_settle_barrier)"; rc=$?
[ "$rc" = 0 ] && grep -q "OVERALL: PASS" <<<"$out" \
  && ok "not-yet-converged, poll lands within budget → PASS" \
  || bad "poll-lands case: rc=$rc out='$out'"

# ── 6. not yet converged, ALREADY past the hard deadline → immediate FAIL, no poll needed ──
reset_env
RD_LAST_CANARY_FID="F-X"; RD_LAST_MEMBER="b"; RD_LAST_CANARY_WRITE_TS="$(($(now) - 1000))"
STUB_ORIGIN=""; STUB_POLL_RC=0   # even if poll WOULD succeed, budget<=0 must short-circuit
out="$(scn_restart_settle_barrier)"; rc=$?
[ "$rc" = 1 ] && grep -q "OVERALL: FAIL" <<<"$out" && grep -q "past the 900s hard deadline" <<<"$out" \
  && ok "already past hard deadline → immediate FAIL (no poll)" \
  || bad "past-deadline case: rc=$rc out='$out'"

# ── 7. not yet converged, poll exhausts its budget and never lands → FAIL ────
reset_env
RD_LAST_CANARY_FID="F-X"; RD_LAST_MEMBER="b"; RD_LAST_CANARY_WRITE_TS="$(($(now) - 30))"
STUB_ORIGIN=""; STUB_POLL_RC=1
out="$(scn_restart_settle_barrier)"; rc=$?
[ "$rc" = 1 ] && grep -q "OVERALL: FAIL" <<<"$out" \
  && ok "poll never lands within budget → FAIL" \
  || bad "poll-timeout case: rc=$rc out='$out'"

echo "── restart-settle-barrier.selftest: $((16 - FAILS))/16 passed ──"
[ "$FAILS" = 0 ] && { echo "OVERALL: PASS"; exit 0; }
echo "OVERALL: FAIL ($FAILS failing)"; exit 1
