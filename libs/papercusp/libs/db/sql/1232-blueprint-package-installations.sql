-- P-006: the parent receipt extends the exact-resource journal (1230).
-- Unlike per-resource rows it exists for an empty install and fences late writes
-- before cleanup enumerates resources. No content or external executor lives here.
CREATE TABLE harness_shared.blueprint_package_installations (
  workspace_id text NOT NULL,
  dependent_id text NOT NULL,
  owner_id text NOT NULL,
  specification_revision text NOT NULL,
  state_revision text NOT NULL,
  expected_resources jsonb NOT NULL CHECK (jsonb_typeof(expected_resources) = 'object'),
  phase text NOT NULL DEFAULT 'preparing'
    CHECK (phase IN ('preparing', 'applied', 'releasing', 'released', 'cleanup_failed')),
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dependent_id)
);
CREATE INDEX blueprint_package_installations_owner_idx
  ON harness_shared.blueprint_package_installations (workspace_id, owner_id)
  WHERE phase <> 'released';
ALTER TABLE harness_shared.blueprint_package_installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY blueprint_package_installations_workspace ON harness_shared.blueprint_package_installations
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.blueprint_package_installations TO harness_app;
GRANT SELECT ON harness_shared.blueprint_package_installations TO harness_zero;
