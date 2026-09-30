-- 095: cross-plan dispatch priority on harness_plan_status.
--
-- Per dbos-system-completion-2026-06-01 P-042/P-045 (D-013). The frontier
-- dispatcher groups the ready set by plan and orders the groups by this
-- priority (lower = dispatched first); the Plans page drag-to-reorder (P-045)
-- writes it. NULL = unset → the frontier orders unset plans AFTER all explicit
-- ones, by `started_at` (so the default is started-order, no backfill needed).
--
--   priority  INTEGER  — cross-plan dispatch rank; lower runs first. NULLable.
--
-- Idempotent (PG 9.6+ IF NOT EXISTS). Pure ALTER.

ALTER TABLE harness_shared.harness_plan_status
  ADD COLUMN IF NOT EXISTS priority INTEGER;
