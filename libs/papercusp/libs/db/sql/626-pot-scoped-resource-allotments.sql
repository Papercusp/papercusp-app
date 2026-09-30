-- 626-pot-scoped-resource-allotments.sql — pot-seat-pools-prose-ux-2026-07-18 P-001.
--
-- Widens the grantee of BOTH the local allotment store and the federated
-- seat-offer store from "always exactly one FLEET" to "exactly one of a FLEET
-- or a POT (audience-gated)":
--
--   harness_shared.resource_allotments (mig 473/486) — fleet_slug becomes
--   NULLABLE; a new pot_slug + audience pair lets a host hand a resource to
--   "the whole pot" (or its trusted-members subset) instead of one named
--   fleet. Exactly one of (fleet_slug, pot_slug) must be set; audience is
--   required iff pot_slug is set (D-002 of the pot-seat-pools plan: audience
--   is an explicit, separate grant — never a silent default). The compound
--   PRIMARY KEY required fleet_slug NOT NULL, so it is replaced by a
--   surrogate `id` + two partial unique indexes (one per grantee kind) that
--   ON CONFLICT can target explicitly.
--
--   harness_shared.p2p_work_offers (mig 490) — same fleet_slug/pot_slug xor,
--   restricted to offer_kind='seat' (a 'work'/'spawn_request' offer is always
--   fleet-scoped; only a D-005 standing seat-offer can be pot-scoped). The
--   audience itself travels inside the signed record_json (SeatOfferPayload.
--   audience) — mirroring how model/effort/count already ride the JSON, not a
--   duplicated column — so no new column there; pot_slug IS duplicated as a
--   column (like fleet_slug) because it is the demux/filter key the board and
--   the claim path query on.
--
-- Idempotent; apply via the runner (db:migrate) or psql + a schema_migrations
-- row in one txn.

\set ON_ERROR_STOP on
-- (No top-level BEGIN/COMMIT: the migration runner supplies the transaction —
-- lint-migrations enforced era. Already applied 2026-07-18; content unchanged.)

-- ── resource_allotments ─────────────────────────────────────────────────────

ALTER TABLE harness_shared.resource_allotments
  DROP CONSTRAINT IF EXISTS resource_allotments_pkey;

ALTER TABLE harness_shared.resource_allotments
  ALTER COLUMN fleet_slug DROP NOT NULL;

ALTER TABLE harness_shared.resource_allotments
  ADD COLUMN IF NOT EXISTS pot_slug  text,
  ADD COLUMN IF NOT EXISTS audience  text;

ALTER TABLE harness_shared.resource_allotments
  ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY;

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_allotments_pkey') THEN
    ALTER TABLE harness_shared.resource_allotments
      ADD CONSTRAINT resource_allotments_pkey PRIMARY KEY (id);
  END IF;
END
$body$;

ALTER TABLE harness_shared.resource_allotments
  DROP CONSTRAINT IF EXISTS resource_allotments_pot_nonempty;
ALTER TABLE harness_shared.resource_allotments
  ADD CONSTRAINT resource_allotments_pot_nonempty CHECK (pot_slug IS NULL OR pot_slug <> '');

ALTER TABLE harness_shared.resource_allotments
  DROP CONSTRAINT IF EXISTS resource_allotments_audience;
ALTER TABLE harness_shared.resource_allotments
  ADD CONSTRAINT resource_allotments_audience
  CHECK (audience IS NULL OR audience IN ('trusted-members', 'whole-pot'));

-- Exactly one of fleet_slug/pot_slug names the grantee (loud refusal at the
-- store layer mirrors this; the DB CHECK is the recurrence guard).
ALTER TABLE harness_shared.resource_allotments
  DROP CONSTRAINT IF EXISTS resource_allotments_grantee_xor;
ALTER TABLE harness_shared.resource_allotments
  ADD CONSTRAINT resource_allotments_grantee_xor
  CHECK ((fleet_slug IS NOT NULL) <> (pot_slug IS NOT NULL));

-- Audience is required iff the grantee is a pot (D-002: never a silent default;
-- and a fleet-scoped row never carries one).
ALTER TABLE harness_shared.resource_allotments
  DROP CONSTRAINT IF EXISTS resource_allotments_audience_pot_only;
ALTER TABLE harness_shared.resource_allotments
  ADD CONSTRAINT resource_allotments_audience_pot_only
  CHECK ((pot_slug IS NOT NULL) = (audience IS NOT NULL));

-- Replace the old compound PK's uniqueness with two partial unique indexes
-- (ON CONFLICT (...) WHERE ... can target either explicitly). One allotment
-- per (fleet, resource) or per (pot, resource) on this machine — re-allocating
-- either is still an UPSERT of the cap.
CREATE UNIQUE INDEX IF NOT EXISTS resource_allotments_fleet_uniq
  ON harness_shared.resource_allotments (workspace_id, fleet_slug, resource_kind, resource_ref)
  WHERE fleet_slug IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS resource_allotments_pot_uniq
  ON harness_shared.resource_allotments (workspace_id, pot_slug, resource_kind, resource_ref)
  WHERE pot_slug IS NOT NULL;

