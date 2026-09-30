-- 1159 — restore and project expired consult conversation lifecycle.
--
-- Migration 796 replaced coord_conversations_state_check for supersession but
-- accidentally omitted the already-supported `expired` state. The expiry
-- sweep writes the fine-grained consult_state row first; this successor makes
-- the coarse projection legal again and repairs rows left open by older
-- runners. Keep the repair narrow to consult parents that are still open so a
-- later terminal lifecycle can never be overwritten.
--
-- FORWARD-COMPAT: this DROP+ADD only widens the existing state constraint with
-- `expired`; every state accepted by the currently deployed release remains
-- valid, and that release's consult reader and expiry writer already handle
-- `expired` explicitly.

ALTER TABLE harness_shared.coord_conversations
  DROP CONSTRAINT IF EXISTS coord_conversations_state_check;

ALTER TABLE harness_shared.coord_conversations
  ADD CONSTRAINT coord_conversations_state_check
  CHECK (state = ANY (ARRAY[
    'open'::text,
    'resolved'::text,
    'closed'::text,
    'superseded'::text,
    'expired'::text
  ]));

WITH stale_expired_consults AS (
  SELECT cs.workspace_id,
         cs.conversation_id,
         COALESCE(cs.closed_at, cs.updated_at, c.updated_at) AS terminal_at
    FROM harness_shared.consult_state cs
    JOIN harness_shared.coord_conversations c
      ON c.workspace_id = cs.workspace_id
     AND c.id = cs.conversation_id
   WHERE c.kind = 'consult'
     AND c.state = 'open'
     AND cs.state = 'expired'
)
UPDATE harness_shared.coord_conversations c
   SET state = 'expired',
       updated_at = GREATEST(c.updated_at, stale.terminal_at)
  FROM stale_expired_consults stale
 WHERE c.workspace_id = stale.workspace_id
   AND c.id = stale.conversation_id
   AND c.kind = 'consult'
   AND c.state = 'open';
