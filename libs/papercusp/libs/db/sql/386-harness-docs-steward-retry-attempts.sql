-- 386-harness-docs-steward-retry-attempts.sql
-- coordination-unification-data-sync-hardening-2026-06-23 (doc-steward robustness).
--
-- The freshness sweep (P-003) treated regen_enqueued_at / reverify_flagged_at as a fire-ONCE
-- latch: once set, no later sweep re-dispatched the doc-steward for that doc. So a steward that
-- DIED transiently — its first model call 429'd during an account-wide rate-limit storm, the
-- spawn recorded `done` with no harness_docs:verify call — left the doc flagged forever and never
-- retried (4 docs observed permanently stuck 2026-06-23). The latch is now a RETRY CLOCK
-- (timestamp) + a GIVE-UP cap (these counters); see freshness-sweep.ts dispatchDue/stewardBackoffMs.
--
-- Per-episode counters: bumped on each dispatch (markRegenEnqueued / markReverifyFlagged), reset to
-- 0 when the doc returns to `fresh` (setDocStatus / verifyDoc) so a future drift re-dispatches
-- cleanly. NULL-safe default 0 = byte-identical to legacy rows. Additive + idempotent.
ALTER TABLE harness_shared.harness_docs
  ADD COLUMN IF NOT EXISTS regen_attempts    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reverify_attempts integer NOT NULL DEFAULT 0;