-- Claim-authority-style read for the pot-scoped grantee (mirrors
-- resource_allotments_fleet_idx from mig 473).
CREATE INDEX IF NOT EXISTS resource_allotments_pot_idx
  ON harness_shared.resource_allotments (workspace_id, pot_slug)
  WHERE status = 'active' AND pot_slug IS NOT NULL;

COMMENT ON COLUMN harness_shared.resource_allotments.pot_slug IS
  'pot-seat-pools-prose-ux-2026-07-18 P-001: the grantee POT (a shared-hive slug this workspace participates in) when this allotment is pot-scoped rather than fleet-scoped. Exactly one of fleet_slug/pot_slug is non-null (resource_allotments_grantee_xor).';
COMMENT ON COLUMN harness_shared.resource_allotments.audience IS
  'pot-seat-pools-prose-ux-2026-07-18 P-001/D-002: who within pot_slug may draw on this allotment — ''trusted-members'' (this host''s local trust list, checked at claim) or ''whole-pot''. Required iff pot_slug is set (resource_allotments_audience_pot_only); never set for a fleet-scoped row.';

-- ── p2p_work_offers ──────────────────────────────────────────────────────────

ALTER TABLE harness_shared.p2p_work_offers
  ALTER COLUMN fleet_slug DROP NOT NULL;

ALTER TABLE harness_shared.p2p_work_offers
  ADD COLUMN IF NOT EXISTS pot_slug text;

ALTER TABLE harness_shared.p2p_work_offers
  DROP CONSTRAINT IF EXISTS p2p_work_offers_pot_nonempty;
ALTER TABLE harness_shared.p2p_work_offers
  ADD CONSTRAINT p2p_work_offers_pot_nonempty CHECK (pot_slug IS NULL OR pot_slug <> '');

-- A 'work'/'spawn_request' offer is always fleet-scoped (fleet_slug set, no
-- pot_slug); a 'seat' offer is exactly one of fleet-scoped or pot-scoped.
-- Mirrors the coerceWorkOfferStoreRecord validation (offer-store-schema.ts).
ALTER TABLE harness_shared.p2p_work_offers
  DROP CONSTRAINT IF EXISTS p2p_work_offers_grantee;
ALTER TABLE harness_shared.p2p_work_offers
  ADD CONSTRAINT p2p_work_offers_grantee
  CHECK (
    (offer_kind <> 'seat' AND fleet_slug IS NOT NULL AND pot_slug IS NULL)
    OR (offer_kind = 'seat' AND (fleet_slug IS NOT NULL) <> (pot_slug IS NOT NULL))
  );

-- The pot-scoped claimable scan (any fleet in the pot, audience gate applied
-- app-side at claim time — P-003).
CREATE INDEX IF NOT EXISTS p2p_work_offers_pot_idx
  ON harness_shared.p2p_work_offers (workspace_id, harness_slug, pot_slug, status)
  WHERE pot_slug IS NOT NULL;

-- Widen the outbox capture UPDATE trigger's content-change WHEN clause to
-- include pot_slug (a federated identity column, like fleet_slug) — byte-
-- identical to migration 490's trigger otherwise.
DROP TRIGGER IF EXISTS capture_p2p_work_offers_outbox_upd_trg ON harness_shared.p2p_work_offers;
CREATE TRIGGER capture_p2p_work_offers_outbox_upd_trg
  AFTER UPDATE ON harness_shared.p2p_work_offers
  FOR EACH ROW WHEN (
        OLD.record_json          IS DISTINCT FROM NEW.record_json
     OR OLD.signature            IS DISTINCT FROM NEW.signature
     OR OLD.signer_device_pubkey IS DISTINCT FROM NEW.signer_device_pubkey
     OR OLD.record_version       IS DISTINCT FROM NEW.record_version
     OR OLD.fleet_slug           IS DISTINCT FROM NEW.fleet_slug
     OR OLD.pot_slug             IS DISTINCT FROM NEW.pot_slug
     OR OLD.offer_kind           IS DISTINCT FROM NEW.offer_kind
     OR OLD.status               IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('offer_fed_key');

COMMENT ON COLUMN harness_shared.p2p_work_offers.pot_slug IS
  'pot-seat-pools-prose-ux-2026-07-18 P-001: for offer_kind=''seat'', the grantee POT when the standing seat-offer is pot-scoped rather than fleet-scoped (exactly one of fleet_slug/pot_slug — p2p_work_offers_grantee). The audience narrowing (trusted-members|whole-pot) rides the signed record_json (SeatOfferPayload.audience), not a column.';
