-- 637-pot-watchdog-fires-repeat-backoff.sql
--
-- EI-16038: 1,603 recorded watchdog fires that armed no wake span only 589
-- distinct (source,reason) premises — 1,119 (69.8%) are exact repeats, and
-- the worst single offenders (one stuck scout draft, one itemless ratified
-- plan, one turn-after-turn missing scorecard) re-fire on a FIXED interval
-- forever because the debounce window never grows despite the premise being
-- provably unchanged since the last fire.
--
-- `repeat_count` lets claimWatchdogFire (packages/operator-core/lib/pot/watchdog.ts)
-- track how many consecutive times the SAME (workspace_id, install_slug, source,
-- reason) has re-fired, so it can widen the required quiet window geometrically
-- (2x per repeat, capped) instead of re-firing at the same cadence indefinitely.
-- 1 = a fresh premise (no prior identical fire, or the first-ever fire).
--
-- Idempotent (IF NOT EXISTS); additive; fresh-migrate-safe.

ALTER TABLE harness_shared.pot_watchdog_fires
    ADD COLUMN IF NOT EXISTS repeat_count integer NOT NULL DEFAULT 1;
