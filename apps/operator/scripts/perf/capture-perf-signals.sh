#!/usr/bin/env bash
# capture-perf-signals.sh — scheduled producer for the perf-signals-v1 guard.
#
# WHY (WI-324, su-2255d 2026-06-22): the CLOSE_WAIT / event-loop-lag / :3070-
# reachability SLO budgets in packages/operator-core/lib/system-health/
# perf-budgets.ts (consumed by the infra health panel AND the green-checkpoint
# perf-gate, apps/operator/lib/release/perf-gate.ts) read the *latest*
# perf-signals-v1 capture and treat anything older than staleMs (10 min) as
# `unknown` — i.e. they SILENTLY GO BLIND. capture-signals.py was only ever run
# ad-hoc by agents, so the latest capture had gone 62h stale and the guard never
# fired. This wrapper is the missing scheduled producer: it refreshes the capture
# on the timer's cadence (every 2 min, well under staleMs) and bounds the dir.
#
# Read-only host probe. Deliberately a systemd timer, NOT a DBOS scheduled
# workflow nor an in-process operator tick: the signals are dev-box host facts
# (ss / ps / systemctl / :3070 CLOSE_WAIT) — infra monitoring, not product code,
# and a per-tick DBOS workflow_status row is exactly the high-freq bloat that
# caused the freeze (EI-1622). Mirrors llm-test-nightly.* per
# dbos-scheduler-consolidation-2026-06-03 D-004.
set -euo pipefail

OUT_DIR="${PAPERCUSP_PERF_BASELINES_DIR:-$HOME/.papercusp/perf-baselines}"
# PAPERCUSP_PERF_SIGNALS_DIR: set by the systemd unit, which runs this script from a
# /tmp snapshot where BASH_SOURCE no longer sits beside capture-signals.py.
SCRIPT_DIR="${PAPERCUSP_PERF_SIGNALS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
KEEP=15  # newest N scheduled captures to retain (~30 min of history at the 2-min cadence)

python3 "$SCRIPT_DIR/capture-signals.py" --label scheduled --out "$OUT_DIR" >/dev/null

# Bound the dir: keep only the newest $KEEP *-scheduled.json files. Globs only the
# scheduled label, so ad-hoc/manual captures (any other label) are never deleted.
mapfile -t files < <(ls -t "$OUT_DIR"/*-scheduled.json 2>/dev/null || true)
if (( ${#files[@]} > KEEP )); then
  printf '%s\n' "${files[@]:KEEP}" | xargs -r rm -f
fi
