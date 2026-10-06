-- WI-10006159: extend the existing normalized decision reservation, without
-- changing fleet specifications, plan content, leases or explicit by-id claims.
-- The authoritative writer already stores both counterexamples in plan_decisions:
-- an affirmative single-implementer decision under a non-conventional title, and
-- a named execution master with no plan_item back-pointer. Arbitrary WI mentions
-- (independent work, examples, release history) are not execution ownership.
--
-- FORWARD-COMPAT: the existing public nine-argument floor signature is recreated
-- in this transaction, preserving every prior label and the twelve-argument
-- caller; the older deployed release can continue using both public signatures.

-- An unbound master cannot use the existing plan-slug index. Index exact body
-- tokens so its candidate lookup does not scan the decision corpus per item.
CREATE INDEX IF NOT EXISTS plan_decisions_execution_tokens_idx
  ON harness_shared.plan_decisions
  USING gin (regexp_split_to_array(body, '[^A-Za-z0-9_-]+'));

DO $guard1364$
BEGIN
  IF to_regprocedure('harness_shared.work_item_claim_floors_pre1364(text,text,text,text,text,text,text,jsonb,text)') IS NULL THEN
    ALTER FUNCTION harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text)
      RENAME TO work_item_claim_floors_pre1364;
  END IF;
END
$guard1364$;

CREATE OR REPLACE FUNCTION harness_shared.work_item_claim_floors(
  p_workspace_id text, p_status text, p_taken_by text, p_origin text,
  p_title text, p_terminal_owner text, p_terminal_completion_ref text,
  p_payload jsonb, p_feature_id text
) RETURNS text[]
LANGUAGE sql STABLE
AS $floor1364$
  SELECT CASE WHEN NOT ('reserved-plan-lane' = ANY(prior.labels)) AND EXISTS (
    SELECT 1 FROM harness_shared.plan_decisions d
    WHERE d.workspace_id = p_workspace_id
      AND (
        (
          d.plan_slug = p_payload->'plan_item'->>'plan_slug'
          AND (
            cardinality(COALESCE(d.item_refs, ARRAY[]::text[])) = 0
            OR p_payload->'plan_item'->>'item_id' = ANY(COALESCE(d.item_refs, ARRAY[]::text[]))
          )
        )
        OR (
          regexp_split_to_array(d.body, '[^A-Za-z0-9_-]+') @> ARRAY[p_feature_id]::text[]
          AND EXISTS (
            SELECT 1 FROM regexp_matches(d.body,
              '(^|[^A-Za-z0-9_-])(WI-[0-9]+)[[:space:]]+owns execution([[:space:]]+and([[:space:]]|$)|[.;]|$)', 'g') AS master(ref)
            WHERE master.ref[2] = p_feature_id
          )
        )
      )
      AND (
        LOWER(d.title) LIKE '%self-only execution route%'
        OR (
          LOWER(BTRIM(d.title)) = 'direct execution route'
          AND (
            LOWER(d.body) LIKE '%implements the plan directly%'
            OR LOWER(d.body) LIKE '%implement it itself%'
            OR LOWER(d.body) LIKE '%no fleet%'
            OR LOWER(d.body) LIKE '%no subagents%'
          )
        )
        OR LOWER(d.body) ~ '(^|[^a-z0-9_-])su-[a-f0-9-]{8,36} is the (single|sole) implementer([[:space:].;]|$)'
        OR LOWER(d.body) ~ '(^|[^a-z0-9_-])route is this session implementing directly, without (a new )?fleet([[:space:].;]|$)'
      )
  ) THEN array_append(prior.labels, 'reserved-plan-lane'::text)
    ELSE prior.labels END
  FROM (SELECT harness_shared.work_item_claim_floors_pre1364(
    p_workspace_id, p_status, p_taken_by, p_origin, p_title,
    p_terminal_owner, p_terminal_completion_ref, p_payload, p_feature_id
  ) AS labels) prior
$floor1364$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text) IS
  'Existing claim-floor SSOT plus WI-10006159 affirmative single-implementer decisions and explicitly named unbound execution masters. Item refs and workspace remain scoped; by-id claims retain their deliberate bypass.';
