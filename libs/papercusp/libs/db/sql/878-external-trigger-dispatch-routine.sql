-- 878-external-trigger-dispatch-routine.sql — external-triggers P-003
--
-- Durable outbox execution for trigger_runs. Ingestion writes pending rows; the
-- existing DBOS routines engine drains them through system:external-trigger-dispatch.
-- No request process owns a timer and a restart cannot lose a matched binding.
--
-- FORWARD-COMPAT: the routines engine treats an unregistered system action as a
-- fail-soft skipped fire. During a rolling deploy the row may become due before the
-- new action module is loaded, but no trigger_run is mutated until the new code runs.

ALTER TABLE harness_shared.trigger_runs
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.trigger_runs'::regclass
       AND conname = 'trigger_runs_attempts_nonnegative_check'
  ) THEN
    ALTER TABLE harness_shared.trigger_runs
      ADD CONSTRAINT trigger_runs_attempts_nonnegative_check CHECK (attempts >= 0);
  END IF;
END
$$;

INSERT INTO harness_shared.routines
  (id, install_slug, workspace_id, name, trigger_kind, trigger_config,
   target_role, concurrency, catchup, active, next_fire_at, tier)
VALUES
  ('rt_papercusp_external_trigger_dispatch', 'papercusp', 'papercusp-workspace',
   'external-trigger-dispatch', 'cron',
   '{"cron":"*/10 * * * * *","batch_size":25,"stale_after_seconds":60}'::jsonb,
   'system:external-trigger-dispatch', 'skip', 'skip-old', TRUE, now(), 'durable')
ON CONFLICT (install_slug, name) DO UPDATE SET
  workspace_id = EXCLUDED.workspace_id,
  trigger_kind = EXCLUDED.trigger_kind,
  trigger_config = EXCLUDED.trigger_config,
  target_role = EXCLUDED.target_role,
  concurrency = EXCLUDED.concurrency,
  catchup = EXCLUDED.catchup,
  tier = EXCLUDED.tier,
  -- Preserve an operator's explicit pause on re-apply/re-seed.
  active = harness_shared.routines.active,
  updated_at = now();
