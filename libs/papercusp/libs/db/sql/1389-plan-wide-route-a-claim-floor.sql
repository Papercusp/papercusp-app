-- WI-10006417 — a Route A choice names the session that implements the whole plan.
-- The earlier D-NNN floor respects non-empty item_refs, which is correct for item-scoped
-- decisions but misses cross-cutting Route A clauses in mixed owner-answer decisions:
-- D-006 names su-dab96471 as implementer while its refs only list P-003/P-006/P-010,
-- leaving linked P-002 available to generic scheduler pickup.
--
-- Keep plan_decisions as the existing durable authority and make this exact affirmative
-- Route A form plan-wide. The by-id claim path remains available to the named executor.
-- The TypeScript twin is reservedPlanLaneExclusionSql in work-items.ts; the real-Postgres
-- claim-ssot agreement test applies this draft and checks both task and feature paths.
-- FORWARD-COMPAT: the RENAME keeps the old body as work_item_claim_floors_pre1389, and the
-- CREATE OR REPLACE below restores work_item_claim_floors with the identical 9-argument
-- signature and text[] return type, wrapping the renamed body. The deployed release calls the
-- same signature, so it resolves the new wrapper; no caller loses the function (WI-10006549).

DO $guard1389$
BEGIN
  IF to_regprocedure(
       'harness_shared.work_item_claim_floors_pre1389(text,text,text,text,text,text,text,jsonb,text)'
     ) IS NULL THEN
    ALTER FUNCTION harness_shared.work_item_claim_floors(
      text, text, text, text, text, text, text, jsonb, text
    ) RENAME TO work_item_claim_floors_pre1389;
  END IF;
END
$guard1389$;

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
AS $floor1389$
  SELECT CASE WHEN NOT ('reserved-plan-lane' = ANY(prior.labels)) AND EXISTS (
    SELECT 1
      FROM harness_shared.plan_decisions d
     WHERE d.workspace_id = p_workspace_id
       AND d.plan_slug = p_payload->'plan_item'->>'plan_slug'
       AND LOWER(d.body) ~ '(^|[^a-z0-9_-])route[[:space:]]+a:[[:space:]]+this session[[:space:]]+[(]su-[a-f0-9-]{8,36}[)][[:space:]]+implements the plan([[:space:].;]|$)'
  ) THEN array_append(prior.labels, 'reserved-plan-lane'::text)
    ELSE prior.labels END
  FROM (SELECT harness_shared.work_item_claim_floors_pre1389(
    p_workspace_id,
    p_status,
    p_taken_by,
    p_origin,
    p_title,
    p_terminal_owner,
    p_terminal_completion_ref,
    p_payload,
    p_feature_id
  ) AS labels) prior
$floor1389$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(
  text, text, text, text, text, text, text, jsonb, text
) IS
  'P-001/P-002 claim-floor SSOT plus WI-10006417 plan-wide Route A reservations. A matching decision in the same workspace and plan reserves linked generic self-select even when item_refs name only other clauses; explicit by-id pickup remains available.';
