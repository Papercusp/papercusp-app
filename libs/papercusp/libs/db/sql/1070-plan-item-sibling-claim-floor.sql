-- 1070-plan-item-sibling-claim-floor.sql — EI-22040898205841125
-- Reserved via db:next-migration before arming.
--
-- Extend the issue-family claim-floor SSOT with the live work-item sibling axis.
-- guardPlanItemSiblingClaim already serializes concurrent implementations of one
-- canonical plan-item, but it runs AFTER the ranked UPDATE. A duplicate row whose
-- sibling was already claimed therefore stayed visible to the queryable oracle and
-- was repeatedly provisionally claimed + cleared by the real selector. The caller
-- saw NULL while the oracle counted the same row and falsely diagnosed an internal
-- claim/read divergence. The TypeScript reservedPlanLaneExclusionSql now excludes
-- this shape before UPDATE; this migration keeps the SQL SSOT view in agreement.
-- FORWARD-COMPAT: the versioned-function rename and stable public-function
-- recreation commit atomically, so deployed readers never observe a committed
-- state without the existing nine-argument public signature; v19 retains the
-- prior implementation while the recreated wrapper adds the sibling floor.
--
-- The stable nine-argument function signature is preserved. Candidate identity is
-- its established payload.plan_item back-pointer; a sibling prefers canonical
-- source_plan_slug/source_plan_item_ids and falls back to its legacy payload only
-- when those source columns are incomplete. The transaction guard remains the
-- concurrency/source-only backstop.

DO $function_guard1070$
BEGIN
  IF to_regprocedure(
       'harness_shared.work_item_claim_floors_v19(text,text,text,text,text,text,text,jsonb,text)'
     ) IS NULL THEN
    IF to_regprocedure(
         'harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text)'
       ) IS NULL THEN
      RAISE EXCEPTION '1070: public work_item_claim_floors function is missing';
    END IF;
    ALTER FUNCTION harness_shared.work_item_claim_floors(
      text, text, text, text, text, text, text, jsonb, text
    ) RENAME TO work_item_claim_floors_v19;
  END IF;
END
$function_guard1070$;

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
      harness_shared.work_item_claim_floors_v19(
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
      CASE WHEN COALESCE(p_payload, '{}'::jsonb) ? 'plan_item' AND EXISTS (
        SELECT 1
          FROM harness_shared.work_items sibling
         WHERE sibling.workspace_id = p_workspace_id
           AND sibling.feature_id <> p_feature_id
           AND sibling.taken_by IS NOT NULL
           AND btrim(sibling.taken_by) <> ''
           AND lower(btrim(sibling.taken_by)) <> 'unassigned'
           AND sibling.status NOT IN ('passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped')
           AND (
             (
               NULLIF(btrim(sibling.source_plan_slug), '') IS NOT NULL
               AND EXISTS (
                 SELECT 1
                   FROM unnest(COALESCE(sibling.source_plan_item_ids, ARRAY[]::text[])) AS sibling_item(item_id)
                  WHERE btrim(sibling_item.item_id) <> ''
               )
               AND btrim(sibling.source_plan_slug) = p_payload->'plan_item'->>'plan_slug'
               AND p_payload->'plan_item'->>'item_id' = ANY(
                 COALESCE(sibling.source_plan_item_ids, ARRAY[]::text[])
               )
             )
             OR (
               NOT (
                 NULLIF(btrim(sibling.source_plan_slug), '') IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM unnest(COALESCE(sibling.source_plan_item_ids, ARRAY[]::text[])) AS sibling_item(item_id)
                    WHERE btrim(sibling_item.item_id) <> ''
                 )
               )
               AND COALESCE(sibling.payload, '{}'::jsonb)->'plan_item'->>'plan_slug'
                     = p_payload->'plan_item'->>'plan_slug'
               AND COALESCE(sibling.payload, '{}'::jsonb)->'plan_item'->>'item_id'
                     = p_payload->'plan_item'->>'item_id'
             )
           )
      ) THEN 'active-plan-item-sibling'::text END
    ),
    NULL::text
  )
$$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(
  text, text, text, text, text, text, text, jsonb, text
) IS
  'P-001/P-002 claim-floor SSOT. Mirrors claimNextIssueWorkItem unconditional floors; EI-22040898205841125 adds active-plan-item-sibling so an already-claimed canonical sibling is excluded before the selector UPDATE and cannot masquerade as claim/read divergence.';

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
  'P-001/P-002 issue-family rows passing every unconditional claim floor. EI-22040898205841125 excludes an unclaimed duplicate implementation while a nonterminal canonical plan-item sibling carries a live work-item claim.';
