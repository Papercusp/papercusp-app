-- 207-watchdog-key-dedup.sql
--
-- watchdog-audit-2026-06-09 (P-004 / D-001 + P-005 / D-002): first-class
-- signal-key dedup for the improvement watchdog.
--
-- Every watchdog capture now stamps `payload.watchdogKey = '<source>:<key>'`
-- (the stable signal identity already used for within-tick dedup + the
-- deferred-escalation boost). At tick start the watchdog pre-filters collected
-- signals against existing improvements carrying a matching key — ONE indexed
-- query — so a standing already-filed signal stops consuming the per-tick
-- capture budget (live evidence: every slot burned on declined title-dups for
-- a whole 24h window). The expression index below is that query's read path.
--
-- The watchdog_ticks columns record what the pre-filter dropped each tick:
--   known_open_keys     — signals whose key matched an OPEN improvement
--                         (standing, already filed — not a new problem).
--   stale_resolved_keys — signals whose key matched only RESOLVED improvements
--                         AND whose newest evidence (`latestAt`) pre-dates the
--                         resolution — stale lookback-window evidence, NOT a
--                         regression (P-005 / D-002: a resolved duplicate
--                         re-files only on evidence newer than the resolution).
--
-- Idempotent (IF NOT EXISTS); additive; fresh-migrate-safe.

-- The pre-filter read path: WHERE payload->>'watchdogKey' = ANY($keys).
-- Partial on key presence — only watchdog-filed rows enter the index, so it
-- stays tiny no matter how the work-item table grows.
CREATE INDEX IF NOT EXISTS engineer_issues_watchdog_key_idx
    ON harness_shared.engineer_issues ((payload->>'watchdogKey'))
    WHERE payload ? 'watchdogKey';

ALTER TABLE harness_shared.watchdog_ticks
    ADD COLUMN IF NOT EXISTS known_open_keys text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS stale_resolved_keys text[] NOT NULL DEFAULT '{}';
