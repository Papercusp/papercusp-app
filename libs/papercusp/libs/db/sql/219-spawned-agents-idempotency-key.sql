-- 219: spawned_agents idempotency key (audit P-017, EI-73).
--
-- A fleet spawn that times out at the route layer gets retried by the
-- caller; without a dedupe key each retry launched ANOTHER agent. The
-- caller now supplies an idempotency key; the partial unique index makes
-- the (workspace, key) pair single-spawn even if two requests race past
-- the application-level check.
--
-- Idempotent: safe to re-run.

ALTER TABLE harness_shared.spawned_agents
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS spawned_agents_idempotency_key_uq
  ON harness_shared.spawned_agents (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
