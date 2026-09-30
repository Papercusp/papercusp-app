-- 1171-event-key-payload-schema.sql — identities-v1 P-029 / D-067
--
-- Adds the `payload_schema` column P-029's item text enumerates verbatim ("versioned
-- key, payload schema, discovery columns, review gating") and that migration 1170
-- shipped without.
--
-- WHY IT IS IN SCOPE (D-067). The question that kept scoping it out was asked as a
-- LITERAL-NAME search: "does capability_class_registry — the mirror 1170 names — have
-- a payload_schema column?" It does not, and that NO reads as "the precedent does not
-- carry one". The precedent DOES carry one; it is spelled in its own domain's noun:
--
--   1140:19  interface_verbs JSONB NOT NULL
--   1140:34  CHECK (jsonb_typeof(interface_verbs) = 'object' AND interface_verbs <> '{}'::jsonb)
--
-- A capability class describes its contract as VERBS; an event key describes its
-- contract as a PAYLOAD. Same slot. So mirroring 1140 faithfully ARGUES FOR this
-- column rather than against it. The structural twin the `event` Cupboard listing
-- kind was copied from carries it literally (421:35, datatype_registry.payload_schema
-- JSONB), end to end through install-datatype-io.ts.
--
-- WHY IT IS CURATED (rung 4), NOT DERIVED. An `events:emit` payload is arbitrary at
-- the call site — there is no single declaration a scan could read to recover the
-- INTENDED shape, which is exactly what a consumer of `events:await` needs. So this
-- is judgment a scan cannot produce, and it belongs on 1170's curated side with
-- title/description/contributor.
--
-- ⚠ READ THIS COLUMN'S NULL DIFFERENTLY FROM THE DERIVED ONES. 1170's load-bearing
-- convention is that a NULLABLE column with NO DEFAULT is DERIVED and its NULL means
-- NOT-YET-DERIVED. This column is nullable too, and means something else:
--
--     payload_schema IS NULL  ->  no payload contract has been DECLARED for this key.
--                                 A curation state, not an un-run measurement.
--
-- That is why it is NOT NULL-guarded by event_key_registry_derived_dated_ck and must
-- never be added to it: a derived-dated CHECK over a curated column would refuse a
-- perfectly good hand-registration for lacking a scan that was never owed. The
-- placement (curated block, above the DERIVED banner) and the COMMENT below are what
-- keep the two nullabilities distinguishable to the next reader.
--
-- Non-destructive by construction: ADD COLUMN (nullable, no default) + a
-- NULL-permitting CHECK. Every already-registered row stays valid, so the currently
-- deployed release keeps serving unchanged and no FORWARD-COMPAT acknowledgment is
-- owed.

-- Bound the ALTER's lock wait. Measured BOTH ways (2026-09-17), which is what makes
-- 3s a choice rather than a default: with no timeout the ALTER queues behind a reader
-- convoy (the hourly backup pg_dump holds AccessShare on EVERY table, observed ~10min),
-- and boot auto-apply sets none; but at 250ms a sibling migration here records having
-- "exhausted all 5 lock_timeout retries", failing the migration at boot. 3s is the
-- value this file's own end-to-end rehearsal passed under.
SET lock_timeout = '3s';

ALTER TABLE harness_shared.event_key_registry
  ADD COLUMN IF NOT EXISTS payload_schema JSONB;

-- The shape guard, mirroring 1140's interface_verbs CHECK — but NULL-permitting,
-- per the curated-NULL semantics above. `jsonb_typeof` rejects the silent wrong
-- shapes a bare JSONB column accepts: a scalar, a string, or a top-level array,
-- each of which would typecheck as JSON and then fail whoever tried to read it as
-- a schema object.
--
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so the re-run guard is explicit;
-- migrations here must be idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'harness_shared.event_key_registry'::regclass
       AND conname  = 'event_key_registry_payload_schema_ck'
  ) THEN
    ALTER TABLE harness_shared.event_key_registry
      ADD CONSTRAINT event_key_registry_payload_schema_ck
      CHECK (payload_schema IS NULL OR jsonb_typeof(payload_schema) = 'object');
  END IF;
END
$$;

COMMENT ON COLUMN harness_shared.event_key_registry.payload_schema IS
  'CURATED (rung 4). The intended shape of this event key''s emitted payload, as a '
  'JSON object; consumers of events:await read it to know what a fired payload '
  'carries. NULL means NO PAYLOAD CONTRACT HAS BEEN DECLARED — a curation state, '
  'NOT the not-yet-derived NULL of emitter/emitter_exists/emit_site_count. Never '
  'add this column to event_key_registry_derived_dated_ck.';

-- THE READ SURFACE MUST SEE IT. 1170's event_key_registry_attested is the registry's
-- documented read surface and ENUMERATES its columns explicitly, so a column added to
-- the table stays invisible there until the view is re-created. It already projects
-- every other curated column (title, description, key_pattern, contributor, status,
-- published, review_status, tags), so leaving this one out would contradict the view's
-- own selection rule — and payload_schema is precisely what a consumer of events:await
-- reads. Adding the column without this is a half-fix: present in the table, absent
-- from the surface everyone reads.
--
-- ⚠ payload_schema IS APPENDED LAST, AFTER updated_at — AND MUST STAY THERE. It belongs
-- beside the curated columns semantically, and moving it up there BREAKS THIS
-- MIGRATION: CREATE OR REPLACE VIEW may only ADD columns at the END of the select
-- list, so a re-ordered copy fails with "cannot change name of view column" on every
-- box that already has 1170's view. The tidier-looking edit is the broken one.
CREATE OR REPLACE VIEW harness_shared.event_key_registry_attested AS
  SELECT
    r.workspace_id,
    r.event_key,
    r.title,
    r.description,
    r.key_pattern,
    r.contributor,
    r.status,
    r.published,
    r.review_status,
    r.tags,
    r.emitter,
    r.emitter_exists,
    r.emit_site_count,
    r.derived_at,
    r.derived_from,
    f.first_fired_at,
    f.last_fired_at,
    f.last_fired_by,
    f.fire_count,
    -- The reconciliation this view exists for: a key a scan says has no emitter,
    -- yet the ledger has watched fire. That contradiction is a finding to file,
    -- never something to paper over by trusting either side.
    (r.emitter_exists IS FALSE AND f.fire_count > 0) AS contradicts_scan,
    r.created_by,
    r.created_at,
    r.updated_at,
    r.payload_schema
  FROM harness_shared.event_key_registry r
  LEFT JOIN harness_shared.event_key_fires f
    ON f.workspace_id = r.workspace_id
   AND f.event_key = r.event_key;
