-- 1305-bulk-run-kind-intake-triage.sql — observation-candidate-acceptance-promotion-2026-09-30
-- P-008 (WI-10004571), plan Decision D-020.
--
-- Admit a third bulk-run kind, 'intake-triage': the registered drain for
-- awaiting observations and unverified candidates. It rides the SAME
-- attention_bulk_runs / attention_bulk_run_items machinery as 'inbox-resolve'
-- (membership = the items snapshot, outcomes = the items table); only the kind
-- differs, so the existing per-(workspace_id, run_kind) single-flight index
-- (migration 937) keeps one intake drain from contending with the Inbox run.
--
-- Expand-only: the CHECK is widened, never narrowed. The currently deployed
-- release only writes 'inbox-resolve' / 'plan-cleanup', both of which the new
-- constraint still admits, so no live writer can start failing.
-- FORWARD-COMPAT: the dropped CHECK is re-added in the same transaction as a strict superset ('inbox-resolve', 'plan-cleanup', 'intake-triage'); the deployed release only writes the first two kinds, so every row it can insert stays valid and no window exists without the constraint.

ALTER TABLE harness_shared.attention_bulk_runs
  DROP CONSTRAINT IF EXISTS attention_bulk_runs_run_kind_check;

ALTER TABLE harness_shared.attention_bulk_runs
  ADD CONSTRAINT attention_bulk_runs_run_kind_check
  CHECK (run_kind IN ('inbox-resolve', 'plan-cleanup', 'intake-triage'));
