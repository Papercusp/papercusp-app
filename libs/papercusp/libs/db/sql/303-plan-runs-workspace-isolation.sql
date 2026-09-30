-- 303-plan-runs-workspace-isolation.sql — workspace-data-isolation-leaks-2026-06-17 F-A2.
--
-- plan_runs / plan_run_turns (scheduled-plan run history + agent transcripts) had
-- NO workspace_id column and were read/written via withWorkspace(DEFAULT_WORKSPACE_ID)
-- (runs.ts) — so a scheduled-plan run + its full transcript created in workspace A
-- were globally visible (plans:runs / plans:run-transcript) in workspace B. Both
-- tables are EMPTY at migration time (verified 0 rows 2026-06-17).
--
-- PHASE 1 (this migration): add workspace_id (additive, DEFAULT '') + index + grants.
-- runs.ts is updated in the SAME change to stamp workspace_id = the active workspace
-- on every write AND filter every read by it, so isolation is enforced immediately by
-- the explicit predicate. RLS is INTENTIONALLY NOT enabled here: enabling it before the
-- new code is universally live would make the old code's INSERT (which omits workspace_id
-- ⇒ '') fail the WITH CHECK during the deploy window. The RLS ENABLE + policy is a Phase-2
-- follow-up (a one-line migration) once this code has shipped everywhere — defense-in-depth
-- on top of the explicit filters. (Mirrors the spec/workspace-scoping two-step: column +
-- backfill first, RLS after.)
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); additive; fresh-migrate-safe.

ALTER TABLE harness_shared.plan_runs
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS plan_runs_workspace_idx
  ON harness_shared.plan_runs(workspace_id);

ALTER TABLE harness_shared.plan_run_turns
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS plan_run_turns_workspace_idx
  ON harness_shared.plan_run_turns(workspace_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plan_runs TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plan_run_turns TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.plan_runs TO harness_zero;
  GRANT SELECT ON harness_shared.plan_run_turns TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;
