#!/usr/bin/env bash
#
# llm-test-nightly.sh — Phase 5 nightly run.
#
# Drives `pnpm llm-test --target operator --target oracle` against the
# live Papercusp instance, then summarizes the result. New errors land
# in `harness_shared.llm_test_findings` (acknowledged=false) — the
# existing /admin/testing?tab=llm&subtab=findings UI is the alert
# surface. This script writes a one-line summary to stdout + a log
# file so systemd-journalctl carries the trail.
#
# Wiring (install once):
#   1. Copy this script's path into the timer's ExecStart.
#   2. Export ANTHROPIC_API_KEY in ~/.config/environment.d/ or via a
#      systemd Environment= line.
#   3. Make sure papercusp-desktop is running (the script will skip
#      with exit 0 if the operator port isn't reachable — better to
#      no-op than blast errors when the user has the laptop closed).
#
# Plan: apps/operator/docs/plans/llm-testing-framework-2026-05-14.md §12
# Phase 5.

set -uo pipefail

# ── Config ────────────────────────────────────────────────────────────
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${PAPERCUSP_REPO_ROOT:-$(git -C "$_HERE" rev-parse --show-toplevel 2>/dev/null || (cd "$_HERE/../../.." && pwd))}"
OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://127.0.0.1:3055}"
LOG_DIR="${LLM_TEST_LOG_DIR:-$HOME/.papercusp/llm-test-logs}"
TARGETS="${LLM_TEST_TARGETS:-operator oracle}"

mkdir -p "$LOG_DIR"
TS=$(date -u +%Y%m%d-%H%M%SZ)
LOG="$LOG_DIR/llm-test-$TS.log"

log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG" ; }

# ── Liveness probe ────────────────────────────────────────────────────
if ! curl -fsS --max-time 5 "$OPERATOR_URL/api/health" >/dev/null 2>&1; then
  if ! curl -fsS --max-time 5 "$OPERATOR_URL/" >/dev/null 2>&1; then
    log "operator not reachable at $OPERATOR_URL — skipping nightly (no-op exit 0)"
    exit 0
  fi
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  log "ANTHROPIC_API_KEY unset — refusing to run"
  exit 1
fi

# ── Run ───────────────────────────────────────────────────────────────
cd "$REPO_ROOT/apps/operator"
log "starting nightly llm-test (targets: $TARGETS)"

OVERALL_RC=0
for target in $TARGETS; do
  log "=== target: $target ==="
  if pnpm -s llm-test --target "$target" 2>&1 | tee -a "$LOG"; then
    log "$target: passed"
  else
    rc=$?
    log "$target: failed (exit $rc)"
    OVERALL_RC=$rc
  fi
done

# ── Retention sweep ───────────────────────────────────────────────────
# Calls harness_shared.llm_test_sweep_old(retain_days). Default 90;
# override with LLM_TEST_RETAIN_DAYS. Runs preserve unacknowledged
# severity=error findings regardless of age.
SWEEP_SQL="SELECT harness_shared.llm_test_sweep_old(${LLM_TEST_RETAIN_DAYS:-90}) AS deleted;"

# ── Summary ───────────────────────────────────────────────────────────
# Query the latest run set for a one-line digest.
SUMMARY_SQL='
  SELECT scenario_target,
         COUNT(*)                              AS runs,
         COUNT(*) FILTER (WHERE status=$$passed$$) AS passed,
         COUNT(*) FILTER (WHERE status=$$failed$$) AS failed,
         COUNT(*) FILTER (WHERE status=$$errored$$) AS errored,
         ROUND(SUM(cost_usd)::numeric, 4)      AS total_cost_usd
  FROM harness_shared.llm_test_runs
  WHERE started_at > now() - INTERVAL $$2 hours$$
  GROUP BY scenario_target
  ORDER BY scenario_target;
'
# Best-effort: skip the summary if psql / embedded-pg discovery is
# unavailable; the systemd journal still carries the per-scenario tee.
if command -v psql >/dev/null 2>&1; then
  PG_URL=$(node -e "
    try {
      const { getHarnessAdminUrl } = require('$REPO_ROOT/apps/operator/lib/embedded-pg-discovery');
      process.stdout.write(getHarnessAdminUrl());
    } catch (e) { process.exit(2); }
  " 2>/dev/null || true)
  if [ -n "$PG_URL" ]; then
    psql "$PG_URL" -c "$SUMMARY_SQL" 2>&1 | tee -a "$LOG" || true
    log "retention sweep:"
    psql "$PG_URL" -c "$SWEEP_SQL" 2>&1 | tee -a "$LOG" || true
  fi
fi

log "complete (overall exit $OVERALL_RC)"
exit "$OVERALL_RC"
