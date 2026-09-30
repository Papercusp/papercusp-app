-- 031-mem-state-to-pg.sql
--
-- Round-7 mem→PG migration: two more process-local Map<>s following the
-- same playbook as 030-oauth-nonces.
--
--   (a) mobile_pair_tokens — 5-min single-use mobile-pair handshake tokens
--       Was: const pending = new Map<string, PendingPair>() in
--       apps/operator/lib/mobile-pair-store.ts.
--
--   (b) operator_rate_limit — per-workspace background-scan rate limit +
--       PG-503 circuit breaker (Phase 3e/3f of the v5 operator plan).
--       Was: const state = new Map<string, WorkspaceRate>() in
--       apps/operator/lib/operator-rate-limit.ts.
--
-- Both are server-internal — NOT in zero_harness publication.

CREATE TABLE IF NOT EXISTS harness_shared.mobile_pair_tokens (
  pair_token    TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  user_email    TEXT,
  desktop_host  TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  consumed      BOOLEAN NOT NULL DEFAULT false,
  created_at_ms BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS mobile_pair_tokens_exp_idx
  ON harness_shared.mobile_pair_tokens (expires_at_ms);

-- Single row per workspace; payload is the WorkspaceRate shape:
--   { recent: number[], consecutive503: number, breakerUntilMs: number }
CREATE TABLE IF NOT EXISTS harness_shared.operator_rate_limit (
  workspace_id  TEXT PRIMARY KEY,
  payload       JSONB NOT NULL,
  updated_at    BIGINT NOT NULL DEFAULT 0
);
