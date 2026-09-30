-- 317: hive_policy — the owner-SIGNED, federated Hive policy record
-- (shared-hive-owner-enforcement-2026-06-19 EN-1).
--
-- The FOUNDATION of the owner-enforcement layer: a CLAIMED Hive owner authors a
-- single signed policy document (rate caps, membership mode, allowlist, moderation,
-- contribution rules) that federates as authoritative Hive state. Honest peers read
-- the owner's signed policy; EN-2/EN-3/EN-4 enforce it at write-admission. EN-1 adds
-- NO enforcement — only the storage + signature + federation + the authoring gate.
--
-- MIRRORS hive_settings (migration 186), the closest analog (a workspace-owned key
-- riding the Hive peer-log), with three deliberate differences:
--   1. SINGLETON per Hive — PK (workspace_id, harness_slug), ONE policy doc per Hive
--      (hive_settings is keyed by an extra setting_key). The whole policy carries ONE
--      owner signature, so "newer policy_version wins" + the signature both apply to
--      the document as a unit.
--   2. The federated subset adds the SIGNATURE columns: policy_json (the canonical
--      signed JSON TEXT), owner_pubkey (the Hive owner's Ed25519 pubkey the policy was
--      signed with), policy_version (monotone, bumps each author). policy_json is TEXT
--      (NOT jsonb) ON PURPOSE: the signature is over the EXACT canonical bytes, and a
--      jsonb round-trip could re-canonicalize them — the same "JSON-serialized TEXT,
--      no jsonb-binding dance" rule migration 186 followed for `value`.
--   3. The read-side projection (projections/hive-policy.ts, tableTag 'hive-policy')
--      VERIFIES the owner signature against the Hive identity pubkey (harness_shared.
--      hives.public_key) BEFORE applying — a forged/unsigned policy is DROPPED, never
--      materialized. That is what makes the policy authoritative over P2P.
--
-- KEYING: harness_slug = the Hive's home_slug (carries the identity, migration 184),
-- so the policy rides the Hive-pubkey topic (P-004) via the EXISTING peer-log
-- machinery. No HARD FK to hives — the read-side projection stays tolerant of applying
-- a policy before the hive identity row materializes locally (cross-machine join
-- ordering); when the hives row is absent the projection fails CLOSED (drops the op,
-- since it cannot resolve the owner pubkey to verify against).
--
-- origin/author_pubkey/fed_ts/fed_hlc = the standard federation columns (echo-guard +
-- provenance + the D-001 HLC LWW ordering key, migration 314). The capture triggers
-- below enqueue local writes via capture_substrate_outbox (key = harness_slug,
-- TG_ARGV[0] — a singleton, so the hive-home slug IS the per-log key); the
-- stamp_local_federated_write BEFORE trigger (migration 214/314) stamps fed_ts +
-- fed_hlc + origin='local' on a local author so the change federates.
--
-- Must land WITH the code (feature-issue-op-keys.ts mapping + register-all.ts
-- projection registration + projections/hive-policy.ts); apply after an operator
-- restart so the drain can dispatch the new table_name. Idempotent; RLS workspace
-- isolation mirrors hive_settings/hives.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.hive_policy (
    workspace_id    text    NOT NULL,
    harness_slug    text    NOT NULL,        -- the Hive's home_slug (carries the identity)
    policy_json     text    NOT NULL,        -- canonical signed policy JSON (federated, TEXT not jsonb — see header)
    owner_pubkey    text    NOT NULL,        -- the Hive owner Ed25519 pubkey the policy was signed with (raw-32 base64)
    signature       text    NOT NULL,        -- base64 Ed25519 signature over the canonical signed bytes (see hive-policy-schema.ts)
    policy_version  integer NOT NULL DEFAULT 1,  -- monotone; bumps on each owner author (secondary order; fed_hlc is the LWW key)
    author_pubkey   text,                    -- standard federation provenance (the writing DEVICE pubkey; distinct from owner_pubkey)
    origin          text    NOT NULL DEFAULT 'local',
    fed_ts          bigint,
    fed_hlc         text,                    -- D-001 HLC ordering key (migration 314) — the LWW winner
    created_at      bigint  NOT NULL,
    updated_at      bigint  NOT NULL DEFAULT 0
);

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hive_policy_pkey') THEN
    ALTER TABLE ONLY harness_shared.hive_policy
      ADD CONSTRAINT hive_policy_pkey PRIMARY KEY (workspace_id, harness_slug);
  END IF;
END
$body$;

ALTER TABLE harness_shared.hive_policy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hive_policy_workspace_isolation ON harness_shared.hive_policy;
CREATE POLICY hive_policy_workspace_isolation ON harness_shared.hive_policy USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Federation capture (mirrors hive_settings mig 186). INSERT/DELETE always capture
-- (the echo-guard in capture_substrate_outbox skips origin<>'local'); UPDATE only
-- when a federated content column actually changes (not on updated_at bumps). The
-- singleton's per-log key = harness_slug (TG_ARGV[0]).
CREATE OR REPLACE TRIGGER capture_hive_policy_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.hive_policy
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('harness_slug');

CREATE OR REPLACE TRIGGER capture_hive_policy_outbox_upd_trg
  AFTER UPDATE ON harness_shared.hive_policy
  FOR EACH ROW WHEN (
        OLD.policy_json    IS DISTINCT FROM NEW.policy_json
     OR OLD.signature      IS DISTINCT FROM NEW.signature
     OR OLD.owner_pubkey   IS DISTINCT FROM NEW.owner_pubkey
     OR OLD.policy_version IS DISTINCT FROM NEW.policy_version)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('harness_slug');

-- The mig-214/314 local-write stamp: a local author (fed_ts untouched, content
-- changed) gets fed_ts + fed_hlc stamped + origin reset to 'local' so the change
-- federates; a projection apply (fed_ts moved) is respected verbatim + recv-advances
-- the HLC clock. This is REQUIRED for the table to federate — migration 314's stamp
-- list is fixed, so a new federated table must attach the trigger itself.
DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.hive_policy;
CREATE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.hive_policy
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();

COMMIT;
