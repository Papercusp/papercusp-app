-- 1284-plan-closure-observations.sql
--
-- WI-10003890 / plan goal-brief-to-claimed-plan-work-2026-09-23 D-032.
--
-- The goal portfolio read (readGoalPortfolioBrief → resolveWorklistClosures) used to run
-- the full plan acceptance gate INLINE for every worklist plan that claims to be
-- finished. One such plan cost 1.4–2.3s of a ~1.8s read, so every goal turn-end
-- obligation read on goal 60d3a8 timed out at its 900ms budget and recorded `unknown`.
--
-- This table holds the last canonical gate verdict per plan: the four fields
-- resolvePlanClosure consumes (satisfied, code, skipped, message), the input
-- fingerprint it was computed against, and when. evaluatePlanAcceptanceGate is the ONE
-- writer (a canonical call — no force, no gradingRecruitment, no caller-supplied
-- evidence fingerprints). The portfolio read loads these rows in one query and serves a
-- row only while its fingerprint still matches and it is younger than a bounded age;
-- otherwise the closure reads `unreadable` / gate-not-evaluated and a background
-- re-evaluation refreshes the row. The ship verb keeps evaluating the gate itself.

CREATE TABLE IF NOT EXISTS harness_shared.plan_closure_observations (
  workspace_id  text        NOT NULL,
  harness_slug  text        NOT NULL,
  plan_slug     text        NOT NULL,
  satisfied     boolean     NOT NULL,
  code          text,
  skipped       text,
  message       text,
  fingerprint   jsonb       NOT NULL CHECK (jsonb_typeof(fingerprint) = 'object'),
  observed_at   timestamptz NOT NULL,
  build_sha     text,
  PRIMARY KEY (workspace_id, harness_slug, plan_slug)
);

ALTER TABLE harness_shared.plan_closure_observations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_closure_observations_workspace_isolation
  ON harness_shared.plan_closure_observations;
CREATE POLICY plan_closure_observations_workspace_isolation
  ON harness_shared.plan_closure_observations FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plan_closure_observations TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.plan_closure_observations IS
  'Last canonical plan acceptance-gate verdict per plan, with the input fingerprint it was computed against (D-032). Orientation only: the goal portfolio closure read serves it while the fingerprint matches; plans:set-plan-status always re-evaluates the gate. Writer: evaluatePlanAcceptanceGate via goals/plan-closure-observations.ts.';
