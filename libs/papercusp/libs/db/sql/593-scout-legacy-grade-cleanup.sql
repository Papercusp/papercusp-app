-- Migration 593 — WI-4467: remove grades from pre-cycle-prefix Scout rows.
--
-- Before the 2026-07-11 cycle-prefixed ledger key fix, Scout persisted the
-- positional idea id (for example scout-idea-reframing-4-0) while also
-- recording a cycle_id.  ON CONFLICT then reused the row in later cycles,
-- leaving a grade attached to a different idea than the one the owner saw.
--
-- Keep the provenance rows (and their recomputable outcome cache), but clear
-- only the human grade association.  The structural predicate is deliberately
-- narrow: Scout origin, a cycle id, and an unprefixed idea id.  New rows use
-- <cycle_id>:<idea_id> and are not touched; su-ideate rows have no cycle id.
-- Idempotent: a second run affects zero rows.

UPDATE harness_shared.scout_routed_ideas
   SET human_grade = NULL,
       human_feedback = NULL,
       graded_by = NULL,
       graded_at = NULL
 WHERE origin = 'scout'
   AND cycle_id IS NOT NULL
   AND position(':' in idea_id) = 0
   AND (human_grade IS NOT NULL OR human_feedback IS NOT NULL OR graded_by IS NOT NULL OR graded_at IS NOT NULL);
