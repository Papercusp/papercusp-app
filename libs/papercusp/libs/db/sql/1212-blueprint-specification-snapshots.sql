-- P-003/P-004 — retain immutable compiled blueprint operation specifications.
-- `harness_shared.blueprints` remains the mutable one-row-per-harness current
-- cache. An accepted work item pins specification_revision here so a later
-- blueprint edit cannot rewrite its worker/model/schema contract. This table is
-- content-addressed, not a second task-state ledger or operation registry.
-- The migration runner wraps this file in its transaction.

CREATE TABLE IF NOT EXISTS harness_shared.blueprint_specifications (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  specification_revision text NOT NULL
    CHECK (specification_revision ~ '^[0-9a-f]{64}$'),
  artifact jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, specification_revision),
  CHECK (artifact->>'specificationRevision' = specification_revision)
);

COMMENT ON TABLE harness_shared.blueprint_specifications IS
  'Immutable compiled blueprint artifacts keyed by revision; work items carry only the pin while harness_shared.blueprints remains the current mutable cache.';

ALTER TABLE harness_shared.blueprint_specifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS blueprint_specifications_workspace_isolation ON harness_shared.blueprint_specifications;
CREATE POLICY blueprint_specifications_workspace_isolation ON harness_shared.blueprint_specifications
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT ON harness_shared.blueprint_specifications TO harness_app;
GRANT SELECT ON harness_shared.blueprint_specifications TO harness_zero;
