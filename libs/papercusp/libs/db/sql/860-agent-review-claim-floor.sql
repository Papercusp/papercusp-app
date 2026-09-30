-- 860-agent-review-claim-floor.sql — abolish-human-review-agent-review-only-2026-08-02 P-004 / D-003
--
-- Add claim floor #15 (`agent-review`) to the issue-family claim-floor SSOT.
-- A local change/feature under peer review stays on the existing work-item row,
-- with payload.agentReview.status carrying only its routing state. Pending work
-- belongs to the reviewer lane; revision-requested work belongs to its submitter.
-- Neither state may leak into ordinary implementation self-select. Approved rows
-- are deliberately re-admitted because approval is not terminal completion.
--
-- The real TypeScript claim path already applies agentReviewNormalExclusionSql.
-- This wrapper keeps the queryable work_items_claimable view in lockstep without
-- copying the fourteen earlier floors.

DROP VIEW IF EXISTS harness_shared.work_items_claimable;

-- FORWARD-COMPAT: The currently deployed release calls only the original public work_item_claim_floors signature, which this same migration recreates before commit; no deployed caller references the renamed private v14 helper.
ALTER FUNCTION harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text)
  RENAME TO work_item_claim_floors_v14;

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
      harness_shared.work_item_claim_floors_v14(
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
      CASE WHEN COALESCE(p_payload, '{}'::jsonb) -> 'agentReview' ->> 'status'
                     IN ('pending', 'revision-requested')
           THEN 'agent-review'::text
      END
    ),
    NULL::text
  )
$$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text) IS
  'P-001/P-002 claim-floor SSOT. Mirrors claimNextIssueWorkItem''s unconditional floors; per-claim rig/swarm/redundancy/cooldown and own-node origin context remain outside the generic view. Floor #15 agent-review reserves pending rows to peer reviewers and revision-requested rows to their submitters; approved rows are re-admitted for implementation (abolish-human-review D-003).';

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
  'P-001/P-002 issue-family rows passing every unconditional claim floor. The generic view intentionally omits caller-context rig/swarm/redundancy/cooldown and own-node origin floors. Floor #15 excludes pending/revision-requested agent-review rows until peer approval re-admits them.';
