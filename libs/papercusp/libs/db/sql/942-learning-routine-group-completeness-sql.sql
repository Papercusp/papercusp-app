-- 942 — complete the self-improvement routine group (EI-21354437941269674).
--
-- Migration 617 grouped the original improvement names, but newer seed rows were
-- added later without group_slug. The Learning tab's loop-control snapshot and
-- routines:group-set both use `self-improvement` as their authoritative membership
-- set, so an ungrouped/health-grouped learning routine was visible as active while
-- Pause all could not control it.
--
-- Idempotent: create the group if needed and repair only the known improvement
-- pipeline names. It never changes active state or pause metadata.

INSERT INTO harness_shared.routine_groups (workspace_id, slug, description, review_cadence)
SELECT DISTINCT r.workspace_id,
       'self-improvement',
       'Gym/scout/blueprint learning loops + the improvement pipeline.',
       '90d'
  FROM harness_shared.routines r
 WHERE r.name LIKE 'improvement-%'
    OR r.name LIKE 'bp-singleton-%'
    OR r.name LIKE 'scout-%'
    OR r.name LIKE '%prospector-cadence'
    OR r.name IN ('gym-cycle', 'template-gym', 'pot-eval-battery', 'scan')
    OR r.name IN ('knowledge-pack-delivery', 'knowledge-pack-hygiene')
ON CONFLICT (workspace_id, slug) DO NOTHING;

UPDATE harness_shared.routines AS r
   SET group_slug = 'self-improvement',
       updated_at = now()
 WHERE r.group_slug IS DISTINCT FROM 'self-improvement'
   AND (
     r.name LIKE 'improvement-%'
     OR r.name LIKE 'bp-singleton-%'
     OR r.name LIKE 'scout-%'
     OR r.name LIKE '%prospector-cadence'
     OR r.name IN ('gym-cycle', 'template-gym', 'pot-eval-battery', 'scan')
     OR r.name IN ('knowledge-pack-delivery', 'knowledge-pack-hygiene')
   )
   AND EXISTS (
     SELECT 1
       FROM harness_shared.routine_groups AS g
      WHERE g.workspace_id = r.workspace_id
        AND g.slug = 'self-improvement'
   );
