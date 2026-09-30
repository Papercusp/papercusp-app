-- 1081-plan-route-decision-claim-floor.sql — WI-41737
-- Reserved via db:next-migration before editing.
--
-- Extend the existing reserved-plan-lane SSOT with the normalized D-NNN route
-- decision axis. A ready plan with no live plan-item lease or durable assignment
-- is normally generic backlog. That is correct for genuinely unowned work, but it
-- is wrong when a recorded decision reserves execution to one direct session.
-- The live counterexample was email-mailbox-identity-ux-2026-08-31#D-006/P-007:
-- scheduler:get_next assigned the shipment lane to a fleet even though the plan
-- said no fleet or subagents were used.
--
-- The marker is deliberately narrow and mirrors reservedPlanLaneExclusionSql:
-- a title containing "self-only execution route", or the exact conventional title
-- "Direct execution route" plus affirmative direct/no-fleet body language. Item
-- refs scope the reservation; an empty set is plan-wide. By-id claims bypass this
-- generic SSOT floor, preserving the explicit route owner's deliberate pickup.
--
-- FORWARD-COMPAT: the deployed release calls only the stable public
-- work_item_claim_floors(text, ...) signature. Renaming its current implementation
-- and recreating that same signature in this transaction leaves the old release
-- callable before commit and routes it to the compatible replacement after commit.

DO $function_guard1081$
BEGIN
  IF to_regprocedure(
       'harness_shared.work_item_claim_floors_v21(text,text,text,text,text,text,text,jsonb,text)'
     ) IS NULL THEN
    IF to_regprocedure(
         'harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text)'
       ) IS NULL THEN
      RAISE EXCEPTION '1081: public work_item_claim_floors function is missing';
    END IF;
    ALTER FUNCTION harness_shared.work_item_claim_floors(
      text, text, text, text, text, text, text, jsonb, text
    ) RENAME TO work_item_claim_floors_v21;
  END IF;
END
$function_guard1081$;

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
      array_remove(
        harness_shared.work_item_claim_floors_v21(
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
             OR EXISTS (
               SELECT 1
                 FROM harness_shared.plan_decisions pd
                WHERE pd.workspace_id = p_workspace_id
                  AND pd.plan_slug = p_payload->'plan_item'->>'plan_slug'
                  AND (
                    cardinality(COALESCE(pd.item_refs, ARRAY[]::text[])) = 0
                    OR p_payload->'plan_item'->>'item_id' = ANY(COALESCE(pd.item_refs, ARRAY[]::text[]))
                  )
                  AND (
                    LOWER(pd.title) LIKE '%self-only execution route%'
                    OR (
                      LOWER(BTRIM(pd.title)) = 'direct execution route'
                      AND (
                        LOWER(pd.body) LIKE '%implements the plan directly%'
                        OR LOWER(pd.body) LIKE '%implement it itself%'
                        OR LOWER(pd.body) LIKE '%no fleet%'
                        OR LOWER(pd.body) LIKE '%no subagents%'
                      )
                    )
                  )
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
  'P-001/P-002 claim-floor SSOT. Mirrors claimNextIssueWorkItem unconditional floors. WI-41737 extends reserved-plan-lane to normalized D-NNN self-only/direct execution-route decisions scoped by item_refs, preventing generic scheduler pickup while preserving explicit by-id claims.';

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
  'P-001/P-002 issue-family rows passing every unconditional claim floor. WI-41737 reserves normalized D-NNN self-only/direct execution-route decisions from generic self-select while by-id pickup remains available.';
