-- 095-harness-app-workspace-table-grants.sql
-- P-062 / agent-tools-workspace-isolation Phase 1 (grants).
--
-- Grant the least-privilege runtime role `harness_app` DML on the
-- WORKSPACE-SCOPED operational `harness_shared` tables, so the agent-tools HTTP
-- path can later (Phase 4) run tools as harness_app under RLS — deny-by-default
-- workspace isolation. EXCLUDES the sensitive per-workspace tables
-- (credentials / secrets / tokens / principals) — those stay admin-only; a tool
-- that genuinely needs them uses the explicit cross-workspace/admin opt-out.
--
-- Safety: additive + behavior-neutral. harness_app is NOT used for HTTP tools
-- until the Phase-4 host flip, and harness_admin (rolbypassrls=t) is unaffected.
-- This does NOT enable RLS (Phase 2) — so it cannot break any existing read.
-- Idempotent (GRANT is). Native dev PG: applied by hand; embedded-pg auto-applies.
--
-- Deliberately NO `ALTER DEFAULT PRIVILEGES` here: auto-granting every FUTURE
-- harness_shared table to harness_app would silently expose a future
-- credentials/secrets table. New operational tables get an explicit grant in
-- their own migration (see this file as the template).
DO $$
DECLARE
  t text;
  -- Sensitive per-workspace / infra tables — never grant to the app role.
  sensitive text[] := ARRAY[
    'auth_audit_log','auth_rate_limit','mobile_pair_tokens','mobile_push_tokens',
    'oauth_nonces','operator_credentials','operator_marketplace_token',
    'operator_publish_credentials','operator_search_provider_credentials',
    'operator_secrets','operator_voice_credentials','system_principals',
    'token_index','trusted_authors'
  ];
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tt
      ON tt.table_schema = c.table_schema AND tt.table_name = c.table_name
    WHERE c.table_schema = 'harness_shared'
      AND c.column_name = 'workspace_id'
      AND tt.table_type = 'BASE TABLE'
      AND c.table_name <> ALL(sensitive)
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.%I TO harness_app', t);
  END LOOP;
END $$;

-- INSERTs into serial/bigserial PKs need sequence USAGE. Sequences are bare
-- counters (no sensitive payload), so a schema-wide grant is safe.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA harness_shared TO harness_app;
