-- 453-operator-activity-workspace-id.sql
--
-- data-scoping-audit-2026-06-22 P-008 (WI-686) — add a REQUIRED workspace_id to the
-- "genuinely-global operator-activity tables the operator serves per-workspace" (D-002):
-- operator_turns, operator_continue_chains, operator_settings, orchestrator_settings,
-- ui_intents, tui_intents, periodic_sweep_runs. Today these 7 tables carry NO scope
-- column at all — every workspace an operator instance serves bleeds into one shared
-- pool (the exact single-tenant assumption D-002/D-005 flags as the multi-tenancy gap).
--
-- Companion code change (same commit): every write site now stamps `activeWorkspaceId()`
-- (packages/operator-core/lib/workspace-registry.ts — the existing per-window-workspace-
-- context resolver, already used by curation-surface.ts) into the new column. No new
-- parameter threading was needed — activeWorkspaceId() is ambient (request-scoped ALS,
-- falling back to the process pin / registry default), the same way these functions
-- already call getOrgPg() ambiently rather than taking a connection as an argument.
--
-- Shape (D-006 backfill discipline — the existing-row backfill ships in THIS migration,
-- not a follow-up): ADD nullable -> UPDATE existing rows to the install's one live
-- workspace ('papercusp-workspace', confirmed via fleet_assignment.workspace_id — this
-- install is single-tenant today, so every pre-migration row unambiguously belongs to
-- it) -> ALTER SET NOT NULL. NO column DEFAULT at any point (lint:no-workspace-default's
-- target is exactly a bare `DEFAULT 'default'` silently routing an unscoped insert into
-- a shared partition; per D-005 the column must be a REQUIRED, explicitly-supplied arg,
-- so this migration never introduces one, not even transiently) — the companion code
-- change lands in the SAME deploy, so by the time this migration's NOT NULL constraint
-- takes effect (migration-runner.js applies at operator boot, i.e. AFTER the new code is
-- already loaded) every write site already supplies workspace_id explicitly.
--
-- periodic_sweep_runs note: its heartbeat write is workspace-agnostic BY DESIGN (one
-- global reaper process, not one per workspace — work-queue-health.ts's own docstring:
-- "the reaper heartbeat is global"). Adding workspace_id here does not change that
-- design; it stamps which operator instance's reaper wrote the row (multi-tenancy
-- readiness), (sweep_name) stays the write key exactly as today (ON CONFLICT
-- (sweep_name) is unchanged).
--
-- Row counts at authoring time (small; instant on this install): operator_turns 8063,
-- ui_intents 692, operator_settings 100, operator_continue_chains 10, tui_intents 9,
-- orchestrator_settings 1, periodic_sweep_runs 1.

DO $$
DECLARE
  backfill_ws text := 'papercusp-workspace';
