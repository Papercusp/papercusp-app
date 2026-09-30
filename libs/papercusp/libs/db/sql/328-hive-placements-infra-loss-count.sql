-- 328-hive-placements-infra-loss-count.sql
-- F-FIX-041 (Queen-approved) — the cursed-item placement breaker counts INFRA-induced
-- placement losses (operator/bg-host dormancy, EI-1758 zombie bees) as item-pathology,
-- so a tractable item false-curses out of placement after 3 infra losses. The fix is a
-- SEPARATE, BOUNDED counter: infra-attributed losses accrue here (cursing only at a far
-- higher threshold, INFRA_BREAKER_THRESHOLD=12 in placement-watchdog.ts), while genuine
-- item-pathology losses keep the normal fail_count/3-strike breaker.
--
-- Why a BOUND (not an unbounded exemption): a per-item infra signal (e.g. "the bee made
-- 0 tool calls") can't perfectly distinguish "infra zombied the bee" from "the item
-- crashes bees pre-tool-call" — an UNBOUNDED exemption would let a genuinely-wedging item
-- escape the breaker forever (the EI-865 unbounded-retry bug, fail_count 356→460). The
-- bound guarantees an item ALWAYS eventually curses (at 12) even if every loss is
-- mis-attributed to infra — safe regardless of signal accuracy — while giving a real
-- infra outage ample headroom (12 graced re-places) to heal.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
ALTER TABLE harness_shared.hive_placements
  ADD COLUMN IF NOT EXISTS infra_loss_count integer NOT NULL DEFAULT 0;

-- F-FIX-041 remediation (Queen request): UN-CURSE the items the infra false-curse already
-- latched (WI-218 / WI-231 / WI-283 — confirmed tractable, lost to the overnight
-- dormancy/zombie window, not item-pathology). Reset them out of the `cursed` latch back
-- to `recovering` with both counters zeroed so the watchdog re-places them on the next
-- sweep (re-placing clears the breaker when the item next completes). escalation_msg_id is
-- PRESERVED so the eventual completion still auto-suppresses the stale advisory
-- (suppressCursedEscalation / the EI-1524 GC). Idempotent: the WHERE status='cursed' guard
-- makes a re-run (or an already-disposed item) a no-op.
UPDATE harness_shared.hive_placements
   SET status = 'recovering',
       fail_count = 0,
       infra_loss_count = 0,
       last_disposition = 'uncursed-infra-false-curse',
       updated_at = now()
 WHERE status = 'cursed'
   AND work_item_id IN ('WI-218', 'WI-231', 'WI-283');
