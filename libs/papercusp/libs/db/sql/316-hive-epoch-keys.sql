-- 316: hive_epoch_keys — per-member WRAPPED epoch keys for the read-plane re-key
-- (shared-pot-release-testing Brief RE-KEY / C-001 / E-001 / Move 2, P-005).
--
-- On a membership/visibility boundary (member-remove / go-private) the owner advances
-- the Hive epoch (hive_settings 'epoch', mig 186) + mints a fresh content key, then
-- WRAPS it to each REMAINING member's device key (libsodium sealed box) and writes one
-- row HERE per remaining member. The removed member is never given a row → it can still
-- replicate future ciphertext but can never unwrap the new epoch key → cut off (the
-- C-001 read cut). Only the WRAPPED blobs cross the wire; the raw epoch key lives
-- device-local in the keychain (service papercusp-hive-epoch-key), never federated.
--   producer  = advanceEpochAndWrap (sync/hyperbee/hive-epoch-boundary.ts)
--   consumer  = createEpochKeyProvider (sync/hyperbee/hive-epoch-key-provider.ts)
--   ordering  = J's pending-epoch-content buffer defers content until its key row applies
--
-- Federated table — mirrors hive_settings (mig 186) + plan-parts (mig 270/271) + the
-- d001 fed_hlc ordering (mig 314): fed_ts/fed_hlc (LWW of record; the projection guards
-- HLC-then-fed_ts), `origin` echo-guard, the BEFORE stamp_local_federated_write trigger
-- + the AFTER capture_substrate_outbox trigger keyed on the generated single-column fed
-- key. Scope column = `harness_slug` (= the Hive home_slug, the projection demux key,
-- mirroring hive_settings — it rides the hive-home→joiner seam A-003 (a′) establishes).
-- Keyed (workspace_id, harness_slug, epoch, member_device_pubkey).
--
-- `wrapped_key` is TEXT (base64 of the sealed blob), NOT bytea — matching the text-value
-- federation convention (hive_settings.value / plan-parts.body); the projection
-- base64-decodes it. Epoch-key rows are write-once per (hive, epoch, member) (a key for
-- an epoch is immutable), so the LWW guard is effectively first-writer-wins; fed_hlc is
-- carried per J's invariant ("any new mutable LWW projection carries fed_hlc + the guard").
--
-- DARK: nothing writes this table LOCALLY (origin='local') until the papercusp-hive-rekey
-- cutover lands (the boundary trigger + op-path are flag-gated), so the capture trigger
-- never fires until then — an additive, unused table, safe to land + auto-apply (exactly
-- as plan-parts mig 270/271 shipped DARK ahead of papercusp-plan-part-federation).
--
-- The migration runner wraps each file in its own transaction (and strips psql
-- metacommands), so this file carries NO top-level BEGIN;/COMMIT;/\set — an inner COMMIT
-- would end the runner's wrapper txn early (migration-runner.js contract; lint:migrations).

CREATE TABLE IF NOT EXISTS harness_shared.hive_epoch_keys (
    workspace_id         text NOT NULL,
    harness_slug         text NOT NULL,        -- the Hive's home_slug (identity; projection demux scope; mirrors hive_settings)
    epoch                integer NOT NULL,     -- the re-key epoch this key is for
    member_device_pubkey text NOT NULL,        -- the remaining member's raw Ed25519 device pubkey (base64)
    wrapped_key          text NOT NULL,        -- base64 of the epoch key sealed to that device (only they unwrap)
    -- Federation bookkeeping (mirrors hive_settings + mig 314); fed_ts/fed_hlc are
    -- stamped by the BEFORE trigger on a local write + carried from the op on a remote apply.
    author_pubkey        text,                 -- LWW tie-break / provenance (the owner that minted+wrapped)
    origin               text NOT NULL DEFAULT 'local', -- echo-guard: capture skips origin<>'local'
    fed_ts               bigint,               -- LWW ordering field (wall ms; the fallback guard)
    fed_hlc              text,                  -- HLC ordering of record (mig 314; the primary guard)
    -- The peer-log key for an epoch-key row: epoch + member, unique within a Hive.
    -- capture_substrate_outbox keys on ONE column; the projection's composeKey returns
    -- the identical value. ':' separator — base64 contains '/' but never ':'.
    epoch_key_fed_key    text GENERATED ALWAYS AS (epoch::text || ':' || member_device_pubkey) STORED,
    created_at           bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
    updated_at           bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint
);

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hive_epoch_keys_pkey') THEN
    ALTER TABLE ONLY harness_shared.hive_epoch_keys
      ADD CONSTRAINT hive_epoch_keys_pkey PRIMARY KEY (workspace_id, harness_slug, epoch, member_device_pubkey);
  END IF;
END
$body$;

-- Read path: this device's key for a (hive, epoch) — the EpochKeyProvider's loader.
CREATE INDEX IF NOT EXISTS hive_epoch_keys_by_member
  ON harness_shared.hive_epoch_keys (workspace_id, harness_slug, member_device_pubkey, epoch);

ALTER TABLE harness_shared.hive_epoch_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hive_epoch_keys_workspace_isolation ON harness_shared.hive_epoch_keys;
CREATE POLICY hive_epoch_keys_workspace_isolation ON harness_shared.hive_epoch_keys
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- ── fed_ts/fed_hlc local-write stamp (mig 214 + d001 mig 314) ──────────────────
CREATE OR REPLACE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.hive_epoch_keys
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();

-- ── CDC capture → substrate_outbox (mirrors plan-parts mig 271) ────────────────
-- DARK until papercusp-hive-rekey: nothing writes origin='local' here until the cutover,
-- so this never fires in practice yet. Keyed on the generated epoch_key_fed_key.
CREATE OR REPLACE TRIGGER capture_hive_epoch_keys_outbox_trg
  AFTER INSERT ON harness_shared.hive_epoch_keys
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('epoch_key_fed_key');

CREATE OR REPLACE TRIGGER capture_hive_epoch_keys_outbox_upd_trg
  AFTER UPDATE ON harness_shared.hive_epoch_keys
  FOR EACH ROW WHEN (
    OLD.wrapped_key IS DISTINCT FROM NEW.wrapped_key
    OR OLD.fed_ts IS DISTINCT FROM NEW.fed_ts
  )
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('epoch_key_fed_key');
