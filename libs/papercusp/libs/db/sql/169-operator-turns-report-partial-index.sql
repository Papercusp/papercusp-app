-- Migration 169 — partial index for the operator-report attention source.
--
-- Plan: report-cards-inbox-reconciliation-2026-06-05 (Brief 38), P-003 / D-004.
--
-- The plans:attention reader gains an operator-report source that scans
-- harness_shared.operator_turns for recent turns carrying a `<report>`
-- payload (report IS NOT NULL, created_at over a recent window). Report
-- turns are a tiny fraction of all turns, so a partial index on the
-- predicate keeps that read O(report turns) instead of a seq scan over
-- the whole transcript.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS so re-running is a no-op.

CREATE INDEX IF NOT EXISTS operator_turns_report_recent_idx
  ON harness_shared.operator_turns (created_at)
  WHERE report IS NOT NULL;
