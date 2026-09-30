-- 490: p2p_work_offers — the publisher-SIGNED, federated OFFER STORE
-- (p2p-work-distribution-2026-07-02 P-102 store leg, WI-1935;
-- agent-allocation-framework-2026-07-03 D-005 seat-offers ride it).
--
-- One signed record per (hive, publisher, offer-id), two kinds in one store:
--   'work' — a P-102 WorkOffer + its inner authorship envelope (what the
--            standing-puller/executor chain verifies at claim time);
--   'seat' — a D-005 STANDING seat-offer: an agent_slot delegation advertised to
--            the fleet owner ("this machine: N model·effort seats, fleet X").
--            Accounts/GPUs stay LOCAL (M19): the payload carries accountScope
--            'auto'|'pinned' only — the account ID never crosses the wire.
--
-- MIRRORS p2p_fleet_directory (migration 476) — the closest analog (a signed
-- record riding the Hive peer-log, verified by the member-side projection
-- BEFORE apply; projections/work-offers.ts). Differences:
--   1. The accountable identity is the PUBLISHER (any hive member whose device
--      attests to them), not a fleet owner: the projection requires the signing
--      device attested to publisher_github_user_id. AUTHORITY (is that publisher
--      in the fleet's owner-signed publisher set? epoch fences?) is decided at
--      CONSUME time against the fleet directory (P-102 receiver chain) — set
--      membership can change after publish, so it is never frozen at apply time.
--   2. local_disposition: a HOST-LOCAL refusal column (revocation-reaper P-106
--      deferred #2 — "cancel unclaimed offers of a revoked fleet/publisher").
--      A host cannot re-sign a foreign record, so its refusal is UNSIGNED and
--      NON-FEDERATED: excluded from the capture triggers' WHEN list, from the
--      wire row (feature-issue-op-keys.ts toWorkOfferValue), from the
--      projection's ON CONFLICT SET, and from the stamp function's content
--      compare (masked below) so a disposition write never advances the row's
--      LWW clock.
--
-- record_json is TEXT (NOT jsonb) ON PURPOSE: the signature is over the EXACT
-- canonical bytes and a jsonb round-trip could re-canonicalize them (same rule
-- as hive_policy / p2p_fleet_directory). fleet_slug / offer_kind / status are
-- duplicated out of the record as columns purely as filter convenience; the
-- projection verifies each matches the signed record (no cuckoo rows).
--
-- KEYING: harness_slug = the Hive's home_slug; offer_fed_key = the ONE-column
-- per-log key `<publisher-uid>/<offer-id>` (TG_ARGV[0]) — publisher-prefixed,
-- so offer-id squatting across publishers is impossible by construction.
--
-- Must land WITH the code (feature-issue-op-keys.ts mapping + register-all.ts
-- registration + projections/work-offers.ts); apply after an operator restart so
-- the drain can dispatch the new table_name. Idempotent; RLS workspace isolation
-- mirrors p2p_fleet_directory.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.p2p_work_offers (
    workspace_id             text    NOT NULL,
    harness_slug             text    NOT NULL,        -- the Hive's home_slug (carries the identity)
    publisher_github_user_id bigint  NOT NULL,        -- the accountable publisher (numeric, X9)
    offer_id                 text    NOT NULL,        -- unique per publisher; no '/' (schema-enforced)
    record_json              text    NOT NULL,        -- canonical signed record JSON (TEXT not jsonb — see header)
    signer_device_pubkey     text    NOT NULL,        -- the signing DEVICE Ed25519 pubkey (raw-32 base64)
    signature                text    NOT NULL,        -- base64 Ed25519 sig over the canonical signed bytes (offer-store-schema.ts)
    record_version           bigint  NOT NULL DEFAULT 1,  -- monotone; bumps on each author (secondary order; fed_hlc is the LWW key)
    fleet_slug               text    NOT NULL,        -- filter convenience; MUST match the signed record (projection-verified)
    offer_kind               text    NOT NULL,        -- 'work' | 'seat'; MUST match the signed record
    status                   text    NOT NULL DEFAULT 'open', -- 'open'|'paused'|'cancelled'; MUST match the signed record
    local_disposition        text,                    -- HOST-LOCAL refusal (P-106 deferred #2); NEVER federated — see header
    offer_fed_key            text GENERATED ALWAYS AS (publisher_github_user_id::text || '/' || offer_id) STORED, -- the ONE-column per-log key (TG_ARGV[0])
    author_pubkey            text,                    -- standard federation provenance (the writing DEVICE pubkey)
    origin                   text    NOT NULL DEFAULT 'local',
    fed_ts                   bigint,
    fed_hlc                  text,                    -- D-001 HLC ordering key (migration 314) — the LWW winner
    created_at               bigint  NOT NULL,
    updated_at               bigint  NOT NULL DEFAULT 0
);

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'p2p_work_offers_pkey') THEN
    ALTER TABLE ONLY harness_shared.p2p_work_offers
      ADD CONSTRAINT p2p_work_offers_pkey
      PRIMARY KEY (workspace_id, harness_slug, publisher_github_user_id, offer_id);
  END IF;
END
$body$;

-- The list read: offers of a fleet by status (the fleet owner's board + the
-- puller's claimable scan).
CREATE INDEX IF NOT EXISTS p2p_work_offers_fleet_idx
  ON harness_shared.p2p_work_offers (workspace_id, harness_slug, fleet_slug, status);

ALTER TABLE harness_shared.p2p_work_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p2p_work_offers_workspace_isolation ON harness_shared.p2p_work_offers;
CREATE POLICY p2p_work_offers_workspace_isolation ON harness_shared.p2p_work_offers USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Federation capture (mirrors p2p_fleet_directory mig 476). INSERT/DELETE always
-- capture (the echo-guard in capture_substrate_outbox skips origin<>'local');
-- UPDATE only when a federated content column actually changes — NOT on
-- local_disposition / updated_at writes. Per-log key = offer_fed_key (TG_ARGV[0]).
CREATE OR REPLACE TRIGGER capture_p2p_work_offers_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.p2p_work_offers
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('offer_fed_key');

CREATE OR REPLACE TRIGGER capture_p2p_work_offers_outbox_upd_trg
  AFTER UPDATE ON harness_shared.p2p_work_offers
  FOR EACH ROW WHEN (
        OLD.record_json          IS DISTINCT FROM NEW.record_json
     OR OLD.signature            IS DISTINCT FROM NEW.signature
     OR OLD.signer_device_pubkey IS DISTINCT FROM NEW.signer_device_pubkey
     OR OLD.record_version       IS DISTINCT FROM NEW.record_version
     OR OLD.fleet_slug           IS DISTINCT FROM NEW.fleet_slug
     OR OLD.offer_kind           IS DISTINCT FROM NEW.offer_kind
     OR OLD.status               IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('offer_fed_key');

-- The mig-214/314 local-write stamp — REQUIRED for the table to federate.
DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.p2p_work_offers;
CREATE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.p2p_work_offers
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();

-- stamp_local_federated_write: add `local_disposition` to the bookkeeping mask
-- (supersedes the mig-314 body; byte-identical otherwise). A host-local
-- disposition write (revocation-reaper P-106 deferred #2) must NOT count as a
-- content change: it is not federated (capture WHEN above excludes it), so
-- letting it re-stamp fed_ts/fed_hlc/origin would advance the row's LWW clock
-- for a change no peer ever sees — a later legitimate publisher update could
-- then lose the LWW compare. Tables without the column are unaffected (jsonb
-- minus a missing key is a no-op) — `local_disposition` is hereby the
-- CONVENTIONAL name for any host-local advisory column on a federated table.
CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  -- A write that moves fed_ts is a projection apply (remote op; fed_ts = the op's
  -- wire ts) or an explicit repair/backfill — respect it verbatim, and advance the
  -- PG HLC clock past the op's HLC so a later LOCAL write is causally-after it.
  IF TG_OP = 'UPDATE' AND NEW.fed_ts IS DISTINCT FROM OLD.fed_ts THEN
    IF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A projection INSERT carries the op's fed_ts AND origin='remote'; a local
    -- INSERT carries neither. Gate the stamp on origin (see mig 214).
    IF NEW.fed_ts IS NULL AND COALESCE(NEW.origin, 'local') = 'local' THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := harness_shared.hlc_now();
    ELSIF NEW.fed_hlc IS NOT NULL THEN
      -- Remote INSERT carrying an hlc → recv-advance.
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE with fed_ts untouched = a local write. Stamp the LWW clock (fed_ts AND
  -- the HLC ordering key) and reset origin so CDC capture federates the change.
  -- Bookkeeping-only writes (version bumps, updated_at touches, generated _search,
  -- host-local local_disposition) keep the prior clock. fed_hlc is masked from the
  -- content compare (it moves with fed_ts; on its own it must not count as a
  -- content change).
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

COMMIT;
