#!/usr/bin/env bash
# replication-soak-diagnostics.selftest.sh — hermetic recurrence guards for
# WI-38376's live-rig diagnostics. No docker/SSH/PG and no matrix run.
#
# Guards that a failed replication-soak leg reports:
#   1. detector/repair evidence from that leg's own line-bounded window;
#   2. the destination's ACTUAL harness_slug|origin row (including local);
#   3. the writer outbox row + exact drained-log announce log_length high-water.
#   4. the receiver's exact per-log liveness + merge-queue snapshot.
# It also proves the b8 wrapper consumes those per-leg verdicts and never falls
# back to a cumulative serve.log grep that an earlier cycle can false-pass.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$DIR/../.." && pwd)"
RESTART="$DESKTOP_DIR/bin/deb-hetzner-restart.sh"
SCEN="$DIR/scenarios/b8-replication-soak.sh"
[ -f "$RESTART" ] && [ -f "$SCEN" ] || { echo "SKIP: replication-soak sources not found"; exit 0; }

FAILS=0
TESTS=11
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

# Sourcing defines the shipping helpers only; the run-if-main guard keeps the
# standalone rig entrypoint inert.
# shellcheck disable=SC1090
source "$RESTART"
set -uo pipefail

# Primitive fakes for the composed failed-leg diagnostic. They model the exact
# m1786605814 ambiguity: destination row exists as local, the writer outbox DID
# drain to a known log, and that log advertised a concrete signed high-water.
_rd_log_line_mark() { echo 20; }
_rd_actual_rows() { echo 'hello-world|local'; }
_rd_writer_outbox_row() { echo '917|hello-world|Y|abcdef0123456789'; }
_rd_writer_log_high_water() {
  echo '[announce-debug] sent fresh harness=hello-world log=abcdef012345... log_length=41'
}
_rd_detector_window() {
  if [ "${STUB_DETECTOR_EVENT:-0}" = 1 ] && [ "$1" = a ]; then
    echo '[replication-liveness] replication_frozen harness=hello-world log=abcdef012345...'
    echo '[replication-liveness] repair-on-detect: re-attached replica session log=abcdef012345... harness=hello-world'
  fi
}
rig_pcusp_run() {
  cat >/dev/null
  printf '%s\n' "$STUB_SUBSTRATE_STATUS"
}
STUB_SUBSTRATE_STATUS='{"replicationLiveness":[{"workspaceId":"workspace-rig","harnessSlug":"hello-world","logs":[{"keyHex":"abcdef0123456789","verdict":"live","knownLength":41,"localLength":37,"mergedPosition":35,"peersCount":1,"mergeQueueIndex":1,"mergeQueueHeadKeyHex":"feedface","msSinceMergeQueueHead":null}]}]}'
[ "${REPLICATION_SOAK_DIAGNOSTICS_RECEIVER_ONLY:-0}" = 1 ] && TESTS=3

STUB_DETECTOR_EVENT=0
out="$(_rd_emit_failed_leg_diagnostics 5 A-to-B a b F-RLSOAK-5-AM 10 10 10 a b hello-world hello-world)"
grep -q 'RECEIVER-LIVENESS-SNAPSHOT.*snapshot={"status":"found","harnessSlug":"hello-world","logKey":"abcdef0123456789","verdict":"live","knownLength":41,"localLength":37,"mergedPosition":35,"peersCount":1,"mergeQueueIndex":1,"mergeQueueHeadKeyHex":"feedface","msSinceMergeQueueHead":null}' <<<"$out" \
  && ok 'failed leg reports the exact receiver log liveness and queue snapshot' \
  || bad "receiver liveness snapshot missing or incomplete: $out"
missing="$(_rd_receiver_liveness_snapshot b hello-world deadbeef)"
grep -q '"status":"log-missing"' <<<"$missing" \
  && ok 'receiver snapshot distinguishes an absent target log from a failed read' \
  || bad "missing receiver log was not explicit: $missing"
if grep -q 'scripts/ptool.mjs' "$RESTART" \
  && grep -q 'dev:dogfood_substrate_status' "$RESTART" \
  && grep -q 'http://127.0.0.1:\$HONO' "$RESTART"; then
  ok 'shipping helper uses the receiver packaged ptool against its local operator'
else
  bad 'shipping helper lost the packaged-ptool receiver path'
