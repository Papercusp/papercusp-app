-- 631-reslug-operator-workspace-changetask-to-papercusp.sql
--
-- Owner-directed 2026-07-19 [owner:Avi, "retype harness_slug" — P-009 Option B]:
-- second slice of the harness_slug retype. Migration 630 moved the BUG rows off
-- the invented slug 'operator:papercusp-workspace'; this moves the remaining
-- issue-family rows (change/task) to the real pot 'papercusp', fully emptying
-- that slug.
--
-- WHY / SAFETY (verified in PG at authoring, 2026-07-19)
-- * 'operator:papercusp-workspace' holds ONLY issue-family rows (bug already
--   moved; 5,450 change/task; ZERO feature-family / other kinds) — so there is
--   no feature_* satellite fan-out to update, and no risk to the feature views.
-- * (harness_slug, feature_id) PK collisions with existing 'papercusp' rows
--   CAN exist for these kinds and MUST be deduped before the re-slug (same as
--   630's bug rows). The dev DB at authoring (2026-07-19 10:17) happened to have
--   ZERO change/task collisions, so the original file did a straight UPDATE — but
--   that assumption is SEED-DEPENDENT: a shipped embedded-pg seed cut from (or
--   reused across) a different point in time DOES contain colliding rows, and the
--   collision-free UPDATE then crashes the operator on first boot with `duplicate
--   key value violates unique constraint "work_items_pkey"` (mac 0.0.12 desktop
--   cut, 2026-07-19, WI-5522). So this migration now DEDUPS first — a straight
--   UPDATE is never safe here. The correctly-slugged 'papercusp' row wins.
-- * The harness_slug-keyed satellites (work_item_claims / work_item_blocked /
--   work_item_replicas) hold ZERO rows for this slug.
-- * Only harness_slug changes; feature_id (EI-/WI- ids) preserved → deps and
--   threads keyed by id stay intact. workspace_id is already 'papercusp-workspace'
--   (matches papercusp rows) and is left untouched.
-- * Idempotent: after the first run no such rows remain (backup INSERT + UPDATE
--   match 0 on re-run); a no-op on a fresh embedded-pg build.

-- 1. Backup for reversibility.
CREATE TABLE IF NOT EXISTS harness_shared.bak_20260719_reslug_operator_changetask (
    feature_id        text        NOT NULL,
    old_harness_slug  text        NOT NULL,
    item_kind         text,
    status            text,
    moved_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO harness_shared.bak_20260719_reslug_operator_changetask (feature_id, old_harness_slug, item_kind, status)
SELECT feature_id, harness_slug, item_kind, status
FROM harness_shared.work_items
WHERE harness_slug = 'operator:papercusp-workspace'
  AND item_kind IN ('change', 'task');

-- 2. Drop the source rows that would collide on the (harness_slug, feature_id)
--    primary key once re-slugged. The correctly-slugged 'papercusp' row for each
--    of these feature_ids already exists and is kept. (Mirrors 630's step 2. On a
--    dev DB / seed with no such collisions this DELETE matches 0 rows — a no-op.)
--    All affected rows (moved AND dropped) were already captured by the backup
--    INSERT in step 1, so this is reversible.
DELETE FROM harness_shared.work_items o
WHERE o.harness_slug = 'operator:papercusp-workspace'
  AND o.item_kind IN ('change', 'task')
  AND EXISTS (
      SELECT 1 FROM harness_shared.work_items p
      WHERE p.harness_slug = 'papercusp'
        AND p.feature_id   = o.feature_id
  );

-- 3. Re-slug the remaining (non-colliding) rows to papercusp.
UPDATE harness_shared.work_items
SET harness_slug = 'papercusp'
WHERE harness_slug = 'operator:papercusp-workspace'
  AND item_kind IN ('change', 'task');
