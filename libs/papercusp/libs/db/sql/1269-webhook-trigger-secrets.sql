-- Migration 1269 — signed webhook ingress for external-event triggers.
--
-- Plan external-app-access-to-workspaces-2026-09-29, P-017 (WI-10004021), decision D-032.
--
-- A webhook is an external-trigger source of kind 'webhook' (harness_shared.trigger_sources,
-- migration 876). An outside system POSTs to /api/hooks/<source id>, signed with an HMAC-SHA256
-- secret. The machine checks the signature and hands the event to the existing ingestion seam,
-- which fires the bound blueprint operation (triggers:bind / triggers:arm, storm caps).
--
--   1. harness_shared.trigger_webhook_secrets: one row per webhook source. The signing secret is
--      stored encrypted with pgcrypto under the operator database key (the P-008 relay store and
--      the P-015 key store do the same), and decrypted only server-side. A rotation keeps the
--      previous secret valid until `previous_valid_until` so senders can switch over (the P-015
--      shape). Row-level security bounds it to the caller's workspace like every trigger table.
--   2. The `webhook-payload` datatype: the canonical payload a webhook event is validated against,
--      seeded into the platform catalog like 877 did. A workspace installs it through
--      installPublishedDatatype when its first webhook is created.
--
-- Additive only: a new table, a new policy, one upserted catalog row.

CREATE TABLE IF NOT EXISTS harness_shared.trigger_webhook_secrets (
  workspace_id          text NOT NULL,
  source_id             uuid NOT NULL,
  secret_ct             bytea NOT NULL,
  previous_secret_ct    bytea NULL,
  previous_valid_until  timestamptz NULL,
  rotated_at            timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source_id),
  CONSTRAINT trigger_webhook_secrets_source_fk
    FOREIGN KEY (workspace_id, source_id)
    REFERENCES harness_shared.trigger_sources (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT trigger_webhook_secrets_previous_complete
    CHECK ((previous_secret_ct IS NULL) = (previous_valid_until IS NULL))
);

COMMENT ON TABLE harness_shared.trigger_webhook_secrets IS
  'EAA P-017 (D-032): the HMAC-SHA256 signing secret of one webhook trigger source, pgcrypto-encrypted under the operator database key. The previous secret stays valid until previous_valid_until after a rotation.';

ALTER TABLE harness_shared.trigger_webhook_secrets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'harness_shared'
       AND tablename = 'trigger_webhook_secrets'
       AND policyname = 'trigger_webhook_secrets_workspace_isolation'
  ) THEN
    CREATE POLICY trigger_webhook_secrets_workspace_isolation
      ON harness_shared.trigger_webhook_secrets
      USING (workspace_id = current_setting('app.workspace_id'::text, true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id'::text, true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.trigger_webhook_secrets TO harness_app;

INSERT INTO harness_shared.datatype_registry
  (id, workspace_id, pot_slug, title, description, tier, work_item_kind,
   payload_schema, authoritative_writer, self_improvement, status, published,
   review_status, tags, created_by, updated_at)
VALUES (
  'webhook-payload', 'papercusp-workspace', 'papercusp', 'Webhook payload',
  'Canonical payload of one signed webhook delivery: the sender''s JSON object body, the event name and the delivery id.',
  'first-class', NULL,
  '{"type":"object","properties":{"id":{"type":"string","minLength":1},"event":{"type":"string","minLength":1},"receivedAt":{"type":"string"},"body":{"type":"object"}},"required":["id","event","body"],"additionalProperties":false}'::jsonb,
  'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
  'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','webhook'],
  'external-app-access-to-workspaces-2026-09-29', now()
)
ON CONFLICT (workspace_id, id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  payload_schema = EXCLUDED.payload_schema,
  tags = EXCLUDED.tags,
  updated_at = now();
