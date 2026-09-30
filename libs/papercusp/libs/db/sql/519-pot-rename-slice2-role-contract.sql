-- Migration 519 — pot-rename SLICE-2 role-id CONTRACT (backfill old→new + tighten guards).
--
-- ⚠ SEQUENCING: this file may land in libs/papercusp/libs/db/sql/ ONLY in the same
-- commit-wave as the write-switch code (writers stamp cup|mug|kettle|blender) and must be
-- force-deployed immediately — any operator boot (:3170 auto-restart, Tauri dev shell)
-- boot-applies pending migrations against the SHARED DB, and the CHECK tighten below
-- would reject the old ids the still-deployed :3070 writes until then.
--
-- Backfills every column that live introspection (2026-07-05) showed holding OLD role ids:
--   spawned_agents.child_role  bee×2323, queen×2188   spawned_agents.parent_role  queen×1750
--   work_items.rank_writer     queen×222              harness_features.rank_writer queen×139
--   agent_usage_samples.role   queen×2437 bee×852 overwatch×673 scout×50
--   autoloop_state.role        overwatch×4            agent_facts.scope_ref        'queen'×39
--   learning_governor_loops.loop_id  scout:*×3        learning_spend_events.loop_id scout:*×271
-- ('red-queen' loop_id is a KEEP name — the LIKE 'scout:%' guard cannot match it.)
-- fleet_assignment.rank_writer held no old values but is guarded-updated for writes that
-- land between introspection and apply. All updates are guarded → idempotent re-run = no-op.
--
-- Then the two write-guards widen→NARROW: hfc_rank_writer_chk and reorder_work_item()
-- contract from bee|queen|cup|mug (mig 506) to cup|mug only; reorder's default flips to 'cup'.
-- Composes onto 506 (expand) + 178 (reorder origin). Runs as harness_admin.

\set ON_ERROR_STOP on

-- ── 1) role-id VALUE backfill (old → new; D-007 map) ─────────────────────────────────
UPDATE harness_shared.spawned_agents SET child_role = CASE child_role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE child_role IN ('bee','queen','sentinel','overwatch','scout');
UPDATE harness_shared.spawned_agents SET parent_role = CASE parent_role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE parent_role IN ('bee','queen','sentinel','overwatch','scout');

-- rank_writer lives ONCE on the unified work_items BASE table (mig 374/506);
-- harness_features + fleet_assignment are views over it (fleet_assignment is a
-- UNION view — not updatable), so the base UPDATE below covers every row.
UPDATE harness_shared.work_items SET rank_writer = CASE rank_writer
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' END
  WHERE rank_writer IN ('bee','queen');

UPDATE harness_shared.agent_usage_samples SET role = CASE role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE role IN ('bee','queen','sentinel','overwatch','scout');

-- autoloop_state PK is (workspace_id, harness_slug, role) and the deployed code
-- ALREADY writes the new ids (OVERWATCH_ROLE='kettle' since a974896b20) — so a renamed
-- twin may exist. Drop the stale old-id row where its twin exists, then rename the rest.
DELETE FROM harness_shared.autoloop_state o
 WHERE o.role IN ('bee','queen','sentinel','overwatch','scout')
   AND EXISTS (
     SELECT 1 FROM harness_shared.autoloop_state n
      WHERE n.workspace_id = o.workspace_id AND n.harness_slug = o.harness_slug
        AND n.role = CASE o.role
              WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
              WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END);
UPDATE harness_shared.autoloop_state SET role = CASE role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE role IN ('bee','queen','sentinel','overwatch','scout');

-- agent_facts.scope_ref: EXACT-value role scopes only (live data: 'queen'×39).
UPDATE harness_shared.agent_facts SET scope_ref = CASE scope_ref
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE scope_ref IN ('bee','queen','sentinel','overwatch','scout');

-- learning loop ids: 'scout:<suffix>' → 'blender:<suffix>'. No FK between the two tables
-- (verified pg_constraint 2026-07-05). 'red-queen' cannot match the prefix guard.
-- learning_governor_loops PK is (workspace_id, loop_id) and provisioning already
-- registers 'blender:*' ids — drop a stale 'scout:*' row where its twin exists first.
DELETE FROM harness_shared.learning_governor_loops o
 WHERE o.loop_id LIKE 'scout:%'
   AND EXISTS (
     SELECT 1 FROM harness_shared.learning_governor_loops n
      WHERE n.workspace_id = o.workspace_id
        AND n.loop_id = 'blender:' || substr(o.loop_id, length('scout:') + 1));
UPDATE harness_shared.learning_governor_loops
   SET loop_id = 'blender:' || substr(loop_id, length('scout:') + 1)
 WHERE loop_id LIKE 'scout:%';
UPDATE harness_shared.learning_spend_events
   SET loop_id = 'blender:' || substr(loop_id, length('scout:') + 1)
 WHERE loop_id LIKE 'scout:%';


