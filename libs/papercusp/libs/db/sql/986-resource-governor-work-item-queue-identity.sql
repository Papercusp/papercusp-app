-- 986-resource-governor-work-item-queue-identity.sql
--
-- capless-adaptive-resource-governor-2026-08-26 P-003.
-- Governor queue records live inside the canonical work_items payload; these
-- indexes make their durable identity race-proof and their queue/status reads
-- selective without introducing a second queue table.
--
-- FORWARD-COMPAT: both indexes are additive. The deployed release neither writes
-- the reserved payload.resource_governor marker nor names either index as an
-- ON CONFLICT arbiter, so adding the partial UNIQUE index cannot invalidate an
-- older writer while the new release is rolling out.

CREATE UNIQUE INDEX IF NOT EXISTS work_items_resource_governor_identity_uq
  ON harness_shared.work_items (
    workspace_id,
    ((payload -> 'resource_governor') ->> 'namespace'),
    ((payload -> 'resource_governor') ->> 'idempotencyKey')
  )
  WHERE ((payload -> 'resource_governor') ->> 'schemaVersion') = '1';

CREATE INDEX IF NOT EXISTS work_items_resource_governor_queue_idx
  ON harness_shared.work_items (
    workspace_id,
    ((payload -> 'resource_governor') ->> 'namespace'),
    ((payload -> 'resource_governor') ->> 'state'),
    created_ts,
    feature_id
  )
  WHERE ((payload -> 'resource_governor') ->> 'schemaVersion') = '1';

COMMENT ON INDEX harness_shared.work_items_resource_governor_identity_uq IS
  'P-003: one canonical durable governor receipt per workspace + namespace + idempotency key.';

COMMENT ON INDEX harness_shared.work_items_resource_governor_queue_idx IS
  'P-003: selective governor queue/status scans over canonical work_items; no parallel queue table.';
