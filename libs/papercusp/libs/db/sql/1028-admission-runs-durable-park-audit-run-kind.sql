-- 1028: give durable-park-audit its own admission_runs.run_kind
--
-- The durable-park audit has been filing its ledger rows under
-- run_kind = 'daily-digest' (DURABLE_PARK_AUDIT_RUN_KIND in
-- work-items-durable-park-audit.ts). That was not an oversight: migration 944
-- constrained run_kind to five literals and 'durable-park-audit' was not one of
-- them, so the producer borrowed the nearest allowed value.
--
-- The cost is that the ledger's OWN grouping key conflates two unrelated
-- producers. An independent acceptance grader (EI-21844734848781188) hit this
-- directly: the rubric's prescribed method is to group admission_runs by
-- run_kind, and doing so silently attributes 9 durable-park rows to the daily
-- digest. A grouping key that lies is worse than a missing one, because the
-- resulting count looks like evidence.
--
-- FORWARD-COMPAT: this only WIDENS the CHECK (every previously-legal value stays
-- legal), so the currently-deployed release keeps writing 'daily-digest' without
-- error until it is replaced. The backfill below moves 9 historical rows out
-- from under 'daily-digest'; the deployed release reads durable-park rows by
-- that same literal, so until it rolls forward it sees those 9 rows as absent.
-- That is a history-only read change to a report whose job is to describe
-- CURRENT park state, and no code branches on their presence.

-- 1. Widen the constraint FIRST — the backfill below writes the new value, so
--    the reverse order would fail the CHECK mid-transaction.
ALTER TABLE harness_shared.admission_runs
  DROP CONSTRAINT IF EXISTS admission_runs_run_kind_check;

ALTER TABLE harness_shared.admission_runs
  ADD CONSTRAINT admission_runs_run_kind_check
  CHECK (run_kind IN (
    'census',
    'promoter-tick',
    'bulk-stage',
    'delta-sweep',
    'daily-digest',
    'durable-park-audit'
  ));

-- 2. Backfill the mis-filed history. Both park modes ('durable-park-audit' and
--    'durable-park-reconcile') come from the same producer and share the new
--    run_kind; detail->>'mode' continues to distinguish them, exactly as
--    'promoter' and 'fail-open' are distinguished within 'promoter-tick'.
--
--    Keyed on detail->>'mode' rather than on an id pattern: mode is what the
--    producer actually writes, so this cannot sweep up a genuine digest row
--    (those carry no 'mode' key at all).
UPDATE harness_shared.admission_runs
   SET run_kind = 'durable-park-audit'
 WHERE run_kind = 'daily-digest'
   AND detail->>'mode' IN ('durable-park-audit', 'durable-park-reconcile');
