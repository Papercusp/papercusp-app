-- 1142: make cross-plan decision `affects` edges durable and reverse-queryable.
--
-- `harness_plans.content` remains canonical. The parser derives this array from
-- each decision's `Affects:` metadata, and the existing plan-index writer
-- replaces these rows atomically on every content write. This column is an
-- extension of the existing derived decision index, not a parallel authority
-- store. Existing rows default empty because the former plans:add-decision
-- implementation emitted affects only as a best-effort notification and did
-- not retain an edge that could be backfilled safely.

ALTER TABLE harness_shared.plan_decisions
  ADD COLUMN IF NOT EXISTS affects text[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS plan_decisions_affects_gin
  ON harness_shared.plan_decisions USING gin (affects);

COMMENT ON COLUMN harness_shared.plan_decisions.affects IS
  'Derived reverse-authority edges parsed from canonical decision Affects: metadata. Target-plan claimants query this array; harness_plans.content remains the source of truth.';
