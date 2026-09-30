-- 863-owner-action-claim-floor.sql — abolish-human-review-agent-review-only-2026-08-02 P-005
--
-- Split the surviving owner-capability gate from the legacy needsHuman
-- compatibility cohort in the database claim-floor SSOT. Migration 860 added
-- agent-review as floor #15; this wrapper adds floor #16 for the deliberately
-- narrow payload.needsOwnerAction key. The legacy needsHuman floor remains in
-- the v15 chain until P-006 re-triages the 750 parked rows.
--
-- The TypeScript claim and diagnostic paths already apply the same two
-- independent predicates. This migration keeps the queryable
-- work_items_claimable view and work_item_claim_floors() function aligned with
-- them, so a strict credential/device/external-service action can never be
-- advertised as ordinary implementation work.

DROP VIEW IF EXISTS harness_shared.work_items_claimable;

-- FORWARD-COMPAT: the deployed release calls only the public v15 signature.
-- Rename and recreate it in this same migration transaction, before commit.
ALTER FUNCTION harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text)
  RENAME TO work_item_claim_floors_v15;

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
      harness_shared.work_item_claim_floors_v15(
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
      CASE WHEN COALESCE(p_payload, '{}'::jsonb) ->> 'needsOwnerAction' = 'true'
           THEN 'needs-owner-action'::text
      END
    ),
    NULL::text
  )
$$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text) IS
  'P-001/P-002 claim-floor SSOT. Mirrors claimNextIssueWorkItem unconditional floors; per-claim rig/swarm/redundancy/cooldown and own-node origin context remain outside the generic view. Floor #15 reserves pending/revision-requested agent-review rows. Floor #16 reserves the strict payload.needsOwnerAction route for credential, physical-device, or external-service action; legacy needsHuman remains a separate compatibility floor until P-006.';

CREATE VIEW harness_shared.work_items_claimable AS
  SELECT wi.*
    FROM harness_shared.work_items wi
   WHERE wi.item_kind IN ('bug', 'change', 'task')
     -- Cheap indexed/payload prefilters; the function below remains authoritative.
     AND wi.status = 'open'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane'             IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman'       IS DISTINCT FROM 'true'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsOwnerAction' IS DISTINCT FROM 'true'
     AND cardinality(harness_shared.work_item_claim_floors(
           wi.workspace_id, wi.status, wi.taken_by, wi.origin, wi.title,
           wi.terminal_owner, wi.terminal_completion_ref, wi.payload, wi.feature_id
         )) = 0;

COMMENT ON VIEW harness_shared.work_items_claimable IS
  'P-001/P-002 issue-family rows passing every unconditional claim floor. The generic view intentionally omits caller-context rig/swarm/redundancy/cooldown and own-node origin floors. Floor #15 excludes active agent review; floor #16 excludes strict owner actions independently from the legacy needsHuman compatibility cohort.';
