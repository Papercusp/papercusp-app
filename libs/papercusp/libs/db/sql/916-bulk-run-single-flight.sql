-- 916-bulk-run-single-flight.sql
--
-- WI-41012 — an inbox BULK RESOLVE run must be single-flight per workspace.
--
-- (Numbered 916, not 915: 915 was allocated to this migration by
-- scripts/next-migration.mjs, but 915-federation-probes-captured-only.sql was
-- written onto the same number four minutes later without going through the
-- allocator. Two files sharing a number is ambiguous to the runner, so this one
-- moved rather than leaving the collision in the tree.)
--
-- op:'start' launches a REAL headless resolver agent holding terminal authority
-- over the owner's attention items (plan inbox-bulk-resolve-2026-08-23, D-001).
-- Until now nothing serialised it: the start route called createRun() with no
-- active-run check, so two starts — a double-click is enough — created two runs
-- and launched two resolvers over overlapping items, each able to resolve the
-- same item and wake its asker twice, for one owner intention.
--
-- The handler now refuses a second start (run_already_active), but a
-- check-then-insert has a race window exactly as wide as its own round trip,
-- which is precisely where a double-click lands. This index is the rail that
-- makes the property true rather than likely: two concurrent inserts cannot
-- both win, and the loser surfaces as a unique violation the store maps back to
-- the same typed refusal.
--
-- Scope note: 'review' is deliberately NOT included. A run in review is waiting
-- on the OWNER, not acting — blocking a new run while an old review list sits
-- unattended would strand the feature behind a dialog the owner may never
-- return to. Only pending/running (an agent is, or is about to be, acting) is
-- exclusive. RUNNING_PHASES in bulk-run-store.ts is the same set; keep them in
-- step.
--
-- FORWARD-COMPAT: the currently-deployed release cannot hit this index. The
-- table is empty in every environment (0 rows at write time), the feature that
-- writes it is gated behind FLAGS.INBOX_BULK_RESOLVE on both the client and the
-- server route, and the only INSERT site is createRun(), which the live release
-- reaches solely through that gated start route. The worst case for older code
-- is that a genuinely concurrent second start fails loudly with a unique
-- violation instead of silently launching a second resolver — which is the
-- defect this migration exists to remove, not a regression it introduces.

CREATE UNIQUE INDEX IF NOT EXISTS attention_bulk_runs_one_active_per_workspace
    ON harness_shared.attention_bulk_runs (workspace_id)
 WHERE phase IN ('pending', 'running');

COMMENT ON INDEX harness_shared.attention_bulk_runs_one_active_per_workspace IS
  'WI-41012: at most one pending/running bulk-resolve run per workspace. A run in review is excluded - it awaits the owner rather than an agent, so it must not block a new run.';
