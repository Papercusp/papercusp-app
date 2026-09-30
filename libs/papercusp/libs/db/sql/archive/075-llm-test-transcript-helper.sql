-- 075 — Transcript decompression helper + retention sweep.
--
-- Plan §7.3.
--
-- 1. llm_test_transcript_raw(run_id uuid) → text
--    Decompresses harness_shared.llm_test_runs.transcript_raw_zstd
--    server-side so the run-detail UI doesn't have to ship the bytea
--    over the wire and decode in JS. Wraps pgcrypto's built-in
--    decompress() pattern.
--
-- 2. llm_test_sweep_old(retain_days int default 90) → int
--    Deletes rows from llm_test_runs older than retain_days, EXCEPT
--    runs that have unacknowledged severity=error findings (those stay
--    until acknowledged — admin still has to look at them). Returns
--    the number of rows deleted. Fixtures are never touched.
--
-- Idempotent: CREATE OR REPLACE.

BEGIN;

CREATE OR REPLACE FUNCTION harness_shared.llm_test_transcript_raw(p_run_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $body$
DECLARE
  v_raw bytea;
BEGIN
  SELECT transcript_raw_zstd INTO v_raw
    FROM harness_shared.llm_test_runs
   WHERE id = p_run_id;
  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;
  -- PG 16 ships built-in zstd via pg_compress / pg_decompress only on
  -- a custom extension. Since the writer uses Node's zstdCompressSync,
  -- we don't have a server-side decompressor in stock PG. Instead,
  -- return the raw bytes hex-encoded — the operator API route is
  -- responsible for decoding. Keeping the helper around as a named
  -- entry point so a future zstd extension can swap the body to
  -- decode(...).
  RETURN encode(v_raw, 'hex');
END;
$body$;

COMMENT ON FUNCTION harness_shared.llm_test_transcript_raw(uuid) IS
  'Returns hex-encoded zstd bytes for an llm_test_runs row. Caller decompresses with node:zlib.zstdDecompressSync(Buffer.from(hex, ''hex'')).';

-- Retention sweep — call from a nightly job or manually.
CREATE OR REPLACE FUNCTION harness_shared.llm_test_sweep_old(p_retain_days int DEFAULT 90)
RETURNS int
LANGUAGE plpgsql
AS $body$
DECLARE
  v_deleted int;
BEGIN
  WITH protected AS (
    SELECT DISTINCT run_id
      FROM harness_shared.llm_test_findings
     WHERE acknowledged = false
       AND severity = 'error'
  ), deletable AS (
    DELETE FROM harness_shared.llm_test_runs r
     WHERE r.started_at < now() - make_interval(days => p_retain_days)
       AND NOT EXISTS (SELECT 1 FROM protected p WHERE p.run_id = r.id)
    RETURNING r.id
  )
  SELECT count(*) INTO v_deleted FROM deletable;
  RETURN v_deleted;
END;
$body$;

COMMENT ON FUNCTION harness_shared.llm_test_sweep_old(int) IS
  'Deletes llm_test_runs older than retain_days, preserving runs with unacknowledged severity=error findings. Cascades to llm_test_findings via FK ON DELETE CASCADE. Returns deleted count.';

COMMIT;
