-- 1296 — typed intake decision on saved bulk-run items
-- (observation-candidate-acceptance-promotion-2026-09-30 P-004, WI-10004567).
--
-- Intake inputs (observations / unverified candidates surfaced as attention
-- items) reviewed in a saved bulk run get one of six typed dispositions:
-- promote, merge, investigate, retain, reject, retry. The existing
-- disposition / recommendation_kind columns keep their vocabulary (the
-- counters, settle and report UI read them); this column carries the intake
-- decision alongside, so no existing reader changes meaning.
--
-- The CHECK repeats the TypeScript validator (bulk-dispositions.ts
-- parseIntakeDecision) so a non-TypeScript writer cannot bypass it, the same
-- pattern migration 1063 uses for revert handles:
--   * disposition is one of the six;
--   * every decision carries a non-blank reason and a non-blank decidedBy
--     (attributable — R-18);
--   * merge names its target, retry names what information is missing;
--   * reject therefore always has a reason (R-3 falsifier).
-- Additive only: a new nullable column and a constraint that NULL satisfies.

ALTER TABLE harness_shared.attention_bulk_run_items
  ADD COLUMN IF NOT EXISTS intake_decision JSONB;

ALTER TABLE harness_shared.attention_bulk_run_items
  DROP CONSTRAINT IF EXISTS attention_bulk_run_items_intake_decision_check;

-- FORWARD-COMPAT: this drops only the constraint this same migration creates, so a re-run is idempotent; the deployed release never reads or writes intake_decision.
ALTER TABLE harness_shared.attention_bulk_run_items
  ADD CONSTRAINT attention_bulk_run_items_intake_decision_check
    CHECK (
      intake_decision IS NULL OR (
        jsonb_typeof(intake_decision) = 'object'
        AND intake_decision->>'disposition' IN
          ('promote', 'merge', 'investigate', 'retain', 'reject', 'retry')
        AND length(btrim(coalesce(intake_decision->>'reason', ''))) > 0
        AND length(btrim(coalesce(intake_decision->>'decidedBy', ''))) > 0
        AND (intake_decision->>'disposition' <> 'merge'
             OR length(btrim(coalesce(intake_decision->>'targetRef', ''))) > 0)
        AND (intake_decision->>'disposition' <> 'retry'
             OR length(btrim(coalesce(intake_decision->>'missingInformation', ''))) > 0)
      )
    );

COMMENT ON COLUMN harness_shared.attention_bulk_run_items.intake_decision IS
  'Typed intake disposition for an intake input in a saved bulk run (P-004): '
  '{disposition: promote|merge|investigate|retain|reject|retry, reason, decidedBy, '
  'owner, targetRef?, missingInformation?, decidedAt}. NULL for non-intake items '
  'and for intake items not yet decided (unreached rows stay pending and resumable).';
