-- 528-restore-fed-hlc-insert-stamp.sql
--
-- EI-8210: migration 517 replaced stamp_local_federated_write() to add the
-- work_items-specific updated_ts/ts mask, but accidentally regressed the D-001
-- HLC half of the insert branch from migrations 314/490:
--
--   local INSERT -> fed_ts stamped, fed_hlc left NULL
--
-- hive_members is a stamp-regime table and capture_hive_members_outbox (mig 477)
-- threads a PUT's row fed_ts/fed_hlc into substrate_outbox.ts/op_hlc. With a NULL
-- fed_hlc, PUT captures fall back to the drain clock instead of preserving the
-- author's ordering key, reopening the mig-446 class for hive_members admission /
-- revocation rows.
--
-- Fix only the function body:
--   * local INSERT stamps BOTH fed_ts and fed_hlc;
--   * remote/projection writes that carry fed_hlc advance the PG HLC clock via
--     hlc_recv(), matching the D-001 causal recv-advance contract;
--   * the migration-517 work_items-only updated_ts/ts bookkeeping mask is kept.
--
-- Idempotent CREATE OR REPLACE. No table rewrite and no trigger reattachment:
-- existing triggers call this function by OID/name and pick up the replacement.

CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  -- A write that moves fed_ts is a projection apply (remote op; fed_ts = the
  -- op's wire ts) or an explicit repair/backfill — respect it verbatim, and
  -- advance the PG HLC clock past the op's HLC so a later LOCAL write is
  -- causally-after it.
  IF TG_OP = 'UPDATE' AND NEW.fed_ts IS DISTINCT FROM OLD.fed_ts THEN
    IF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A projection INSERT carries the op's fed_ts AND origin='remote'; a local
    -- INSERT carries neither. Gate the stamp on origin: EXCLUDED reflects the
    -- row AFTER BEFORE-INSERT triggers, so stamping a remote ts-less op here
    -- would hand it a fresh clock and let it through the writers' LWW guard.
    IF NEW.fed_ts IS NULL AND COALESCE(NEW.origin, 'local') = 'local' THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := harness_shared.hlc_now();
    ELSIF NEW.fed_hlc IS NOT NULL THEN
      -- Remote INSERT carrying an HLC -> recv-advance.
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE with fed_ts untouched = a local write (or a same-op re-fold; see
  -- migration 517). Stamp the LWW clock + reset origin ONLY when a REAL content
  -- column changed. Bookkeeping-only writes keep the prior clock.
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

  IF (to_jsonb(NEW) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition')
  THEN
    NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    NEW.fed_hlc := harness_shared.hlc_now();
    NEW.origin := 'local';
  END IF;
  RETURN NEW;
END;
$fn$;
