-- 886-backfill-consult-conversation-lifecycle.sql
--
-- The consult close path originally wrote consult_state and its typed close
-- post, but did not update the coarse coord_conversations projection.  The
-- live close path now settles both rows; this migration repairs rows written
-- by the older path so conversations:get/list do not continue to report a
-- terminal close as an open conversation.
--
-- Only the three typed close terminal states are repaired here.  `expired`,
-- `declined`, and `no_qualified_responder` retain their existing semantics:
-- an expired consult may receive a requester's late typed disposition, while
-- the other routing terminals are not consult:close outcomes.

WITH stale_terminal_closes AS (
  SELECT cs.workspace_id,
         cs.conversation_id,
         cs.state AS consult_state,
         NULLIF(cs.outcome ->> 'answer', '') AS answer,
         COALESCE(cs.closed_at, c.updated_at) AS terminal_at,
         close_post.post_id
    FROM harness_shared.consult_state cs
    JOIN harness_shared.coord_conversations c
      ON c.workspace_id = cs.workspace_id
     AND c.id = cs.conversation_id
    LEFT JOIN LATERAL (
      SELECT pm.post_id
        FROM harness_shared.consult_post_meta pm
       WHERE pm.workspace_id = cs.workspace_id
         AND pm.conversation_id = cs.conversation_id
         AND pm.kind = 'close'
       ORDER BY pm.post_id DESC
       LIMIT 1
    ) close_post ON TRUE
   WHERE c.kind = 'consult'
     AND c.state = 'open'
     AND cs.state IN ('closed_answered', 'closed_cant_help', 'graduated')
)
UPDATE harness_shared.coord_conversations c
   SET state = CASE
                 WHEN stale.consult_state = 'closed_answered' THEN 'resolved'
                 ELSE 'closed'
               END,
       accepted_answer = CASE
                           WHEN stale.consult_state = 'closed_answered'
                             THEN COALESCE(c.accepted_answer, stale.answer)
                           ELSE c.accepted_answer
                         END,
       accepted_post_id = CASE
                           WHEN stale.consult_state = 'closed_answered'
                             THEN COALESCE(c.accepted_post_id, stale.post_id)
                           ELSE c.accepted_post_id
                         END,
       updated_at = GREATEST(c.updated_at, stale.terminal_at),
       resolved_at = CASE
                       WHEN stale.consult_state = 'closed_answered'
                         THEN stale.terminal_at
                       ELSE c.resolved_at
                     END
  FROM stale_terminal_closes stale
 WHERE c.workspace_id = stale.workspace_id
   AND c.id = stale.conversation_id;
