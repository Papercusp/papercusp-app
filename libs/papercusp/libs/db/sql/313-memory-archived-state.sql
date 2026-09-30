-- 313-memory-archived-state.sql
--
-- P-016 (watchdog-and-exposed-systems-improvement-2026-06-18):
-- Add 'archived' state to memory_canonical for reversible soft-archiving of
-- ephemeral-harness memories. The archived state is excluded from production
-- recall (read-side filter in canonical-store.ts + memory:search scope fan-out).
-- NOT a write-gate — ephemeral harnesses still write; they are only excluded
-- at read time. Reversible: UPDATE state = 'active' WHERE state = 'archived'.

-- Extend the CHECK constraint to include 'archived'.
ALTER TABLE harness_shared.memory_canonical
  DROP CONSTRAINT IF EXISTS memory_canonical_state_check,
  ADD CONSTRAINT memory_canonical_state_check
    CHECK (state = ANY (ARRAY[
      'active', 'broken_anchor', 'superseded', 'contradicted', 'forgotten', 'archived'
    ]));

-- Soft-archive the ~202 benchmark/ephemeral-harness memories identified in
-- the production memory_canonical table (as of 2026-06-18). These are from
-- hive/harness instances matching the ephemeral benchmark pattern
-- (hiveloop, e2e-imp, bench-, xbq*, memcap, DELETEME, p016-*, smoke-gen-*,
-- shared-hive-test-*, scope-test-*) that co-mingle with production memories.
-- The archived state means they are excluded from production recall queries
-- without being hard-deleted (reversible).
UPDATE harness_shared.memory_canonical
SET state = 'archived', updated_at = now()
WHERE state = 'active'
  AND payload->>'user_id' = ANY(ARRAY[
    'hive:hiveloop-hive',
    'hive:e2e-imp-j2',
    'hive:p016-rs2',
    'hive:smoke-generic-0615',
    'hive:smoke-gen-0615',
    'hive:p016-e2e',
    'hive:p016-resmoke',
    'hive:shared-hive-test-hive',
    'hive:bench-memcap-probe-DELETEME',
    'harness:hiveloop-hive',
    'hive:xbq72ugvazs',
    'hive:scope-test-1781758230'
  ]);
