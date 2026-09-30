-- Migration 576 — partial index for the H5b allhive-broadcast-sweep detector
-- (coord-authority-hardening-2026-07-11 P-010 / WI-4175, the EI-9501 class).
--
-- allhive-broadcast-sweep.ts (dbos/periodic-workflows.ts, every 5 min) selects
-- unflagged non-queen hive-wide broadcasts with:
--   WHERE surface = 'messages'
--     AND body->>'kind' = 'message'
--     AND body->'to' @> '["*"]'::jsonb
--     AND ts >= <now - lookback>
--     AND ... (queen/system exemptions + NOT EXISTS dedupe)
--   ORDER BY ts ASC
--
-- Without an index that is a JSONB-predicate scan of the whole messages
-- surface of harness_shared.coord_event_log every tick (the exact shape
-- WI-3825 / mig 545 spent ~79h of DB CPU on). Hive-wide *message*-kind
-- broadcasts are RARE by design — lifecycle kinds (plan_event / ack /
-- notify / …) broadcast '*' constantly but are excluded by the kind
-- predicate, and tools/send.ts down-scopes a fleeted sender's bare '*' —
-- so a PARTIAL index matching the sweep's static predicate exactly costs
-- almost nothing to maintain and turns the tick into a tiny index range
-- scan over (ts). Mirrors mig 536 (reply-deadline partial index), the
-- sweep-predicate house pattern.

CREATE INDEX IF NOT EXISTS coord_event_log_allhive_broadcast
  ON harness_shared.coord_event_log (ts)
  WHERE surface = 'messages'
    AND body->>'kind' = 'message'
    AND body->'to' @> '["*"]'::jsonb;

COMMENT ON INDEX harness_shared.coord_event_log_allhive_broadcast IS
  'H5b allhive-broadcast detector (P-010/WI-4175): partial index over the rare kind=message to=[*] hive-wide broadcasts so the 5-min sweep is an index range scan, not a JSONB seq scan (mig 576).';
