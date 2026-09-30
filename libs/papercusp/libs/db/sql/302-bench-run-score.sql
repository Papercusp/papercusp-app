-- 302-bench-run-score.sql
-- Add the continuous partial-credit score column to the scoreable run-result row.
--
-- TaskRunResult.score (@papercusp/bench-metrics schema.ts) is the [0,1] partial-credit
-- value for suites that grade a weighted RUBRIC/CHECKPOINT set rather than a single diff
-- pass — TheAgentCompany checkpoint partial-credit, PaperBench Replication Score, and the
-- AgentsNet coordination score (plan benchmark-suite-agentsnet-2026-06-17 P-004). The TS
-- field + emit/store path existed but the column was never added, so the score never
-- persisted; this closes that gap. NULL for boolean-resolved suites (SWE-bench family),
-- where `resolved` IS the score.
--
-- Idempotent + additive (nullable, no default backfill) — safe to boot-apply.

ALTER TABLE harness_shared.benchmark_run_result
    ADD COLUMN IF NOT EXISTS score double precision;

COMMENT ON COLUMN harness_shared.benchmark_run_result.score IS
    'Continuous partial-credit score in [0,1] for rubric/checkpoint/coordination suites '
    '(TheAgentCompany, PaperBench, AgentsNet); NULL for boolean-resolved SWE-bench family '
    'where resolved IS the score. Mirrors bench-metrics TaskRunResult.score.';
