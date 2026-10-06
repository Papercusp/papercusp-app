-- 1362 — trigger-pack installations (generalized-integrations-google-migration-cupboard-workflows-2026-10-05
-- P-012, D-013).
--
-- A Cupboard trigger pack is pure manifest data. Installing one into a harness now MATERIALIZES it:
-- plan targets become plans, bindings and edges become DISARMED trigger_bindings rows, and the
-- installer-local choices (which local data source a portable `datatype` source binds to, the pack
-- input values) are recorded here, owned by one installation row.
--
--   1. harness_shared.trigger_pack_installations — one row per (workspace, harness, plugin).
--      `resources` lists what the installation created (plan slugs, binding ids, the edge source),
--      `unmet` lists bindings that could not bind yet (zero or several candidate sources), and
--      `status` is needs-configuration until `unmet` is empty. Installation never arms anything.
--   2. trigger_bindings.datatype_id — a portable binding matches only canonical events of this
--      datatype. The binding engine compares it with the event's datatypeId (NULL = any).
--   3. trigger_bindings.pack_installation_id — links every binding an installation owns, so
--      uninstall (P-013) is one query. SET NULL keeps run history addressable after uninstall.
--   4. The `trigger-run-completion` platform datatype: the canonical payload of the internal
--      `ext:trigger-pack-edge:binding-run-completed` event that stitches pack edges through the
--      ordinary ingestion outbox. Seeded into the platform catalog like 1269 seeds webhook-payload;
--      a workspace installs it through installPublishedDatatype on its first edge.
--
-- Additive only: a new table, two nullable columns, one index, one upserted catalog row.

CREATE TABLE IF NOT EXISTS harness_shared.trigger_pack_installations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     text NOT NULL,
  harness_slug     text NOT NULL,
  plugin_name      text NOT NULL,
  plugin_version   text NOT NULL,
  source_mappings  jsonb NOT NULL DEFAULT '{}'::jsonb,
  inputs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  resources        jsonb NOT NULL DEFAULT '{}'::jsonb,
  unmet            jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL DEFAULT 'needs-configuration',
  created_by       text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trigger_pack_installations_identity UNIQUE (workspace_id, harness_slug, plugin_name),
  CONSTRAINT trigger_pack_installations_status_check
    CHECK (status IN ('needs-configuration', 'configured')),
  CONSTRAINT trigger_pack_installations_source_mappings_object
    CHECK (jsonb_typeof(source_mappings) = 'object'),
  CONSTRAINT trigger_pack_installations_inputs_object CHECK (jsonb_typeof(inputs) = 'object'),
  CONSTRAINT trigger_pack_installations_resources_object CHECK (jsonb_typeof(resources) = 'object'),
  CONSTRAINT trigger_pack_installations_unmet_array CHECK (jsonb_typeof(unmet) = 'array'),
  CONSTRAINT trigger_pack_installations_names_nonempty
    CHECK (btrim(harness_slug) <> '' AND btrim(plugin_name) <> '' AND btrim(plugin_version) <> '')
);

COMMENT ON TABLE harness_shared.trigger_pack_installations IS
  'generalized-integrations P-012 (D-013): one materialized Cupboard trigger pack in one harness. Owns the plans, disarmed bindings and edge source it created (resources), the installer-local source mappings and inputs, and the unmet source requirements. Installing never arms anything.';
COMMENT ON COLUMN harness_shared.trigger_pack_installations.source_mappings IS
  'Pack binding id -> installer-chosen local data_sources id. Only portable (datatype) sources and ambiguous provider-pinned sources need one.';
COMMENT ON COLUMN harness_shared.trigger_pack_installations.unmet IS
  'Array of { bindingId, requirement, candidates[] }: bindings left unbound until the installer supplies a source mapping.';

ALTER TABLE harness_shared.trigger_pack_installations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'harness_shared'
       AND tablename = 'trigger_pack_installations'
       AND policyname = 'trigger_pack_installations_workspace_isolation'
  ) THEN
    CREATE POLICY trigger_pack_installations_workspace_isolation
      ON harness_shared.trigger_pack_installations
      USING (workspace_id = current_setting('app.workspace_id'::text, true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id'::text, true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.trigger_pack_installations TO harness_app;

ALTER TABLE harness_shared.trigger_bindings
  ADD COLUMN IF NOT EXISTS datatype_id text NULL,
  ADD COLUMN IF NOT EXISTS pack_installation_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trigger_bindings_pack_installation_fk'
       AND conrelid = 'harness_shared.trigger_bindings'::regclass
  ) THEN
    ALTER TABLE harness_shared.trigger_bindings
      ADD CONSTRAINT trigger_bindings_pack_installation_fk
      FOREIGN KEY (pack_installation_id)
      REFERENCES harness_shared.trigger_pack_installations (id)
      ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trigger_bindings_datatype_id_nonempty'
       AND conrelid = 'harness_shared.trigger_bindings'::regclass
  ) THEN
    ALTER TABLE harness_shared.trigger_bindings
      ADD CONSTRAINT trigger_bindings_datatype_id_nonempty
      CHECK (datatype_id IS NULL OR btrim(datatype_id) <> '');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS trigger_bindings_ws_pack_installation_idx
  ON harness_shared.trigger_bindings (workspace_id, pack_installation_id)
  WHERE pack_installation_id IS NOT NULL;

COMMENT ON COLUMN harness_shared.trigger_bindings.datatype_id IS
  'Portable binding datatype (P-012, D-013): when set, the binding engine queues a run only for canonical events whose datatypeId equals it. NULL matches any datatype.';
COMMENT ON COLUMN harness_shared.trigger_bindings.pack_installation_id IS
  'The trigger_pack_installations row that materialized this binding; NULL for hand-bound and pre-P-012 bindings.';

INSERT INTO harness_shared.datatype_registry
  (id, workspace_id, pot_slug, title, description, tier, work_item_kind,
   payload_schema, authoritative_writer, self_improvement, status, published,
   review_status, tags, nature, created_by, updated_at)
VALUES (
  'trigger-run-completion', 'papercusp-workspace', 'papercusp', 'Trigger run completion',
  'Canonical payload of the internal trigger-pack edge event: one upstream binding run finished successfully. Downstream pack bindings filter on upstreamBindingId and inherit correlationId.',
  'first-class', NULL,
  '{"type":"object","properties":{"upstreamBindingId":{"type":"string","minLength":1},"upstreamTriggerRunId":{"type":"string","minLength":1},"packInstallationId":{"type":"string"},"correlationId":{"type":"string","minLength":1},"actionType":{"type":"string","minLength":1},"planRunId":{"type":["integer","null"]},"instancePlanSlug":{"type":["string","null"]},"completedAt":{"type":"string"}},"required":["upstreamBindingId","upstreamTriggerRunId","correlationId","actionType"],"additionalProperties":false}'::jsonb,
  'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"]}'::jsonb,
  'active', TRUE, 'approved', ARRAY['trigger-pack','internal','first-party','event'],
  'event',
  'generalized-integrations-google-migration-cupboard-workflows-2026-10-05', now()
)
ON CONFLICT (workspace_id, id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  payload_schema = EXCLUDED.payload_schema,
  tags = EXCLUDED.tags,
  nature = EXCLUDED.nature,
  updated_at = now();
