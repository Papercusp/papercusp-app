-- P-021: distinguish future recoverable one-shot wake claims from historical
-- fired awaits that predate delivery-intent recovery. A fired row with no wake
-- delivery is ambiguous without this writer-stamped marker: old settled rows
-- must not be replayed merely because their delivery ledger was never written.
-- New claims stamp this column in the SAME UPDATE as fired_at. A process death
-- after that commit can be recovered regardless of how long the host is down.
-- No historical backfill: those rows have no reliable intent provenance.
ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS fired_delivery_intent_at timestamptz;

-- Migration 1215 already indexes fired plain one-shot wakes by workspace and
-- fired_at. The reconciler uses that index and checks this marker on candidates;
-- a second hot-table index would duplicate the same sweep path.

COMMENT ON COLUMN harness_shared.event_awaits.fired_delivery_intent_at IS
  'Stamped atomically with a newly fired one-shot wake claim. Only marked rows may be replayed by the missing-delivery reconciler; historical fired rows are not durable wake intents.';