-- ── 1b) owner-steering config-key migration (WI-2932 runbook §S2-cleanups) ──────────
-- hive_settings.value is TEXT holding a JSON object keyed by role id for these two
-- settings. Rename old→new keys in place; guarded to rows still carrying an old key,
-- so a re-run is a no-op. (Code reads flipped in the same wave: modelOverrides.kettle /
-- .papercup, roleTierCeiling without the legacy fallback.)
UPDATE harness_shared.hive_settings hs
   SET value = (
     SELECT jsonb_object_agg(
              CASE e.k
                WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
                WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' ELSE e.k END,
              e.v)::text
       FROM jsonb_each(hs.value::jsonb) AS e(k, v)
   )
 WHERE hs.setting_key IN ('owner-steering:tier-ceilings', 'owner-steering:model-overrides')
   AND hs.value ~ '^\s*{'
   AND hs.value::jsonb ?| ARRAY['bee','queen','sentinel','overwatch','scout'];

-- ── 2) rank_writer CHECK: contract to cup|mug ────────────────────────────────────────
-- (lives ONCE on the unified work_items base table; both views read through it — mig 506 note)
ALTER TABLE harness_shared.work_items
  DROP CONSTRAINT IF EXISTS hfc_rank_writer_chk;
ALTER TABLE harness_shared.work_items
  ADD CONSTRAINT hfc_rank_writer_chk
  CHECK (rank_writer IS NULL OR rank_writer IN ('cup', 'mug')) NOT VALID;
ALTER TABLE harness_shared.work_items
  VALIDATE CONSTRAINT hfc_rank_writer_chk;

-- ── 3) reorder_work_item(): guard + default contract to cup|mug ──────────────────────
-- SAME body as migration 506, changing ONLY the p_writer default, guard, and message.
CREATE OR REPLACE FUNCTION harness_shared.reorder_work_item(
  p_workspace text,
  p_assignee  text,
  p_item_id   text,
  p_target    integer,
  p_writer    text DEFAULT 'cup'
) RETURNS integer
LANGUAGE plpgsql
AS $reorder$
DECLARE
  v_old_rank integer;
  v_count    integer;
  v_new_rank integer;
  v_now      timestamptz := now();
BEGIN
  IF p_writer IS NULL OR p_writer NOT IN ('cup', 'mug') THEN
    RAISE EXCEPTION 'reorder_work_item: writer must be cup|mug (got %)', p_writer;
  END IF;

  -- The current rank of the moving item (NULL if it was unranked / newly appended).
  SELECT assignee_rank INTO v_old_rank
    FROM harness_shared.work_items
   WHERE workspace_id = p_workspace AND taken_by = p_assignee AND feature_id = p_item_id;

  -- Queue length EXCLUDING the moving item — the target clamps to [0, len].
  SELECT count(*) INTO v_count
    FROM harness_shared.work_items
   WHERE workspace_id = p_workspace AND taken_by = p_assignee
     AND feature_id <> p_item_id;

  v_new_rank := GREATEST(0, LEAST(p_target, v_count));

  -- Pull the moving item out (so the renumber below sees a contiguous peer set), then
  -- compact the survivors into a dense 0..n-1 ordering by their current rank
  -- (NULLs last, then created order), then re-open a gap at v_new_rank and slot it in.
  UPDATE harness_shared.work_items
     SET assignee_rank = NULL, rank_writer = p_writer, rank_updated_at = v_now
   WHERE workspace_id = p_workspace AND taken_by = p_assignee AND feature_id = p_item_id;

  WITH ordered AS (
    SELECT feature_id,
           row_number() OVER (
             ORDER BY assignee_rank ASC NULLS LAST, rank_updated_at ASC NULLS LAST, created_ts ASC
           ) - 1 AS seq
      FROM harness_shared.work_items
     WHERE workspace_id = p_workspace AND taken_by = p_assignee
       AND feature_id <> p_item_id
  ), shifted AS (
    SELECT feature_id,
           CASE WHEN seq < v_new_rank THEN seq ELSE seq + 1 END AS new_rank
      FROM ordered
  )
  UPDATE harness_shared.work_items w
     SET assignee_rank = s.new_rank, rank_updated_at = v_now
    FROM shifted s
   WHERE w.workspace_id = p_workspace AND w.taken_by = p_assignee
     AND w.feature_id = s.feature_id
     AND w.assignee_rank IS DISTINCT FROM s.new_rank;

  -- Slot the moving item into the freed hole.
  UPDATE harness_shared.work_items
     SET assignee_rank = v_new_rank, rank_writer = p_writer, rank_updated_at = v_now
   WHERE workspace_id = p_workspace AND taken_by = p_assignee AND feature_id = p_item_id;

  RETURN v_new_rank;
END;
$reorder$;

GRANT EXECUTE ON FUNCTION harness_shared.reorder_work_item(text, text, text, integer, text) TO harness_app;
