-- 658-watchdog-ticks-seen-keys.sql
-- watchdog-churn-delta-gate-2026-07-25 P-001.
--
-- The improvement-watchdog re-files a work item for every STANDING live-state condition
-- on every 15-min tick: `partitionSignalsByKnownKeys` only suppresses a signal that matches
-- an OPEN item, or a RESOLVED item whose updatedAt post-dates the signal's `latestAt` — and
-- live-state collectors (stalled-claim, unresolved-escalation, migration-drift, service-down,
-- perf-regression, orphaned-dispatch) deliberately omit `latestAt`, so that guard is skipped
-- entirely and the signal falls through to `fresh`. Once a separate subsystem retires the
-- item (improvement-hygiene dup-close, watchdog-auto-close, watchdog-green-resolve) the next
-- tick re-files it. Measured 7d: 162 excess duplicate work items (70% of the watchdog's
-- output); `stalled-claim` alone produced 60 copies of ONE key.
--
-- The fix is a DELTA rather than more dedup: a key seen in the previous `ran` tick is a
-- standing condition, not a new detection. `watchdog_ticks` already records the keys the tick
-- DROPPED (known_open_keys / stale_resolved_keys / deferred_keys) but never the keys it SAW,
-- so the delta has nothing to diff against. This column is that missing ledger.
--
-- Same shape as the sibling key columns: text[], NOT NULL, defaulted empty so existing rows
-- read as "no keys seen" and the gate fails OPEN (files) rather than suppressing on absent
-- history.

ALTER TABLE harness_shared.watchdog_ticks
  ADD COLUMN IF NOT EXISTS seen_keys text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN harness_shared.watchdog_ticks.seen_keys IS
  'Every `${source}:${key}` signal observed this tick (watchdog-churn-delta-gate-2026-07-25 P-001). '
  'The delta gate suppresses a signal whose key appeared in the previous ran tick — a standing '
  'condition is not a new detection. Empty on pre-migration rows, which fails the gate OPEN.';
