-- 564-memory-federation-columns.sql — mem0 federation Phase 2, Part 1.
-- Add federation columns to memory_canonical for receive-side projection.
-- Mirrors agent_facts federation columns (mig 461, D-005 H6, D-006 privacy).
--
-- H6 (peer-review D-005): memories are observations, not consensus — the apply side
-- partitions by source so peers can never clobber each other's memories. Local rows
-- keep source_hive NULL; foreign rows carry the RECEIVER-STAMPED source (from the
-- admitted log identity, never sender-claimed). The identity index is extended
-- with the source dimension.
--
-- Idempotent; apply via runner or psql + schema_migrations row in one txn.

\set ON_ERROR_STOP on

ALTER TABLE harness_shared.memory_canonical
  ADD COLUMN IF NOT EXISTS harness_slug  text,          -- the Hive home slug (federation identity carrier; NULL = un-hived local memory)
  ADD COLUMN IF NOT EXISTS author_pubkey text,
  ADD COLUMN IF NOT EXISTS origin        text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS fed_ts        bigint,
  ADD COLUMN IF NOT EXISTS source_hive   text;          -- receiver-stamped foreign source (NULL = locally authored)

-- Rebuild the identity to include the source dimension (H6: per-source partitioning).
-- Note: memory_canonical's PRIMARY KEY is (id), so we add a UNIQUE index for the federated identity.
DROP INDEX IF EXISTS harness_shared.memory_canonical_fed_identity;
CREATE UNIQUE INDEX IF NOT EXISTS memory_canonical_fed_identity
  ON harness_shared.memory_canonical (workspace_id, id, coalesce(source_hive, ''));
