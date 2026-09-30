#!/usr/bin/env bash
# reconnect_catchup.sh — Brief 13 matrix scenario for Brief 4 (LIVE reconnect / catch-up).
#
# Sourced by bin/deb-hetzner-matrix.sh (NOT executable standalone — the standalone proof
# is bin/deb-hetzner-reconnect.sh). Thin adapter: sources the standalone reconnect script,
# which (under its run-if-main guard) only DEFINES `scenario_reconnect_catchup` + the _rc_*
# helpers and provisions NOTHING, then registers a matrix scn_ wrapper around it. One
# source of truth for the scenario logic (deb-hetzner-reconnect.sh); this file only maps it
# onto the matrix scn_/matrix_register contract.
#
# INVASIVE: kills + restarts the member (b) sidecar. Registered with a HIGH order so it
# runs LATE (after the non-invasive content/plan-part/coord scenarios, alongside restart
# durability); it leaves both sidecars UP + re-joined so later scenarios can reuse the
# shared frames. Reads matrix globals FRAME_MEMBER_SLUG[a|b] (populated by the matrix's
# provision + rig_owner_publish_hive + rig_join_all).

# Define scenario_reconnect_catchup + _rc_* helpers from the standalone (guard skips its
# entrypoint because BASH_SOURCE != $0 when sourced). $DESKTOP_DIR is set by the matrix.
source "$DESKTOP_DIR/bin/deb-hetzner-reconnect.sh"

scn_reconnect_catchup() {
  local out rc
  out="$(scenario_reconnect_catchup a b 2>&1)"; rc=$?
  if [ "$rc" = 0 ]; then
    echo "reconnect/catch-up OK (offline member caught up on content+plan-part+coord; no loss/dup; roster intact; link healed)"
  else
    echo "reconnect/catch-up FAIL — key lines:"
    printf '%s\n' "$out" | grep -E '✗|OVERALL:' | sed 's/^/      /'
    echo "      ── full assert transcript (all ✓/✗) ──"
    printf '%s\n' "$out" | grep -E '✓|✗|OVERALL:' | sed 's/^/      /'
  fi
  return "$rc"
}

matrix_register reconnect_catchup 85 "reconnect / catch-up (offline member)" scn_reconnect_catchup
