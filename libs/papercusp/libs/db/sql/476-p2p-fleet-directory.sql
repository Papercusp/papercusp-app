-- 476: p2p_fleet_directory — the owner-SIGNED, federated FLEET DIRECTORY record
-- (p2p-work-distribution-2026-07-02 P-101, D-006).
--
-- D-006: a fleet is a CHANNEL — exactly ONE accountable owner (numeric gh user id,
-- X9) + an owner-signed delegated publisher set, browsable hive-wide as a directory
-- card. This table stores one signed record per (hive, owner, fleet-slug); the
-- record federates over the hive peer-log and the member-side projection
-- (projections/fleet-directory.ts) VERIFIES the device signature + the device→owner
-- attestation BEFORE applying — a forged/unsigned record is DROPPED, never
-- materialized. H5 falls out structurally: the key (and every scope id derived from
-- it, scope-repo.ts `fleet:<uid>/<slug>`) is owner-prefixed, so slug squatting on a
-- bare global name is impossible by construction.
--
-- MIRRORS hive_policy (migration 317) — the closest analog (an owner-signed record
-- riding the Hive peer-log) — with two differences:
--   1. NOT a singleton: keyed (workspace_id, harness_slug, owner_github_user_id,
--      fleet_slug) — one row per fleet. The per-log key for capture_substrate_outbox
--      must be ONE column (TG_ARGV[0]), so `fleet_dir_fed_key` is a GENERATED STORED
--      column `<owner-uid>/<fleet-slug>` (unique within the hive; the projection's
--      composeKey mirrors it exactly).
--   2. The signer is a DEVICE key (signer_device_pubkey), not the hive identity key:
--      the projection resolves the device→user attestation (hive_members) fresh per
--      op and requires the attested user == the record's owner. The H10 alternate
--      path — a signature by the HIVE identity pubkey — is honored ONLY for a change
--      that sets archived=true (hive-owner force-archive of an orphaned fleet).
--
-- record_json is TEXT (NOT jsonb) ON PURPOSE: the signature is over the EXACT
-- canonical bytes and a jsonb round-trip could re-canonicalize them (same rule as
-- hive_policy.policy_json / hive_settings.value). `archived` is duplicated out of the
-- record as a column purely as a filter convenience; the projection verifies the
-- column matches the signed record (no cuckoo rows).
--
-- KEYING: harness_slug = the Hive's home_slug (carries the identity, migration 184),
-- so records ride the Hive-pubkey topic via the existing peer-log machinery. No hard
-- FK to hives/hive_members — the projection fails CLOSED when it cannot resolve the
-- attestation or the hive identity.
--
-- origin/author_pubkey/fed_ts/fed_hlc = the standard federation columns (echo-guard +
-- provenance + the D-001 HLC LWW ordering key, migration 314). The
-- stamp_local_federated_write BEFORE trigger is REQUIRED for the table to federate
-- (migration 314's stamp list is fixed — a new federated table attaches it itself).
--
-- Must land WITH the code (feature-issue-op-keys.ts mapping + register-all.ts
-- registration + projections/fleet-directory.ts); apply after an operator restart so
-- the drain can dispatch the new table_name. Idempotent; RLS workspace isolation
-- mirrors hive_policy.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.p2p_fleet_directory (
    workspace_id          text    NOT NULL,
    harness_slug          text    NOT NULL,        -- the Hive's home_slug (carries the identity)
    owner_github_user_id  bigint  NOT NULL,        -- the ONE accountable owner (numeric, X9)
    fleet_slug            text    NOT NULL,        -- H5: namespaced under the owner by the key itself
    record_json           text    NOT NULL,        -- canonical signed record JSON (federated, TEXT not jsonb — see header)
    signer_device_pubkey  text    NOT NULL,        -- the signing DEVICE Ed25519 pubkey (raw-32 base64); hive pubkey on the H10 force-archive path
    signature             text    NOT NULL,        -- base64 Ed25519 signature over the canonical signed bytes (fleet-directory-schema.ts)
    record_version        bigint  NOT NULL DEFAULT 1,  -- monotone; bumps on each author (secondary order; fed_hlc is the LWW key)
    archived              boolean NOT NULL DEFAULT false, -- filter convenience; MUST match the signed record (projection-verified)
    fleet_dir_fed_key     text GENERATED ALWAYS AS (owner_github_user_id::text || '/' || fleet_slug) STORED, -- the ONE-column per-log key (TG_ARGV[0])
    author_pubkey         text,                    -- standard federation provenance (the writing DEVICE pubkey)
    origin                text    NOT NULL DEFAULT 'local',
    fed_ts                bigint,
    fed_hlc               text,                    -- D-001 HLC ordering key (migration 314) — the LWW winner
    created_at            bigint  NOT NULL,
    updated_at            bigint  NOT NULL DEFAULT 0
);

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'p2p_fleet_directory_pkey') THEN
    ALTER TABLE ONLY harness_shared.p2p_fleet_directory
      ADD CONSTRAINT p2p_fleet_directory_pkey
      PRIMARY KEY (workspace_id, harness_slug, owner_github_user_id, fleet_slug);
  END IF;
END
$body$;

ALTER TABLE harness_shared.p2p_fleet_directory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p2p_fleet_directory_workspace_isolation ON harness_shared.p2p_fleet_directory;
CREATE POLICY p2p_fleet_directory_workspace_isolation ON harness_shared.p2p_fleet_directory USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Federation capture (mirrors hive_policy mig 317). INSERT/DELETE always capture
-- (the echo-guard in capture_substrate_outbox skips origin<>'local'); UPDATE only
-- when a federated content column actually changes (not on updated_at bumps). The
-- per-log key = fleet_dir_fed_key (TG_ARGV[0], the generated column above).
CREATE OR REPLACE TRIGGER capture_p2p_fleet_directory_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.p2p_fleet_directory
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('fleet_dir_fed_key');

CREATE OR REPLACE TRIGGER capture_p2p_fleet_directory_outbox_upd_trg
  AFTER UPDATE ON harness_shared.p2p_fleet_directory
  FOR EACH ROW WHEN (
        OLD.record_json          IS DISTINCT FROM NEW.record_json
     OR OLD.signature            IS DISTINCT FROM NEW.signature
     OR OLD.signer_device_pubkey IS DISTINCT FROM NEW.signer_device_pubkey
     OR OLD.record_version       IS DISTINCT FROM NEW.record_version
     OR OLD.archived             IS DISTINCT FROM NEW.archived)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('fleet_dir_fed_key');

-- The mig-214/314 local-write stamp: a local author (fed_ts untouched, content
-- changed) gets fed_ts + fed_hlc stamped + origin reset to 'local' so the change
-- federates; a projection apply (fed_ts moved) is respected verbatim + recv-advances
-- the HLC clock. REQUIRED for the table to federate (see header).
DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.p2p_fleet_directory;
CREATE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.p2p_fleet_directory
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();

COMMIT;
