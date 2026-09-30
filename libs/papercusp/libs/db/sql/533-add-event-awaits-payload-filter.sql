-- 533-add-event-awaits-payload-filter.sql
-- Predicate/payload watches (EI-8998): watch:create / events:await gain an optional
-- payload_filter — a mingo query object evaluated against the emitted event's
-- PAYLOAD (not just its key), reusing the same @papercusp/rules matcher that
-- pattern awaits (migration 480) already use for KEY globs. Kills the
-- polling-vigil pattern: "wake me when queue_depth < 5" without a bespoke exact
-- key per threshold.
--
-- NULL (the default/common case) preserves today's behavior exactly — the
-- once-typed atomic exactly-once claim in store.fireAwaitsForKey stays a single
-- UPDATE for filter-less rows; only rows WITH a filter fall back to the
-- select-then-conditionally-claim path already used for pattern rows.

ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS payload_filter jsonb;

COMMENT ON COLUMN harness_shared.event_awaits.payload_filter IS
  'EI-8998: optional mingo query object tested against the emitted payload at fire time (in addition to the event_key/pattern match). NULL = no payload predicate (today''s behavior).';
