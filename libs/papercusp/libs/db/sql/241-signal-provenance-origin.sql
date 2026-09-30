-- 241-signal-provenance-origin.sql
--
-- self-learning-frontier-2026-06-12 (P-002 / D-002, brief FB-03): signal
-- PROVENANCE on every learning-signal row, so synthetic signals from the
-- frontier loops can coexist with the live self-improvement loop without
-- polluting organic learners.
--
-- Learning-signal rows are improvements captures — engineer_issues rows tagged
-- `papercusp-improvement` (capture-core.ts), including everything the watchdog
-- files. Each now carries a signal_origin:
--   'organic' — a real signal from live operation (the default; every row that
--               existed before this migration is organic by definition);
--   'drill'   — a vaccination-planted synthetic friction (frontier P-031);
--   'replay'  — output of a counterfactual replay run (frontier P-020/P-021);
--   'shadow'  — output of a shadow ablation (frontier P-023).
--
-- Every learning consumer filters to organic unless explicitly opted in — the
-- read-side default lives at the single repointable read seam
-- (packages/operator-core/lib/harness/improvements/read-items.ts), so digest,
-- triage, decay, hygiene, recurrence escalation, gym routed ideas, the scout
-- corpus, the implement loop, and the Learning tab all inherit it.
--
-- NAMING: engineer_issues already has `origin` — the federation local/remote
-- column (migration 108). This is the distinct LEARNING provenance column.
--
-- Idempotent; additive; fresh-migrate-safe. The column default backfills the
-- whole existing backlog as organic in one metadata-only ALTER (PG 11+).

ALTER TABLE harness_shared.engineer_issues
  ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';

ALTER TABLE harness_shared.engineer_issues
  DROP CONSTRAINT IF EXISTS engineer_issues_signal_origin_chk;
ALTER TABLE harness_shared.engineer_issues
  ADD CONSTRAINT engineer_issues_signal_origin_chk
  CHECK (signal_origin IN ('organic', 'drill', 'replay', 'shadow'));

COMMENT ON COLUMN harness_shared.engineer_issues.signal_origin IS
  'Learning-signal provenance (self-learning-frontier P-002/D-002): organic | drill | replay | shadow. Default organic; learning consumers filter to organic unless explicitly opted in (read-items.ts). Distinct from `origin`, the federation local/remote column.';
