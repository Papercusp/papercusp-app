-- 853-plan-item-terminal-claim-floor.sql — EI-20467873456529090
--
-- Add claim floor #14 (`terminal-plan-item`) to the issue-family claim-floor SSOT. An open
-- work-item can retain a payload.plan_item back-pointer after the effective plan item is done or
-- dropped. The post-claim planItemLaneBlockReason guard already rejects that residue, but the
-- shared preview/aggregate/bench surfaces counted it first, so a fleet lane with no actionable
-- work could refuse to bench (and scheduler:get_next could report a false survivor).
--
-- The normalized plan_items table (migration 675) is the derived, indexed status surface rebuilt
-- from canonical plan content. Match by workspace + plan/item identity, deliberately omitting the
-- payload harness_slug copy: plan-harness canonicalization can repair that copy asynchronously,
-- while (workspace_id, plan_slug) is the plan identity used by the existing claim floors.
--
-- This migration wraps the previous floor function instead of copying its entire SQL body. The
-- renamed v13 helper remains private to this SSOT function; the wrapper adds exactly one floor and
-- leaves every existing floor byte-for-byte unchanged.

DROP VIEW IF EXISTS harness_shared.work_items_claimable;

-- FORWARD-COMPAT: The currently deployed release calls only the original public work_item_claim_floors signature, which this same migration recreates before commit; no deployed caller references the renamed private v13 helper.
ALTER FUNCTION harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text)
  RENAME TO work_item_claim_floors_v13;

CREATE FUNCTION harness_shared.work_item_claim_floors(
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
      harness_shared.work_item_claim_floors_v13(
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
      CASE WHEN COALESCE(p_payload, '{}'::jsonb) ? 'plan_item'
                AND EXISTS (
                  SELECT 1
                    FROM harness_shared.plan_items pi
                   WHERE pi.workspace_id = p_workspace_id
                     AND pi.plan_slug = p_payload->'plan_item'->>'plan_slug'
                     AND pi.item_id = p_payload->'plan_item'->>'item_id'
                     AND pi.status IN ('done', 'dropped')
                )
           THEN 'terminal-plan-item'::text
      END
    ),
    NULL::text
  )
$$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text) IS
  'P-001/P-002 claim-floor SSOT. Mirrors claimNextIssueWorkItem''s unconditional floors; per-claim rig/swarm/redundancy/cooldown and own-node origin context remain outside the generic view. EI-20467873456529090 adds floor #14 terminal-plan-item: an open work-item linked to a normalized plan_items row with status done/dropped is terminal residue and is not claimable.';

CREATE VIEW harness_shared.work_items_claimable AS
  SELECT wi.*
    FROM harness_shared.work_items wi
   WHERE wi.item_kind IN ('bug', 'change', 'task')
     -- Cheap indexed/payload prefilters; the function below remains authoritative.
     AND wi.status = 'open'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane'       IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman' IS DISTINCT FROM 'true'
     AND cardinality(harness_shared.work_item_claim_floors(
           wi.workspace_id, wi.status, wi.taken_by, wi.origin, wi.title,
           wi.terminal_owner, wi.terminal_completion_ref, wi.payload, wi.feature_id
         )) = 0;

COMMENT ON VIEW harness_shared.work_items_claimable IS
  'P-001/P-002 issue-family rows passing every unconditional claim floor. The generic view intentionally omits caller-context rig/swarm/redundancy/cooldown and own-node origin floors. Floor #14 excludes open work-items linked to terminal normalized plan-items (EI-20467873456529090).';
