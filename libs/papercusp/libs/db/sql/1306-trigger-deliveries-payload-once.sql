-- 1306: trigger_deliveries stores each event payload ONCE, and only for as long as
-- anything can read it (WI-10004921).
--
-- Measured 2026-10-01: harness_shared.trigger_deliveries was 7.4 GB (6.8 GB TOAST) for
-- ~400k rows. Ingestion fans every canonical event out to four sinks (event-bus,
-- trigger-bindings, personal-vault, app-delivery) and claimDelivery() wrote the FULL
-- payload into every sink's ledger row, so each event was stored four times, and
-- nothing ever pruned any of it.
--
-- Nothing reads a delivery row's payload back on the delivery path: a retry re-delivers
-- the in-memory event of the re-ingest, never the stored copy. The only reader is the
-- trigger-run detail view, which reads the EVENT-BUS row (trigger_runs.delivery_id) and
-- already falls back to trigger_runs.payload when it is NULL. So:
--   * payload becomes nullable: non-event-bus sink rows store NULL from now on, and
--     external-triggers/delivery-retention.ts strips the rest after the replay horizon;
--   * payload_pruned_at records WHY a payload is NULL, so a stripped row is never
--     mistaken for an event that arrived without one.
-- The rows themselves stay: (source_id, dedupe_key, sink_kind, sink_ref) is each sink's
-- dedupe identity, and deleting it would re-deliver an old event on a provider resync.
--
-- Expand-only (relaxes a constraint, adds a nullable column): the deployed release keeps
-- writing payloads exactly as before and its one reader already tolerates NULL.

ALTER TABLE harness_shared.trigger_deliveries
  ALTER COLUMN payload DROP NOT NULL;

ALTER TABLE harness_shared.trigger_deliveries
  ADD COLUMN IF NOT EXISTS payload_pruned_at timestamptz;

COMMENT ON COLUMN harness_shared.trigger_deliveries.payload IS
  'Canonical event payload. Stored only on the event-bus sink row (the row trigger_runs.delivery_id references); other sink rows store NULL. Stripped to NULL by external-triggers/delivery-retention.ts after the replay horizon — see payload_pruned_at.';

COMMENT ON COLUMN harness_shared.trigger_deliveries.payload_pruned_at IS
  'When delivery-retention stripped this row''s payload (NULL = never stripped). A NULL payload with NULL payload_pruned_at is a non-event-bus sink row that never stored one.';

-- The retention sweep's work queue: rows that still hold a payload. Partial, so it stays
-- tiny once the backlog drains and costs nothing on the (payload-less) majority.
CREATE INDEX IF NOT EXISTS trigger_deliveries_payload_held_idx
  ON harness_shared.trigger_deliveries (completed_at)
  WHERE payload IS NOT NULL;
