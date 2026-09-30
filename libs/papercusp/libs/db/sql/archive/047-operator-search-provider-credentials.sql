-- Migration 047 — operator_search_provider_credentials.
--
-- Storage for the 14 web-search provider API keys that OMP's web_search
-- tool consumes via env vars (TAVILY_API_KEY, BRAVE_API_KEY, JINA_API_KEY,
-- PERPLEXITY_API_KEY, EXA_API_KEY, KIMI_*, KAGI_API_KEY, ZAI_API_KEY,
-- PARALLEL_API_KEY, SYNTHETIC_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY
-- (search-specific override), Codex OAuth, SearXNG endpoint+auth).
--
-- Single-row-per-workspace with a JSONB payload of `{ env_var_name: value }`.
-- Encrypted at rest via pgcrypto (per Migration 027's pattern); reads/writes
-- go through apps/operator/lib/operator-state-pg.ts which knows to decrypt.
--
-- Mirrors operator_voice_credentials in shape — single-table, single-row,
-- encrypted payload, NOT in zero_harness publication so values never
-- broadcast over WS.
--
-- Used by:
--   - GET/POST /api/credentials/search-providers (operator UI)
--   - /settings/api-keys "Search providers" section
--   - Orchestrator spawn-env injection at OMP launch (decrypts + sets env)
--
-- Idempotent + non-destructive — adds a table only.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.operator_search_provider_credentials (
  workspace_id  TEXT PRIMARY KEY,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_ct    BYTEA,                     -- pgcrypto-encrypted JSONB; preferred over `payload`.
  updated_at    BIGINT NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint
);

COMMENT ON TABLE harness_shared.operator_search_provider_credentials IS
  'API keys for the 14 OMP web_search providers. Single-row-per-workspace; encrypted at rest via pgcrypto. Read/written by /api/credentials/search-providers; injected as env vars at OMP spawn time.';

ALTER TABLE harness_shared.operator_search_provider_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osc_workspace_isolation ON harness_shared.operator_search_provider_credentials;
CREATE POLICY osc_workspace_isolation
  ON harness_shared.operator_search_provider_credentials
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE
  ON harness_shared.operator_search_provider_credentials TO harness_app;
GRANT ALL
  ON harness_shared.operator_search_provider_credentials TO harness_admin;
-- Intentionally NOT granted to harness_zero — credentials must not be
-- replicated over WS.

COMMIT;
