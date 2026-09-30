-- 392-placement-infra-curse-deadlock-fix.sql
-- WI-677 — the placement-breaker INFRA false-curse deadlock.
--
-- After the EI-85 host restart reaped the placement bees, the F-FIX-041 BOUNDED infra
-- breaker counted the post-dormancy (operator-was-down) loss toward a per-item curse.
-- Because that signal is ITEM-INDEPENDENT it fires for EVERY placement in LOCKSTEP, so a
-- string of restarts/dormancy windows climbed all of them to infraBreakerThreshold (12)
-- together and cursed the whole frontier at fail_count=0 — 31 genuinely-ready items that
-- fleet:place_batch then PERMANENTLY refused ("the placement breaker has halted re-placing
-- this item"). A curse only clears on COMPLETION, but a refused item can never complete →
-- deadlock. A host restart thus cascaded into a multi-item placement freeze.
--
-- The DURABLE code fix lands alongside this migration:
--   • placement-watchdog.ts evaluatePlacement — postDormancySweep is now FULLY EXEMPT
--     (both counters flat, never curses); an operator-wide outage can never be
--     item-pathology, so it accrues toward no breaker. Only the per-item zombie signal
--     keeps the bounded infra breaker. (Stops the recurrence.)
--   • placement-gather.ts loadCursedWorkItemIds — place_batch now hard-blocks ONLY
--     genuinely pathology-cursed items (fail_count >= breakerThreshold); a fail_count-0
--     infra-curse stays re-placeable. (Breaks the deadlock for any infra-curse.)
--
-- This migration CLEARS the already-latched stale infra-curses so they leave the `cursed`
-- state immediately and re-enter placement with a FRESH bound (mig 328 did the same for 3
-- hardcoded ids; this generalizes it to the whole fail_count-0 cursed signature, and it is
-- durable now that the recurrence is fixed above). A fail_count-0 `cursed` row is an
-- infra false-curse BY DEFINITION — a genuine pathology curse requires fail_count >=
-- breakerThreshold (>= 3) — so this never un-curses a genuinely-doomed item.
--
-- Reset → 'recovering' with both counters zeroed so the watchdog re-places it on the next
-- sweep (re-placing clears the breaker when the item next completes). escalation_msg_id is
-- PRESERVED so the eventual completion still auto-suppresses the stale advisory
-- (suppressCursedEscalation / the EI-1524 GC). Idempotent: the WHERE guard makes a re-run
-- (or an already-disposed item) a no-op.
UPDATE harness_shared.hive_placements
   SET status = 'recovering',
       fail_count = 0,
       infra_loss_count = 0,
       last_disposition = 'uncursed-infra-false-curse',
       updated_at = now()
 WHERE status = 'cursed'
   AND fail_count = 0;
