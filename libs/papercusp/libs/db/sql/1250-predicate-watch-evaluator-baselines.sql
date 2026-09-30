-- 1250 — predicate_watches: per-EVALUATOR baselines
--
-- WI-10004125.
--
-- WHY. Several hosts run the predicate poller (the dev shell, :3170, :3070) and split
-- the due rows between them with FOR UPDATE SKIP LOCKED, so successive polls of ONE
-- row land on different hosts. Those hosts routinely run DIFFERENT BUILDS — main lags
-- staging by design, so :3070 serves older code than :3170 for hours at a time — and
-- a tool result derived by code (an assessment code, a classification) can differ
-- between them at the same instant. The row kept a single baseline (last_eval /
-- last_value) written by whichever host polled last, so a `changed` watch compared
-- :3070's answer against :3170's and fired on the build skew, not on a change.
-- Measured 2026-09-30: state:subscribe on gate.greenCheckpoint.verdict fired twice in
-- minutes (repair-head-red -> inconclusive) while the repair queue was byte-identical;
-- the same dev:pipeline_position call returned 'inconclusive' from :3070 (9a9473af)
-- and 'repair-head-red' from :3170 (8f662b7c2f).
--
-- `evaluator_baselines` maps an evaluator key (`<host>@<build>`) to that evaluator's
-- own previous observation, so each poller compares only against itself. last_eval /
-- last_value remain the row's LATEST observation (what first_eval / join-existing
-- report), no longer the comparison baseline.
--
-- FORWARD-COMPAT: additive only. A new column with a constant default, so the
-- currently deployed release's INSERTs (which never name it) still succeed, and its
-- reads and writes are otherwise unaffected.

ALTER TABLE harness_shared.predicate_watches
  ADD COLUMN IF NOT EXISTS evaluator_baselines jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN harness_shared.predicate_watches.evaluator_baselines IS
  'Per-evaluator baselines, keyed <host>@<build>: { eval: boolean, value: jsonb, at: iso }. '
  'Edge and changed detection compare each poll only to the SAME evaluator''s previous '
  'observation (WI-10004125). last_eval/last_value are the latest observation by any evaluator.';
