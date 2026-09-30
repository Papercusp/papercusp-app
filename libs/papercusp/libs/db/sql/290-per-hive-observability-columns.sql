-- 290-per-hive-observability-columns.sql
--
-- per-hive-learning-loops-2026-06-14 (P-013, OPTIONAL observability).
--
-- Make three per-agent observability signals attributable to a Hive (D-008), so
-- a future per-hive memory-health / calibration card can scope to one Hive. These
-- are ADDITIVE + NULLABLE — nothing writes them yet (the write-side stamping +
-- the consuming cards are future work); historical rows keep NULL. No read path
-- depends on them today, so this is a pure observability-readiness migration.
--
-- Idempotent (IF NOT EXISTS); additive; fresh-migrate-safe.

-- ── memory_recall_stats (240) — currently fully global (no workspace/hive) ─────
ALTER TABLE harness_shared.memory_recall_stats ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE harness_shared.memory_recall_stats ADD COLUMN IF NOT EXISTS hive_slug text;
CREATE INDEX IF NOT EXISTS memory_recall_stats_ws_hive_created_idx
    ON harness_shared.memory_recall_stats (workspace_id, hive_slug, created_at DESC);

-- ── memory_feedback (000-baseline) — already workspace-scoped ──────────────────
ALTER TABLE harness_shared.memory_feedback ADD COLUMN IF NOT EXISTS hive_slug text;
CREATE INDEX IF NOT EXISTS memory_feedback_ws_hive_created_idx
    ON harness_shared.memory_feedback (workspace_id, hive_slug, created_at DESC);

-- ── calibration_predictions (253) — already workspace-scoped ───────────────────
ALTER TABLE harness_shared.calibration_predictions ADD COLUMN IF NOT EXISTS hive_slug text;
CREATE INDEX IF NOT EXISTS calibration_predictions_ws_hive_idx
    ON harness_shared.calibration_predictions (workspace_id, hive_slug);
