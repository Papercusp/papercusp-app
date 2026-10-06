-- 1310-acceptance-adoption-runs.sql — observation-candidate-acceptance-promotion-2026-09-30
-- P-011 (WI-10004574), plan Decisions D-004 / D-009 / D-018.
--
-- One append-only ledger for the legacy acceptance adoption and its canary:
--   * cohort-report  — the report-first dry run of ONE bounded legacy cohort
--                      (row ids + their updated_ts fingerprint; nothing mutated);
--   * cohort-apply   — the enrolment of exactly the reported, still-unprotected
--                      rows (one apply per report, enforced below);
--   * cohort-revert  — the recovery of an apply (restores the prior absent
--                      readiness on every row nobody reviewed since);
--   * canary         — a named-runtime canary receipt; the enforcement cutover
--                      refuses to move without a passed one (R-37).
--
-- Why not attention_bulk_runs: those rows are resolver-AGENT launches with
-- per-item agent dispositions and an owner digest. Adoption is a deterministic
-- system mutation keyed by a report fingerprint, and a canary receipt has no
-- items at all, so neither fits that table's contract.
--
-- Expand-only: a new table nothing deployed reads or writes.
-- FORWARD-COMPAT: the partial unique index is on a brand-new table that no deployed release reads or writes, so no live writer can start failing on it.

CREATE TABLE IF NOT EXISTS harness_shared.acceptance_adoption_runs (
  run_id        text PRIMARY KEY,
  workspace_id  text NOT NULL,
  harness_slug  text NOT NULL,
  kind          text NOT NULL
                CHECK (kind IN ('cohort-report', 'cohort-apply', 'cohort-revert', 'canary')),
  cohort_key    text,
  report_run_id text REFERENCES harness_shared.acceptance_adoption_runs (run_id),
  runtime       text,
  build_sha     text,
  status        text NOT NULL
                CHECK (status IN ('recorded', 'applied', 'reverted', 'passed', 'failed')),
  actor         text NOT NULL,
  fingerprint   text,
  row_ids       text[] NOT NULL DEFAULT '{}'::text[],
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS acceptance_adoption_runs_scope_kind_idx
  ON harness_shared.acceptance_adoption_runs (workspace_id, harness_slug, kind, created_at DESC);

-- A report is applied at most once; a revert targets exactly one apply.
CREATE UNIQUE INDEX IF NOT EXISTS acceptance_adoption_runs_one_apply_per_report
  ON harness_shared.acceptance_adoption_runs (report_run_id)
  WHERE kind IN ('cohort-apply', 'cohort-revert');

GRANT SELECT, INSERT, UPDATE ON harness_shared.acceptance_adoption_runs TO harness_app, harness_admin;
