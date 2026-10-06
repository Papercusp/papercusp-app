-- 1294 — EI-24749278196855647: remove full-payload detoast from readiness census reads.
--
-- readWorkItemReadinessProjection scans the workspace work_items population and needs only
-- agentReview, implementationReadiness, reopenHistory, externalBlockers, and implementation-
-- readiness key presence. Extracting those fields from the polymorphic payload for every row
-- forces PostgreSQL to detoast/decompress the full JSONB value on the hot sync-resolver path.
-- STORED generated columns preserve payload as the single writer source while moving this
-- extraction to row writes. NULLIF maps an explicit JSON null subdocument to SQL NULL, matching
-- jsonb_to_record's jsonb-field behavior; the separate boolean preserves key presence even when
-- implementationReadiness is explicitly JSON null.
--
-- Adding STORED columns rewrites work_items under ACCESS EXCLUSIVE. Lock the view first, matching
-- migration 1110's view-to-base-table order and preventing a view/table lock inversion.

LOCK TABLE harness_shared.engineer_issues IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS agent_review_projection jsonb
    GENERATED ALWAYS AS (NULLIF(payload -> 'agentReview', 'null'::jsonb)) STORED,
  ADD COLUMN IF NOT EXISTS implementation_readiness_projection jsonb
    GENERATED ALWAYS AS (NULLIF(payload -> 'implementationReadiness', 'null'::jsonb)) STORED,
  ADD COLUMN IF NOT EXISTS implementation_readiness_enrolled boolean
    GENERATED ALWAYS AS (payload ? 'implementationReadiness') STORED,
  ADD COLUMN IF NOT EXISTS reopen_history_projection jsonb
    GENERATED ALWAYS AS (NULLIF(payload -> 'reopenHistory', 'null'::jsonb)) STORED,
  ADD COLUMN IF NOT EXISTS external_blockers_projection jsonb
    GENERATED ALWAYS AS (NULLIF(payload -> 'externalBlockers', 'null'::jsonb)) STORED;

COMMENT ON COLUMN harness_shared.work_items.agent_review_projection IS
  'EI-24749278196855647: materialized payload.agentReview for readiness reads; payload remains canonical for writers.';
COMMENT ON COLUMN harness_shared.work_items.implementation_readiness_projection IS
  'EI-24749278196855647: materialized payload.implementationReadiness for readiness reads; payload remains canonical for writers.';
COMMENT ON COLUMN harness_shared.work_items.implementation_readiness_enrolled IS
  'EI-24749278196855647: materialized presence of payload.implementationReadiness, including explicit JSON null.';
COMMENT ON COLUMN harness_shared.work_items.reopen_history_projection IS
  'EI-24749278196855647: materialized payload.reopenHistory for readiness reads; payload remains canonical for writers.';
COMMENT ON COLUMN harness_shared.work_items.external_blockers_projection IS
  'EI-24749278196855647: materialized payload.externalBlockers for readiness reads; payload remains canonical for writers.';

DO $mig1294_check$
DECLARE
  generated_jsonb_count integer;
  generated_boolean_count integer;
  mismatches bigint;
BEGIN
  SELECT count(*)::int
    INTO generated_jsonb_count
    FROM information_schema.columns
   WHERE table_schema = 'harness_shared'
     AND table_name = 'work_items'
     AND column_name IN (
       'agent_review_projection',
       'implementation_readiness_projection',
       'reopen_history_projection',
       'external_blockers_projection'
     )
     AND data_type = 'jsonb'
     AND is_generated = 'ALWAYS';

  SELECT count(*)::int
    INTO generated_boolean_count
    FROM information_schema.columns
   WHERE table_schema = 'harness_shared'
     AND table_name = 'work_items'
     AND column_name = 'implementation_readiness_enrolled'
     AND data_type = 'boolean'
     AND is_generated = 'ALWAYS';

  IF generated_jsonb_count <> 4 OR generated_boolean_count <> 1 THEN
    RAISE EXCEPTION
      '1294: expected four STORED JSONB projections and one STORED readiness-presence boolean; found % JSONB and % boolean',
      generated_jsonb_count,
      generated_boolean_count;
  END IF;

  SELECT count(*)
    INTO mismatches
    FROM harness_shared.work_items
   WHERE agent_review_projection IS DISTINCT FROM NULLIF(payload -> 'agentReview', 'null'::jsonb)
      OR implementation_readiness_projection IS DISTINCT FROM NULLIF(payload -> 'implementationReadiness', 'null'::jsonb)
      OR implementation_readiness_enrolled IS DISTINCT FROM (payload ? 'implementationReadiness')
      OR reopen_history_projection IS DISTINCT FROM NULLIF(payload -> 'reopenHistory', 'null'::jsonb)
      OR external_blockers_projection IS DISTINCT FROM NULLIF(payload -> 'externalBlockers', 'null'::jsonb);

  IF mismatches <> 0 THEN
    RAISE EXCEPTION
      '1294: % work_items rows disagree with their payload-derived readiness projections',
      mismatches;
  END IF;
END
$mig1294_check$;
