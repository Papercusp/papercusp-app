-- Migration 1003 — keep the local WI allocator above restored/federated rows.
--
-- EI-21637077415806005 / WI-2944 reproduced the failure on the Windows guest:
-- work_item_seq.last_value was 79 while the restored Papercusp rows already
-- contained WI-79 through WI-39334. The resource governor therefore allocated
-- WI-79, its INSERT ... ON CONFLICT DO NOTHING suppressed the primary-key
-- collision, and capability:launch-agent could not persist a durable receipt.
--
-- The sequence is per database, but WI rows are copied between databases. Keep
-- the existing allocator surface and make that topology safe in two places:
--   1. a BEFORE INSERT trigger advances the sequence for every incoming WI-N row;
--   2. next_work_item_id and the trigger share one transaction advisory lock, so
--      a local allocation cannot race an imported row at the same frontier.
-- The one-time backfill repairs already-drifted/restored databases when applied.

CREATE OR REPLACE FUNCTION harness_shared.next_work_item_id() RETURNS text
    LANGUAGE plpgsql
    VOLATILE
    SET search_path = pg_catalog, harness_shared
AS $body$
DECLARE
    candidate bigint;
BEGIN
    -- Held until the caller's transaction commits its new row. The import-side
    -- trigger below takes the same lock before its row can become visible.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('harness_shared.work_item_seq:federation-floor', 0)
    );
    candidate := nextval('harness_shared.work_item_seq'::regclass);
    RETURN 'WI-' || candidate::text;
END
$body$;

CREATE OR REPLACE FUNCTION harness_shared.advance_work_item_seq_from_insert()
RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, harness_shared
AS $body$
DECLARE
    numeric_text text;
    imported_numeric numeric;
    imported_id bigint;
    current_id bigint;
BEGIN
    numeric_text := substring(NEW.feature_id FROM '^WI-([0-9]+)$');
    IF numeric_text IS NULL THEN
        RETURN NEW;
    END IF;

    -- Parse as arbitrary-precision numeric first so a malformed/out-of-range
    -- external id cannot abort an otherwise-valid replicated INSERT.
    imported_numeric := numeric_text::numeric;
    IF imported_numeric > 9223372036854775807 THEN
        RETURN NEW;
    END IF;
    imported_id := imported_numeric::bigint;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('harness_shared.work_item_seq:federation-floor', 0)
    );
    SELECT last_value INTO current_id FROM harness_shared.work_item_seq;
    IF imported_id > current_id THEN
        PERFORM setval('harness_shared.work_item_seq'::regclass, imported_id, true);
    END IF;
    RETURN NEW;
END
$body$;

DROP TRIGGER IF EXISTS work_items_advance_id_sequence ON harness_shared.work_items;
CREATE TRIGGER work_items_advance_id_sequence
    BEFORE INSERT ON harness_shared.work_items
    FOR EACH ROW
    EXECUTE FUNCTION harness_shared.advance_work_item_seq_from_insert();

-- Repair databases whose rows arrived before the trigger existed. Numeric casts
-- deliberately happen through numeric and are bounded before bigint conversion.
DO $backfill$
DECLARE
    max_existing_id bigint;
    current_id bigint;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('harness_shared.work_item_seq:federation-floor', 0)
    );
    SELECT COALESCE(max(candidate), 0)::bigint
      INTO max_existing_id
      FROM (
        SELECT substring(feature_id FROM 4)::numeric AS candidate
          FROM harness_shared.work_items
         WHERE feature_id ~ '^WI-[0-9]+$'
      ) AS numeric_ids
     WHERE candidate <= 9223372036854775807;

    SELECT last_value INTO current_id FROM harness_shared.work_item_seq;
    IF max_existing_id > current_id THEN
        PERFORM setval('harness_shared.work_item_seq'::regclass, max_existing_id, true);
    END IF;
END
$backfill$;

COMMENT ON FUNCTION harness_shared.next_work_item_id() IS
    'Allocate the next kind-independent WI-N id under the same transaction lock used by restored/federated WI row inserts.';
COMMENT ON FUNCTION harness_shared.advance_work_item_seq_from_insert() IS
    'Advance work_item_seq before a restored/federated WI-N row inserts, preventing a later local allocator collision.';
