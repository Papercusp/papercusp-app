-- 1062-resource-governor-admission-ledger.sql
--
-- resource-governor-admission-ledger-2026-09-01 P-002 / D-006.
--
-- The resource governor currently stores one admission receipt per row in
-- harness_shared.work_items. Admission receipts are durable queue state, not
-- work: they have no plan, claim, assignment, review, or completion meaning.
-- This migration gives the existing Governor / AdmissionDriver state machine a
-- purpose-built PostgreSQL persistence entity without creating another
-- governor or another scheduling surface.
--
-- FORWARD COMPATIBILITY. The table and indexes are additive. The only hook on
-- an existing relation is a DORMANT BEFORE INSERT guard: it does nothing until
-- the ledger-backed writer records the per-workspace cutover latch in the
-- existing operator_settings KV. The currently deployed work-item writer can
-- therefore continue during migration apply; after the first new writer
-- commits the latch, an old process fails closed instead of creating a new
-- payload.resource_governor work item. UPDATE settlement of receipts created
-- before cutover remains allowed.

CREATE TABLE IF NOT EXISTS harness_shared.resource_governor_admissions (
  workspace_id text NOT NULL,
  receipt_id text NOT NULL DEFAULT ('RG-' || gen_random_uuid()::text),
  -- DurableAdmissionRecord is the single canonical state. Every scalar column
  -- below is a generated projection, so queue indexes cannot drift from it.
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  schema_version integer GENERATED ALWAYS AS ((record->>'schemaVersion')::integer) STORED,
  namespace text GENERATED ALWAYS AS (record->>'namespace') STORED,
  idempotency_key text GENERATED ALWAYS AS (record->>'idempotencyKey') STORED,
  request_fingerprint text GENERATED ALWAYS AS (record->>'requestFingerprint') STORED,
  admission_class text GENERATED ALWAYS AS (record->>'admissionClass') STORED,
  state text GENERATED ALWAYS AS (record->>'state') STORED,
  priority double precision GENERATED ALWAYS AS ((record->>'priority')::double precision) STORED,
  coalesce_key text GENERATED ALWAYS AS (NULLIF(record->>'coalesceKey', '')) STORED,
  enqueued_at_ms bigint GENERATED ALWAYS AS ((record->>'enqueuedAtMs')::bigint) STORED,
  updated_at_ms bigint GENERATED ALWAYS AS ((record->>'updatedAtMs')::bigint) STORED,
  deadline_at_ms bigint GENERATED ALWAYS AS ((record->>'deadlineAtMs')::bigint) STORED,
  decision_generation bigint GENERATED ALWAYS AS ((record->'decision'->>'generation')::bigint) STORED,
  lease_owner text GENERATED ALWAYS AS (NULLIF(btrim(record->'lease'->>'owner'), '')) STORED,
  lease_expires_at_ms bigint GENERATED ALWAYS AS ((record->'lease'->>'expiresAtMs')::bigint) STORED,

  CONSTRAINT resource_governor_admissions_pkey PRIMARY KEY (workspace_id, receipt_id),
  CONSTRAINT resource_governor_admissions_receipt_id_chk CHECK (
    receipt_id ~ '^RG-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT resource_governor_admissions_record_object_chk CHECK (jsonb_typeof(record) = 'object'),
  CONSTRAINT resource_governor_admissions_schema_chk CHECK (schema_version = 1),
  CONSTRAINT resource_governor_admissions_namespace_chk CHECK (namespace IS NOT NULL AND btrim(namespace) <> ''),
  CONSTRAINT resource_governor_admissions_idempotency_chk CHECK (
    idempotency_key IS NOT NULL
    AND btrim(idempotency_key) <> ''
    AND char_length(idempotency_key) <= 200
  ),
  CONSTRAINT resource_governor_admissions_fingerprint_chk CHECK (
    request_fingerprint IS NOT NULL AND btrim(request_fingerprint) <> ''
  ),
  CONSTRAINT resource_governor_admissions_class_chk CHECK (
    admission_class IS NOT NULL AND btrim(admission_class) <> ''
  ),
  CONSTRAINT resource_governor_admissions_state_chk CHECK (
    state IN ('queued', 'eligible', 'leased', 'running', 'completed', 'cancelled', 'superseded', 'expired')
  ),
  CONSTRAINT resource_governor_admissions_time_chk CHECK (
    enqueued_at_ms IS NOT NULL
    AND enqueued_at_ms >= 0
    AND updated_at_ms IS NOT NULL
    AND updated_at_ms >= enqueued_at_ms
    AND (deadline_at_ms IS NULL OR deadline_at_ms >= 0)
  ),
  CONSTRAINT resource_governor_admissions_decision_chk CHECK (
    decision_generation IS NOT NULL AND decision_generation >= 0
  ),
  CONSTRAINT resource_governor_admissions_lease_chk CHECK (
    (
      state IN ('leased', 'running')
      AND lease_owner IS NOT NULL
      AND lease_expires_at_ms IS NOT NULL
      AND lease_expires_at_ms >= updated_at_ms
    )
    OR
    (
      state NOT IN ('leased', 'running')
      AND lease_owner IS NULL
      AND lease_expires_at_ms IS NULL
    )
  ),
  CONSTRAINT resource_governor_admissions_identity_uq UNIQUE (
    workspace_id, namespace, idempotency_key
  )
);

-- Queue selection. The class/priority/time suffix supports both the simple
-- priority order and the controller's class-filtered weighted selection.
CREATE INDEX IF NOT EXISTS resource_governor_admissions_active_queue_idx
  ON harness_shared.resource_governor_admissions (
    workspace_id,
    namespace,
    state,
    admission_class,
    priority DESC,
    enqueued_at_ms,
    receipt_id
  )
  WHERE state IN ('queued', 'eligible');

-- Latest-wins coalescing searches only active rows carrying a coalesce key.
CREATE INDEX IF NOT EXISTS resource_governor_admissions_active_coalesce_idx
  ON harness_shared.resource_governor_admissions (
    workspace_id,
    namespace,
    coalesce_key,
    enqueued_at_ms DESC,
    receipt_id
  )
  WHERE coalesce_key IS NOT NULL
    AND state IN ('queued', 'eligible', 'leased', 'running');

-- Lease expiry and positive owner-death reconciliation share this active-only
-- access path. receipt_id remains the final compare-and-set identity.
CREATE INDEX IF NOT EXISTS resource_governor_admissions_active_lease_idx
  ON harness_shared.resource_governor_admissions (
    workspace_id,
    namespace,
    lease_expires_at_ms,
    lease_owner,
    receipt_id
  )
  WHERE state IN ('leased', 'running');

-- Both numeric-deadline expiry and no-deadline abandonment are bounded by this
-- queued-only index; updated_at_ms is the abandonment dwell clock.
CREATE INDEX IF NOT EXISTS resource_governor_admissions_pending_expiry_idx
  ON harness_shared.resource_governor_admissions (
    workspace_id,
    namespace,
    deadline_at_ms,
    updated_at_ms,
    receipt_id
  )
  WHERE state IN ('queued', 'eligible');

-- Terminal retention is independent of the work-item retention policy.
CREATE INDEX IF NOT EXISTS resource_governor_admissions_terminal_retention_idx
  ON harness_shared.resource_governor_admissions (
    updated_at_ms,
    workspace_id,
    receipt_id
  )
  WHERE state IN ('completed', 'cancelled', 'superseded', 'expired');

COMMENT ON TABLE harness_shared.resource_governor_admissions IS
  'Canonical PostgreSQL admission ledger for the existing capless resource governor. One RG-UUID receipt per workspace/namespace/idempotency key; record is the versioned DurableAdmissionRecord. This table is not work and intentionally has no work-item, plan, claim, assignment, federation, review, or completion surface.';

COMMENT ON COLUMN harness_shared.resource_governor_admissions.receipt_id IS
  'Opaque RG-UUID admission identity generated by the ledger. Never allocated from harness_shared.work_item_seq and never a WI-/EI-/feature identity.';

COMMENT ON COLUMN harness_shared.resource_governor_admissions.record IS
  'Single canonical DurableAdmissionRecord JSON document. Generated columns are read/index projections only and cannot diverge from it.';

-- Reuse the existing operator_settings KV for the cross-version latch instead
-- of adding a second one-row control table. The new store writes:
--   key   = resource_governor_admission_ledger_cutover:<workspace_id>
--   value = 1
-- in the same transaction that establishes ledger-only admission.
CREATE OR REPLACE FUNCTION harness_shared.reject_post_cutover_governor_work_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, harness_shared
AS $function$
BEGIN
  IF jsonb_exists(COALESCE(NEW.payload, '{}'::jsonb), 'resource_governor')
     AND EXISTS (
       SELECT 1
         FROM harness_shared.operator_settings AS setting
        WHERE setting.key = 'resource_governor_admission_ledger_cutover:' || NEW.workspace_id
          AND setting.value = '1'
     )
  THEN
    RAISE EXCEPTION
      'resource-governor admission cutover is active for workspace %; legacy work_items receipt insertion is disabled',
      NEW.workspace_id
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'work_items_resource_governor_post_cutover_guard';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS reject_post_cutover_governor_work_item_trg
  ON harness_shared.work_items;
CREATE TRIGGER reject_post_cutover_governor_work_item_trg
  BEFORE INSERT ON harness_shared.work_items
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.reject_post_cutover_governor_work_item();

COMMENT ON FUNCTION harness_shared.reject_post_cutover_governor_work_item() IS
  'Bounded rolling-cutover guard: after the ledger writer latches one workspace in operator_settings, reject only NEW payload.resource_governor work_items rows from an old binary. Existing legacy rows may still UPDATE to settle.';
