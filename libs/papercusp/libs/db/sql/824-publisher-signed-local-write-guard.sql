-- Migration 824 — a local write cannot outrank a remote publisher-signed row
-- (WI-6250).
--
-- THE DEFECT --------------------------------------------------------------------
-- `stamp_local_federated_write()` deliberately turns an UPDATE that changes real
-- content without moving the wire clock into a locally-authored federation op: it
-- stamps a fresh fed_ts/fed_hlc and resets origin='local'. That is correct for the
-- ordinary multi-writer CDC tables. It is unsafe for a publisher-signed store such
-- as p2p_work_offers: a receiving host cannot re-sign a peer publisher's record, but
-- an accidental SQL update could still give the unsigned local bytes a newer LWW
-- clock. Every later redelivery of the publisher's genuine, older-clocked op would
-- then lose the fed_order_key comparison, permanently shadowing the signed record.
--
-- Migration 681 removed the generated-column phantom diff that first triggered the
-- class. This migration is defense in depth for the next real-content write: when a
-- row is remote-owned (`OLD.origin = 'remote'`) and carries the conventional
-- publisher-signature marker (`signer_device_pubkey`), a clock-stationary content
-- change is rejected synchronously with check_violation. The exception is the loud
-- anomaly signal WI-6250 requested; no unsigned replacement reaches storage and no
-- newer local clock is minted.
--
-- SCOPE -------------------------------------------------------------------------
-- The signer column is inspected through to_jsonb(OLD), so the shared trigger stays
-- generic and tables without publisher-signed rows are unchanged. Host-local advisory
-- writes such as local_disposition remain masked and therefore do not trip the guard.
-- Locally-published signed rows retain origin='local' and may still be updated by their
-- publisher through the normal author path.
--
-- SAME-MILLISECOND REMOTE OPS ----------------------------------------------------
-- The projection discriminator previously recognized only a moved fed_ts. HLC is the
-- real total-order key, so two genuine remote revisions can share an epoch millisecond
-- while fed_hlc advances. Treat either wire-clock component moving as an explicit
-- projection/repair path and recv-advance the HLC before returning. Without this,
-- the new guard would reject a legitimate remote revision; before this migration the
-- same revision was instead mis-stamped origin='local'.
--
-- REGRESSION GUARD ---------------------------------------------------------------
-- stamp-local-federated-write-generated-cols.integration.test.ts loads this exact
-- function body from the highest migration and drives real BEFORE-trigger behavior on
-- Postgres. It proves the rejection, the unchanged stored publisher record, the HLC-only
-- remote-update path, the ordinary unsigned local-write path, generated-column masking,
-- and bookkeeping masking. STAMP_FN_MIGRATION can pin this .DRAFT before arming.
--
-- Idempotent CREATE OR REPLACE. Existing triggers bind by function name. No table
-- rewrite, trigger reattachment, or destructive DDL; the migration runner supplies the
-- transaction.

CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
DECLARE
  mask text[] := ARRAY[
    'fed_ts', 'fed_hlc', 'origin', 'author_pubkey', 'updated_at',
    '_search', 'version', 'local_disposition'
  ];
  gen_cols text[];
  content_changed boolean;
BEGIN
  -- A write that moves either component of the wire order key is a projection
  -- apply or an explicit repair/backfill. Respect it verbatim and advance the PG
  -- HLC clock so a later legitimate local write is causally after it.
  IF TG_OP = 'UPDATE'
     AND (NEW.fed_ts IS DISTINCT FROM OLD.fed_ts
          OR NEW.fed_hlc IS DISTINCT FROM OLD.fed_hlc) THEN
    IF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A projection INSERT carries the op's fed_ts AND origin='remote'; a local
    -- INSERT carries neither. Gate the stamp on origin so a remote ts-less op
    -- cannot receive a fresh local clock and pass the projection's LWW guard.
    IF NEW.fed_ts IS NULL AND COALESCE(NEW.origin, 'local') = 'local' THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := harness_shared.hlc_now();
    ELSIF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE with the wire clock untouched is a local write or a same-op re-fold.
  -- Stamp only when a real content column changed. Bookkeeping and generated
  -- columns retain their prior clock and origin.
  IF TG_TABLE_NAME = 'work_items' THEN
    mask := mask || ARRAY['updated_ts', 'ts'];
  END IF;

  SELECT coalesce(array_agg(a.attname::text), ARRAY[]::text[])
    INTO gen_cols
    FROM pg_attribute a
   WHERE a.attrelid = TG_RELID
     AND a.attgenerated <> ''
     AND a.attnum > 0
     AND NOT a.attisdropped;
  mask := mask || gen_cols;

  content_changed := (to_jsonb(NEW) - mask) IS DISTINCT FROM (to_jsonb(OLD) - mask);

  -- WI-6250: this host is a receiver, not the publisher, when a signed row's
  -- current provenance is remote. A clock-stationary content mutation therefore
  -- cannot be authorized or re-signed here. Fail loudly before an unsigned local
  -- replacement can mint a newer LWW clock and permanently shadow the publisher.
  IF content_changed
     AND COALESCE(OLD.origin, 'local') = 'remote'
     AND NULLIF(to_jsonb(OLD)->>'signer_device_pubkey', '') IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'publisher-signed remote row on %I.%I cannot be changed by a local write',
        TG_TABLE_SCHEMA,
        TG_TABLE_NAME
      ),
      DETAIL = 'Move fed_ts or fed_hlc only when applying an authenticated projection op or an explicit repair.';
  END IF;

  IF content_changed THEN
    NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    NEW.fed_hlc := harness_shared.hlc_now();
    NEW.origin := 'local';
  END IF;
  RETURN NEW;
END;
$fn$;
