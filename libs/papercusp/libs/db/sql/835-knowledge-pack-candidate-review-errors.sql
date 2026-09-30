-- 835-knowledge-pack-candidate-review-errors
-- P-001 (blender-loop-repair-and-opus5-xhigh-2026-08-16): the transferability
-- judge errored on every auto-adopt sweep for 28 days (unkeyed distiller no-op
-- '[]' → parse-null → verdict 'error' → stays pending) and NOTHING surfaced it:
-- the error lived only in a journald warn line. Persist the per-candidate error
-- streak so (a) the failure is visible on the row itself and (b) the sweep can
-- trip a durable alarm (a filed work-item) when the SAME candidate errors N
-- consecutive sweeps. Additive only — no destructive DDL.

ALTER TABLE harness_shared.knowledge_pack_candidates
  ADD COLUMN IF NOT EXISTS review_error_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_review_error text,
  ADD COLUMN IF NOT EXISTS last_review_error_at timestamptz;

COMMENT ON COLUMN harness_shared.knowledge_pack_candidates.review_error_count IS
  'Consecutive auto-adopt sweeps whose transferability review returned verdict ''error'' for this candidate (reset to 0 on any successful decide). Crossing REVIEW_ERROR_ALARM_THRESHOLD files a work-item alarm (candidates.ts).';
COMMENT ON COLUMN harness_shared.knowledge_pack_candidates.last_review_error IS
  'The most recent review-error reason, including the raw-response snippet the judge saw (bounded).';
COMMENT ON COLUMN harness_shared.knowledge_pack_candidates.last_review_error_at IS
  'When the most recent review error was recorded.';
