-- 630-reslug-workspace-bugs-to-papercusp.sql
--
-- Owner-directed 2026-07-19 [owner:Avi]: re-associate mis-filed workspace-scoped
-- BUG rows to harness_slug='papercusp' so the papercusp fleet can drain them.
--
-- WHY THIS EXISTS
-- Operator/watchdog sessions filed bugs under an INVENTED harness_slug equal to
-- their operator scope string ('operator:papercusp-workspace') or the raw
-- workspace id ('papercusp-workspace') instead of the real pot 'papercusp'.
-- No session ever runs under those slugs, and scheduler:get_next hard-floors
-- every claim to `harness_slug = <caller's harness>` (work-items.ts
-- claimFloorsWhereSql) -- so ~4,853 bugs (309 of the 392 open ones immediately
-- claimable) sat STRUCTURALLY UNCLAIMABLE, which is why the bug curve flattened
-- after the 07-17 drain. The owner ruled this work belongs to papercusp and
-- chose Option B ("retype harness_slug") on the P-009 decision
-- (conv-mrrhcweq-0000-be3fb1a5c7564202a0ac4fc6d40d0b86). This migration is the
-- first, highest-value slice of that retype: the bug rows.
--
-- SAFETY / SHAPE
-- * Only harness_slug changes. feature_id (the EI-/WI- id) is PRESERVED, so
--   every dependent reference keyed by id (work_item_deps.blocked_ref/blocker_ref,
--   coord threads/posts by id) stays intact. workspace_id is already
--   'papercusp-workspace' on all three slugs (matches existing papercusp rows),
--   so it is left untouched.
-- * The satellite tables that DO key on harness_slug (work_item_claims,
--   work_item_blocked, work_item_replicas) were verified to hold ZERO rows for
--   these source slugs at authoring time, so nothing there needs re-slugging.
-- * 12 rows collide on the (harness_slug, feature_id) PRIMARY KEY with existing
--   'papercusp' rows. All 12 are SYNTHETIC auto-issues ([replication-liveness]
--   / hive-coordination-health scorecard duplicates), mostly already resolved on
--   the source side and already present under papercusp. They are dropped (the
--   correctly-slugged papercusp row is kept). All affected rows -- moved and
--   dropped -- are captured in the backup table below first, for reversibility.
-- * Idempotent: after the first run no source-slug bug rows remain, so the
--   backup INSERT, the DELETE, and the UPDATE all match 0 rows on re-run. On a
--   fresh embedded-pg ship build (no such rows) the whole file is a no-op.

-- 1. Backup every affected bug row (moved + dropped) for reversibility.
CREATE TABLE IF NOT EXISTS harness_shared.bak_20260719_reslug_workspace_bugs (
    feature_id        text        NOT NULL,
    old_harness_slug  text        NOT NULL,
    status            text,
    moved_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO harness_shared.bak_20260719_reslug_workspace_bugs (feature_id, old_harness_slug, status)
SELECT feature_id, harness_slug, status
FROM harness_shared.work_items
WHERE item_kind = 'bug'
  AND harness_slug IN ('operator:papercusp-workspace', 'papercusp-workspace');

-- 2. Drop the synthetic duplicate rows that would violate the (harness_slug,
--    feature_id) primary key on re-slug. The correctly-slugged 'papercusp' row
--    for each of these feature_ids already exists and is kept.
DELETE FROM harness_shared.work_items o
WHERE o.item_kind = 'bug'
  AND o.harness_slug IN ('operator:papercusp-workspace', 'papercusp-workspace')
  AND EXISTS (
      SELECT 1 FROM harness_shared.work_items p
      WHERE p.harness_slug = 'papercusp'
        AND p.feature_id   = o.feature_id
  );

-- 3. Re-slug the remaining (non-colliding) bug rows to papercusp.
UPDATE harness_shared.work_items
SET harness_slug = 'papercusp'
WHERE item_kind = 'bug'
  AND harness_slug IN ('operator:papercusp-workspace', 'papercusp-workspace');
