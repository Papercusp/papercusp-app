-- 876-external-trigger-core.sql — external-triggers-gmail-slack-2026-08-22 P-001
--
-- Canonical trigger substrate shared by provider adapters, the ext:* event bus,
-- plan bindings, and the Personal Vault fan-out.  Provider replay state stays
-- on the source row; v1 deliberately has no always-on queue table.
--
-- A delivery row represents one normalized event going to one sink.  The sink
-- dimension is part of the idempotency key so one provider event can fan out to
-- the event bus and Personal Vault without being mistaken for a duplicate.
-- Trigger runs are separate: one emitted event may match multiple bindings.
--
-- FORWARD-COMPAT: this migration only adds tables, indexes, policies, and grants;
-- the currently deployed release does not reference them.

CREATE TABLE IF NOT EXISTS harness_shared.trigger_sources (
    workspace_id       text NOT NULL,
    id                 uuid NOT NULL DEFAULT gen_random_uuid(),
    kind               text NOT NULL,
    config             jsonb NOT NULL DEFAULT '{}'::jsonb,
    credential_ref     text,
    status             text NOT NULL DEFAULT 'unconfigured',
    cursor             jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_connected_at  timestamptz,
    last_error         text,
    created_by         text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT trigger_sources_kind_nonempty
      CHECK (btrim(kind) <> ''),
    CONSTRAINT trigger_sources_credential_ref_nonempty
      CHECK (credential_ref IS NULL OR btrim(credential_ref) <> ''),
    CONSTRAINT trigger_sources_status_check
      CHECK (status IN (
        'unconfigured', 'ready', 'connecting', 'connected',
        'degraded', 'error', 'disabled'
      )),
    CONSTRAINT trigger_sources_config_object_check
      CHECK (jsonb_typeof(config) = 'object'),
    CONSTRAINT trigger_sources_cursor_object_check
      CHECK (jsonb_typeof(cursor) = 'object')
);

COMMENT ON TABLE harness_shared.trigger_sources IS
  'Configured schedule/manual/external trigger sources. Provider replay watermarks live in cursor; credentials are referenced opaquely and never stored here.';
COMMENT ON COLUMN harness_shared.trigger_sources.cursor IS
  'Provider-owned reconnect/replay watermark (for example Gmail historyId or Slack delayed-event state); not an application queue.';
COMMENT ON COLUMN harness_shared.trigger_sources.credential_ref IS
  'Opaque reference to injected credential storage. Secret material must never be stored in this table.';

