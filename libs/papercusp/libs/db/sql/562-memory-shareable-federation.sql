-- 562-memory-shareable-federation.sql — mem0 federation Phase 1, Part 1.
-- Add a `shareable` boolean column to memory_canonical for cross-machine memory federation.
-- Mirrors agent_facts F1-1 federation pattern (mig 461).
--
-- Privacy (D-006): shareable defaults to false — hive-private memories never federate.
-- The capture trigger (mig 563) will enqueue only shareable=true rows.
-- GENERATED ALWAYS AS column extracts from payload (like user_id, workspace_id) so
-- the backend's metadata.shareable write automatically populates it.
-- Idempotent; apply via runner or psql + schema_migrations row in one txn.

ALTER TABLE harness_shared.memory_canonical
  ADD COLUMN IF NOT EXISTS shareable boolean
    GENERATED ALWAYS AS (COALESCE((payload->>'shareable')::boolean, false)) STORED;

CREATE INDEX IF NOT EXISTS memory_canonical_shareable_idx
  ON harness_shared.memory_canonical (shareable)
  WHERE shareable = true;

COMMENT ON COLUMN harness_shared.memory_canonical.shareable IS
  'GENERATED from payload->>''shareable'' (F0-2 federation). OPT-IN federation egress: true = this memory may federate to other hives. Default false — memories are hive-private. Capture triggers enqueue only shareable=true rows.';
