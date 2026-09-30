-- 1072-plan-assignment-claim-floor.sql — EI-22040912157347872
-- Reserved via db:next-migration before arming.
--
-- Extend the existing reserved-plan-lane floor with the durable ASSIGNMENT axis.
-- A plan_item_claims lease is only the live grip; plan_item_assignments is the
-- durable ownership intent that deliberately survives interruption. Before this
-- migration, a route-owning plan session between claim leases left its linked
-- work-item visible to generic self-select. WI-1801547 reproduced the resulting
-- claim -> inspect D-006 -> release -> immediately re-serve loop twice.
-- FORWARD-COMPAT: the versioned function rename is transactional and immediately
-- recreates the stable public function signature and view used by old readers.
--
-- This wrapper keeps the public signature stable, preserves every prior floor,
-- removes only the old combined reserved-plan-lane label, and rebuilds that label
-- from the current TypeScript predicate's plan lifecycle + live-lease semantics
-- plus an active (released_ts IS NULL) durable assignment. The generic SQL view
-- has no claimant identity, so every active assignment is correctly reserved;
-- the TypeScript claim path carries the caller-relative assignee exemption.

-- FORWARD-COMPAT + rerun safety: deployed code calls the stable public signature.
-- Migration 1070 snapshots the prior implementation as v19. Snapshot its stable
-- public wrapper as v20 once, then recreate the public name without dropping the
-- dependent work_items_claimable view.
DO $function_guard1072$
BEGIN
  IF to_regprocedure(
       'harness_shared.work_item_claim_floors_v20(text,text,text,text,text,text,text,jsonb,text)'
     ) IS NULL THEN
    IF to_regprocedure(
         'harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text)'
       ) IS NULL THEN
      RAISE EXCEPTION '1072: public work_item_claim_floors function is missing';
    END IF;
    ALTER FUNCTION harness_shared.work_item_claim_floors(
      text, text, text, text, text, text, text, jsonb, text
    ) RENAME TO work_item_claim_floors_v20;
  END IF;
END
$function_guard1072$;

CREATE OR REPLACE FUNCTION harness_shared.work_item_claim_floors(
  p_workspace_id            text,
  p_status                  text,
  p_taken_by                text,
  p_origin                  text,
  p_title                   text,
  p_terminal_owner          text,
  p_terminal_completion_ref text,
  p_payload                 jsonb,
  p_feature_id              text
) RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT array_remove(
    array_append(
      -- The prior public function may include migration 920's draft experiment in
      -- focused tests. Remove the label and rebuild it once from the SHIPPED TS
      -- predicate: ordinary draft remains free; paused/active remains reserved.
      array_remove(
        harness_shared.work_item_claim_floors_v20(
          p_workspace_id,
          p_status,
          p_taken_by,
          p_origin,
          p_title,
          p_terminal_owner,
          p_terminal_completion_ref,
          p_payload,
          p_feature_id
        ),
        'reserved-plan-lane'::text
      ),
      CASE WHEN COALESCE(p_payload, '{}'::jsonb) ? 'plan_item' AND (
             EXISTS (
               SELECT 1
                 FROM harness_shared.harness_plans hp
                WHERE hp.workspace_id = p_workspace_id
                  AND hp.plan_slug = p_payload->'plan_item'->>'plan_slug'
                  AND (
                    hp.op_status IN ('started', 'paused')
                    OR (hp.status IN ('paused', 'active') AND hp.template_slug IS NULL)
                  )
             )
             OR EXISTS (
               SELECT 1
                 FROM harness_shared.plan_item_claims pic
                WHERE pic.workspace_id = p_workspace_id
                  AND pic.plan_slug = p_payload->'plan_item'->>'plan_slug'
                  AND pic.item_id = p_payload->'plan_item'->>'item_id'
                  AND pic.expires_ts > now()
             )
             OR EXISTS (
               SELECT 1
                 FROM harness_shared.plan_item_assignments pia
                WHERE pia.workspace_id = p_workspace_id
                  AND pia.plan_slug = p_payload->'plan_item'->>'plan_slug'
                  AND pia.item_id = p_payload->'plan_item'->>'item_id'
                  AND pia.released_ts IS NULL
                  AND NULLIF(BTRIM(pia.assignee_name), '') IS NOT NULL
             )
           ) THEN 'reserved-plan-lane'::text
      END
    ),
    NULL::text
  )
$$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(
  text, text, text, text, text, text, text, jsonb, text
) IS
  'P-001/P-002 claim-floor SSOT. Mirrors claimNextIssueWorkItem unconditional floors; per-claim rig/swarm/redundancy/cooldown, claimant identity, and own-node origin context remain outside the generic view. EI-22040912157347872 extends reserved-plan-lane to active durable plan-item assignments, preventing generic claim/release churn while the assigned owner is between claim leases; operational/lifecycle plan and live-lease semantics remain aligned with reservedPlanLaneExclusionSql.';

-- Keep the view OID and every dependent object intact; the column list is unchanged.
CREATE OR REPLACE VIEW harness_shared.work_items_claimable AS
  SELECT wi.*
    FROM harness_shared.work_items wi
   WHERE wi.item_kind IN ('bug', 'change', 'task')
     AND wi.status = 'open'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsOwnerAction' IS DISTINCT FROM 'true'
     AND cardinality(harness_shared.work_item_claim_floors(
           wi.workspace_id, wi.status, wi.taken_by, wi.origin, wi.title,
           wi.terminal_owner, wi.terminal_completion_ref, wi.payload, wi.feature_id
         )) = 0;

COMMENT ON VIEW harness_shared.work_items_claimable IS
  'P-001/P-002 issue-family rows passing every unconditional claim floor. The generic view intentionally omits caller-context rig/swarm/redundancy/cooldown and own-node origin floors. EI-22040912157347872 reserves active durable plan-item assignments so an assigned plan lane cannot re-enter generic self-select between lease claims.';
