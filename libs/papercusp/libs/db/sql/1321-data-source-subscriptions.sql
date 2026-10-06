-- 1321 — Per-pot and per-plan data-source subscriptions for the granted-sources injection leg.
--
-- Plan enterprise-data-sources-2026-10-01 P-017 (WI-10005054), acceptance BAR R-11.
-- Company sources (a whole Slack workspace, an Asana org) are too large and noisy for
-- global recall, so turn-start injection of organization documents is OPT-IN: a pot or
-- a plan subscribes to a source, and only subscribed sources are injected for agents
-- working in that pot or on that plan. A subscription decides RELEVANCE only; it never
-- widens access. Every injected document still passes the vault grant, the source ACL
-- (document_permission_lists + provider_identity_mappings) and the disclosure ledger.
--
-- `source` is the documents corpus `source` column (personal_documents.source, the
-- normalized connector key such as 'slack'), not a trigger_sources id: an organization
-- document carries its source as that string, and a live search adapter (P-018) is
-- addressed by the same key.
--
-- Revocation is historical (revoked_at), like provider_identity_mappings.
--
-- FORWARD-COMPAT: this migration only CREATEs a new table, its indexes and its policy; the currently-deployed release never reads or writes harness_shared.data_source_subscriptions, so the partial unique index on live rows cannot change any statement it runs.

CREATE TABLE IF NOT EXISTS harness_shared.data_source_subscriptions (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id  text        NOT NULL,
  subject_kind  text        NOT NULL CHECK (subject_kind IN ('pot', 'plan')),
  subject_ref   text        NOT NULL CHECK (length(btrim(subject_ref)) > 0),
  source        text        NOT NULL CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  created_by    text        NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    text,
  CONSTRAINT data_source_subscriptions_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT data_source_subscriptions_revocation_chk
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- One live subscription per (subject, source); re-subscribing after a revoke inserts a
-- new row and keeps the old one as history.
CREATE UNIQUE INDEX IF NOT EXISTS data_source_subscriptions_live_key
  ON harness_shared.data_source_subscriptions (workspace_id, subject_kind, subject_ref, source)
  WHERE revoked_at IS NULL;

ALTER TABLE harness_shared.data_source_subscriptions ENABLE ROW LEVEL SECURITY;

DO $data_source_subscriptions_policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'harness_shared'
       AND tablename = 'data_source_subscriptions'
       AND policyname = 'data_source_subscriptions_workspace_isolation'
  ) THEN
    CREATE POLICY data_source_subscriptions_workspace_isolation
      ON harness_shared.data_source_subscriptions FOR ALL TO public
      USING (workspace_id = current_setting('app.workspace_id', true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;
END
$data_source_subscriptions_policy$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.data_source_subscriptions TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.data_source_subscriptions IS
  'enterprise-data-sources P-017 / R-11: which document sources (personal_documents.source) a pot or plan injects at turn start. Relevance only, never access: injected documents still pass the vault grant, the source ACL and the disclosure ledger.';
