-- 168-operator-conversation-summary.sql
--
-- Operator context compaction (operator-context-compaction-2026-06-05 P-001 / D-002):
-- the operator brain's rolling conversation summary is stored WITH the conversation.
-- `summary_text` is the compacted gist of every turn with seq <= summary_through_seq;
-- turns after that watermark are still inside the verbatim recent window the brain
-- sees each turn. Regenerated incrementally (D-003) by
-- packages/operator-core/lib/operator-conversation-compaction.ts; writes are CAS'd
-- on summary_through_seq so concurrent compactors can't interleave.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS only.

ALTER TABLE harness_shared.operator_conversations
  ADD COLUMN IF NOT EXISTS summary_text TEXT,
  ADD COLUMN IF NOT EXISTS summary_through_seq BIGINT,
  ADD COLUMN IF NOT EXISTS summary_updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS summary_model TEXT,
  ADD COLUMN IF NOT EXISTS summary_turns_covered INTEGER;

COMMENT ON COLUMN harness_shared.operator_conversations.summary_text IS
  'Rolling compacted summary of turns with seq <= summary_through_seq (operator context compaction, operator-context-compaction-2026-06-05). NULL until the first compaction.';
COMMENT ON COLUMN harness_shared.operator_conversations.summary_through_seq IS
  'Highest operator_turns.seq covered by summary_text. CAS baseline for incremental regeneration.';
COMMENT ON COLUMN harness_shared.operator_conversations.summary_updated_at IS
  'Epoch ms of the last successful compaction write.';
COMMENT ON COLUMN harness_shared.operator_conversations.summary_model IS
  'Model id that produced summary_text (e.g. claude-haiku-4-5).';
COMMENT ON COLUMN harness_shared.operator_conversations.summary_turns_covered IS
  'Total turns folded into summary_text across all compactions (observability).';
