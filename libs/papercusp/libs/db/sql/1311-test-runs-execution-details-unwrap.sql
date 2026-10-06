-- EI-24799048791133095: test_runs.execution_details must be a jsonb OBJECT.
--
-- Most writers (the Vitest reporter in libs/test-config, the Playwright reporter,
-- the llm-test ledger) handed postgres-js a value they had already
-- JSON.stringify'd. A hand-rolled postgres(url) client keeps postgres-js's
-- default jsonb serializer, which is JSON.stringify, so the text was encoded a
-- second time and stored as a jsonb STRING scalar. Measured 2026-10-01:
-- 826,257 string rows against 6,477 object rows. Every
-- `execution_details->>'key'` read on a string row silently returns NULL, so
-- analytic SQL gets a confident, well-formed empty answer. The TypeScript
-- readers already decode both shapes (decodeStoredDetails), so nothing in-repo
-- depended on the string form.
--
-- The writers now pass the object itself. This migration covers the rest of
-- the class:
--   1. A BEFORE trigger unwraps a string that holds valid JSON text. Writers
--      from older generations keep inserting strings until they redeploy: the
--      :3070 release checkout, checkpoint clones of older candidates, and
--      other hive checkouts that share this database. The trigger also covers
--      any future writer that repeats the mistake.
--   2. A one-time backfill of the existing string rows.
--
-- pg_input_is_valid (PG16+; this server and embedded PG are 18.x) checks
-- validity WITHOUT a plpgsql EXCEPTION block. An EXCEPTION block opens a
-- subtransaction per row, and doing that ~800k times in one transaction would
-- overflow the subxid cache for every concurrent reader. A string that is not
-- valid JSON text is kept as written; readers already treat it as unproven.
-- Additive only (a function, a trigger, a data rewrite to an equivalent
-- value), so no FORWARD-COMPAT acknowledgment is needed.

CREATE OR REPLACE FUNCTION harness_shared.test_runs_unwrap_execution_details()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.execution_details IS NOT NULL
     AND jsonb_typeof(NEW.execution_details) = 'string'
     AND pg_input_is_valid(NEW.execution_details #>> '{}', 'jsonb') THEN
    NEW.execution_details := (NEW.execution_details #>> '{}')::jsonb;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS test_runs_unwrap_execution_details ON harness_shared.test_runs;
CREATE TRIGGER test_runs_unwrap_execution_details
  BEFORE INSERT OR UPDATE OF execution_details ON harness_shared.test_runs
  FOR EACH ROW EXECUTE FUNCTION harness_shared.test_runs_unwrap_execution_details();

-- Backfill. Same predicate as the trigger, so the rewrite is exactly what the
-- trigger would have stored. A row whose string is not valid JSON is left alone.
UPDATE harness_shared.test_runs
   SET execution_details = (execution_details #>> '{}')::jsonb
 WHERE execution_details IS NOT NULL
   AND jsonb_typeof(execution_details) = 'string'
   AND pg_input_is_valid(execution_details #>> '{}', 'jsonb');
