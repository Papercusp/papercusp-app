-- Migration 526 — operator_integration_credentials.
--
-- Generic PG-backed secret store for THIRD-PARTY INTEGRATION API keys that
-- don't fit the closed 4-key platform allowlist in operator_credentials
-- (openai/anthropic/zeroentropy/github_pat) or the OMP-search-specific
-- operator_search_provider_credentials. Example: a user-supplied WeatherAPI
-- key for a future weather widget (owner-ask-batch-2026-07-06 P-002) — per
-- storage policy, a secret NEVER goes into a tree file; it goes here.
--
-- Shape mirrors operator_search_provider_credentials: single-row-per-
-- workspace, JSONB payload of `{ key_name: value }`, encrypted at rest via
-- pgcrypto (see db-encryption.ts ENCRYPTED_TABLES). Read/written by
-- integration-credentials.ts; NOT in zero_harness publication — values never
-- broadcast over WS.
--
-- Idempotent + non-destructive — adds a table only.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS harness_shared.operator_integration_credentials (
  workspace_id  TEXT PRIMARY KEY,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_ct    BYTEA,                     -- pgcrypto-encrypted JSONB; preferred over `payload`.
  updated_at    BIGINT NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint
);

COMMENT ON TABLE harness_shared.operator_integration_credentials IS
  'Generic third-party integration API keys (e.g. a weather-widget key) that are not one of the 4 platform provider keys. Single-row-per-workspace; encrypted at rest via pgcrypto.';

ALTER TABLE harness_shared.operator_integration_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oic_workspace_isolation ON harness_shared.operator_integration_credentials;
CREATE POLICY oic_workspace_isolation
  ON harness_shared.operator_integration_credentials
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE
  ON harness_shared.operator_integration_credentials TO harness_app;
GRANT ALL
  ON harness_shared.operator_integration_credentials TO harness_admin;
-- Intentionally NOT granted to harness_zero — credentials must not be
-- replicated over WS.
