-- 861-plan-forced-past-index.sql — plan-completion-audit-and-acceptance-verdict-2026-08-13 P-008 / D-003
--
-- The append-only `## Acceptance waiver` block in harness_plans.content remains
-- canonical. This bounded projection ({count, latest}) lets plans:get/list and
-- federation expose a permanent forced-shipment marker without repeatedly
-- detoasting and parsing the full markdown document.
--
-- FORWARD-COMPAT: the deployed release ignores an additive nullable column.
-- The new release recomputes it on every locked content write and falls back to
-- parsing content on full-row reads, so a pre-861 row remains truthful while the
-- backfill below covers existing v1 machine records for index-only reads.

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS forced_past jsonb;

COMMENT ON COLUMN harness_shared.harness_plans.forced_past IS
  'Bounded {count,latest} projection of the append-only acceptance-waiver log in content; content is canonical.';

-- Plan markdown is editable, so a marker that merely LOOKS like a v1 base64url
-- record may be malformed. The application parser ignores such records; the
-- migration must do the same instead of aborting the entire fleet migration.
CREATE OR REPLACE FUNCTION pg_temp.decode_forced_past_v1(encoded text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $fn$
DECLARE
  parsed jsonb;
  normalized_checks jsonb;
  normalized_actor jsonb;
BEGIN
  parsed := convert_from(
    decode(
      rpad(
        translate(encoded, '-_', '+/'),
        ((length(encoded) + 3) / 4) * 4,
        '='
      ),
      'base64'
    ),
    'UTF8'
  )::jsonb;

  IF jsonb_typeof(parsed) <> 'object'
     OR jsonb_typeof(parsed -> 'reason') <> 'string'
     OR jsonb_typeof(parsed -> 'forcedAt') <> 'string'
     OR jsonb_typeof(parsed -> 'checks') <> 'array' THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(parsed -> 'checks') AS check_value
     WHERE jsonb_typeof(check_value) <> 'string'
  ) THEN
    RETURN NULL;
  END IF;

  IF parsed ? 'forcedBy'
     AND jsonb_typeof(parsed -> 'forcedBy') <> 'null'
     AND (
       jsonb_typeof(parsed -> 'forcedBy') <> 'object'
       OR jsonb_typeof(parsed -> 'forcedBy' -> 'ownerId') <> 'string'
       OR jsonb_typeof(parsed -> 'forcedBy' -> 'ownerLabel') <> 'string'
     ) THEN
    RETURN NULL;
  END IF;

  IF parsed ? 'legacy' AND jsonb_typeof(parsed -> 'legacy') <> 'boolean' THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(jsonb_agg(value ORDER BY value), '[]'::jsonb)
    INTO normalized_checks
    FROM jsonb_array_elements_text(parsed -> 'checks') AS check_value(value);

  normalized_actor := CASE
    WHEN jsonb_typeof(parsed -> 'forcedBy') = 'object' THEN
      jsonb_build_object(
        'ownerId', parsed -> 'forcedBy' ->> 'ownerId',
        'ownerLabel', parsed -> 'forcedBy' ->> 'ownerLabel'
      )
    ELSE 'null'::jsonb
  END;

  RETURN jsonb_build_object(
    'reason', parsed ->> 'reason',
    'checks', normalized_checks,
    'forcedAt', parsed ->> 'forcedAt',
    'forcedBy', normalized_actor,
    'legacy', coalesce((parsed ->> 'legacy')::boolean, false)
  );
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$fn$;

WITH candidates AS (
  SELECT p.workspace_id,
         p.harness_slug,
         p.plan_slug,
         m.ordinality,
         pg_temp.decode_forced_past_v1(m.captures[1]) AS record
    FROM harness_shared.harness_plans p
    CROSS JOIN LATERAL regexp_matches(
      p.content,
      '<!--[[:space:]]*papercusp:forced-past:v1:([A-Za-z0-9_-]+)[[:space:]]*-->',
      'g'
    ) WITH ORDINALITY AS m(captures, ordinality)
), summaries AS (
  SELECT workspace_id,
         harness_slug,
         plan_slug,
         jsonb_build_object(
           'count', count(*)::int,
           'latest', (array_agg(record ORDER BY ordinality DESC))[1]
         ) AS forced_past
    FROM candidates
   WHERE record IS NOT NULL
   GROUP BY workspace_id, harness_slug, plan_slug
)
UPDATE harness_shared.harness_plans p
   SET forced_past = s.forced_past
  FROM summaries s
 WHERE p.workspace_id = s.workspace_id
   AND p.harness_slug = s.harness_slug
   AND p.plan_slug = s.plan_slug
   AND p.forced_past IS DISTINCT FROM s.forced_past;

DROP FUNCTION pg_temp.decode_forced_past_v1(text);
