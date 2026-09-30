-- 206-watchdog-ticks-deferred-keys.sql
--
-- watchdog-robustness-2026-06-09 (P-009 / D-010): record WHICH signals a tick
-- deferred (dropped by the anti-flood cap), so the next tick can ESCALATE a signal
-- that keeps losing a slot. (Renumbered from 204 — collided with a peer's
-- 204-pending-wakes via a git-sync timing race.)
--
-- Before this, watchdog_ticks.deferred stored only a COUNT — there was no way to tell
-- whether the same persistent-but-minor signal was being starved tick after tick.
-- deferred_keys carries the `${source}:${key}` of each deferred signal;
-- planWatchdogCaptures boosts the rank of a key seen here on a recent tick so it
-- eventually lands instead of ageing out forever.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); additive; fresh-migrate-safe. The table is
-- tiny (~96 rows/day) so no index is needed — the reader pulls the last row.

ALTER TABLE harness_shared.watchdog_ticks
    ADD COLUMN IF NOT EXISTS deferred_keys text[] NOT NULL DEFAULT '{}';
