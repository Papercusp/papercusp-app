-- 234-scout-idea-grading.sql
--
-- Scout idea grading (scout-idea-grading-2026-06-12, contract C-1 / D-006):
-- the grade lives ON the routed-idea ledger row, not in a new table — one
-- grade per idea with grader attribution, and every consumer (outcome math,
-- priming, the Scout view read) already reads scout_routed_ideas.
--
-- A grade is a faster, stronger outcome signal than the Change Feed's derived
-- won/lost: it feeds (a) fractional win credit into the lens-weight math
-- (C-5: winCredit = (grade-1)/4, grade DOMINATES the system outcome per
-- D-002) and (b) a labelled owner/Queen feedback block into ideator prompts
-- (C-4). NULL human_grade = ungraded — the existing classifyIdeaOutcome path
-- is untouched for those rows.
--
-- graded_by is 'owner' | 'Queen' (D-004: the Queen auto-grades ungraded
-- ideas; an owner grade is sovereign). The precedence rule is enforced in the
-- write seam (gradeRoutedIdea, C-2), not here — the column stays plain text
-- so the seam owns the vocabulary.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); additive; fresh-migrate-safe. RLS
-- and the harness_app/harness_zero grants on scout_routed_ideas (migration
-- 194) are table-level and already cover the new columns.

ALTER TABLE harness_shared.scout_routed_ideas
    ADD COLUMN IF NOT EXISTS human_grade smallint
        CHECK (human_grade BETWEEN 1 AND 5);

ALTER TABLE harness_shared.scout_routed_ideas
    ADD COLUMN IF NOT EXISTS human_feedback text;

ALTER TABLE harness_shared.scout_routed_ideas
    ADD COLUMN IF NOT EXISTS graded_by text;

ALTER TABLE harness_shared.scout_routed_ideas
    ADD COLUMN IF NOT EXISTS graded_at timestamptz;
