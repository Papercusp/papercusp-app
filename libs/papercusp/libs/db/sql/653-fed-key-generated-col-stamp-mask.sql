-- Migration 653 — exclude plan_item_assignments' `fed_key` GENERATED column from
-- stamp_local_federated_write_trg's content-diff mask.
--
-- WI-971 followup (live gate 2026-07-20 13:40:25 run): item-assignments backfill AND
-- incr-A→B both showed "NEVER crossed (src outbox=0/N)" while the other 9 CDC content
-- types passed. Direct inspection of the live two-peer rig's PG found the peer's row
-- DID exist with correct content + a real remote author_pubkey/fed_ts, but
-- `origin='local'` instead of 'remote' — so the smoke's `WHERE origin='remote'` poll
-- never matched a genuinely-delivered row. Root-caused + reproduced with a targeted
-- integration test (plan-item-assignments.integration.test.ts: "a same-op double-apply
-- ... does NOT flip origin/fed_ts") that installs the REAL prod trigger stack (the
-- existing test fixture omitted it entirely, so CI never exercised this path).
--
-- THE DEFECT ------------------------------------------------------------------------
-- `harness_shared.plan_item_assignments.fed_key` is `GENERATED ALWAYS AS
-- ((plan_slug||':')||item_id) STORED` (mig 140). PostgreSQL computes a STORED
-- generated column's value AFTER every BEFORE ROW trigger finishes — so inside
-- `stamp_local_federated_write_trg` (a BEFORE INSERT OR UPDATE trigger),
-- `to_jsonb(NEW)->>'fed_key'` is always NULL, while `to_jsonb(OLD)->>'fed_key'` holds
-- the real, already-computed value from the stored row. The trigger's content-diff
-- mask (mig 214/517) already excludes ONE other generated column, `_search`
-- (tsvector, used by harness_plans/work_items/engineer_issues) — but `plan_item_assignments`
-- introduced a DIFFERENT generated column name, `fed_key`, that was never added to the
-- same exclusion set. So on EVERY update to this table (any content change, AND any
-- byte-identical re-fold of the same remote op — a retry, a backfill re-scan, a second
-- drain pass), the mask-diff spuriously detects "real content changed" purely from the
-- NULL-vs-populated fed_key mismatch, and unconditionally re-stamps `origin='local'` —
-- silently mislabeling a remote peer's row as locally-authored, corrupting its
-- federation state (a stale local write can later beat a legitimately newer remote
-- write in the LWW compare; and — the observed symptom — a smoke/gate probe keying on
-- `origin='remote'` false-negatives even though the content genuinely crossed).
--
-- `plan_item_assignments` is the ONLY one of the ~18 tables sharing this function with
-- a generated column outside the existing mask (verified by grep across every CDC
-- table's DDL) — every other affected table's generated column is `_search`, already
-- excluded, or has none. `to_jsonb(x) - 'fed_key'` is a documented no-op on a jsonb
-- object with no such key, so adding it to the GENERAL (non-work_items-scoped) mask is
-- safe for every other table on this function, mirroring how `_search` is already
-- excluded unconditionally rather than table-scoped.
--
-- No repair pass needed: a previously-mislabeled `origin='local'` row self-heals the
-- next time ANY genuinely newer op (local or remote) legitimately updates it — this is
-- bookkeeping-label drift, not lost/corrupted content (the row's actual document
-- fields were always correct; the WHERE-clause tests above only mispolled origin).
--
-- Idempotent (CREATE OR REPLACE; trigger attachments unchanged — they bind by function
-- name, same convention as mig 517). The runner provides the transaction — NO
-- BEGIN/COMMIT here (lint:migrations).

CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  -- A write that moves fed_ts is a projection apply (remote op; fed_ts = the
  -- op's wire ts) or an explicit repair/backfill — respect it verbatim.
  IF TG_OP = 'UPDATE' AND NEW.fed_ts IS DISTINCT FROM OLD.fed_ts THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A projection INSERT carries the op's fed_ts AND origin='remote'; a local
    -- INSERT carries neither. Gate the stamp on origin: `EXCLUDED` reflects the
    -- row AFTER BEFORE-INSERT triggers, so stamping a remote ts-less op here
    -- would hand it a fresh clock and let it through the writers' LWW guard.
    IF NEW.fed_ts IS NULL AND COALESCE(NEW.origin, 'local') = 'local' THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := harness_shared.hlc_now();
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE with fed_ts untouched = a local write (or a same-op re-fold; see header).
  -- Stamp the LWW clock + reset origin ONLY when a REAL content column changed.
  -- Bookkeeping-only writes (version bumps, updated_at touches, generated _search /
  -- fed_key) keep the prior clock.
  --
  -- WI-183/WI-2853: `work_items` (renamed from harness_features_consolidated, mig 374)
  -- has no `updated_at` column — its bookkeeping timestamps are `updated_ts`/`ts`,
  -- which the base mask below does not name. Exclude them too, but ONLY for this
  -- table (mig 517; not global — `coord_event_log.ts` is genuine content there).
  IF TG_TABLE_NAME = 'work_items' THEN
    IF (to_jsonb(NEW) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'updated_ts' - 'ts')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'updated_ts' - 'ts')
    THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := harness_shared.hlc_now();
      NEW.origin := 'local';
    END IF;
    RETURN NEW;
  END IF;

  -- mig 653: exclude `fed_key` (plan_item_assignments' GENERATED ALWAYS ... STORED
  -- key) from the diff — see header. A no-op `-` on every table without that column.
  IF (to_jsonb(NEW) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'fed_key')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'fed_key')
  THEN
    NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    NEW.fed_hlc := harness_shared.hlc_now();
    NEW.origin := 'local';
  END IF;
  RETURN NEW;
END;
$fn$;
