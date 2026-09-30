-- 1131-substrate-outbox-enqueue-age.sql.DRAFT — EI-22439271926709536.
--
-- `substrate_outbox.ts` is the wire/LWW timestamp carried by the operation. It
-- can intentionally predate the local enqueue by days or weeks (for example
-- when a backfill replays a row with its source `fed_ts`). It must not also be
-- used as the drain-health capture clock.
--
-- Add a local enqueue clock with a database default so every capture path —
-- generic CDC triggers and explicit backfill inserts alike — gets the same
-- timestamp without requiring a synchronized application-code edit.
--
-- FORWARD-COMPAT: this is an additive column with a database default; the
-- currently deployed writers omit it safely, existing rows are backfilled
-- before NOT NULL, and the currently deployed readers continue using `ts`.

ALTER TABLE harness_shared.substrate_outbox
  ADD COLUMN IF NOT EXISTS enqueued_at_ms BIGINT;

-- Existing rows predate this clock. Their wire timestamp is the only durable
-- age signal available, so retain it conservatively rather than backfilling
-- old undrained work to "now" and hiding a real backlog. New rows use the
-- independent database default below.
UPDATE harness_shared.substrate_outbox
   SET enqueued_at_ms = COALESCE(
     enqueued_at_ms,
     ts,
     (EXTRACT(epoch FROM now()) * 1000)::bigint
   )
 WHERE enqueued_at_ms IS NULL;

ALTER TABLE harness_shared.substrate_outbox
  ALTER COLUMN enqueued_at_ms
    SET DEFAULT ((EXTRACT(epoch FROM now()) * 1000)::bigint),
  ALTER COLUMN enqueued_at_ms SET NOT NULL;

COMMENT ON COLUMN harness_shared.substrate_outbox.enqueued_at_ms IS
  'Local enqueue time in epoch milliseconds. Independent from ts, which carries the operation wire/LWW timestamp and may be historical during backfill.';
