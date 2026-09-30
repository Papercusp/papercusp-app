-- 455-agent-facts-shareable.sql — F0-2 of federated-scout-gym-learning-2026-07-02.
-- Facts federate HIVE-SCOPED, OPT-IN ONLY (owner privacy default, D-001/D-005):
-- a fact leaves the hive only when its author explicitly marked it shareable.
-- Idempotent; apply via the runner (or psql + schema_migrations row in one txn).

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS shareable boolean NOT NULL DEFAULT false;

-- The federation egress read: live shareable facts only.
CREATE INDEX IF NOT EXISTS agent_facts_shareable
  ON harness_shared.agent_facts (workspace_id, scope, expires_at)
  WHERE shareable = true AND retracted_at IS NULL;
