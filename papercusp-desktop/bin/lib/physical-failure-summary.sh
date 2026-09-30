#!/usr/bin/env bash
# physical-failure-summary.sh — name WHY a physical hive-git drill run failed.
#
# Plan physical-drill-iteration-speed-2026-09-29 P-001 (WI-10003891).
#
# The P-505 physical drill printed the same generic line for 14 consecutive
# failed runs ("physical E/G adapter command failed — see physical-probe.stdout
# + physical-probe.stderr"), each with a different real cause. The cause was only
# in the adapter's stderr, which the next run then deleted (the drill wipes $WORK
# at start). This helper reads that stderr and returns ONE line naming the phase
# that failed and the reason it reported, so the drill's summary line carries it.
#
# Inputs it relies on (both emitted on the adapter's stderr):
#   - hive-git-physical-scenario.sh run_all_phases prints
#       "hive-git-physical-scenario: PHASE_START <letter> <function>"
#     before each phase, so the LAST such marker is the phase that was running.
#   - both the scenario and the probe prefix their messages with
#       "hive-git-physical-scenario: " / "hive-git-physical-probe: ",
#     and their fail() exits immediately after printing, so the LAST prefixed
#     non-marker line is the most specific reason available — EXCEPT for the
#     lines the probe's EXIT trap prints AFTER fail() (TRAILER_RE below). Real
#     run 20260930T014309Z summarised as "preserved failed-run diagnostics at
#     ..." and hid the cause on the line before it; those lines are skipped.
#   - the rig preflight prints "PHYSICAL_PREFLIGHT_FAILED <check>: <reason>"
#     (unprefixed) and the probe's own refusal line only points at it, so a
#     preflight refusal is summarised by its FIRST such line, naming the check.
#
# Output (stdout, one line):
#   phase <X> (<function>): <reason>
#   phase <X> (<function>): no prefixed reason line (exit without fail())
#   before any phase: <reason>                      (setup / preflight failure)
#   no adapter stderr at <path>
#
# Usage:
#   physical-failure-summary.sh <adapter-stderr-file>
#   or source it and call: physical_failure_summary <adapter-stderr-file>

physical_failure_summary() {
  local err_file="$1"
  if [ -z "$err_file" ] || [ ! -f "$err_file" ]; then
    printf 'no adapter stderr at %s\n' "${err_file:-<unset>}"
    return 0
  fi
  local marker_re='^hive-git-physical-scenario: PHASE_START '
  local prefix_re='^hive-git-physical-(scenario|probe): '
  # Post-failure housekeeping the probe's EXIT trap prints after fail(): never a cause.
  local trailer_re='^hive-git-physical-probe: preserved failed-run diagnostics at '
  local preflight_re='^PHYSICAL_PREFLIGHT_FAILED '
  # Errors the TypeScript producer modules throw ("physical-drill-<module>: <message>").
  local producer_re='^(Error: )?physical-drill-[a-z0-9-]+: '
  local phase_line phase_letter phase_fn reason preflight
  phase_line="$(grep -E "$marker_re" "$err_file" | tail -n 1)"
  reason="$(grep -E "$prefix_re" "$err_file" | grep -vE "$marker_re" | grep -vE "$trailer_re" \
    | tail -n 1 | sed -E "s/$prefix_re//")"
  preflight="$(grep -E "$preflight_re" "$err_file" | head -n 1)"
  if [ -z "$phase_line" ] && [ -n "$preflight" ]; then
    reason="rig preflight refused the run: ${preflight}"
  fi
  # A producer that throws exits the probe/scenario under set -e WITHOUT fail(), so no
  # prefixed line names the cause; the producer's own error line does. Real same-box run
  # 20260930T043830Z summarised "no prefixed reason line" above
  # "physical-drill-host-receipt: cached announce identity/keychain mismatch at ...".
  if [ -z "$reason" ]; then
    reason="$(grep -E "$producer_re" "$err_file" | tail -n 1 | sed -E 's/^Error: //')"
  fi
  # Keep the summary to one readable line.
  reason="$(printf '%s' "$reason" | tr -d '\r' | cut -c1-400)"
  if [ -n "$phase_line" ]; then
    phase_letter="$(printf '%s\n' "$phase_line" | awk '{print $3}')"
    phase_fn="$(printf '%s\n' "$phase_line" | awk '{print $4}')"
    if [ -n "$reason" ]; then
      printf 'phase %s (%s): %s\n' "$phase_letter" "$phase_fn" "$reason"
    else
      printf 'phase %s (%s): no prefixed reason line (exit without fail())\n' \
        "$phase_letter" "$phase_fn"
    fi
  elif [ -n "$reason" ]; then
    printf 'before any phase: %s\n' "$reason"
  else
    printf 'before any phase: no prefixed reason line in %s\n' "$err_file"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ "$#" -eq 1 ] || { echo 'usage: physical-failure-summary.sh <adapter-stderr-file>' >&2; exit 2; }
  physical_failure_summary "$1"
fi
