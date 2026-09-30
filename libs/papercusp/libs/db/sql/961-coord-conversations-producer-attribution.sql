-- 961-coord-conversations-producer-attribution.sql — EI-21462599108204160
--
-- Record WHICH tool opened each conversation.
--
-- Until now the only record of that was the Decision-tier escalation twin
-- (`coord_open_escalations.body->>'conversationId'`), which `coord:ask-owner`
-- writes alongside the Alert-tier conversation row. `resolveConversation`
-- correctly CLOSES that twin when the question is answered — that is the
-- EI-19399318647145782 zombie fix, and it works (measured: 0 of 26 resolved
-- questions leave an open twin, against 9 of 11 before it landed).
--
-- The side effect is that attribution is destroyed by the act of answering.
-- An OPEN ask-owner question is identifiable; an ANSWERED one is not. So the
-- answer RATE per tool — the one number you actually want from this table —
-- is precisely the number that cannot be computed from it.
--
-- NULL is meaningful and is NOT backfilled to a fabricated 'unknown': the
-- column is written from a REQUIRED field on the open path, so a writer
-- cannot omit it. Any NULL is therefore definitionally a row opened before
-- this migration, or one federated from a peer still running older code —
-- never a live producer that forgot to declare itself. Backfilling a literal
-- would erase exactly that distinction.

ALTER TABLE harness_shared.coord_conversations
  ADD COLUMN IF NOT EXISTS producer text;

COMMENT ON COLUMN harness_shared.coord_conversations.producer IS
  'The tool that opened this conversation (e.g. coord:ask-owner, coord:ask, consult:get_feedback). NULL = opened before attribution existed, or federated from an older peer. Never inferred — written from a required field at open time. EI-21462599108204160.';

-- Answer-rate-per-producer is the query this column exists to serve, and it
-- filters on producer + state together.
CREATE INDEX IF NOT EXISTS coord_conversations_producer_state_idx
  ON harness_shared.coord_conversations (workspace_id, producer, state);
