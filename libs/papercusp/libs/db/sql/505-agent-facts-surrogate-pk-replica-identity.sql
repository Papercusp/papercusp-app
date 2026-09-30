-- 505-agent-facts-surrogate-pk-replica-identity.sql — fix the agent_facts GC-sweep
-- DELETE failure on federated/embedded operators, version-agnostically (WI-2914).
--
-- ROOT CAUSE (the full chain):
--   • 444: harness_shared.agent_facts has NO primary key — only a UNIQUE INDEX
--     (agent_facts_identity, which uses a coalesce() expression → a FUNCTIONAL
--     index, ineligible to be a REPLICA IDENTITY USING INDEX).
--   • 462: adds a STORED generated column `fed_key` (the federation wire key).
--   • 498: to make DELETEs loggable for a no-PK table, set REPLICA IDENTITY FULL.
--   • embedded-postgres-server bootstrap: creates publication `zero_harness FOR
--     TABLES IN SCHEMA harness_shared, ...` (publishes DELETEs) — so agent_facts
--     is a delete-publishing table.
--   On PG18, a delete-publishing table whose FULL replica identity contains an
--   *unpublished* generated column cannot be DELETEd from:
--     ERROR: cannot delete from table "agent_facts"
--     DETAIL: Replica identity must not contain unpublished generated columns.
--   → the periodic (~30s) agent-facts sweep/GC can NEVER delete expired rows:
--   unbounded growth + a permanent "[agent-facts] sweep failed" error loop on
--   every embedded/federated operator. Found on the packaged Linux desktop's
--   embedded operator (WI-2902 clean-VM test, 2026-07-05). The dev box's native
--   PG never reproduced it because it has no `zero_harness` publication.
--
-- FIX (version-agnostic — works on the PG16 test container AND the PG18 ship
-- target, applied uniformly by the migration runner, so no per-version branch):
-- give agent_facts a SURROGATE primary key and switch it back to REPLICA IDENTITY
-- DEFAULT. DEFAULT uses only the PK column(s) — a plain, non-generated `id` — so
-- the generated `fed_key` is no longer part of the replica identity at all and the
-- "unpublished generated columns" restriction cannot apply on ANY PG version. This
-- supersedes 498's FULL (FULL was only ever a no-PK workaround; a PK-based DEFAULT
-- identity is both correct and cheaper — it logs one key, not the whole old row).
--
-- ZERO federation risk: agent_facts federation flows through the app-level capture
-- triggers → capture_substrate_outbox → hyperbee peer-log (461/462). Row-level
-- triggers always see the full OLD/NEW tuple regardless of REPLICA IDENTITY, so the
-- outbox capture is untouched. REPLICA IDENTITY only governs pgoutput logical
-- decoding, and `zero_harness` has NO live consumer (zero-cache retired; verified:
-- no replication slots / subscriptions). The surrogate `id` is internal-only: it is
-- NOT the upsert target (that stays the agent_facts_identity unique index).
--
-- Idempotent + guarded (mirrors 498's guarded-statement convention): safe to
-- re-run and safe on a plain non-federated operator (REPLICA IDENTITY is a no-op
-- where nothing publishes the table).
\set ON_ERROR_STOP on
-- No explicit BEGIN/COMMIT: the migration runner (db:migrate) wraps each file
-- in a single transaction, so raw transaction control here is redundant and
-- unsafe (nested-txn / premature COMMIT). Enforced by lint:migrations (505 was
-- flagged by the enforced-era gate; WI-2914).

DO $do$
BEGIN
  -- Only touch the table if it exists (mirror 498's guard).
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'harness_shared' AND c.relname = 'agent_facts' AND c.relkind = 'r'
  ) THEN
    -- (1) Surrogate identity column. Appended (ADD COLUMN) so existing column
    --     order / positional access is undisturbed; backfilled monotonically for
    --     existing rows by the IDENTITY sequence.
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'harness_shared.agent_facts'::regclass
        AND attname = 'id' AND NOT attisdropped
    ) THEN
      ALTER TABLE harness_shared.agent_facts
        ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;
    END IF;

    -- (2) Primary key on the surrogate (needed for REPLICA IDENTITY DEFAULT to
    --     have key columns to log). Guard: add only if the table has no PK yet.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'harness_shared.agent_facts'::regclass AND contype = 'p'
    ) THEN
      ALTER TABLE harness_shared.agent_facts
        ADD CONSTRAINT agent_facts_pkey PRIMARY KEY (id);
    END IF;

    -- (3) Use the PK as the replica identity (supersedes 498's FULL). Idempotent.
    ALTER TABLE harness_shared.agent_facts REPLICA IDENTITY DEFAULT;
  END IF;
END $do$;
