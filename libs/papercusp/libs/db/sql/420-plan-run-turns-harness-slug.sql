-- 420-plan-run-turns-harness-slug.sql
--
-- data-scoping-audit-2026-06-22 P-005 — give `plan_run_turns` its own
-- `harness_slug` column for RLS + federation SYMMETRY with its parent.
--
-- Today a transcript turn reaches its scope only via the parent `plan_runs`
-- row (plan_runs IS harness_slug-scoped; the child is not). Any per-harness RLS
-- policy or federation projection on the turns table therefore needs a join to
-- the parent. Denormalize the parent's `harness_slug` onto the child so the
-- turns table is directly scope-bearing (the same shape the rest of the
-- harness_shared work tables carry).
--
-- Additive + NULLABLE (NOT a 'default' literal — derived from the parent, never
-- defaulted, so lint:no-workspace-default / lint:scope-defaults stay clean). The
-- writer (appendPlanRunTurn, agent-tools/plans/runs.ts) populates it via a
-- correlated subquery on the parent run; the expand/contract is safe across the
-- undeployed window — the pre-deploy writer simply omits the column (→ NULL), the
-- post-deploy writer fills it. Reader-dormant today (no RLS policy reads it yet),
-- so a NULL during that window is harmless.
--
-- NB hive_slug is intentionally NOT added: the parent `plan_runs` carries only
-- `harness_slug` (no hive column), so harness_slug is the exact parent-scope
-- mirror; the owning hive is derivable from harness_slug via the registry
-- (hiveHomeSlugForHarness) without denormalizing a column the parent lacks.
--
-- plan_run_turns is currently empty (0 rows live) → the ADD + backfill is
-- instant. Idempotent + non-destructive.

ALTER TABLE harness_shared.plan_run_turns
  ADD COLUMN IF NOT EXISTS harness_slug text;

-- D-006 backfill discipline: assign existing turns the parent run's harness.
-- Idempotent (IS DISTINCT FROM guard) + a no-op on the empty live table.
UPDATE harness_shared.plan_run_turns t
   SET harness_slug = r.harness_slug
  FROM harness_shared.plan_runs r
 WHERE r.id = t.plan_run_id
   AND t.harness_slug IS DISTINCT FROM r.harness_slug;

CREATE INDEX IF NOT EXISTS plan_run_turns_harness_slug_idx
  ON harness_shared.plan_run_turns (harness_slug);

COMMENT ON COLUMN harness_shared.plan_run_turns.harness_slug IS
  'Denormalized parent plan_runs.harness_slug (data-scoping-audit P-005) — makes the transcript-turn table directly scope-bearing for RLS/federation symmetry. Populated by appendPlanRunTurn from the parent run; NULL only for a turn written by pre-deploy code in the expand window. Derived, never defaulted.';
