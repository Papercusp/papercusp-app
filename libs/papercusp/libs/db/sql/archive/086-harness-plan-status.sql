-- 086: harness_plan_status — tracks which plans are "started" (active for orchestrator).
--
-- Per plans-central-harness-ux-2026-05-26 Phase 1 P-001.
--
-- The plan frontmatter status (draft/active/shipped/superseded) tracks the
-- document lifecycle. This table tracks the operational state: whether the
-- user has started a plan, causing the orchestrator to pick only features
-- whose source_plan_slug is in the started set.
--
-- status values:
--   started  — orchestrator picks features from this plan
--   paused   — orchestrator ignores features from this plan until resumed
--   done     — plan work is complete; archived for history
--
-- A plan with no row in this table is implicitly NOT started (orchestrator
-- will not pick its features).

CREATE TABLE IF NOT EXISTS harness_shared.harness_plan_status (
  workspace_id   TEXT        NOT NULL,
  harness_slug   TEXT        NOT NULL,
  plan_slug      TEXT        NOT NULL,
  status         TEXT        NOT NULL CHECK (status IN ('started', 'paused', 'done')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, plan_slug)
);

-- Row-level security: workspace isolation.
ALTER TABLE harness_shared.harness_plan_status ENABLE ROW LEVEL SECURITY;

-- DROP-then-CREATE so the policy is idempotent when the table pre-exists
-- (CREATE POLICY has no IF NOT EXISTS; mirrors the trigger handling below).
DROP POLICY IF EXISTS harness_plan_status_workspace_isolation
  ON harness_shared.harness_plan_status;
CREATE POLICY harness_plan_status_workspace_isolation
  ON harness_shared.harness_plan_status
  AS PERMISSIVE FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Fast lookup: "which plans are started for harness X?"
CREATE INDEX IF NOT EXISTS hps_started_idx
  ON harness_shared.harness_plan_status (workspace_id, harness_slug, status)
  WHERE status = 'started';

-- Trigger: keep updated_at current on every update.
CREATE OR REPLACE FUNCTION harness_shared.set_hps_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$body$;

DROP TRIGGER IF EXISTS hps_updated_at_trigger ON harness_shared.harness_plan_status;
CREATE TRIGGER hps_updated_at_trigger
  BEFORE UPDATE ON harness_shared.harness_plan_status
  FOR EACH ROW EXECUTE FUNCTION harness_shared.set_hps_updated_at();

-- Access grants: harness_app is the runtime role; harness_admin owns schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_plan_status TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_plan_status TO harness_admin;
