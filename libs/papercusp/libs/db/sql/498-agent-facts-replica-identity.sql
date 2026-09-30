-- 498-agent-facts-replica-identity.sql — fix agent_facts DELETE failure on
-- federated/embedded operators (WI-2718).
--
-- ROOT CAUSE: harness_shared.agent_facts (444-agent-facts.sql) has NO primary
-- key — only a UNIQUE INDEX (agent_facts_identity) — and no explicit replica
-- identity, so Postgres defaults it to REPLICA IDENTITY DEFAULT, which
-- requires a PRIMARY KEY to log DELETEs for logical replication. On a
-- federated/embedded operator, agent_facts is included in a publication that
-- replicates deletes (the hyperbee/federation sync path) — so any DELETE
-- against it fails with:
--   "cannot delete from table \"agent_facts\" because it does not have a
--    replica identity and publishes deletes"
-- which breaks the periodic agent-facts sweep/GC (expired rows can never be
-- deleted -> unbounded growth + a recurring "[agent-facts] sweep failed" log
-- error, a release-bar item).
--
-- FIX: set REPLICA IDENTITY FULL. This uses the full row (not a key column)
-- to identify a row being deleted/updated for replication purposes — no PK
-- is required, and no publication/subscription wiring is touched. A plain,
-- additive, idempotent DB change (safe to run on a plain, non-federated
-- operator too — REPLICA IDENTITY is a no-op there since nothing publishes
-- the table).
--
-- Idempotent: ALTER TABLE ... REPLICA IDENTITY is itself idempotent (setting
-- the same mode twice is a no-op), but guard with a state check anyway so a
-- re-run of this file never errors on a table that's somehow been dropped or
-- renamed between deploys (mirrors the baseline's own guarded-statement
-- convention).
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'harness_shared' AND c.relname = 'agent_facts' AND c.relkind = 'r'
  ) THEN
    ALTER TABLE harness_shared.agent_facts REPLICA IDENTITY FULL;
  END IF;
END $do$;
