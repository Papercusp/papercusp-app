-- 167-drop-operator-scanner-tables.sql
--
-- unify-agent-launches-as-blueprints-2026-06-04 D-005 (the scanner teardown,
-- executed 2026-06-05 under owner mandate — see plan decisions D-009/D-010):
-- the bespoke operator-scanner + its operator-card recommendation stream are
-- retired. Proactive scanning is now the scheduled `scan` LAUNCH BLUEPRINT
-- (seed-scan-routine.ts → system:blueprint-run {blueprintId:'scan'} → the
-- scanner role via the invoke route); findings land as tracked work_items in
-- the self-improvement backlog (improvements:capture / improvements:digest) —
-- one triage surface, not a separate card feed.
--
-- Drops the six scanner-owned tables (verified 2026-06-05: no pg_proc function
-- or trigger body references any of them; row contents are historical scan
-- output with no consumers left in code):
--   operator_scans            — scan-history rows (582 historical rows)
--   operator_dismissed_cards  — card dismissal/cooldown cache
--   operator_scan_locks       — per-workspace scan mutex (expirable sweep removed)
--   operator_last_scan        — single-row-per-workspace last-scan snapshot
--   operator_idle_snapshot    — single-row-per-workspace idle snapshot
--   operator_scanner_session  — persistent claude --session-id continuity (mig 021)
--
-- (harness_shared.operator_paused is NOT dropped — the pause/resume sentinel
-- survives in device-operator-actions.ts.)
--
-- Idempotent: safe to re-run.

DROP TABLE IF EXISTS harness_shared.operator_scans;
DROP TABLE IF EXISTS harness_shared.operator_dismissed_cards;
DROP TABLE IF EXISTS harness_shared.operator_scan_locks;
DROP TABLE IF EXISTS harness_shared.operator_last_scan;
DROP TABLE IF EXISTS harness_shared.operator_idle_snapshot;
DROP TABLE IF EXISTS harness_shared.operator_scanner_session;
