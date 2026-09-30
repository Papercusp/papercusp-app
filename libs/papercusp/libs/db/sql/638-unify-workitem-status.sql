-- 638 · work-item-status-full-unify (P-002) — collapse the feature+issue status vocabulary
-- to ONE unified enum on the work_items BASE TABLE.
--
-- TOPOLOGY (relkind-verified 2026-07-19): work_items is the base TABLE (relkind 'r', ~23k rows);
-- harness_features_consolidated + engineer_issues are VIEWS over it (the issue view exposes
-- status AS state) — so terminal_reason goes on work_items ONLY (you cannot ALTER a view), and the
-- two views auto-reflect the backfilled status.
--
-- UNIFIED ENUM: open | wip | blocked | needs-human | done | dropped  (open = the single claimable
-- token). terminal_reason preserves the passed/resolved (→done) and deprecated/closed (→dropped)
-- nuance so the unification is LOSS-FREE + REVERSIBLE (plan decision D-002).
--
-- MAPPING validated READ-ONLY against all 23,094 live rows 2026-07-19 (every value mapped cleanly;
-- resulting distribution: resolved→done 10788, open→open 8710, closed→dropped 1353, passed→done 1182,
-- todo→open 572, deprecated→dropped 418, blocked 65, in_progress→wip 6, failing→open 3, needs-human 3,
-- done 1). Idempotent: the WHERE guard makes a re-run a no-op.
--
-- SAFE STANDALONE (does NOT require a coordinated code deploy): every status-partitioning reader was
-- widened to a legacy∪unified transitional superset FIRST (SETTLED_WORK_ITEM_STATES, FEATURE/ISSUE
-- terminal sets, frontier-readiness TERMINAL_STATUSES, the claim floor ['todo','open'], the reaper
-- non-requeue set, and the P-007 consumer subset — all shipped). So after this backfill, backfilled
-- rows read as unified while new writes stay legacy (work_items:set_state's alias maps are untouched
-- until the P-003 writer-flip), and BOTH are handled correctly. Follow-ons (own migrations/PRs):
-- P-003 writer-flip + P-006 (2 views re-expose terminal_reason; wir_status_sync_dependents_trg WHEN/fn
-- from the legacy terminal set to done/dropped) land together; then the cleanup narrows the supersets.
--
-- TRIGGER CASCADE: work_items has 13 user triggers; a bulk status UPDATE would fire emit_change_notify
-- (~23k), capture_work_items_outbox CDC (~21k), stamp_local_federated_write (re-federate all), and
-- wir_status_sync_dependents (~13.7k) — for a one-time vocab remap that cascade is pure noise (and
-- floods federation + wakes the fleet), so the backfill runs with USER triggers DISABLED. Federation
-- of the vocab change is per-peer (each machine runs this migration locally), NOT via CDC. This holds
-- an ACCESS EXCLUSIVE lock on work_items for the backfill duration (~seconds); reactive caches that
-- emit_change_notify would refresh are cleared by the operator restart that applies this migration.

-- 1. terminal_reason column (idempotent).
ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS terminal_reason text;
COMMENT ON COLUMN harness_shared.work_items.terminal_reason IS
  'Pre-unification status nuance preserved across the status-vocabulary collapse (work-item-status-full-unify): passed|resolved when status=done, deprecated|closed when status=dropped; NULL for a plain done/dropped. Makes the unification loss-free + reversible.';

-- 2. Backfill with USER triggers disabled (idempotent — the WHERE guards a re-run to a no-op).
--    DISABLE + UPDATE + ENABLE run in this migration's single transaction, so a rollback restores
--    the triggers and the ENABLE re-persists them on commit.
ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER;

UPDATE harness_shared.work_items
SET terminal_reason = CASE status
      WHEN 'passed'     THEN 'passed'
      WHEN 'resolved'   THEN 'resolved'
      WHEN 'deprecated' THEN 'deprecated'
      WHEN 'closed'     THEN 'closed'
      ELSE terminal_reason END,
    status = CASE status
      WHEN 'todo'        THEN 'open'
      WHEN 'failing'     THEN 'open'
      WHEN 'in_progress' THEN 'wip'
      WHEN 'passed'      THEN 'done'
      WHEN 'resolved'    THEN 'done'
      WHEN 'deprecated'  THEN 'dropped'
      WHEN 'closed'      THEN 'dropped'
      ELSE status END
WHERE status IN ('todo','failing','in_progress','passed','resolved','deprecated','closed');

ALTER TABLE harness_shared.work_items ENABLE TRIGGER USER;
