-- Widen harness_shared.admission_runs.run_kind to admit 'resolver-whole-corpus',
-- the P-007 whole-corpus resolver pass ledger (plan
-- silent-intake-central-resolution-2026-09-01).
--
-- FORWARD-COMPAT: this only ADDS an allowed run_kind value; every value the
-- currently-deployed release writes remains valid, and the deployed release's
-- code never writes 'resolver-whole-corpus' (that code has not shipped yet),
-- so no currently-live writer becomes invalid.

ALTER TABLE harness_shared.admission_runs DROP CONSTRAINT admission_runs_run_kind_check;
ALTER TABLE harness_shared.admission_runs ADD CONSTRAINT admission_runs_run_kind_check
  CHECK (run_kind IN ('census', 'promoter-tick', 'bulk-stage', 'delta-sweep', 'daily-digest',
                       'durable-park-audit', 'resolver-whole-corpus'));
