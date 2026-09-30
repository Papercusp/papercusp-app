-- Migration 536 — partial index for the EI-8986 reply-deadline sweep.
--
-- reply-deadline-sweep.ts (dbos/periodic-workflows.ts, every 5 min) selects
-- due deadlines with:
--   WHERE surface = 'messages'
--     AND body ? 'replyDeadlineAt'
--     AND (body->>'replyDeadlineAt')::bigint <= <now>
--   ORDER BY (body->>'replyDeadlineAt')::bigint ASC
--
-- Without an index that is a full JSONB-predicate scan of the messages
-- surface of harness_shared.coord_event_log (millions of rows) every tick.
-- `replyDeadlineAt` is a rare, explicit opt-in stamp (coord:send
-- { replyDeadlineSec }), so a PARTIAL expression index costs almost nothing
-- to maintain and turns the sweep into an index range scan. The index
-- predicate matches the query predicate exactly; the indexed expression
-- matches the compare + ORDER BY expression exactly.
--
-- The `::bigint` cast is safe by construction: the only writer
-- (tools/send.ts) stamps Math.round(Date.now() + sec*1000) — integer ms
-- (the Math.round landed with this migration; the field is hours old and
-- the arg was previously stamped un-rounded but only ever from integer-second
-- callers, so no fractional rows exist to poison the build).

CREATE INDEX IF NOT EXISTS coord_event_log_reply_deadline
  ON harness_shared.coord_event_log (((body->>'replyDeadlineAt')::bigint))
  WHERE surface = 'messages' AND body ? 'replyDeadlineAt';

COMMENT ON INDEX harness_shared.coord_event_log_reply_deadline IS
  'EI-8986 reply-deadline sweep: partial index over the rare replyDeadlineAt opt-in stamp so the 5-min backstop sweep is an index scan, not a JSONB seq scan (mig 536).';
