-- Portable identities P-006: extend blueprint provisioning with resource ownership.
-- The existing immutable release index remains package/history authority. These
-- rows only journal exact external writes and their shared install dependents.
CREATE TABLE harness_shared.blueprint_package_resources (
  workspace_id text NOT NULL,
  resource_key text NOT NULL,
  memory_scope text NOT NULL,
  package_kind text NOT NULL,
  package_ref text NOT NULL,
  package_version text NOT NULL,
  package_hash text NOT NULL,
  resource_kind text NOT NULL,
  item_key text NOT NULL,
  installed_hash text NOT NULL,
  write_key uuid NOT NULL DEFAULT gen_random_uuid(),
  phase text NOT NULL DEFAULT 'intent'
    CHECK (phase IN ('intent', 'ready', 'cleanup_failed', 'deleted', 'detached')),
  external_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(external_refs) = 'array'),
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, resource_key),
  UNIQUE (workspace_id, write_key)
);

CREATE TABLE harness_shared.blueprint_package_dependents (
  workspace_id text NOT NULL,
  dependent_id text NOT NULL,
  resource_key text NOT NULL,
  phase text NOT NULL DEFAULT 'prepared' CHECK (phase IN ('prepared', 'applied', 'released')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dependent_id, resource_key),
  FOREIGN KEY (workspace_id, resource_key)
    REFERENCES harness_shared.blueprint_package_resources (workspace_id, resource_key)
);
CREATE INDEX blueprint_package_dependents_resource_idx
  ON harness_shared.blueprint_package_dependents (workspace_id, resource_key)
  WHERE phase <> 'released';

ALTER TABLE harness_shared.blueprint_package_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.blueprint_package_dependents ENABLE ROW LEVEL SECURITY;
CREATE POLICY blueprint_package_resources_workspace ON harness_shared.blueprint_package_resources
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY blueprint_package_dependents_workspace ON harness_shared.blueprint_package_dependents
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.blueprint_package_resources,
  harness_shared.blueprint_package_dependents TO harness_app;
GRANT SELECT ON harness_shared.blueprint_package_resources,
  harness_shared.blueprint_package_dependents TO harness_zero;
