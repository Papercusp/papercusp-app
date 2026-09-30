-- 1239-capability-class-cupboard-provenance.sql — portable-identity-packages-2026-09-26 P-021 / D-015
--
-- A third-party class contract reaches a destination registry only through a
-- consent-bound Cupboard importer (classes:define stays platform-only). The
-- imported row must say WHERE it came from, so the destination can:
--   * derive the platform-shadow rule from its own rows (a namespace holding any
--     non-import row is platform-owned) instead of a hand-kept list; and
--   * trace every imported contract back to the signed artifact and the exact
--     canonical contract hash the administrator consented to.
--
-- Expand-only: every existing row is a platform definition and keeps working
-- unchanged under the defaults. Source conformance run ids from the publisher
-- are stored as provenance only; they never create a provider binding.

ALTER TABLE harness_shared.capability_class_registry
  ADD COLUMN IF NOT EXISTS provenance_kind TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS publisher_namespace TEXT,
  ADD COLUMN IF NOT EXISTS contract_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_artifact_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'capability_class_registry_provenance_kind_ck'
  ) THEN
    ALTER TABLE harness_shared.capability_class_registry
      ADD CONSTRAINT capability_class_registry_provenance_kind_ck
      CHECK (provenance_kind IN ('platform', 'cupboard-import'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'capability_class_registry_import_provenance_ck'
  ) THEN
    ALTER TABLE harness_shared.capability_class_registry
      ADD CONSTRAINT capability_class_registry_import_provenance_ck
      CHECK (
        provenance_kind <> 'cupboard-import'
        OR (publisher_namespace IS NOT NULL
            AND contract_hash IS NOT NULL
            AND source_artifact_hash IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN harness_shared.capability_class_registry.provenance_kind IS
  'platform = defined locally (classes:define / seed); cupboard-import = written by the consent-bound Cupboard class-contract importer (P-021).';
COMMENT ON COLUMN harness_shared.capability_class_registry.publisher_namespace IS
  'Normalized signing-publisher login; equals the first id segment for cupboard-import rows.';
COMMENT ON COLUMN harness_shared.capability_class_registry.contract_hash IS
  'sha256 of the canonical contract bytes carried in the signed release closure.';
COMMENT ON COLUMN harness_shared.capability_class_registry.source_artifact_hash IS
  'artifactContentHash (Merkle root) of the signed Cupboard release that carried the contract.';
COMMENT ON COLUMN harness_shared.capability_class_registry.source_provenance IS
  'Publisher-side facts carried as evidence only (e.g. source conformance run ids); never an authorization.';

CREATE INDEX IF NOT EXISTS capability_class_registry_namespace_provenance_idx
  ON harness_shared.capability_class_registry (workspace_id, (split_part(id, '.', 1)), provenance_kind);
