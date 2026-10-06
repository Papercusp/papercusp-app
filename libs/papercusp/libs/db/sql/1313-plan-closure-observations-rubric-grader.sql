-- 1313-plan-closure-observations-rubric-grader.sql
--
-- WI-10004673 / plan goal-brief-to-claimed-plan-work-2026-09-23 D-039.
--
-- The turn-start obligation reader (readAgentObligationAgenda) still ran
-- evaluatePlanAcceptanceGate INLINE for every own/worklist plan it raises an
-- independent-verification obligation for: 1.0-1.8s of bg-host main-thread CPU per
-- agenda read, which lagged the event loop enough that goal 60d3a8's 900ms turn-end
-- timers fired at up to ~3.9s and recorded `unknown`.
--
-- D-032 already persists the canonical gate verdict per plan for the goal portfolio's
-- closure read. The obligation reader can serve the same observation, but its
-- provider also names the acceptance rubric (episode key) and the independent grader
-- (evidence text), which the table did not keep. This adds both. Additive only: rows
-- written before this migration read NULL for both until their next refresh, which
-- the 10-minute observation age bound guarantees.

ALTER TABLE harness_shared.plan_closure_observations
  ADD COLUMN IF NOT EXISTS rubric_id text,
  ADD COLUMN IF NOT EXISTS graded_by text;

COMMENT ON COLUMN harness_shared.plan_closure_observations.rubric_id IS
  'The acceptance rubric the recorded gate verdict names (PlanAcceptanceGateVerdict.rubricId), when one exists (D-039).';
COMMENT ON COLUMN harness_shared.plan_closure_observations.graded_by IS
  'The independent grader satisfying the recorded gate verdict (PlanAcceptanceGateVerdict.gradedBy), when satisfied by a grading (D-039).';
