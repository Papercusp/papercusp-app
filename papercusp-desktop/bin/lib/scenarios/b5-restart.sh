#!/usr/bin/env bash
# b5-restart.sh — Brief 13 matrix scenario for Brief 5 (LIVE restart durability).
#
# Sourced by bin/deb-hetzner-matrix.sh (NOT executable standalone — the standalone proof
# is bin/deb-hetzner-restart.sh). Thin adapter on the same one-source-of-truth pattern as
# reconnect_catchup.sh: sourcing the standalone script only DEFINES
# `scenario_restart_durability` (its run-if-main guard skips the entrypoint), then this
# file maps it onto the matrix scn_/matrix_register contract.
#
# INVASIVE: cold-restarts the member (b) sidecar. Registered order 80 so it runs late,
# just before reconnect_catchup(85)/revocation_kcut(90); it leaves both sidecars UP +
# re-joined for the later invasive scenarios.

source "$DESKTOP_DIR/bin/deb-hetzner-restart.sh"

scn_restart_durability() {
  # WI-5772: scenario_restart_durability exports RD_LAST_RAN_AT / RD_LAST_CANARY_FID
  # / RD_LAST_MEMBER / RD_LAST_CANARY_WRITE_TS as plain (non-local) globals so the
  # LATER settle-barrier scenario (order 82) can re-poll the same canary. A `$(...)`
  # command substitution runs its command in a SUBSHELL — any such global write
  # inside it is discarded the instant the subshell exits, so capturing this call's
  # output via `out="$(scenario_restart_durability a b 2>&1)"` silently dropped
  # EVERY one of those exports, on both PASS and FAIL, every session. That is the
  # actual root cause behind "settle-barrier always reports 'order 80 didn't run
  # this session'" — order 80 DID run, its exports just never escaped this subshell.
  # Fix: redirect to a temp file instead (same pattern deb-hetzner-matrix.sh's own
  # top-level runner already uses, for the identical reason) so the call runs in
  # THIS shell and its global exports survive.
  local out rc tmp
  tmp="$(mktemp)"
  scenario_restart_durability a b >"$tmp" 2>&1; rc=$?
  out="$(cat "$tmp")"
  if [ "$rc" = 0 ]; then
    rm -f "$tmp"
    echo "restart durability OK (cold sidecar restart lost nothing, re-emitted nothing)"
  else
    echo "restart durability FAIL — key lines:"
    printf '%s\n' "$out" | grep -E '✗|OVERALL:' | sed 's/^/      /'
    echo "      ── full assert transcript (all ✓/✗) ──"
    printf '%s\n' "$out" | grep -E '✓|✗|OVERALL:' | sed 's/^/      /'
    rm -f "$tmp"
  fi
  return "$rc"
}

matrix_register restart_durability 80 "restart durability (cold member restart)" scn_restart_durability
