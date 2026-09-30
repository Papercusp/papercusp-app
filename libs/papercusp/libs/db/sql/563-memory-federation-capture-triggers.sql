-- 563-memory-federation-capture-triggers.sql — mem0 federation Phase 1, Part 2.
-- Capture triggers that enqueue ONLY shareable=true memories into the peer-log outbox.
-- Mirrors agent_facts capture triggers (mig 461, D-006 privacy).
--
-- H6 (peer-review D-005): memories are observations, not consensus — the apply side
-- partitions by source so peers can never clobber each other's memories. Local rows
-- keep source_hive NULL; foreign rows carry the receiver-stamped source (from the
-- admitted log identity, never sender-claimed).
--
-- Privacy (D-006, owner-ratified): only shareable=true rows capture (trigger WHEN
-- clause) — hive-private memories never reach the outbox at all. Capture uses the
-- `id` column as the op key (TG_ARGV[0]).
--
-- Idempotent; apply via runner or psql + schema_migrations row in one txn.

\set ON_ERROR_STOP on

-- ALTER TABLE harness_shared.memory_canonical
--   ADD COLUMN IF NOT EXISTS harness_slug  text,          -- federation identity (NULL = un-hived local memory)
--   ADD COLUMN IF NOT EXISTS author_pubkey text,
--   ADD COLUMN IF NOT EXISTS origin        text NOT NULL DEFAULT 'local',
--   ADD COLUMN IF NOT EXISTS fed_ts        bigint,
--   ADD COLUMN IF NOT EXISTS source_hive   text;          -- receiver-stamped foreign source (NULL = locally authored)
-- NOTE: These columns (harness_slug, origin, source_hive, etc.) will be added in Phase 2
-- when we wire the receive-side. For Phase 1, we only need the capture triggers.

-- Federation capture: SHAREABLE memories only (privacy default D-006). The echo-guard
-- in capture_substrate_outbox already skips origin<>'local' (inbound applies never
-- re-capture). key column for the op = `id` (TG_ARGV[0]).
CREATE OR REPLACE TRIGGER capture_memory_canonical_outbox_ins_trg
  AFTER INSERT ON harness_shared.memory_canonical
  FOR EACH ROW
  WHEN (NEW.shareable = true)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('id');

CREATE OR REPLACE TRIGGER capture_memory_canonical_outbox_del_trg
  AFTER DELETE ON harness_shared.memory_canonical
  FOR EACH ROW
  WHEN (OLD.shareable = true)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('id');

-- UPDATE captures only when a FEDERATED field changes AND the row is (or was)
-- shareable — a private memory's edits never reach the outbox; flipping shareable
-- off captures once (peers apply the retraction of sharing).
CREATE OR REPLACE TRIGGER capture_memory_canonical_outbox_upd_trg
  AFTER UPDATE ON harness_shared.memory_canonical
  FOR EACH ROW
  WHEN ((NEW.shareable = true OR OLD.shareable = true)
    AND (OLD.payload IS DISTINCT FROM NEW.payload
      OR OLD.shareable IS DISTINCT FROM NEW.shareable))
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('id');
