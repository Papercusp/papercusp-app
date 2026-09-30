-- Migration 699 — restore the D-001 hlc_recv() recv-advance in
-- stamp_local_federated_write(), dropped by mig-653's full-body clobber and
-- never carried forward into mig-681 (WI-6249).
--
-- THE DEFECT --------------------------------------------------------------------
-- Migration 528 added `PERFORM harness_shared.hlc_recv(NEW.fed_hlc)` on the two
-- REMOTE paths of this trigger — the UPDATE-moves-fed_ts branch and the
-- remote-INSERT branch — the D-001 causal recv-advance contract: observing a
-- remote op's HLC advances THIS process's logical clock so a later LOCAL write
-- is guaranteed to be stamped strictly-after it.
--
-- Migration 653 (the `fed_key` generated-column mask fix) replaced the whole
-- function body from a stale pre-528 copy: it kept 528's other change (local
-- INSERT stamps both fed_ts and fed_hlc) but its two remote branches contain no
-- hlc_recv call at all — an accidental clobber, not an intended change (653's
-- header says nothing about the recv-advance). Migration 681 (WI-6210, the
-- generic generated-column mask) replaced the body again from 653's copy, so the
-- regression carried forward untouched — 681's own header documents this
-- explicitly as "NOT fixed here, deliberately... tracked separately." This is
-- that separate fix.
--
-- IMPACT: without the recv-advance, a peer's HLC clock does not advance past a
-- remote op's clock, so a subsequent local write is not guaranteed causally-after
-- it. That weakens `lwwPick` back toward wall-clock-skew dependence across
-- machines — exactly the class migration 446/D-001 was written to close.
--
-- THE FIX ------------------------------------------------------------------------
-- Re-add the two `PERFORM harness_shared.hlc_recv(NEW.fed_hlc)` calls to the
-- CURRENT (mig-681) body, changing nothing else: the fed_ts-moved early return
-- now recv-advances before RETURNING; the INSERT branch recv-advances on the
-- remote (non-local-stamp) path. The generic pg_attribute-driven generated-column
-- mask from 681 is preserved verbatim.
--
-- META-PATTERN GUARD: this function has now been damaged TWICE by a full-body
-- CREATE OR REPLACE built from a stale copy (517 dropped 314's HLC insert stamp;
-- 653/681 dropped 528's recv-advance). A regression test
-- (stamp-local-federated-write-recv-advance.integration.test.ts) now asserts the
-- LIVE function body still calls hlc_recv, and drives the two remote paths on a
-- real migrated Postgres to prove the clock actually advances — so the next
-- full-body replace cannot silently drop this again.
--
-- Idempotent (CREATE OR REPLACE; trigger attachments unchanged — they bind by
-- function name, same convention as every prior migration to this function). The
-- runner provides the transaction — NO BEGIN/COMMIT here (lint:migrations).

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
  -- op's wire ts) or an explicit repair/backfill — respect it verbatim, and
  -- (mig-528/D-001, restored) advance the PG HLC clock past the op's HLC so a
  -- later LOCAL write is causally-after it.
  IF TG_OP = 'UPDATE' AND NEW.fed_ts IS DISTINCT FROM OLD.fed_ts THEN
    IF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
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
    ELSIF NEW.fed_hlc IS NOT NULL THEN
      -- (mig-528/D-001, restored) Remote INSERT carrying an HLC -> recv-advance.
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE with fed_ts untouched = a local write (or a same-op re-fold; see
  -- migration 653/681 header). Stamp the LWW clock + reset origin ONLY when a
  -- REAL content column changed. Bookkeeping-only writes (version bumps,
  -- updated_at touches) and generated columns keep the prior clock.
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
  -- (see mig-681 header). Derived from the catalog so a newly-added generated column is
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
