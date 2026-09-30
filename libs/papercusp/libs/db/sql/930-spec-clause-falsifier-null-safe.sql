-- 930 — fix 929's falsifier shape CHECK: it PASSED a falsifier with no `observation` key.
--
-- Plan: first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20, item P-016 (D-016).
--
-- THE BUG, found by the integration probe written alongside 929 (SQL three-valued logic):
--
--   929 asserted   jsonb_typeof(falsifier -> 'observation') = 'string'
--
-- When the key is ABSENT, `falsifier -> 'observation'` is SQL NULL, `jsonb_typeof(NULL)`
-- is NULL, and `NULL = 'string'` is NULL — not FALSE. A CHECK constraint REJECTS only on
-- FALSE: it treats NULL as satisfied. So `{"probeMethod": "how"}` — a falsifier that
-- declares only how to probe and never says what would be OBSERVED — was accepted, which
-- is precisely the decorative-declaration case 929 exists to block. A blank observation
-- was correctly rejected ('' IS a string, so the length test returned FALSE); only the
-- MISSING one slipped through. The two read identically to every downstream grader.
--
-- THE FIX: test key EXISTENCE with `?` before testing the value's type. `?` returns a
-- strict boolean, never NULL, and `FALSE AND NULL` is FALSE — so the whole conjunction
-- now evaluates to FALSE rather than NULL when the key is absent.
--
-- The probeMethod branch was already NULL-safe and is preserved verbatim in shape: an
-- absent key makes `falsifier -> 'probeMethod'` SQL NULL, so `IS NULL` is TRUE (allowed),
-- while a JSON `null` is a present value of type 'null' and is rejected. Restated with
-- `?` here only so both branches read the same way.
--
-- FORWARD-COMPAT: this DROPs `plan_spec_clause_revisions_falsifier_shape` before
-- re-adding it. The constraint was introduced by migration 929 earlier today, on a column
-- 929 itself added; no release deployed to :3070 predates 929 without also predating the
-- column, so no live code can depend on the constraint being absent, and the replacement
-- is strictly STRICTER on a shape the store already refuses to write. Existing rows are
-- unaffected: every falsifier written through the store carries a non-blank observation,
-- and the guard test below is what proves it, so the ADD is validated immediately rather
-- than left NOT VALID.

ALTER TABLE harness_shared.plan_spec_clause_revisions
  DROP CONSTRAINT IF EXISTS plan_spec_clause_revisions_falsifier_shape;

ALTER TABLE harness_shared.plan_spec_clause_revisions
  ADD CONSTRAINT plan_spec_clause_revisions_falsifier_shape CHECK (
    falsifier IS NULL
    OR (
      jsonb_typeof(falsifier) = 'object'
      -- `?` is the load-bearing addition: strict boolean, so an absent key yields FALSE
      -- (rejected) rather than NULL (silently accepted). See the header.
      AND falsifier ? 'observation'
      AND jsonb_typeof(falsifier -> 'observation') = 'string'
      AND length(btrim(falsifier ->> 'observation')) > 0
      AND (
        NOT (falsifier ? 'probeMethod')
        OR (
          jsonb_typeof(falsifier -> 'probeMethod') = 'string'
          AND length(btrim(falsifier ->> 'probeMethod')) > 0
        )
      )
    )
  );

COMMENT ON CONSTRAINT plan_spec_clause_revisions_falsifier_shape
  ON harness_shared.plan_spec_clause_revisions IS
  'D-016 shape guard. Fires only when a falsifier IS supplied; NULL stays legal because '
  'undeclared is a gradeable gap, not a violation. Key EXISTENCE is tested with `?` before '
  'the value type: without that, an absent `observation` makes the comparison NULL and a '
  'CHECK accepts NULL (the 929 bug fixed by 930).';
