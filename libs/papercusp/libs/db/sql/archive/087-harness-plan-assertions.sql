-- 087: harness_plan_assertions — inline VAL-* assertion storage.
--
-- Per plans-central-harness-ux-2026-05-26 Phase 6 P-019.
--
-- Assertions are authored inline inside plan items as nested VAL-* sub-bullets.
-- plans:promote extracts them here so the validator agent can resolve assertion
-- text by ID without reading the plan file.
--
-- The plan item remains the canonical source of truth. This table is a
-- projection: rebuilt whenever plans:promote runs. No automated migration
-- of existing validation-contract.md entries.
--
-- val_id format: VAL-{plan_slug}-{NNN}  (globally unique within a harness)

CREATE TABLE IF NOT EXISTS harness_shared.harness_plan_assertions (
  workspace_id   TEXT        NOT NULL,
  harness_slug   TEXT        NOT NULL,
  val_id         TEXT        NOT NULL,
  plan_slug      TEXT        NOT NULL,
  item_id        TEXT        NOT NULL,
  verify_text    TEXT        NOT NULL,
  evidence_text  TEXT        NOT NULL DEFAULT '',
  status         TEXT        NOT NULL DEFAULT 'todo'
                             CHECK (status IN ('todo', 'validating', 'passed', 'failed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, val_id)
);

ALTER TABLE harness_shared.harness_plan_assertions ENABLE ROW LEVEL SECURITY;

-- DROP-then-CREATE so the policy is idempotent when the table pre-exists
-- (CREATE POLICY has no IF NOT EXISTS; mirrors the trigger handling below).
DROP POLICY IF EXISTS harness_plan_assertions_workspace_isolation
  ON harness_shared.harness_plan_assertions;
CREATE POLICY harness_plan_assertions_workspace_isolation
  ON harness_shared.harness_plan_assertions
  AS PERMISSIVE FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE INDEX IF NOT EXISTS hpa_plan_item_idx
  ON harness_shared.harness_plan_assertions (workspace_id, harness_slug, plan_slug, item_id);

CREATE OR REPLACE FUNCTION harness_shared.set_hpa_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$body$;

DROP TRIGGER IF EXISTS hpa_updated_at_trigger ON harness_shared.harness_plan_assertions;
CREATE TRIGGER hpa_updated_at_trigger
  BEFORE UPDATE ON harness_shared.harness_plan_assertions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.set_hpa_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_plan_assertions TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_plan_assertions TO harness_admin;
