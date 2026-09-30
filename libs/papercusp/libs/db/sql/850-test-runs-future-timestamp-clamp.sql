-- 850-test-runs-future-timestamp-clamp.sql
--
-- EI-20857750690095410 + EI-20816222655077027 (same root cause, filed 11h apart).
--
-- SYMPTOM: harness_shared.test_runs held 47 rows across 29 files stamped with
-- started_at/finished_at in the FUTURE — from 2026-09-08 out to 2027-08-09.
-- Both of this table's recency indexes are `... finished_at DESC`
-- (test_runs_file_path_idx, test_runs_source_idx), so a future-dated row wins
-- every latestPerFile / sinceHours slice for its file until that date passes.
-- The read still returns ok with a full-looking result, so an agent triaging a
-- red gate sees a plausible list of failures that is actually stale rows, and
-- the REAL current failures get pushed out of a bounded read. This is a
-- false-confidence failure, not a crash — which is why it survived 9 days.
--
-- MEASURED CAUSE (not the "leaked vi.setSystemTime fixture" the filings
-- suspected — that hypothesis does not survive the data): within ONE 86-second
-- run, every file came back skewed by EXACTLY 30.00 days, and a second run of
-- the SAME 9 files by EXACTLY 365.00 days, with the wall-clock time-of-day
-- preserved to the second. A per-test faketimer cannot do that, and the
-- reporter that stamps these values (libs/test-config/src/admin-test-runs-reporter.ts,
-- `const finishedAt = new Date()`) implements Reporter from 'vitest/node', so it
-- runs in the MAIN process where a worker's vi.setSystemTime cannot reach it.
-- The signature is a PROCESS-WIDE faked clock for a whole vitest run — i.e. a
-- suite deliberately run under a libfaketime-style +30d/+365d offset to exercise
-- expiry/TTL behaviour. That is a legitimate thing to do; silently poisoning the
-- shared ledger is the defect.
--
-- WHY THE GUARD LIVES HERE AND NOT IN THE REPORTER: there are 7+ distinct INSERT
-- sites into this table (the test-config reporter, an operator-core copy, two
-- playwright reporters, scripts/report-cargo-tests.mjs, and the Tests-tab
-- ingestion route bundled into papercusp-desktop/src-tauri/**/serve.mjs). The
-- serve.mjs ones are BUILD ARTIFACTS, so a source-level clamp cannot reach them
-- at all. Worse, a writer running under a faked clock cannot detect its own
-- poisoning: comparing `new Date()` against `new Date()` always agrees. The
-- database's now() is the one clock a test process cannot fake, so the only
-- place this can be enforced for every writer, present and future, is here.
-- (Per-source fixes for a per-registry problem are what guarantee a next
-- instance — this table has already grown 7 writers.)
--
-- WHY CLAMP RATHER THAN REJECT: every reporter is deliberately fail-soft (D-007:
-- "swallow every PG error; never throw out of any hook"), so a CHECK constraint
-- that REJECTED these rows would silently DISCARD real test results — strictly
-- worse than a wrong timestamp. Clamping also recovers the truth rather than
-- approximating it: the row is INSERTed at the real moment the run finished, and
-- created_at is DEFAULT now() (DB-stamped, unfakeable), so created_at is the
-- true finish time to within the insert latency. duration_ms is measured as an
-- elapsed delta and is unaffected by a constant clock offset, so it is preserved
-- and started_at is re-derived from it.
--
-- TOLERANCE: 5 minutes. Measured, not guessed — the poisoned population is
-- cleanly bimodal: all 47 bad rows are >= 30 DAYS ahead, and there is no
-- legitimate population anywhere near the boundary. The tolerance exists only so
-- ordinary app-host-vs-DB clock offset (and a 'running' row stamped a moment
-- ahead) is never touched.
--
-- (No top-level BEGIN/COMMIT: the migration runner wraps each file in its own
-- transaction — lint-migrations enforces this for every enforced-era file.)

CREATE OR REPLACE FUNCTION harness_shared.test_runs_clamp_future_timestamps()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  -- now() is transaction_timestamp(); stable within the txn and matches the
  -- column defaults for started_at/created_at.
  real_now  timestamptz := now();
  tolerance constant interval := interval '5 minutes';
  dur       interval;
BEGIN
  dur := make_interval(secs => COALESCE(NEW.duration_ms, 0) / 1000.0);

  IF NEW.finished_at IS NOT NULL AND NEW.finished_at > real_now + tolerance THEN
    NEW.finished_at := real_now;
    -- Re-derive the start from the PRESERVED duration, exactly as the reporter
    -- does (startedAt = finishedAt - durationMs).
    NEW.started_at := real_now - dur;
  ELSIF NEW.started_at > real_now + tolerance THEN
    -- A 'running' row (finished_at NULL), or a start stamped ahead of its own
    -- finish. Anchor to the real clock the same way.
    NEW.started_at := COALESCE(NEW.finished_at, real_now) - dur;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.test_runs_clamp_future_timestamps() IS
  'EI-20857750690095410: clamps future-dated started_at/finished_at to the DB clock at write time. A vitest run under a faked/offset process clock (libfaketime-style, observed at +30d and +365d) otherwise writes rows that win every finished_at DESC recency slice and mask real results. Fires for EVERY writer because the reporters are fail-soft and two of them are bundled build artifacts; a writer under a faked clock cannot detect its own skew.';

DROP TRIGGER IF EXISTS test_runs_clamp_future_timestamps ON harness_shared.test_runs;

CREATE TRIGGER test_runs_clamp_future_timestamps
  BEFORE INSERT OR UPDATE ON harness_shared.test_runs
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.test_runs_clamp_future_timestamps();

-- Repair the rows already in the ledger. created_at is DEFAULT now() and was
-- stamped by the database at the real insert moment, so it is the trustworthy
-- anchor; duration_ms is an elapsed delta and survives a constant clock offset.
UPDATE harness_shared.test_runs
   SET finished_at = created_at,
       started_at  = created_at - make_interval(secs => COALESCE(duration_ms, 0) / 1000.0)
 WHERE finished_at > now() + interval '5 minutes';

UPDATE harness_shared.test_runs
   SET started_at = created_at - make_interval(secs => COALESCE(duration_ms, 0) / 1000.0)
 WHERE started_at > now() + interval '5 minutes';
