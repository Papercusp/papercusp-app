-- P-012 autonomous-inbox-resolution-2026-08-31: admit the deterministic
-- `enlist-plan` finding through the existing plan-cleanup disposition ledger.
-- The action itself uses goals:set-property (typed value validation + CAS +
-- provenance); this migration only widens the row discriminator.
-- FORWARD-COMPAT: this only widens the existing CHECK; the deployed release writes
-- pre-existing finding kinds and does not depend on the dropped constraint object.

ALTER TABLE harness_shared.plan_cleanup_run_findings
  DROP CONSTRAINT IF EXISTS plan_cleanup_run_findings_finding_kind_check;

ALTER TABLE harness_shared.plan_cleanup_run_findings
  ADD CONSTRAINT plan_cleanup_run_findings_finding_kind_check
  CHECK (finding_kind IN ('enlist-plan', 'flip-to-done', 'cleared-blocker',
                          'finish-plan', 'orphaned-claim', 'stale-now',
                          'archive-candidate', 'semantic'));
