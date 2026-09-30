-- 842: partial expression indexes for the scorecard/observation jsonb paths on
-- harness_shared.work_items (WI-39537 — Rubrics detail open slow / times out).
--
-- listScorecards (packages/operator-core/lib/scorecards.ts) reads through the
-- engineer_issues VIEW, whose payload column is `payload - '_ei'`. After view
-- inlining the planner therefore sees expressions of the exact shape
--   ((payload - '_ei') -> 'observation') ->> '<key>'
-- and an index is only usable if its expression matches that shape structurally
-- (a plain payload -> 'observation' index would never match). Measured before
-- these indexes: 22.8s / 7.0M shared-buffer hits for one rubric's scorecard
-- list (74 rows) — the correlated superseded_by subquery re-filtered all ~68K
-- workspace rows per output row. Both resolvers behind the rubric detail panel
-- (scorecards.list, rubrics.trend) run that query, so the panel exceeded the
-- 10s sync-resolver timeout and never rendered for scorecard-heavy rubrics.
--
-- Partial (IS NOT NULL) on purpose: ~1.5K of ~66K rows carry an observation
-- rubricRef, and far fewer carry supersedes — the predicate keeps the indexes
-- tiny, and every consuming query constrains these paths with `=`, which
-- implies IS NOT NULL, so the partial indexes are always eligible.

CREATE INDEX IF NOT EXISTS work_items_obs_supersedes_idx
  ON harness_shared.work_items ((((payload - '_ei') -> 'observation') ->> 'supersedes'))
  WHERE (((payload - '_ei') -> 'observation') ->> 'supersedes') IS NOT NULL;

CREATE INDEX IF NOT EXISTS work_items_obs_rubric_ref_idx
  ON harness_shared.work_items ((((payload - '_ei') -> 'observation') ->> 'rubricRef'))
  WHERE (((payload - '_ei') -> 'observation') ->> 'rubricRef') IS NOT NULL;
