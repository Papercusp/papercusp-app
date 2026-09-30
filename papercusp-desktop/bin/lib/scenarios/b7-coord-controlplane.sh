#!/usr/bin/env bash
# b7-coord-controlplane.sh — Brief 13 matrix scenario for Brief 7 (coord control-plane
# federation boundary: which coordination flows cross machines vs stay local).
#
# Sourced by bin/deb-hetzner-matrix.sh (NOT executable standalone — the standalone proof
# is bin/deb-hetzner-coord-controlplane.sh). Thin adapter on the same one-source-of-truth
# pattern as reconnect_catchup.sh / b5-restart.sh: sourcing the standalone script only
# DEFINES `scenario_coord_controlplane` + the _ctrl_* helpers (its run-if-main guard skips
# the entrypoint), then this file maps it onto the matrix scn_/matrix_register contract.
#
# NON-INVASIVE (no sidecar kill/restart; probes only INSERT throwaway timestamped rows):
# registered order 50 — after concurrent_lww(40), before the invasive restart(80)/
# reconnect(85)/revocation(90). STATE NOTE: the scenario's BASELINE probe writes the FIXED
# feature_id F-CTRL-BASE (not run-suffixed), so it is one-shot per provisioned rig — fine
# in a normal matrix run (fresh frames, no other scenario touches that id), but a REPEAT
# run on kept-up frames (--keep-up + --only=coord_controlplane again) would PK-collide the
# baseline row and false-negative the wire check. The negative probes assert rows stay
# ABSENT on b, which prior scenarios' data cannot violate (their ids are unique-per-probe).
#
# The wrapped scenario returns 0 = every flow matched the code-derived expectation, 1 =
# divergence (the STANDALONE script always exits 0 after the probes — the meaningful
# verdict for the matrix lives in this return code).

source "$DESKTOP_DIR/bin/deb-hetzner-coord-controlplane.sh"

scn_coord_controlplane() {
  local out rc
  out="$(scenario_coord_controlplane a b 2>&1)"; rc=$?
  if [ "$rc" = 0 ]; then
    echo "coord control-plane boundary OK (harness-scoped msg/escalation/handoff surfaces federated; raw presence/watermark/await stayed local)"
  else
    echo "coord control-plane boundary FAIL — key lines:"
    printf '%s\n' "$out" | grep -E '✗|BRIEF 7 MATRIX' | sed 's/^/      /'
    echo "      ── full assert transcript (all ✓/✗) ──"
    printf '%s\n' "$out" | grep -E '✓|✗|BRIEF 7 MATRIX' | sed 's/^/      /'
  fi
  return "$rc"
}

matrix_register coord_controlplane 50 "coord control-plane federation boundary" scn_coord_controlplane
