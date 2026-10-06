-- 1368: acceptance claim floor — kind-specific verification (P-006, WI-10006220; plan
-- unified-bug-pipeline-and-honest-queue-2026-10-05 D-019).
--
-- The acceptance seal is the one verification stage, and its check is chosen by kind:
-- a bug's contract must carry a reproduction receipt (verification.check = 'reproduction',
-- a receipt the D-023/D-024 parser accepts); every other kind must carry agent-review
-- authority. A contract that fails its kind's check reads 'incomplete'.
--
-- This re-renders harness_shared.work_item_implementation_readiness_admits (migration 1301)
-- from implementationReadinessNormalExclusionSql (packages/operator-core/lib/harness/
-- improvements/agent-review-policy.ts) with every bound parameter inlined — not a hand
-- translation. claim-ssot-agreement.integration.test.ts re-renders the TS fragment and fails
-- if this body drifts from it. Same signature, so the 12-argument work_item_claim_floors
-- overload and the work_items_claimable view pick the new body up unchanged.
--
-- Behaviour today: the enforcement cutover is still the far sentinel, and the pre-cutover
-- legacy floor admits 'incomplete', so no current row changes claimability. Post-cutover
-- rows (and the acceptance canary's synthetic probes) are judged with the kind check.
-- Not destructive: CREATE OR REPLACE of an existing function with an identical signature.

CREATE OR REPLACE FUNCTION harness_shared.work_item_implementation_readiness_admits(
  p_payload    jsonb,
  p_item_kind  text,
  p_title      text,
  p_summary    text,
  p_created_ts bigint
) RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $floor1368$
  SELECT
    COALESCE((COALESCE((
    (
      (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'schemaVersion' = 'implementation-readiness-v1'
      AND (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'status' = 'ready'
      AND (CASE
    WHEN NOT (COALESCE((
    jsonb_typeof((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness')) = 'object'
    AND (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'schemaVersion' = 'implementation-readiness-v1'
    AND (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'status' = ANY('{"unknown","not-ready","ready"}'::text[])
    AND (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'source' = ANY('{"capture-policy","agent-review","triage-freshness","creation-enrollment"}'::text[])
    AND jsonb_typeof((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'reason') = 'string'
    AND ((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'reason') ~ '[^[:space:]]'
    AND jsonb_typeof((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'updatedAt') = 'string'
    AND ((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'updatedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  ), FALSE))
      OR jsonb_typeof(((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance')) IS DISTINCT FROM 'object'
      OR ((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') = '{}'::jsonb THEN 'absent'
    WHEN NOT (COALESCE((
    COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'problem')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'problem') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'outcome')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'outcome') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'scope')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'scope') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'completionCheck')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'completionCheck') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND jsonb_typeof(((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'evidence') = 'array'
    AND jsonb_array_length(((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'evidence') > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'evidence') AS entry(value)
       WHERE NOT COALESCE(jsonb_typeof(entry.value) = 'string' AND (entry.value #>> '{}') ~ '[^[:space:]]', FALSE)
    )
  ), FALSE) AND COALESCE((
    ((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') ->> 'contractVersion' = 'implementation-acceptance-v1'
    AND jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority')) = 'object'
    AND COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'reason')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'reason') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'sourceRevision')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'sourceRevision') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND jsonb_typeof(((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'acceptedAt') = 'string'
    AND (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') ->> 'acceptedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  ), FALSE)) THEN 'incomplete'
    WHEN NOT ((
    CASE (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'kind'
      WHEN 'agent-review' THEN COALESCE(
        COALESCE(jsonb_typeof(((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'reviewer')) = 'string' AND (((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'reviewer') #>> '{}') ~ '[^[:space:]]', FALSE)
        AND COALESCE(jsonb_typeof(((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'submittedBy')) = 'string' AND (((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'submittedBy') #>> '{}') ~ '[^[:space:]]', FALSE)
        AND (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'reviewer' <> (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'submittedBy'
        AND jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'round') = 'number'
        AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'round') ~ '^[1-9][0-9]*$',
        FALSE
      )
      WHEN 'policy' THEN COALESCE(
        jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'policy') = 'string'
        AND (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'policy' = ANY('{"trusted-tool-failure-promotion"}'::text[])
        AND COALESCE(jsonb_typeof(((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'actor')) = 'string' AND (((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'actor') #>> '{}') ~ '[^[:space:]]', FALSE),
        FALSE
      )
      ELSE FALSE
    END
  )) THEN 'invalid-authority'
    WHEN (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') ->> 'sourceRevision') IS DISTINCT FROM ('src-v1:'::text || encode(sha256(convert_to(
    item_kind || chr(31) || title || chr(31) || COALESCE(summary, ''),
    'UTF8'
  )), 'hex')) THEN 'stale-revision'
    WHEN NOT (COALESCE((
    CASE WHEN item_kind = 'bug' THEN (
      ((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' ->> 'check' = 'reproduction'
      AND jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt')) = 'object'
      AND jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') -> 'kind') = 'string'
      AND (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') ->> 'kind' = ANY('{"failing-test","scripted-repro","current-build-observation","encounter"}'::text[])
      AND COALESCE(jsonb_typeof(((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') -> 'ref')) = 'string' AND (((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') -> 'ref') #>> '{}') ~ '[^[:space:]]', FALSE)
      AND jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') -> 'buildSha') = 'string'
      AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') ->> 'buildSha') ~ '^[[:space:]]*[0-9a-fA-F]{7,40}[[:space:]]*$'
    ) ELSE (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'kind' = 'agent-review' END
  ), FALSE)) THEN 'incomplete'
    ELSE 'qualifying'
  END) = 'qualifying'
    )
    OR (
      (COALESCE(created_ts, 0) < '4102444800000'::bigint)
      AND (CASE
    WHEN NOT (COALESCE((
    jsonb_typeof((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness')) = 'object'
    AND (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'schemaVersion' = 'implementation-readiness-v1'
    AND (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'status' = ANY('{"unknown","not-ready","ready"}'::text[])
    AND (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'source' = ANY('{"capture-policy","agent-review","triage-freshness","creation-enrollment"}'::text[])
    AND jsonb_typeof((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'reason') = 'string'
    AND ((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'reason') ~ '[^[:space:]]'
    AND jsonb_typeof((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'updatedAt') = 'string'
    AND ((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'updatedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  ), FALSE))
      OR jsonb_typeof(((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance')) IS DISTINCT FROM 'object'
      OR ((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') = '{}'::jsonb THEN 'absent'
    WHEN NOT (COALESCE((
    COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'problem')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'problem') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'outcome')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'outcome') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'scope')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'scope') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'completionCheck')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'completionCheck') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND jsonb_typeof(((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'evidence') = 'array'
    AND jsonb_array_length(((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'evidence') > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'evidence') AS entry(value)
       WHERE NOT COALESCE(jsonb_typeof(entry.value) = 'string' AND (entry.value #>> '{}') ~ '[^[:space:]]', FALSE)
    )
  ), FALSE) AND COALESCE((
    ((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') ->> 'contractVersion' = 'implementation-acceptance-v1'
    AND jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority')) = 'object'
    AND COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'reason')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'reason') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND COALESCE(jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'sourceRevision')) = 'string' AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'sourceRevision') #>> '{}') ~ '[^[:space:]]', FALSE)
    AND jsonb_typeof(((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'acceptedAt') = 'string'
    AND (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') ->> 'acceptedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  ), FALSE)) THEN 'incomplete'
    WHEN NOT ((
    CASE (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'kind'
      WHEN 'agent-review' THEN COALESCE(
        COALESCE(jsonb_typeof(((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'reviewer')) = 'string' AND (((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'reviewer') #>> '{}') ~ '[^[:space:]]', FALSE)
        AND COALESCE(jsonb_typeof(((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'submittedBy')) = 'string' AND (((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'submittedBy') #>> '{}') ~ '[^[:space:]]', FALSE)
        AND (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'reviewer' <> (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'submittedBy'
        AND jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'round') = 'number'
        AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'round') ~ '^[1-9][0-9]*$',
        FALSE
      )
      WHEN 'policy' THEN COALESCE(
        jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'policy') = 'string'
        AND (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'policy' = ANY('{"trusted-tool-failure-promotion"}'::text[])
        AND COALESCE(jsonb_typeof(((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'actor')) = 'string' AND (((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') -> 'actor') #>> '{}') ~ '[^[:space:]]', FALSE),
        FALSE
      )
      ELSE FALSE
    END
  )) THEN 'invalid-authority'
    WHEN (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') ->> 'sourceRevision') IS DISTINCT FROM ('src-v1:'::text || encode(sha256(convert_to(
    item_kind || chr(31) || title || chr(31) || COALESCE(summary, ''),
    'UTF8'
  )), 'hex')) THEN 'stale-revision'
    WHEN NOT (COALESCE((
    CASE WHEN item_kind = 'bug' THEN (
      ((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' ->> 'check' = 'reproduction'
      AND jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt')) = 'object'
      AND jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') -> 'kind') = 'string'
      AND (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') ->> 'kind' = ANY('{"failing-test","scripted-repro","current-build-observation","encounter"}'::text[])
      AND COALESCE(jsonb_typeof(((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') -> 'ref')) = 'string' AND (((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') -> 'ref') #>> '{}') ~ '[^[:space:]]', FALSE)
      AND jsonb_typeof((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') -> 'buildSha') = 'string'
      AND ((((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'verification' -> 'receipt') ->> 'buildSha') ~ '^[[:space:]]*[0-9a-fA-F]{7,40}[[:space:]]*$'
    ) ELSE (((COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') -> 'evidence' -> 'acceptance') -> 'authority') ->> 'kind' = 'agent-review' END
  ), FALSE)) THEN 'incomplete'
    ELSE 'qualifying'
  END) NOT IN ('stale-revision', 'invalid-authority')
      AND (
        NOT ((COALESCE(payload, '{}'::jsonb) ? 'implementationReadiness'))
        OR (
          (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'schemaVersion' = 'implementation-readiness-v1'
          AND (
            (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'status' = 'ready'
            OR (
              (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'status' = 'unknown'
              AND (COALESCE(payload, '{}'::jsonb) -> 'implementationReadiness') ->> 'source' = 'creation-enrollment'
            )
          )
        )
      )
    )
  ), FALSE)), FALSE)
    FROM (
      SELECT p_payload    AS payload,
             p_item_kind  AS item_kind,
             p_title      AS title,
             p_summary    AS summary,
             p_created_ts AS created_ts
    ) AS row_columns
$floor1368$;
