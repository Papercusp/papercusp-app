-- 387-event-wake-delivery-source.sql
-- loop-wake-rate-limit-robustness-2026-06-23 (P0a — turn-outcome attribution).
--
-- A wake delivery is queued with an emit-time `source` attribution (e.g. a loop fire's
-- `loop:<routineId>`, a lock-grant bridge, a system reconciler) — but until now that
-- source was used only for the notify-path emitter identity and was NOT persisted on the
-- delivery row. The loop wake-turn-death fix (agent-insights/loop-wake-turn-deaths-recorded-
-- as-delivered) needs it durably on the row: when a detached `resume-headless` turn 429s
-- and dies, the ASYNC exit handler must know "this delivery was a LOOP wake from routine R"
-- to feed exactly that loop's failure-streak circuit (recordFire) + a 429-aware re-arm —
-- without it, a non-loop wake death to the same session would be mis-attributed to the loop.
--
-- Additive + idempotent: NULL = today's deliveries (no attribution); a generic, reusable
-- per-delivery attribution dimension (also handy for events:status / the wake meter).
ALTER TABLE harness_shared.event_wake_deliveries
  ADD COLUMN IF NOT EXISTS source text;
