-- 175-watch-floor-coalesce-cols.sql — unify-watch-primitive-2026-06-06 (P-005/P-007, D-009).
--
-- ADDITIVE generalization of the await-event store (mig 163) into the unified `watch`
-- model. event_awaits stays the wake-side registration store; these columns make
-- cardinality (`once`) and the per-subscriber wake floor (`min_sleep_sec`) first-class,
-- and let event_wake_deliveries carry the floor input + coalesce accounting.
--
-- Why additive (not a rename): the green :3070 host runs the RELEASE checkout whose code
-- still reads `event_awaits`/`event_wake_deliveries` by name across a currently-held
-- release gate. Adding defaulted columns is invisible to that old code (it SELECTs/INSERTs
-- named columns), so the live fleet's wake path keeps working while the new code uses the
-- new columns. Defaults preserve TODAY's behavior exactly: once=true (every existing await
-- is one-shot), min_sleep_sec=NULL (no floor → one-shot grants still wake promptly),
-- urgent=false, coalesced_count=1.

-- ── event_awaits → the unified watch registration ──────────────────────────────
-- once: cardinality. true = one-shot (today's await — fires once, auto-consumes via
--   fired_at). false = standing (re-arms; a fire queues a delivery WITHOUT consuming it).
ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS once BOOLEAN NOT NULL DEFAULT true;

-- min_sleep_sec: the per-subscriber wake floor for this watch's wakes, in seconds.
--   NULL/0 = no floor (one-shot grants wake promptly). Meaningful for standing wake
--   watches (the pot-style hot recurring case the floor bounds).
ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS min_sleep_sec INTEGER;

-- urgency: a watch whose wakes ALWAYS bypass the floor (e.g. a human-message / escalation
--   watch). Propagated onto each delivery this watch produces (OR'd with the emit-time
--   urgent flag). Default false — ordinary watches obey their floor.
ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS urgency BOOLEAN NOT NULL DEFAULT false;

-- ── event_wake_deliveries → floor input + coalesce accounting ───────────────────
-- urgent: bypass the per-subscriber floor for this delivery (a human message, an
--   escalation, a hard deadline) — wake now regardless of min_sleep.
ALTER TABLE harness_shared.event_wake_deliveries
  ADD COLUMN IF NOT EXISTS urgent BOOLEAN NOT NULL DEFAULT false;

-- min_sleep_sec: denormalized from the await at insert so the pump can decide the floor
--   without re-joining (claimDueDeliveries already correlates wake_handle/note).
ALTER TABLE harness_shared.event_wake_deliveries
  ADD COLUMN IF NOT EXISTS min_sleep_sec INTEGER;

-- coalesced_count: how many fires folded into this one wake (1 = not coalesced). The
--   "here are the N things that fired while you slept" union size; observability for the
--   wake meter. Coalesced-away siblings settle as channel='coalesced' (free-text channel,
--   no CHECK constraint — no enum migration needed).
ALTER TABLE harness_shared.event_wake_deliveries
  ADD COLUMN IF NOT EXISTS coalesced_count INTEGER NOT NULL DEFAULT 1;
