#!/usr/bin/env bash
# Collect a PSI-stamped desktop-perf sample (resource-efficiency-closeout-2026-08-13 D-005).
#
# D-005 rules that block-mode may only arm once the quiet-window threshold is derived from a
# LARGER PSI-stamped sample than the 3 runs that justified the design. Every run now stamps
# /proc/pressure/cpu at start and end (perf-report.ts recordHostPressure), so the sample is
# collected simply by running the smoke spec repeatedly and reading the rows back out of
# harness_shared.desktop_perf_runs.
#
# Deliberately SEQUENTIAL: concurrent desktop instances would contend with each other, which
# would manufacture the very contention the sample is meant to observe.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

N="${1:-12}"
LOG="${2:-/tmp/psi-sample.log}"
: > "$LOG"

for i in $(seq 1 "$N"); do
  echo "=== SAMPLE $i/$N start $(date -u +%FT%TZ) psi=$(awk '/^some/{print $2}' /proc/pressure/cpu) load=$(cut -d' ' -f1 /proc/loadavg)" >> "$LOG"
  env -u PAPERCUSP_OPERATOR_URL npx wdio run wdio.conf.ts --spec ./specs/smoke.spec.ts >> "$LOG" 2>&1
  rc=$?
  echo "=== SAMPLE $i/$N exit=$rc $(date -u +%FT%TZ)" >> "$LOG"
done
echo "===ALL DONE===" >> "$LOG"
