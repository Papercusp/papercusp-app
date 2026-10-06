-- 1369 — trigger-pack review state (generalized-integrations-google-migration-cupboard-workflows-2026-10-05
-- P-013, D-016).
--
-- A materialized trigger pack is armed as a unit, against a REVIEW: a deterministic document of
-- everything the pack can do once armed (plugin version, capabilities and OAuth scopes, every owned
-- binding with its source, event pattern, filter, target, input and storm policy, plan targets with a
-- content hash, recipients where knowable). Arming records the sha256 fingerprint of the review the
-- installer saw. Every later materialize recomputes it: when it differs (every version update does,
-- because the version is part of the document) all owned bindings are disarmed and the fingerprint
-- is cleared, so an updated pack never keeps firing without a fresh review. The single arm chokepoint
-- (setExternalTriggerBindingArmed) refuses to arm a pack-owned binding while reviewed_fingerprint is NULL.
--
-- `manifest` keeps the installed manifest (capabilities, OAuth scopes, the trigger-pack declaration)
-- so the review can be rebuilt at arm time and the pack exported without re-reading plugin files.
--
-- Additive only: four columns, one with a default.

ALTER TABLE harness_shared.trigger_pack_installations
  ADD COLUMN IF NOT EXISTS manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reviewed_fingerprint text NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by text NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trigger_pack_installations_reviewed_fingerprint_shape'
       AND conrelid = 'harness_shared.trigger_pack_installations'::regclass
  ) THEN
    ALTER TABLE harness_shared.trigger_pack_installations
      ADD CONSTRAINT trigger_pack_installations_reviewed_fingerprint_shape
      CHECK (reviewed_fingerprint IS NULL OR reviewed_fingerprint ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trigger_pack_installations_manifest_object'
       AND conrelid = 'harness_shared.trigger_pack_installations'::regclass
  ) THEN
    ALTER TABLE harness_shared.trigger_pack_installations
      ADD CONSTRAINT trigger_pack_installations_manifest_object CHECK (jsonb_typeof(manifest) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN harness_shared.trigger_pack_installations.manifest IS
  'P-013 (D-016): the installed plugin manifest, written by every materialize. Source of the review''s capabilities and OAuth scopes and of the exported package manifest.';
COMMENT ON COLUMN harness_shared.trigger_pack_installations.reviewed_fingerprint IS
  'P-013 (D-016): sha256 of the pack review the installer armed against. NULL = unreviewed: no pack-owned binding may be armed. Cleared (and every owned binding disarmed) when a re-materialize changes the review.';
COMMENT ON COLUMN harness_shared.trigger_pack_installations.reviewed_by IS
  'P-013 (D-016): who armed the pack against reviewed_fingerprint.';
COMMENT ON COLUMN harness_shared.trigger_pack_installations.reviewed_at IS
  'P-013 (D-016): when the pack was armed against reviewed_fingerprint.';
