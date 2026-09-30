-- 661-add-watchdog-ticks-standing-keys.sql
-- Completes watchdog-churn-delta-gate-2026-07-25 (P-003/D-001) — EI-18638773146465036.
--
-- 658-watchdog-ticks-seen-keys.sql added `seen_keys` (the ledger the delta gate diffs
-- against) and the code (partitionSignalsByKnownKeys / runWatchdogTick in
-- packages/operator-core/lib/harness/improvements/watchdog.ts) already computes
-- `partition.standing` — the signals THIS tick suppressed because their key was seen on
-- the previous ran tick — and threads it as `WatchdogTickRecord.standingKeys` all the way
-- to `recordWatchdogTick`. But that function's INSERT never had a `standing_keys` column
-- to write it to, so the value was silently dropped every tick: no audit trail existed for
-- how much (or how often, or on which key) the anti-churn gate is actually engaging — the
-- exact "nothing alarms on a churning watchdogKey" detector gap the bug report called out.
--
-- This column is that missing ledger, in the same shape as its siblings (known_open_keys /
-- stale_resolved_keys / seen_keys): text[], NOT NULL, defaulted empty so existing rows read
-- as "suppressed nothing" rather than failing a read.

ALTER TABLE harness_shared.watchdog_ticks
  ADD COLUMN IF NOT EXISTS standing_keys text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN harness_shared.watchdog_ticks.standing_keys IS
  'Every `${source}:${key}` signal suppressed THIS tick by the P-003/D-001 delta gate '
  '(watchdog-churn-delta-gate-2026-07-25) because the key was already in the previous ran '
  'tick''s seen_keys — a standing condition, not a new detection. Was computed in-memory '
  '(SignalPartition.standing) and threaded to recordWatchdogTick since P-001 but had no '
  'column to land in until this migration (EI-18638773146465036).';
