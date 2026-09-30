-- 852 — integrity constraints for first-class plan spec clauses.
--
-- Migration 851 is already applied and therefore immutable. This additive
-- follow-up makes its application-level invariants database-total: identities
-- belong to a real plan, current_revision names a real immutable snapshot, and
-- supersession targets an exact prior snapshot in the same plan. Plan-item
-- ownership is intentionally validated by plans:set-specs instead of an FK:
-- plan_items is a derived index that is atomically DELETE+INSERT rebuilt on
-- every plan-content write, so an FK to it would make ordinary plan edits fail.

DO $add_plan_fk$ BEGIN
  ALTER TABLE harness_shared.plan_spec_clauses
    ADD CONSTRAINT plan_spec_clauses_plan_fk
    FOREIGN KEY (workspace_id, harness_slug, plan_slug)
    REFERENCES harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
    ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $add_plan_fk$;
ALTER TABLE harness_shared.plan_spec_clauses
  VALIDATE CONSTRAINT plan_spec_clauses_plan_fk;

-- The identity row is inserted with current_revision=0, then its revision is
-- appended and the pointer advances in the same transaction. Deferred checking
-- admits that safe construction sequence while refusing a dangling pointer at
-- COMMIT — including writes from future alternate APIs.
DO $add_current_revision_fk$ BEGIN
  ALTER TABLE harness_shared.plan_spec_clauses
    ADD CONSTRAINT plan_spec_clauses_current_revision_fk
    FOREIGN KEY (workspace_id, harness_slug, plan_slug, spec_id, current_revision)
    REFERENCES harness_shared.plan_spec_clause_revisions
      (workspace_id, harness_slug, plan_slug, spec_id, revision)
    DEFERRABLE INITIALLY DEFERRED NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $add_current_revision_fk$;
ALTER TABLE harness_shared.plan_spec_clauses
  VALIDATE CONSTRAINT plan_spec_clauses_current_revision_fk;

DO $add_supersedes_fk$ BEGIN
  ALTER TABLE harness_shared.plan_spec_clause_revisions
    ADD CONSTRAINT plan_spec_clause_revisions_supersedes_fk
    FOREIGN KEY (
      workspace_id, harness_slug, plan_slug,
      supersedes_spec_id, supersedes_revision
    ) REFERENCES harness_shared.plan_spec_clause_revisions
      (workspace_id, harness_slug, plan_slug, spec_id, revision)
    ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $add_supersedes_fk$;
ALTER TABLE harness_shared.plan_spec_clause_revisions
  VALIDATE CONSTRAINT plan_spec_clause_revisions_supersedes_fk;

DO $add_exact_exemption_check$ BEGIN
  ALTER TABLE harness_shared.plan_spec_clause_revisions
    ADD CONSTRAINT plan_spec_clause_revisions_exemption_exact
    CHECK ((lifecycle_status = 'exempt') = (exemption IS NOT NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $add_exact_exemption_check$;
ALTER TABLE harness_shared.plan_spec_clause_revisions
  VALIDATE CONSTRAINT plan_spec_clause_revisions_exemption_exact;

DO $add_acceptance_provenance_check$ BEGIN
  ALTER TABLE harness_shared.plan_spec_clause_revisions
    ADD CONSTRAINT plan_spec_clause_revisions_acceptance_exact
    CHECK ((lifecycle_status IN ('accepted', 'active')) = (accepted_by IS NOT NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $add_acceptance_provenance_check$;
ALTER TABLE harness_shared.plan_spec_clause_revisions
  VALIDATE CONSTRAINT plan_spec_clause_revisions_acceptance_exact;
