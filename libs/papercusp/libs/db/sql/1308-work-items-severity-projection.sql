-- 1308 — papercusp-log-performance-remediation-2026-09-23 P-013 (WI-10004929):
-- remove the per-row payload detoast from the work-items summary severity facet.
--
-- workItems.summary (sync-resolver/work-items-list-query.ts) counts severity over every
-- in-scope row. Severity lives at payload._ei.severity, so the facet detoasted and
-- decompressed the whole TOASTed payload for ~83k issue rows on every summary read
-- (measured 2026-10-01: mean 1,380 ms and ~389k buffer hits per call over 26k calls).
-- A STORED generated column moves that extraction to row writes, exactly as migration
-- 1294 did for the readiness projections. payload remains the single writer source; the
-- expression is byte-for-byte the reader's previous CASE, so facet values are unchanged
-- (non-issue kinds stay NULL; an issue with no _ei.severity reads 'minor').
--
-- Adding a STORED column rewrites work_items under ACCESS EXCLUSIVE. Lock the view first,
-- matching migrations 1110 and 1294, to prevent a view/table lock inversion.

LOCK TABLE harness_shared.engineer_issues IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS severity_projection text
    GENERATED ALWAYS AS (
      CASE WHEN item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])
           THEN COALESCE(payload -> '_ei' ->> 'severity', 'minor')
           ELSE NULL
      END
    ) STORED;

COMMENT ON COLUMN harness_shared.work_items.severity_projection IS
  'P-013 / WI-10004929: materialized issue severity (payload._ei.severity, default minor; NULL for non-issue kinds) for list/summary reads; payload remains canonical for writers.';

DO $mig1308_check$
DECLARE
  generated_count integer;
  mismatches bigint;
BEGIN
  SELECT count(*)::int
    INTO generated_count
    FROM information_schema.columns
   WHERE table_schema = 'harness_shared'
     AND table_name = 'work_items'
     AND column_name = 'severity_projection'
     AND data_type = 'text'
     AND is_generated = 'ALWAYS';

  IF generated_count <> 1 THEN
    RAISE EXCEPTION '1308: expected one STORED text severity_projection; found %', generated_count;
  END IF;

  SELECT count(*)
    INTO mismatches
    FROM harness_shared.work_items
   WHERE severity_projection IS DISTINCT FROM (
     CASE WHEN item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])
          THEN COALESCE(payload -> '_ei' ->> 'severity', 'minor')
          ELSE NULL
     END);

  IF mismatches <> 0 THEN
    RAISE EXCEPTION '1308: % work_items rows disagree with their payload-derived severity', mismatches;
  END IF;
END
$mig1308_check$;
