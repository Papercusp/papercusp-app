-- 1301-acceptance-claim-floor.sql — P-007, plan observation-candidate-acceptance-promotion-2026-09-30
-- (decisions D-016 / D-017). Resolves WI-10004706. Reserved via db:next-migration before editing.
--
-- PROBLEM ------------------------------------------------------------------------------------
-- The TypeScript claim paths (self-pull, by-id, assignment, the admission promoter census) apply
-- the implementation-readiness / acceptance floor through
-- agentReviewNormalExclusionSql -> implementationReadinessNormalExclusionSql
-- (packages/operator-core/lib/harness/improvements/agent-review-policy.ts). The queryable SSOT,
-- harness_shared.work_items_claimable, did not: raw-SQL claimable counts admitted unreviewed,
-- unaccepted and stale-accepted intake rows that no claim path would ever serve.
-- (The agent-review pending / revision-requested floor IS already in the view, through the
-- work_item_claim_floors_v15 wrapper from migration 860; only floor #16 was missing.)
--
-- SHAPE --------------------------------------------------------------------------------------
-- 1. harness_shared.work_item_implementation_readiness_admits(payload, item_kind, title, summary,
--    created_ts) is the SQL twin of implementationReadinessNormalExclusionSql(sql, 'payload',
--    'work_items'). Its body is that TypeScript fragment RENDERED by postgres.js with every bound
--    parameter inlined — not a hand translation. claim-ssot-agreement.integration.test.ts
--    re-renders the TS fragment and fails if this body drifts from it, and checks the TS twin
--    implementationReadinessAdmitsClaim over a row matrix.
-- 2. A 12-argument overload of harness_shared.work_item_claim_floors takes the row's own
--    item_kind, summary and created_ts and appends the label 'implementation-readiness' when the
--    floor refuses. The 9-argument function is unchanged: its signature lacks the three columns
--    the floor needs, and a lookup by (workspace_id, feature_id) is both unindexed and ambiguous
--    (89 duplicate pairs measured 2026-10-01), so it cannot carry this floor.
-- 3. work_items_claimable is recreated to call the 12-argument overload. Same columns, same
--    other predicates; its membership now matches the TypeScript claim drain on floor #16.
--    (Column list: see the FORWARD-COMPAT note below.)
--
-- CUTOVER (D-018): the created-after-cutover arm is DEFERRED to P-011 (cohort baseline + named
-- canary). The rendered literal is the far sentinel 2100-01-01T00:00:00.000Z (epoch ms
-- 4102444800000, the IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER constant; the claim-SSOT
-- integration test re-renders and pins the two), so every current row keeps the legacy readiness
-- floor until P-011 lowers it in a new migration. A stale-revision or invalid-authority
-- acceptance refuses at any age, today.
--
-- The view is DROPPED and CREATED (as migration 654 did), not CREATE OR REPLACE'd: its stored
-- column list (82 columns) has drifted from work_items (90 columns, a different order), which
-- CREATE OR REPLACE VIEW refuses ("cannot change name of view column"). Nothing depends on the
-- view; grants come from the schema's default privileges exactly as they did for 654.
-- lint-migrations: allow-view-drop work_items_claimable has no dependent objects (the DROP is non-CASCADE, so it fails rather than silently dropping any) and is recreated in this same transaction with every prior column; its owner and grants come from the schema default privileges, verified unchanged by a live BEGIN..ROLLBACK dry-run on 2026-10-01 (as 654 did).
-- FORWARD-COMPAT: the view is dropped and recreated in this same migration transaction, and the recreated view keeps every column the old one exposed (it only gains the 8 newer work_items columns), so the release still serving :3070 reads it unchanged.

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
AS $floor1301$
  SELECT
    COALESCE((
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
      ), FALSE)
    FROM (
      SELECT p_payload    AS payload,
             p_item_kind  AS item_kind,
             p_title      AS title,
             p_summary    AS summary,
             p_created_ts AS created_ts
    ) AS row_columns
$floor1301$;

COMMENT ON FUNCTION harness_shared.work_item_implementation_readiness_admits(jsonb, text, text, text, bigint) IS
  'Claim floor #16 (implementation readiness + acceptance contract). SQL twin of implementationReadinessNormalExclusionSql in agent-review-policy.ts, rendered from it (migration 1301, P-007). TRUE = the floor admits the row.';

CREATE OR REPLACE FUNCTION harness_shared.work_item_claim_floors(
  p_workspace_id            text,
  p_status                  text,
  p_taken_by                text,
  p_origin                  text,
  p_title                   text,
  p_terminal_owner          text,
  p_terminal_completion_ref text,
  p_payload                 jsonb,
  p_feature_id              text,
  p_item_kind               text,
  p_summary                 text,
  p_created_ts              bigint
) RETURNS text[]
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $floors1301$
  SELECT CASE
           WHEN harness_shared.work_item_implementation_readiness_admits(
                  p_payload, p_item_kind, p_title, p_summary, p_created_ts
                )
             THEN floors.labels
           ELSE array_append(floors.labels, 'implementation-readiness'::text)
         END
    FROM (
      SELECT harness_shared.work_item_claim_floors(
               p_workspace_id,
               p_status,
               p_taken_by,
               p_origin,
               p_title,
               p_terminal_owner,
               p_terminal_completion_ref,
               p_payload,
               p_feature_id
             ) AS labels
    ) AS floors
$floors1301$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text, text, text, bigint) IS
  'Complete unconditional claim-floor labels for one work_items row: the 9-argument floors plus floor #16 implementation-readiness (migration 1301, P-007). Pass the row''s own item_kind, summary and created_ts.';

DROP VIEW IF EXISTS harness_shared.work_items_claimable;

CREATE VIEW harness_shared.work_items_claimable AS
  SELECT wi.*
    FROM harness_shared.work_items wi
   WHERE wi.item_kind IN ('bug', 'change', 'task')
     AND wi.status = 'open'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsOwnerAction' IS DISTINCT FROM 'true'
     AND cardinality(harness_shared.work_item_claim_floors(
           wi.workspace_id, wi.status, wi.taken_by, wi.origin, wi.title,
           wi.terminal_owner, wi.terminal_completion_ref, wi.payload, wi.feature_id,
           wi.item_kind, wi.summary, wi.created_ts
         )) = 0;

COMMENT ON VIEW harness_shared.work_items_claimable IS
  'P-001/P-002 issue-family rows passing every unconditional claim floor, including floor #16 implementation-readiness (migration 1301, P-007 / WI-10004706).';
