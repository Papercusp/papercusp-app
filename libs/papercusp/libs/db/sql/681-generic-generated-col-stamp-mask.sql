-- Migration 681 — mask EVERY generated column (not a hand-listed name) in
-- `stamp_local_federated_write`'s content-diff.
--
-- WI-6210 / p2p first-green rig, 2026-07-27. THIRD occurrence of one defect class.
--
-- THE CLASS -------------------------------------------------------------------------
-- PostgreSQL computes a STORED generated column AFTER every BEFORE ROW trigger
-- finishes. So inside `stamp_local_federated_write_trg` (BEFORE INSERT OR UPDATE),
-- `to_jsonb(NEW)->>'<generated col>'` is always NULL while `to_jsonb(OLD)->>'<same>'`
-- holds the already-computed stored value. The trigger's content-diff mask therefore
-- sees a spurious "real content changed" on EVERY update to such a table — including a
-- byte-identical RE-APPLY of the same remote op (a retry, a backfill re-scan, a second
-- drain pass) — and unconditionally re-stamps `NEW.origin := 'local'` with a fresh
-- local fed_ts/fed_hlc. That silently relabels a remote peer's row as locally-authored
-- and, because the fresh clock is NEWER than the wire, every later redelivery of the
-- publisher's genuine op loses the LWW compare: the federated record stays permanently
-- shadowed, with no repair path.
--
-- Occurrence 1 (mig 214/517): `_search` — masked by name.
-- Occurrence 2 (mig 653): `plan_item_assignments.fed_key` — masked by name. That
--   migration also asserted, "verified by grep across every CDC table's DDL", that
--   `plan_item_assignments` was the ONLY remaining table with a generated column
--   outside the mask.
-- Occurrence 3 (THIS): `harness_shared.p2p_work_offers.offer_fed_key`
--   (`GENERATED ALWAYS AS (publisher_github_user_id::text || '/' || offer_id) STORED`,
--   mig 490:62; the trigger is attached at 490:112). 653's claim was wrong because its
--   grep matched the literal `fed_key` and this column is named `offer_fed_key`.
--
-- Observed live on the two-peer federation rig (leg 2026-07-27T01:11Z, scenario
-- seat_offer): frame b publishes a seat offer; frame a applies it correctly
-- (`origin='remote'`, fed_ts = b's wire ts 1785114852911), then 258ms later the SAME
-- 18-column projection upsert re-folds the identical op (md5 unchanged) and the trigger
-- rewrites it to `origin='local'` with fed_ts 1785114853920. The scenario asserts
-- `origin='remote'` and so failed on a row that had genuinely arrived. Three earlier
-- diagnoses (un-threaded apply / capture echo / forgeable writerPubkey) were all
-- REFUTED by instruments before this was found: the WI-6210 apply-path detector fired
-- zero times in a bundle verified to contain it, and frame a's outbox was empty.
--
-- THE FIX ---------------------------------------------------------------------------
-- Stop naming generated columns one bug at a time. Derive them from the catalog for
-- the triggering table (`pg_attribute.attgenerated <> ''`) and subtract the whole set.
-- This closes the class: a future table can add a generated column under any name and
-- the mask covers it on day one, with no third migration and no grep.
--
-- Behaviour preserved verbatim from mig 653: the fed_ts-moved early return, the
-- INSERT branch's origin-gated local stamp, and the `work_items`-only
-- `updated_ts`/`ts` bookkeeping exclusion (mig 517 — NOT global, because
-- `coord_event_log.ts` is genuine content there).
--
-- The explicit `- 'fed_key'` from 653 is dropped: it is now covered generically where
-- it is actually generated, and keeping it by name would wrongly mask a column called
-- `fed_key` on some future table where it IS genuine content. `_search` is kept in the
-- base mask (it is generated on every table that has it, so this is belt-and-braces).
--
-- COST: one `pg_attribute` index lookup per row-update, and only on the branch that
-- still needs the diff — the two early returns above it (fed_ts moved, INSERT) run
-- first and never reach it. That is comparable to the two whole-row `to_jsonb()` casts
-- the diff already performs on the same path.
--
-- NOT fixed here, deliberately: mig 653 also dropped the `hlc_recv()` recv-advance
-- that mig 528 added (both the UPDATE-moves-fed_ts and remote-INSERT branches), which
-- looks like an accidental full-body clobber rather than an intended change. That is a
-- SEPARATE defect with its own blast radius; folding it in here would make this
-- migration's effect on the federation rig unattributable. Tracked separately.
--
-- Idempotent CREATE OR REPLACE. No table rewrite and no trigger reattachment: existing
-- triggers call this function by name and pick up the replacement.

CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
DECLARE
  mask text[] := ARRAY[
    'fed_ts', 'fed_hlc', 'origin', 'author_pubkey', 'updated_at',
    '_search', 'version', 'local_disposition'
  ];
  gen_cols text[];
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
  -- Bookkeeping-only writes (version bumps, updated_at touches) and generated
  -- columns keep the prior clock.
  --
  -- WI-183/WI-2853: `work_items` (renamed from harness_features_consolidated, mig 374)
  -- has no `updated_at` column — its bookkeeping timestamps are `updated_ts`/`ts`,
  -- which the base mask does not name. Exclude them too, but ONLY for this table
  -- (mig 517; not global — `coord_event_log.ts` is genuine content there).
  IF TG_TABLE_NAME = 'work_items' THEN
    mask := mask || ARRAY['updated_ts', 'ts'];
  END IF;

  -- mig 681: every GENERATED column of the triggering table. A STORED generated
  -- column reads NULL in NEW inside a BEFORE trigger but holds its computed value in
  -- OLD, so leaving one in the diff reports a phantom content change on every update
  -- (see header). Derived from the catalog so a newly-added generated column is
  -- covered without another migration.
  SELECT coalesce(array_agg(a.attname::text), ARRAY[]::text[])
    INTO gen_cols
    FROM pg_attribute a
   WHERE a.attrelid = TG_RELID
     AND a.attgenerated <> ''
     AND a.attnum > 0
     AND NOT a.attisdropped;
  mask := mask || gen_cols;

  IF (to_jsonb(NEW) - mask) IS DISTINCT FROM (to_jsonb(OLD) - mask) THEN
    NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    NEW.fed_hlc := harness_shared.hlc_now();
    NEW.origin := 'local';
  END IF;
  RETURN NEW;
END;
$fn$;
