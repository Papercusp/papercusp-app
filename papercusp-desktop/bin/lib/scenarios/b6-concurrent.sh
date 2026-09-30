#!/usr/bin/env bash
# b6-concurrent.sh — Brief 13 matrix scenario for Brief 6 (concurrent writes / LWW convergence).
#
# Sourced by bin/deb-hetzner-matrix.sh (NOT executable standalone — the standalone proof
# is bin/deb-hetzner-concurrent.sh). Thin adapter on the same one-source-of-truth pattern
# as reconnect_catchup.sh / b5-restart.sh: sourcing the standalone script only DEFINES
# `scenario_concurrent_lww` + the _cl_* helpers (its run-if-main guard skips the
# entrypoint), then this file maps it onto the matrix scn_/matrix_register contract.
#
# NON-INVASIVE (no sidecar kill/restart): registered order 40 — after the base
# content/plan-part/coord scenarios (10/20/30), before the invasive restart(80)/
# reconnect(85)/revocation(90). Tolerates prior scenarios' data on the shared frames:
# every feature_id is timestamp-suffixed, and the roster gate compares b's CURRENT
# hive_members set to a's (whatever earlier scenarios wrote). Leaves the frames healthy.

source "$DESKTOP_DIR/bin/deb-hetzner-concurrent.sh"

scn_concurrent_lww() {
  local out rc
  out="$(scenario_concurrent_lww a b 2>&1)"; rc=$?
  if [ "$rc" = 0 ]; then
    echo "concurrent writes OK (no loss on different keys; deterministic byte-identical LWW winner on the same key)"
  else
    # WI-10003114: the scenario's failure-time diagnostics (PHASE2 final rows + the
    # PHASE2-DIAG PG capture of row/outbox/refusal counters + rosters) are the ONLY evidence
    # that names which column keeps re-stamping a contested row. The ✓/✗ projection below
    # dropped them, so every banked FAIL lost them. Emit them FIRST so the matrix's
    # "last N lines" excerpt still ends on the key lines.
    echo "concurrent writes / LWW FAIL — failure-time diagnostics:"
    printf '%s\n' "$out" | awk '/PHASE2 final:|PHASE2-DIAG/{p=1} p' | sed 's/^/      /'
    echo "concurrent writes / LWW FAIL — key lines:"
    printf '%s\n' "$out" | grep -E '✗|OVERALL:|PHASE2 timing:' | sed 's/^/      /'
    echo "      ── full assert transcript (all ✓/✗) ──"
    printf '%s\n' "$out" | grep -E '✓|✗|OVERALL:|PHASE2 timing:' | sed 's/^/      /'
  fi
  return "$rc"
}

matrix_register concurrent_lww 40 "concurrent writes / LWW convergence" scn_concurrent_lww