BEGIN
  -- operator_turns
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='harness_shared' AND table_name='operator_turns' AND column_name='workspace_id'
  ) THEN
    ALTER TABLE harness_shared.operator_turns ADD COLUMN workspace_id text;
    UPDATE harness_shared.operator_turns SET workspace_id = backfill_ws WHERE workspace_id IS NULL;
    ALTER TABLE harness_shared.operator_turns ALTER COLUMN workspace_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS operator_turns_workspace_id_idx ON harness_shared.operator_turns (workspace_id);
  END IF;

  -- operator_continue_chains
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='harness_shared' AND table_name='operator_continue_chains' AND column_name='workspace_id'
  ) THEN
    ALTER TABLE harness_shared.operator_continue_chains ADD COLUMN workspace_id text;
    UPDATE harness_shared.operator_continue_chains SET workspace_id = backfill_ws WHERE workspace_id IS NULL;
    ALTER TABLE harness_shared.operator_continue_chains ALTER COLUMN workspace_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS operator_continue_chains_workspace_id_idx ON harness_shared.operator_continue_chains (workspace_id);
  END IF;

  -- operator_settings
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='harness_shared' AND table_name='operator_settings' AND column_name='workspace_id'
  ) THEN
    ALTER TABLE harness_shared.operator_settings ADD COLUMN workspace_id text;
    UPDATE harness_shared.operator_settings SET workspace_id = backfill_ws WHERE workspace_id IS NULL;
    ALTER TABLE harness_shared.operator_settings ALTER COLUMN workspace_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS operator_settings_workspace_id_idx ON harness_shared.operator_settings (workspace_id);
  END IF;

  -- orchestrator_settings
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='harness_shared' AND table_name='orchestrator_settings' AND column_name='workspace_id'
  ) THEN
    ALTER TABLE harness_shared.orchestrator_settings ADD COLUMN workspace_id text;
    UPDATE harness_shared.orchestrator_settings SET workspace_id = backfill_ws WHERE workspace_id IS NULL;
    ALTER TABLE harness_shared.orchestrator_settings ALTER COLUMN workspace_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS orchestrator_settings_workspace_id_idx ON harness_shared.orchestrator_settings (workspace_id);
  END IF;

  -- ui_intents
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='harness_shared' AND table_name='ui_intents' AND column_name='workspace_id'
  ) THEN
    ALTER TABLE harness_shared.ui_intents ADD COLUMN workspace_id text;
    UPDATE harness_shared.ui_intents SET workspace_id = backfill_ws WHERE workspace_id IS NULL;
    ALTER TABLE harness_shared.ui_intents ALTER COLUMN workspace_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS ui_intents_workspace_id_idx ON harness_shared.ui_intents (workspace_id);
  END IF;

  -- tui_intents
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='harness_shared' AND table_name='tui_intents' AND column_name='workspace_id'
  ) THEN
    ALTER TABLE harness_shared.tui_intents ADD COLUMN workspace_id text;
    UPDATE harness_shared.tui_intents SET workspace_id = backfill_ws WHERE workspace_id IS NULL;
    ALTER TABLE harness_shared.tui_intents ALTER COLUMN workspace_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS tui_intents_workspace_id_idx ON harness_shared.tui_intents (workspace_id);
  END IF;

  -- periodic_sweep_runs
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='harness_shared' AND table_name='periodic_sweep_runs' AND column_name='workspace_id'
  ) THEN
    ALTER TABLE harness_shared.periodic_sweep_runs ADD COLUMN workspace_id text;
    UPDATE harness_shared.periodic_sweep_runs SET workspace_id = backfill_ws WHERE workspace_id IS NULL;
    ALTER TABLE harness_shared.periodic_sweep_runs ALTER COLUMN workspace_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS periodic_sweep_runs_workspace_id_idx ON harness_shared.periodic_sweep_runs (workspace_id);
  END IF;
END $$;

COMMENT ON COLUMN harness_shared.operator_turns.workspace_id IS
  'REQUIRED (data-scoping-audit P-008/WI-686/D-005) — the workspace this turn belongs to, stamped from activeWorkspaceId() at write time. No column default by design; an omitted value is a caller bug, not a silent ''default'' partition.';
COMMENT ON COLUMN harness_shared.operator_continue_chains.workspace_id IS
  'REQUIRED (data-scoping-audit P-008/WI-686/D-005) — stamped from activeWorkspaceId() at write time.';
COMMENT ON COLUMN harness_shared.operator_settings.workspace_id IS
  'REQUIRED (data-scoping-audit P-008/WI-686/D-005) — stamped from activeWorkspaceId() at write time.';
COMMENT ON COLUMN harness_shared.orchestrator_settings.workspace_id IS
  'REQUIRED (data-scoping-audit P-008/WI-686/D-005) — stamped from activeWorkspaceId() at write time.';
COMMENT ON COLUMN harness_shared.ui_intents.workspace_id IS
  'REQUIRED (data-scoping-audit P-008/WI-686/D-005) — stamped from activeWorkspaceId() at write time.';
COMMENT ON COLUMN harness_shared.tui_intents.workspace_id IS
  'REQUIRED (data-scoping-audit P-008/WI-686/D-005) — stamped from activeWorkspaceId() at write time.';
COMMENT ON COLUMN harness_shared.periodic_sweep_runs.workspace_id IS
  'REQUIRED (data-scoping-audit P-008/WI-686/D-005) — which operator instance''s reaper wrote this heartbeat row; the sweep itself stays workspace-agnostic (one global process), (sweep_name) is unchanged as the write key.';
