-- 929 — D-016: every contract clause declares an explicit FALSIFIER.
--
-- Plan: first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20, item P-016.
-- Owner ruling D-016 (2026-08-21): validation contracts must specifically say what
-- would falsify/break them. Falsifiability was already ENFORCED but never DECLARED —
-- `mutation_required` proves the covering TEST can fail, `behavior_class` forces
-- breaking-condition clauses, and the P-006 adequacy standard grades catch-ability —
-- yet no field stated the concrete observation that proves a clause VIOLATED.
--
-- Why the field earns its place (D-016's stated rationale):
--   (a) it makes the P-007 adequacy evaluation MECHANICAL — a test is adequate iff
--       it can produce the falsifying observation;
--   (b) it structurally filters vacuous clauses: no falsifier can be written for
--       "the system is robust", which gives P-014's vacuous-fixture adversarial
--       suite a declared target to detect;
--   (c) it matches system precedent — registered state cells each declare their own
--       falsifier, and the repo's mutation-probe discipline already demands
--       demonstrated falsifiability.
--
-- EXPAND ONLY, deliberately NULLABLE. D-016 says every clause SHOULD declare one,
-- but a NOT NULL here would (i) reject every already-committed revision, and
-- (ii) break every existing writer the moment this applies, while :3070 still serves
-- the older release checkout. The presence requirement is therefore GRADED, not
-- constrained: D-016 assigns concreteness grading to the P-004 spec-quality standard,
-- and P-013 owns turning reported gaps into hard enforcement. A later CONTRACT
-- migration can tighten this once the backfill and the grader are both live.
-- No FORWARD-COMPAT line is required: this migration adds a nullable column and a
-- CHECK that is vacuously true for existing rows, so currently-deployed code that
-- has never heard of `falsifier` keeps working unchanged.

ALTER TABLE harness_shared.plan_spec_clause_revisions
  ADD COLUMN IF NOT EXISTS falsifier jsonb;

COMMENT ON COLUMN harness_shared.plan_spec_clause_revisions.falsifier IS
  'D-016: the concrete observation that proves THIS clause violated, plus how to produce it. '
  'Shape: { "observation": <non-empty text>, "probeMethod"?: <non-empty text> }. '
  'observation = what you would SEE if the promise were broken (not a restatement of the promise). '
  'probeMethod = how to produce that observation (the probe/mutation/input that elicits it). '
  'Covered by content_hash, so revising a falsifier appends a NEW revision rather than mutating a '
  'standing promise in place. NULL means undeclared, which is a gradeable gap, not a passing clause.';

-- FORWARD-COMPAT: the DROP CONSTRAINT below is safe because the constraint it drops is
-- created by THIS migration, on a column THIS migration adds. No deployed release can
-- depend on `plan_spec_clause_revisions_falsifier_shape` — before this file runs, neither
-- the constraint nor `falsifier` exists anywhere. The DROP is only here so the file is
-- re-runnable (ADD CONSTRAINT is not idempotent on its own); it can never remove a
-- constraint the live :3070 release checkout is validating against.
--
-- Shape guard. Deliberately NOT a presence guard (see EXPAND note above): this fires
-- only when a falsifier IS supplied, and rejects the two shapes that would make the
-- field decorative rather than load-bearing — a non-object, and an object whose
-- `observation` is missing/blank/non-string. A blank observation is worse than a NULL
-- one: NULL reports honestly as undeclared, whereas '' reads to every downstream
-- grader as "declared" while saying nothing.
ALTER TABLE harness_shared.plan_spec_clause_revisions
  DROP CONSTRAINT IF EXISTS plan_spec_clause_revisions_falsifier_shape;

ALTER TABLE harness_shared.plan_spec_clause_revisions
  ADD CONSTRAINT plan_spec_clause_revisions_falsifier_shape CHECK (
    falsifier IS NULL
    OR (
      jsonb_typeof(falsifier) = 'object'
      AND jsonb_typeof(falsifier -> 'observation') = 'string'
      AND length(btrim(falsifier ->> 'observation')) > 0
      AND (
        falsifier -> 'probeMethod' IS NULL
        OR (
          jsonb_typeof(falsifier -> 'probeMethod') = 'string'
          AND length(btrim(falsifier ->> 'probeMethod')) > 0
        )
      )
    )
  );

-- Partial index over the DECLARED ones. The queries this exists for are "which active
-- clauses still lack a falsifier" (the P-004 grading sweep and P-016's reporting leg),
-- which scan by lifecycle_status and then test declaredness; indexing only the
-- non-null rows keeps it small while the backfill is still in progress.
CREATE INDEX IF NOT EXISTS plan_spec_clause_revisions_falsifier_declared
  ON harness_shared.plan_spec_clause_revisions (workspace_id, harness_slug, plan_slug, spec_id, revision DESC)
  WHERE falsifier IS NOT NULL;
