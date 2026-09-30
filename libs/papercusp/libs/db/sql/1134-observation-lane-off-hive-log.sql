-- 1134-observation-lane-off-hive-log.sql
--
-- P-043 of plan shared-pot-dao-cupboard-v1-2026-09-04 (decisions D-057 / D-059,
-- bug WI-2147374): stop federating `lane = 'observation'` work_items onto the
-- append-only hive peer log.
--
-- WHY
-- ---
-- An observation is one agent's TURN-END REFLECTION about its own session. It is
-- never claimable, never triaged, carries no assignee and no plan link, and every
-- read tool already excludes it by default (`includeObservations:false`). Nothing
-- on another machine reads one. It is a D-059 tier-1 fact — local Postgres is the
-- whole story — yet the work_items capture trigger has been putting every insert
-- and every edit of one onto a log with no eviction code, replicated to every
-- member of the hive, forever.
--
-- MEASURED (2026-09-06, harness_shared.substrate_outbox, 24h window,
-- workspace_id='papercusp-workspace', harness_slug='papercusp'):
--   observation lane   6,065 appends over 3,340 keys   11 MB/day
--   all other lanes   19,600 appends over 3,239 keys   56 MB/day
-- so this removes ~24% of the engineer_issues federation stream and ~4% of the
-- 257 MB/day this peer appends in total. It is deliberately the SMALL half of
-- P-043: the same measurement showed the dominant cost is whole-row re-append of
-- large edited rows (harness_plans 11.94 appends/key at 75 KB, features 32.13/key),
-- which needs epoch rotation, not an exclusion. This is the part that is safe to
-- do by exclusion, because these rows genuinely have no cross-machine reader.
--
-- WHY THE TRIGGER AND NOT THE DRAIN
-- ---------------------------------
-- The engineer_issues WIRE ROW carries no `lane` column (34 fields, checked
-- 2026-09-06), so the outbox drain physically cannot make this decision — it
-- would have to re-read PG per row. The trigger sees the whole NEW row, and
-- filtering here also keeps the rows out of substrate_outbox entirely rather
-- than enqueueing them to be dropped later.
--
-- SHAPE
-- -----
-- The trigger FUNCTION (capture_work_items_outbox, latest def mig 559 + mig 965's
-- columns) is left completely untouched — only the WHEN clauses change, so this
-- cannot regress any other federation path.
--
--   * capture_work_items_outbox_ins_del_trg is SPLIT. A WHEN clause on a combined
--     `AFTER INSERT OR DELETE` trigger cannot reference NEW (it does not exist on
--     DELETE), so INSERT gets its own filtered trigger and DELETE gets its own
--     UNFILTERED one. Keeping DELETE unfiltered is deliberate: observation rows
--     federated before this migration already exist on peers, and a tombstone for
--     one is a cleanup, not a cost (deletes here are rare).
--   * the two UPDATE triggers gain `AND new.lane IS DISTINCT FROM 'observation'`
--     on top of their existing conditions, which are reproduced verbatim from
--     pg_get_triggerdef() as they stood at mig 1133.
--
-- `IS DISTINCT FROM` (not `<>`) so a NULL lane — every non-observation row — still
-- federates; `NULL <> 'observation'` would be NULL and silently drop everything.
--
-- REVERSIBLE: re-creating the three original triggers restores the old behaviour
-- exactly; no data is touched and no column is dropped.
-- The runner provides the transaction -- NO BEGIN/COMMIT here (lint:migrations).

-- ── INSERT / DELETE: split so the INSERT half can filter on NEW ──────────────
DROP TRIGGER IF EXISTS capture_work_items_outbox_ins_del_trg ON harness_shared.work_items;
DROP TRIGGER IF EXISTS capture_work_items_outbox_ins_trg ON harness_shared.work_items;
DROP TRIGGER IF EXISTS capture_work_items_outbox_del_trg ON harness_shared.work_items;

CREATE TRIGGER capture_work_items_outbox_ins_trg
  AFTER INSERT ON harness_shared.work_items
  FOR EACH ROW
  WHEN (new.lane IS DISTINCT FROM 'observation')
  EXECUTE FUNCTION harness_shared.capture_work_items_outbox();

CREATE TRIGGER capture_work_items_outbox_del_trg
  AFTER DELETE ON harness_shared.work_items
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.capture_work_items_outbox();

-- ── UPDATE (feature family) ─────────────────────────────────────────────────
DROP TRIGGER IF EXISTS capture_work_items_feature_upd_trg ON harness_shared.work_items;
CREATE TRIGGER capture_work_items_feature_upd_trg
  AFTER UPDATE ON harness_shared.work_items
  FOR EACH ROW
  WHEN (
    new.item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text])
    AND old.* IS DISTINCT FROM new.*
    AND new.lane IS DISTINCT FROM 'observation'
  )
  EXECUTE FUNCTION harness_shared.capture_work_items_outbox();

-- ── UPDATE (issue family) ───────────────────────────────────────────────────
DROP TRIGGER IF EXISTS capture_work_items_issue_upd_trg ON harness_shared.work_items;
CREATE TRIGGER capture_work_items_issue_upd_trg
  AFTER UPDATE ON harness_shared.work_items
  FOR EACH ROW
  WHEN (
    new.item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])
    AND (
      old.title IS DISTINCT FROM new.title
      OR old.summary IS DISTINCT FROM new.summary
      OR old.status IS DISTINCT FROM new.status
      OR old.taken_by IS DISTINCT FROM new.taken_by
      OR old.taken_at IS DISTINCT FROM new.taken_at
      OR old.item_kind IS DISTINCT FROM new.item_kind
      OR old.harness_slug IS DISTINCT FROM new.harness_slug
      OR old.payload IS DISTINCT FROM new.payload
      OR old.fed_ts IS DISTINCT FROM new.fed_ts
      OR old.fed_hlc IS DISTINCT FROM new.fed_hlc
    )
    AND new.lane IS DISTINCT FROM 'observation'
  )
  EXECUTE FUNCTION harness_shared.capture_work_items_outbox();
