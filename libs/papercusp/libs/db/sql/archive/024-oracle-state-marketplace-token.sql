-- 024-oracle-state-marketplace-token.sql
--
-- Round-5 file→PG migrations from the post-round-4 audit:
--
--   ~/.papercusp/oracle/prompt.md           → operator_oracle_prompt    (Zero)
--   ~/.papercusp/oracle/memory.md           → operator_oracle_memory    (Zero)
--   ~/.papercusp/marketplace-secrets.env    → operator_marketplace_token (NO Zero)
--
-- Oracle prompt + memory are per-workspace markdown blobs (same shape as
-- operator_preferences from migration 022). Marketplace token is a
-- service-credential that should not broadcast over WS.

CREATE TABLE IF NOT EXISTS harness_shared.operator_oracle_prompt (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_shared.operator_oracle_memory (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

-- Service token is sensitive — NOT in zero_harness publication.
CREATE TABLE IF NOT EXISTS harness_shared.operator_marketplace_token (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);
