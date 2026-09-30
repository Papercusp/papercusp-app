-- 1156 — PUI legacy-history continuation lineage (public release P-008).
--
-- Continuing a read-only historical chat creates a NEW writable agent-chat
-- identity.  These two fields make the relationship durable without changing
-- the source row's runtime class or pretending copied turns were produced by
-- the successor runtime.

ALTER TABLE harness_shared.agent_chats_consolidated
  ADD COLUMN IF NOT EXISTS continued_from_chat_id TEXT,
  ADD COLUMN IF NOT EXISTS continued_from_turn_count INTEGER;

CREATE INDEX IF NOT EXISTS agent_chats_consolidated_continued_from_idx
  ON harness_shared.agent_chats_consolidated
    (workspace_id, harness_slug, continued_from_chat_id)
  WHERE continued_from_chat_id IS NOT NULL;

COMMENT ON COLUMN harness_shared.agent_chats_consolidated.continued_from_chat_id IS
  'Immutable source agent-chat id copied into a fresh writable continuation; the source row is never re-homed.';
COMMENT ON COLUMN harness_shared.agent_chats_consolidated.continued_from_turn_count IS
  'Number of source transcript turns snapshotted into the continuation when it was created.';
