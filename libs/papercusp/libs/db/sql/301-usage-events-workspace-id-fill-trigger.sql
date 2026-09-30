-- 301-usage-events-workspace-id-fill-trigger.sql
--
-- WI-192: contributor_usage_events does not actually federate.
--
-- BUG (confirmed, test-documented in the G2 federation-edge-cases test): the
-- table `harness_shared.contributor_usage_events` is declared sync:'peer-log'
-- with a capture trigger (mig 108: capture_substrate_outbox_trg, key 'event_id')
-- + a read-side projection (projections/usage.ts) + an op-mapper
-- (feature-issue-op-keys.toUsageValue). The send path is otherwise complete —
-- BUT the table has NO `workspace_id` column. The shared capture function
-- `capture_substrate_outbox()` stamps the outbox row's workspace_id from
-- `COALESCE(row->>'workspace_id', '')` → '' for every usage event. The Stage-3
-- drain (`drainOutboxOnce`) filters on the booted handle's REAL workspaceId, so
-- it never matches these '' rows → usage ops are silently dropped and never
-- federate.
--
-- This is the EXACT class migration 103 fixed for harness_issues_consolidated
-- (issue outbox rows were also stamped workspace_id='' for want of a fill
-- trigger). The fix there: a BEFORE-INSERT trigger running
-- `harness_shared.fill_workspace_id_from_projects()` that resolves workspace_id
-- from `harness_shared.projects` by slug (fallback 'default'), so the
-- AFTER-INSERT capture trigger sees a real workspace_id and enqueues it.
--
-- FIX (mirrors migration 103, adapted for this table):
--   1. ADD a `workspace_id` column to contributor_usage_events
--      (NOT NULL DEFAULT '' — same shape as features/issues; transparent to the
--      append-only projection + op-mapper, which never read or write it — it is
--      purely an outbox routing column).
--   2. ATTACH `fill_ws_usage_trg` BEFORE INSERT, reusing the SAME shared
--      `fill_workspace_id_from_projects()` function (it references NEW.workspace_id
--      + NEW.harness_slug — both now present). BEFORE-INSERT fires before the row
--      is stored, so the AFTER-INSERT capture trigger (mig 108) sees the filled
--      workspace_id and enqueues the real value → the standard drain matches it
--      → usage events federate.
--   3. BACKFILL the existing workspace_id='' usage rows from projects (so any
--      already-captured-but-stranded events get a non-empty routing key too).
--
-- Named dollar-quote ($body$, NOT $$) per the repo PG-migration convention.
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP TRIGGER IF EXISTS + CREATE.
-- No \set / BEGIN / COMMIT: the embedded-pg migration runner strips psql
-- metacommands and wraps each file in its own txn.

-- ── 1. the workspace_id column (mirrors features/issues' shape) ───────────────
ALTER TABLE harness_shared.contributor_usage_events
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';

-- ── 2. the BEFORE-INSERT fill trigger (the actual fix; reuses the shared fn) ──
-- fill_workspace_id_from_projects() is defined in 000-baseline (and re-asserted
-- in mig 103). It resolves NEW.workspace_id from harness_shared.projects by slug,
-- falling back to 'default' — so the AFTER-INSERT capture trigger enqueues a real
-- workspace_id and the real-workspace drain matches it.
DROP TRIGGER IF EXISTS fill_ws_usage_trg
  ON harness_shared.contributor_usage_events;
CREATE TRIGGER fill_ws_usage_trg
  BEFORE INSERT ON harness_shared.contributor_usage_events
  FOR EACH ROW EXECUTE FUNCTION harness_shared.fill_workspace_id_from_projects();

-- ── 3. backfill existing empty-workspace_id usage rows ────────────────────────
UPDATE harness_shared.contributor_usage_events AS u
   SET workspace_id = COALESCE(NULLIF(p.workspace_id, ''), 'default')
  FROM harness_shared.projects AS p
 WHERE p.slug = u.harness_slug
   AND (u.workspace_id IS NULL OR u.workspace_id = '');

-- Any usage event whose harness has no projects row still gets 'default'
-- (mirrors the function's fallback) so the drain has a non-empty key to match on.
UPDATE harness_shared.contributor_usage_events
   SET workspace_id = 'default'
 WHERE workspace_id IS NULL OR workspace_id = '';
