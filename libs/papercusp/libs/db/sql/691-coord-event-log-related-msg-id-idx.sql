-- 691 — index the coord reply-chain edge.
--
-- conversations-agent-messages-2026-07-27 P-001: the new `conversations.
-- agentMessageList` sync query treats an agent↔agent coord envelope with no
-- `related_msg_id` as a conversation ROOT and reports how many replies hang off
-- it. Resolving that edge (`body->>'related_msg_id' = ANY(<roots>)`) had no
-- index and planned as a sequential scan of the whole event log — measured
-- 82ms against 105k rows on the dev box, paid on EVERY SSE invalidation of a
-- query that a always-open rail pane subscribes to.
--
-- Partial on `body ? 'related_msg_id'` because the edge is sparse: 8,120 of
-- 104,587 rows carry one (~8%), so the index stays small while covering every
-- row the lookup can possibly match. Expression index on the extracted text
-- (not the jsonb) so it matches the `->>` the resolver actually writes.
--
-- Idempotent; CREATE INDEX (not CONCURRENTLY) because the migration runner
-- wraps each file in a transaction and this table is small enough that the
-- brief lock is a non-event.

CREATE INDEX IF NOT EXISTS coord_event_log_related_msg_id_idx
  ON harness_shared.coord_event_log ((body ->> 'related_msg_id'))
  WHERE (body ? 'related_msg_id');
