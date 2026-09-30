-- portable-identity-packages P-004 / D-003. Extend the existing registry;
-- execution kind/latency are attested by the passing run, never caller guesses.
-- All existing providers and old writers retain their tool/sync semantics.
-- Recipe inspection/runtime and operation execution have separate admission
-- gates. A row's kind is not authorization to execute it.
-- FORWARD-COMPAT: The two replaced constraints are foreign keys, not columns or uniqueness targets. Existing rows and old writers receive tool/sync defaults; original primary keys and all unique indexes remain intact. New composite FKs preserve the existing passing-run identity requirements while adding execution metadata. Real-PG upgrade tests cover pre-upgrade rows and old insert shapes.
-- lint-migrations: allow-index-swap Only foreign keys are replaced; no unique index or UNIQUE constraint is dropped, so every deployed ON CONFLICT target retains its original index. New unique constraints add referenced tuples for the stronger foreign keys.

ALTER TABLE harness_shared.capability_class_conformance_runs
  ADD COLUMN provider_kind TEXT NOT NULL DEFAULT 'tool',
  ADD COLUMN latency_class TEXT NOT NULL DEFAULT 'sync',
  ADD CONSTRAINT capability_class_conformance_execution_ck CHECK (
    (provider_kind IN ('tool', 'recipe') AND latency_class = 'sync') OR
    (provider_kind = 'operation' AND latency_class = 'async')
  ),
  ADD CONSTRAINT capability_class_conformance_execution_uq UNIQUE (
    workspace_id, class_id, class_version, provider_package, provider_version,
    id, structural_passed, provider_kind, latency_class
  );

ALTER TABLE harness_shared.capability_class_provider_bindings
  ADD COLUMN provider_kind TEXT NOT NULL DEFAULT 'tool',
  ADD COLUMN latency_class TEXT NOT NULL DEFAULT 'sync',
  DROP CONSTRAINT capability_class_provider_run_fk,
  ADD CONSTRAINT capability_class_provider_run_fk FOREIGN KEY (
    workspace_id, class_id, class_version, provider_package, provider_version,
    conformance_run_id, binding_eligible, provider_kind, latency_class
  ) REFERENCES harness_shared.capability_class_conformance_runs (
    workspace_id, class_id, class_version, provider_package, provider_version,
    id, structural_passed, provider_kind, latency_class
  ),
  ADD CONSTRAINT capability_class_provider_execution_uq UNIQUE (
    workspace_id, class_id, class_version, provider_package, provider_version,
    provider_kind, latency_class
  );

ALTER TABLE harness_shared.pot_capability_class_bindings
  ADD COLUMN provider_kind TEXT NOT NULL DEFAULT 'tool',
  ADD COLUMN latency_class TEXT NOT NULL DEFAULT 'sync',
  DROP CONSTRAINT pot_capability_class_provider_fk,
  ADD CONSTRAINT pot_capability_class_provider_fk FOREIGN KEY (
    workspace_id, class_id, class_version, provider_package, provider_version,
    provider_kind, latency_class
  ) REFERENCES harness_shared.capability_class_provider_bindings (
    workspace_id, class_id, class_version, provider_package, provider_version,
    provider_kind, latency_class
  );

COMMENT ON COLUMN harness_shared.capability_class_conformance_runs.provider_kind IS
  'Attested provider execution kind. Recipe and operation admission require their own validators; not a runtime grant.';
COMMENT ON COLUMN harness_shared.pot_capability_class_bindings.latency_class IS
  'Exact selected provider latency. Sync identity sinks must refuse async providers; never invoke an operation inline.';