fi
if [ "${REPLICATION_SOAK_DIAGNOSTICS_RECEIVER_ONLY:-0}" = 1 ]; then
  echo "── replication-soak-diagnostics.selftest: $((TESTS - FAILS))/$TESTS passed (receiver-only) ──"
  [ "$FAILS" = 0 ] && { echo 'OVERALL: PASS'; exit 0; }
  echo "OVERALL: FAIL ($FAILS failing)"; exit 1
fi

grep -q 'actual_rows=hello-world|local' <<<"$out" \
  && ok 'failed leg preserves the actual wrong-origin destination row' \
  || bad "actual destination row missing: $out"
grep -q 'writer_outbox=id=917,harness=hello-world,drained=Y,log=abcdef0123456789' <<<"$out" \
  && ok 'failed leg reports writer outbox drain + exact drained log' \
  || bad "writer outbox evidence missing: $out"
grep -q 'writer_announce=.*log_length=41' <<<"$out" \
  && ok 'failed leg reports the writer signed announce high-water' \
  || bad "writer announce high-water missing: $out"
[ "$(grep -c 'DETECTOR-CYCLE-WINDOW cycle=5 leg=A-to-B' <<<"$out")" = 2 ] \
  && grep -q 'DETECTOR-CYCLE-VERDICT cycle=5 leg=A-to-B detector_events=0 result=blind' <<<"$out" \
  && ok 'zero-event failed leg emits two bounded windows + a blind verdict' \
  || bad "blind detector-window verdict wrong: $out"

STUB_DETECTOR_EVENT=1
out="$(_rd_emit_failed_leg_diagnostics 5 A-to-B a b F-RLSOAK-5-AM 10 10 10 a b hello-world hello-world)"
grep -q 'frame=a lines=10-20 detector_events=1 repair_events=1' <<<"$out" \
  && grep -q 'DETECTOR-CYCLE-VERDICT cycle=5 leg=A-to-B detector_events=1 result=observed' <<<"$out" \
  && ok 'in-window detector fire + repair produces an observed verdict' \
  || bad "observed detector-window verdict wrong: $out"

# Source the REAL wrapper. matrix_register is its only required top-level seam.
matrix_register() { :; }
# shellcheck disable=SC1090
source "$SCEN"

drv_exec() { bad 'b8 wrapper re-read a remote/cumulative log'; return 1; }
scenario_replication_liveness_soak() {
  cat <<'EOF'
  ✗ cycle 5 A→B FAIL: F-RLSOAK-5-AM did not land
  ⚙ DETECTOR-CYCLE-VERDICT cycle=5 leg=A-to-B detector_events=0 result=blind
OVERALL: INCOMPLETE
EOF
  return 1
}
out="$(scn_replication_soak)"; rc=$?
[ "$rc" = 1 ] && grep -q 'DETECTOR REGRESSION: 1/1 failed replication leg' <<<"$out" \
  && ! grep -q '✓ detector fire-path pin' <<<"$out" \
  && ok 'wrapper scores a blind failed leg red from its own verdict' \
  || bad "wrapper blind-leg score wrong: rc=$rc out=$out"

scenario_replication_liveness_soak() {
  cat <<'EOF'
  ✗ cycle 5 A→B FAIL: F-RLSOAK-5-AM did not land
  ⚙ DETECTOR-CYCLE-VERDICT cycle=5 leg=A-to-B detector_events=1 result=observed
OVERALL: INCOMPLETE
EOF
  return 1
}
out="$(scn_replication_soak)"; rc=$?
[ "$rc" = 1 ] && grep -q '✓ detector fire-path pin: all 1 failed replication leg' <<<"$out" \
  && ok 'wrapper accepts only an in-window detector observation' \
  || bad "wrapper observed-leg score wrong: rc=$rc out=$out"

if ! grep -q "grep -qE 'replication_stalled.*harness=" "$SCEN"; then
  ok 'shipping wrapper contains no cumulative serve.log detector fallback'
else
  bad 'shipping wrapper still contains the cumulative serve.log false-pass path'
fi

echo "── replication-soak-diagnostics.selftest: $((TESTS - FAILS))/$TESTS passed ──"
[ "$FAILS" = 0 ] && { echo 'OVERALL: PASS'; exit 0; }
echo "OVERALL: FAIL ($FAILS failing)"; exit 1
