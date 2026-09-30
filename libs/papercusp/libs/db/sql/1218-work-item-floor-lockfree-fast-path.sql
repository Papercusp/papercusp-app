-- Migration 1218 — lock-free fast path for the WI federation-floor trigger.
--
-- p2p-join-catchup-speed-2026-09-23 P-527. Migration 1003's BEFORE INSERT
-- trigger took the federation-floor transaction advisory lock for EVERY
-- incoming WI-N row and held it to COMMIT, even when work_item_seq was already
-- past the row's id. A snapshot-seeded join inserts hundreds of thousands of
-- WI-N rows, nearly all below the floor, so two parallel apply lanes would take
-- turns on that lock at transaction length. read-merge therefore sent every
-- WI-N row to one lane, and the WI-N part of a set crossing ran serially
-- (P-007 run #5: about 1.0x there, against 2-4x on the other tables; the VM's
-- sequence stood at 10002322 while it inserted WI-512xxx rows).
--
-- The lock exists so a local allocation cannot race an import that RAISES the
-- floor. When the sequence is already past the imported id, no later nextval
-- can return that id (nextval only moves up, and this trigger only ever setvals
-- upward), so there is nothing to exclude: return without the lock. Only a row
-- that raises the floor takes the lock, and it re-reads the sequence under it.
--
-- It also fixes an edge the old comparison missed: a sequence that was never
-- called (is_called = false) hands out last_value itself on the next nextval,
-- so an imported id EQUAL to last_value must still advance it.

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
    current_called boolean;
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

    -- Fast path: the sequence is already past this id, so no allocation can
    -- reach it. Sequence state is read outside MVCC, so this sees the latest value.
    SELECT last_value, is_called INTO current_id, current_called FROM harness_shared.work_item_seq;
    IF imported_id < current_id OR (imported_id = current_id AND current_called) THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('harness_shared.work_item_seq:federation-floor', 0)
    );
    SELECT last_value, is_called INTO current_id, current_called FROM harness_shared.work_item_seq;
    IF imported_id > current_id OR (imported_id = current_id AND NOT current_called) THEN
        PERFORM setval('harness_shared.work_item_seq'::regclass, imported_id, true);
    END IF;
    RETURN NEW;
END
$body$;

COMMENT ON FUNCTION harness_shared.advance_work_item_seq_from_insert() IS
    'Advance work_item_seq before a restored/federated WI-N row inserts, preventing a later local allocator collision. Takes the federation-floor lock only when the row raises the floor.';
