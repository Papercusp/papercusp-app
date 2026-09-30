-- 1141-enforce-capability-class-passing-bindings.sql
-- identities-v1 P-016 forward fix for applied migration 1140.
--
-- 1140's application handler installed bindings only after a structural pass,
-- but its database FK named conformance_run_id alone. A direct writer could
-- therefore attach a failed run, a run for another provider/class/workspace, or
-- a verb map that differed from the run. Make those derived-truth invariants
-- relational: every binding must reference the same exact tuple AND a passing
-- run, and verb_bindings is read from that immutable run instead of duplicated.
--
-- FORWARD-COMPAT: migration 1140 and the classes:* handlers are new in this
-- still-unshipped P-016 change; the currently deployed release has no reader or
-- writer for any capability_class_* table. The live provider-binding table is
-- empty before this migration is armed. Dropping its duplicated verb_bindings
-- column and replacing the run FK therefore cannot break an old binary or lose
-- user data. The new handler reads the verb map from the joined conformance run
-- and never names the dropped column.

ALTER TABLE harness_shared.capability_class_conformance_runs
  ADD CONSTRAINT capability_class_conformance_binding_identity_uq
  UNIQUE (
    workspace_id, class_id, class_version, provider_package, provider_version,
    id, structural_passed
  );

ALTER TABLE harness_shared.capability_class_provider_bindings
  ADD COLUMN binding_eligible BOOLEAN GENERATED ALWAYS AS (TRUE) STORED;

ALTER TABLE harness_shared.capability_class_provider_bindings
  DROP CONSTRAINT capability_class_provider_run_fk;

ALTER TABLE harness_shared.capability_class_provider_bindings
  ADD CONSTRAINT capability_class_provider_run_fk
  FOREIGN KEY (
    workspace_id, class_id, class_version, provider_package, provider_version,
    conformance_run_id, binding_eligible
  )
  REFERENCES harness_shared.capability_class_conformance_runs (
    workspace_id, class_id, class_version, provider_package, provider_version,
    id, structural_passed
  );

ALTER TABLE harness_shared.capability_class_provider_bindings
  DROP CONSTRAINT capability_class_provider_verbs_ck;

ALTER TABLE harness_shared.capability_class_provider_bindings
  DROP COLUMN verb_bindings;
