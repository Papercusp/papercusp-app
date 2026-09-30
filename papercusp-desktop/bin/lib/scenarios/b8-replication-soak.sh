#!/usr/bin/env bash
# b8-replication-soak.sh — matrix scenario for P-004 (WI-1840): the
# replication-liveness restart SOAK (shared-hive-p2p-release-readiness-2026-07-03).
#
# Sourced by bin/deb-hetzner-matrix.sh (NOT executable standalone — the standalone
# proof is `bin/deb-hetzner-restart.sh --soak`). Thin adapter on the same
# one-source-of-truth pattern as b5-restart.sh/reconnect_catchup.sh: sourcing the
# standalone restart script only DEFINES `scenario_replication_liveness_soak`
# (its run-if-main guard skips the entrypoint); this file maps it onto the matrix
# scn_/matrix_register contract.
#
# WHAT IT PINS (the WI-183 / P-059 class): after a kill/restart the swarm re-peers
# (peer_connected both ways) but peer-log replication can silently never resume —
# writes stop crossing with zero errors. The soak cold-restarts alternating frames
# RL_SOAK_CYCLES (default 5) times and asserts live replication re-establishes
# BOTH directions within RL_SOAK_SLA_S (default 90s) EVERY cycle, plus a negative
# detector-assert: on a soak whose probes all passed, no UNRECOVERED stall for the
# soak's own harness within the soak's own window (WI-5715, 2026-07-25). Stalls
# that fire and then recover are EXPECTED — a cold restart legitimately produces a
# ~15s connected-but-no-replicator window that self-repair re-attaches — and the
# fire-path pin below asserts the detector MUST fire on a genuinely red soak, so
# demanding blanket silence contradicted it and made this scenario unpassable.
#
# INVASIVE: cold-restarts BOTH sidecars repeatedly. Registered order 87 so it runs
# late — after restart_durability(80)/reconnect_catchup(85), before
# revocation_kcut(90); it leaves both sidecars UP + re-joined.

# b5-restart.sh may already have sourced this (guard against double-source noise);
# sourcing is idempotent — it only defines functions.
source "$DESKTOP_DIR/bin/deb-hetzner-restart.sh"

scn_replication_soak() {
  local out rc
  out="$(scenario_replication_liveness_soak a b 2>&1)"; rc=$?
  # WI-5481/WI-5355 investigation gap: the outer matrix harness redirects THIS
  # function's stdout to $RIG_WORK/scn.replication_soak.log, but until now every
  # line of $out (the per-cycle PASS/FAIL detail, the rig_wait_swarm "swarm not
  # re-peered within window" warnings, timings) was captured into this local var
  # and then discarded — only a grep-filtered ✗/OVERALL subset on FAIL ever
  # reached that log, so the ⚠ pairing-warning line (needed to correlate a
  # failed probe with a failed post-restart re-pair) was never persisted
  # anywhere. Always echo the FULL raw output first so it lands in the
  # per-scenario log regardless of outcome; the summary/filtered lines below
  # are kept for the terse local-matrix.out report.
  echo "── full replication-liveness soak output (for post-hoc correlation) ──"
  printf '%s\n' "$out"
  echo "── end full output ──"
  if [ "$rc" = 0 ]; then
    echo "replication-liveness soak OK (${RL_SOAK_CYCLES:-5} kill/restart cycles: replication re-established both directions within SLA every cycle; detector quiet)"
  else
    echo "replication-liveness soak FAIL — key lines:"
    printf '%s\n' "$out" | grep -E '✗|OVERALL:' | sed 's/^/      /'
    # ── detector fire-path pin (WI-38376) ───────────────────────────────────
    # The scenario emits one DETECTOR-CYCLE-VERDICT for every failed probe leg,
    # using exact per-leg serve.log line marks. Never re-read cumulative logs
    # here: m1786605814 proved that an earlier cycle's legitimate detector fire
    # can otherwise false-pass a later cycle whose real SLA miss was invisible.
    local failed_legs evidence_verdicts blind observed inconclusive
    failed_legs="$(printf '%s\n' "$out" | grep -cE '^  ✗ cycle [0-9]+ (A→B|B→A) FAIL:')"
    evidence_verdicts="$(printf '%s\n' "$out" | grep -c 'DETECTOR-CYCLE-VERDICT')"
    blind="$(printf '%s\n' "$out" | grep -c 'DETECTOR-CYCLE-VERDICT.*result=blind')"
    observed="$(printf '%s\n' "$out" | grep -c 'DETECTOR-CYCLE-VERDICT.*result=observed')"
    inconclusive="$(printf '%s\n' "$out" | grep -c 'DETECTOR-CYCLE-VERDICT.*result=inconclusive')"
    if [ "$failed_legs" = 0 ] || [ "$evidence_verdicts" != "$failed_legs" ] || [ "$inconclusive" != 0 ]; then
      echo "      ✗ detector fire-path INCONCLUSIVE: failed_legs=$failed_legs cycle_verdicts=$evidence_verdicts inconclusive=$inconclusive — every failed replication leg must carry a measurable line-bounded detector window"
    elif [ "$blind" != 0 ]; then
      echo "      ✗ DETECTOR REGRESSION: $blind/$failed_legs failed replication leg(s) emitted ZERO replication_stalled/replication_frozen events inside their own write→timeout windows (earlier-cycle events do not count)"
    else
      echo "      ✓ detector fire-path pin: all $observed failed replication leg(s) carried a detector event inside their own write→timeout windows"
    fi
    # ── EI-19940993365684927: THE LAST LINE MUST BE THE VERDICT ──────────────
    # A gate artifact's final line must BE its verdict, or be MORE alarming than
    # it — never less. Readers (human and agent) read the tail.
    #
    # The detector pin above is a SUB-ASSERTION about the WI-1840 detector, not
    # about this soak. On the ✓ branch it is true on its own terms and reads as
    # reassuring, and it used to be the FINAL line this function emitted on a
    # FAILED soak. So `tail -1` on scn.replication_soak.log showed a ✓ for a
    # scenario that had just FAILED its SLA: a peer read exactly that tail and
    # concluded "all 18 scenarios green" while this one was INCOMPLETE.
    #
    # Re-emit the verdict LAST so the reassuring sub-assertion can never be the
    # tail. Unconditional and self-authored on purpose: replaying $out's own
    # OVERALL: line would print NOTHING when the soak died before emitting one,
    # which silently restores the very bug this fixes.
    # SAFE BY CONSTRUCTION: local-matrix.sh takes this scenario's verdict from
    # the RETURN CODE (return "$rc"), never by parsing this log, so this line
    # changes only what a reader sees. It also cannot be mistaken for a pass by
    # the unanchored `grep -qaE 'OVERALL: PASS'` in live-federation-gate.sh.
    echo "OVERALL: INCOMPLETE — replication-liveness soak FAILED (rc=$rc). The ✓/✗ line above is a sub-assertion about the DETECTOR, not this scenario's verdict."
  fi
  return "$rc"
}

matrix_register replication_soak 87 "replication-liveness soak (5x kill/restart, both directions, SLA)" scn_replication_soak