CREATE TABLE IF NOT EXISTS harness_shared.trigger_bindings (
    workspace_id       text NOT NULL,
    id                 uuid NOT NULL DEFAULT gen_random_uuid(),
    source_id          uuid NOT NULL,
    plan_harness_slug  text NOT NULL,
    plan_slug          text NOT NULL,
    event_pattern      text NOT NULL,
    event_filter       jsonb NOT NULL DEFAULT '{}'::jsonb,
    action             jsonb NOT NULL DEFAULT '{}'::jsonb,
    armed              boolean NOT NULL DEFAULT false,
    storm_policy       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by         text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT trigger_bindings_source_fk
      FOREIGN KEY (workspace_id, source_id)
      REFERENCES harness_shared.trigger_sources (workspace_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT trigger_bindings_plan_fk
      FOREIGN KEY (workspace_id, plan_harness_slug, plan_slug)
      REFERENCES harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
      ON DELETE RESTRICT,
    CONSTRAINT trigger_bindings_event_pattern_nonempty
      CHECK (btrim(event_pattern) <> ''),
    CONSTRAINT trigger_bindings_event_filter_object_check
      CHECK (jsonb_typeof(event_filter) = 'object'),
    CONSTRAINT trigger_bindings_action_object_check
      CHECK (jsonb_typeof(action) = 'object'),
    CONSTRAINT trigger_bindings_storm_policy_object_check
      CHECK (jsonb_typeof(storm_policy) = 'object')
);

COMMENT ON TABLE harness_shared.trigger_bindings IS
  'Attach a source event pattern to a plan action. A plan is derived as triggered when at least one binding exists; no copied plan kind/is_triggered flag is stored.';
COMMENT ON COLUMN harness_shared.trigger_bindings.armed IS
  'Installed is not armed: a binding must be explicitly armed before it can start a plan.';

CREATE TABLE IF NOT EXISTS harness_shared.trigger_deliveries (
    workspace_id       text NOT NULL,
    id                 uuid NOT NULL DEFAULT gen_random_uuid(),
    source_id          uuid NOT NULL,
    dedupe_key         text NOT NULL,
    datatype_id        text NOT NULL,
    event_key          text NOT NULL,
    payload            jsonb NOT NULL,
    sink_kind          text NOT NULL,
    sink_ref           text NOT NULL DEFAULT 'default',
    outcome            text NOT NULL DEFAULT 'pending',
    emitted_event_key  text,
    attempts           integer NOT NULL DEFAULT 0,
    error              text,
    received_at        timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT trigger_deliveries_source_fk
      FOREIGN KEY (workspace_id, source_id)
      REFERENCES harness_shared.trigger_sources (workspace_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT trigger_deliveries_datatype_fk
      FOREIGN KEY (workspace_id, datatype_id)
      REFERENCES harness_shared.datatype_registry (workspace_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT trigger_deliveries_dedupe_key_nonempty
      CHECK (btrim(dedupe_key) <> ''),
    CONSTRAINT trigger_deliveries_event_key_nonempty
      CHECK (btrim(event_key) <> ''),
    CONSTRAINT trigger_deliveries_sink_kind_nonempty
      CHECK (btrim(sink_kind) <> ''),
    CONSTRAINT trigger_deliveries_sink_ref_nonempty
      CHECK (btrim(sink_ref) <> ''),
    CONSTRAINT trigger_deliveries_outcome_check
      CHECK (outcome IN ('pending', 'delivered', 'failed', 'skipped')),
    CONSTRAINT trigger_deliveries_payload_object_check
      CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT trigger_deliveries_attempts_nonnegative_check
      CHECK (attempts >= 0),
    CONSTRAINT trigger_deliveries_sink_dedupe_key
      UNIQUE (workspace_id, source_id, dedupe_key, sink_kind, sink_ref)
);

COMMENT ON TABLE harness_shared.trigger_deliveries IS
  'One durable outcome per normalized provider event and sink. Canonical payload validation failures remain failed ledger rows rather than silently mutating their shape.';
COMMENT ON COLUMN harness_shared.trigger_deliveries.datatype_id IS
  'Canonical external-data datatype in harness_shared.datatype_registry (for example email-message or chat-message).';
COMMENT ON COLUMN harness_shared.trigger_deliveries.sink_kind IS
  'Fan-out destination class, such as event-bus or personal-vault; paired with sink_ref in the delivery idempotency key.';

CREATE TABLE IF NOT EXISTS harness_shared.trigger_runs (
    workspace_id       text NOT NULL,
    id                 uuid NOT NULL DEFAULT gen_random_uuid(),
    binding_id         uuid NOT NULL,
    delivery_id        uuid,
    dedupe_key         text NOT NULL,
    status             text NOT NULL DEFAULT 'pending',
    args               jsonb NOT NULL DEFAULT '{}'::jsonb,
    plan_run_ref       text,
    outcome            jsonb NOT NULL DEFAULT '{}'::jsonb,
    error              text,
    triggered_at       timestamptz NOT NULL DEFAULT now(),
    started_at         timestamptz,
    completed_at       timestamptz,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT trigger_runs_binding_fk
      FOREIGN KEY (workspace_id, binding_id)
      REFERENCES harness_shared.trigger_bindings (workspace_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT trigger_runs_delivery_fk
      FOREIGN KEY (workspace_id, delivery_id)
      REFERENCES harness_shared.trigger_deliveries (workspace_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT trigger_runs_dedupe_key_nonempty
      CHECK (btrim(dedupe_key) <> ''),
    CONSTRAINT trigger_runs_status_check
      CHECK (status IN (
        'pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled'
      )),
    CONSTRAINT trigger_runs_args_object_check
      CHECK (jsonb_typeof(args) = 'object'),
    CONSTRAINT trigger_runs_outcome_object_check
      CHECK (jsonb_typeof(outcome) = 'object'),
    CONSTRAINT trigger_runs_binding_dedupe_key
      UNIQUE (workspace_id, binding_id, dedupe_key)
);

COMMENT ON TABLE harness_shared.trigger_runs IS
  'One idempotent plan-start attempt per binding and trigger occurrence. External-event runs may point to a delivery; schedule/manual runs need not.';

CREATE INDEX IF NOT EXISTS trigger_sources_ws_kind_status_idx
  ON harness_shared.trigger_sources (workspace_id, kind, status);
CREATE INDEX IF NOT EXISTS trigger_bindings_ws_source_armed_idx
  ON harness_shared.trigger_bindings (workspace_id, source_id, armed);
CREATE INDEX IF NOT EXISTS trigger_bindings_ws_plan_idx
  ON harness_shared.trigger_bindings (workspace_id, plan_harness_slug, plan_slug);
CREATE INDEX IF NOT EXISTS trigger_deliveries_ws_source_received_idx
  ON harness_shared.trigger_deliveries (workspace_id, source_id, received_at DESC);
CREATE INDEX IF NOT EXISTS trigger_deliveries_ws_outcome_received_idx
  ON harness_shared.trigger_deliveries (workspace_id, outcome, received_at DESC);
CREATE INDEX IF NOT EXISTS trigger_deliveries_ws_event_key_idx
  ON harness_shared.trigger_deliveries (workspace_id, event_key, received_at DESC);
CREATE INDEX IF NOT EXISTS trigger_runs_ws_binding_triggered_idx
  ON harness_shared.trigger_runs (workspace_id, binding_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS trigger_runs_ws_status_triggered_idx
  ON harness_shared.trigger_runs (workspace_id, status, triggered_at DESC);

DO $$
DECLARE
  table_name text;
  policy_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'trigger_sources', 'trigger_bindings', 'trigger_deliveries', 'trigger_runs'
  ] LOOP
    policy_name := table_name || '_workspace_isolation';

    IF NOT (SELECT relrowsecurity
              FROM pg_class
             WHERE oid = format('harness_shared.%I', table_name)::regclass) THEN
      EXECUTE format('ALTER TABLE harness_shared.%I ENABLE ROW LEVEL SECURITY', table_name);
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'harness_shared'
         AND tablename = table_name
         AND policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON harness_shared.%I ' ||
        'USING (workspace_id = current_setting(''app.workspace_id''::text, true)) ' ||
        'WITH CHECK (workspace_id = current_setting(''app.workspace_id''::text, true))',
        policy_name,
        table_name
      );
    END IF;

    IF NOT has_table_privilege(
      'harness_app', format('harness_shared.%I', table_name), 'INSERT'
    ) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.%I TO harness_app',
        table_name
      );
    END IF;
    IF NOT has_table_privilege(
      'harness_zero', format('harness_shared.%I', table_name), 'SELECT'
    ) THEN
      EXECUTE format(
        'GRANT SELECT ON harness_shared.%I TO harness_zero',
        table_name
      );
    END IF;
  END LOOP;
END $$;
