-- 1115 — Gym candidate-version verdict (Blender evidence-driven redesign P-002).
--
-- Keep the existing proposal rows readable while every newly-recorded candidate
-- carries one immutable, hash-pinned version + gate verdict. Historical rows are
-- intentionally NULL and are never eligible for autonomous promotion.

\set ON_ERROR_STOP on
-- The migration runner supplies the transaction and ON_ERROR_STOP behavior.

ALTER TABLE harness_shared.gym_proposals
  ADD COLUMN IF NOT EXISTS task_corpus text NOT NULL DEFAULT 'synthetic',
  ADD COLUMN IF NOT EXISTS candidate_verdict jsonb;

DO $constraints$ BEGIN
  ALTER TABLE harness_shared.gym_proposals
    ADD CONSTRAINT gym_proposals_task_corpus_check
    CHECK (task_corpus IN ('synthetic', 'real', 'mixed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $constraints$;

COMMENT ON COLUMN harness_shared.gym_proposals.candidate_verdict IS
  'Immutable candidate-version envelope: complete variant/parent overlays, pinned evaluator/rubric/task/code hashes, gate results, and the single promotion verdict. NULL is historical and not auto-promotable.';

CREATE INDEX IF NOT EXISTS gym_proposals_candidate_verdict_idx
  ON harness_shared.gym_proposals (workspace_id, harness_slug)
  WHERE candidate_verdict IS NOT NULL;
