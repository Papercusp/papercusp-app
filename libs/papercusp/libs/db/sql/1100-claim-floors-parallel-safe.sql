-- 1100-claim-floors-parallel-safe.sql
--
-- work_items:claimable — the authoritative queue oracle — could not be read: it
-- failed with "canceling statement due to statement timeout" (EI-21553706255036686).
--
-- MEASURED CAUSE (2026-09-03, this database):
--   EXPLAIN (ANALYZE, BUFFERS) SELECT count(*)
--     FROM harness_shared.work_items_claimable WHERE harness_slug='papercusp'
--   => Execution Time: 12933 ms, Buffers: shared hit=11428278, Rows Removed by Filter: 82019
--   against a default statement_timeout of 5000 ms. So this is NOT a load-dependent
--   flake; the read is ~2.6x over the ceiling deterministically. (A call that passes a
--   LIMIT can still return, which is why the failure looks intermittent from the tool.)
--
-- The per-row cost is harness_shared.work_item_claim_floors(...) — evaluated for every
-- candidate row (~84k open rows in this harness). The planner is willing to parallelise
-- that bitmap heap scan and the server is provisioned for it
-- (max_parallel_workers_per_gather=8, max_parallel_workers=128), but ALL EIGHT
-- work_item_claim_floors* functions are marked PARALLEL UNSAFE, and a single
-- parallel-unsafe function anywhere in the query forbids a parallel plan outright.
--
-- That marking is the CREATE FUNCTION default, not a decision: every one of the eight is
-- provolatile='s' (STABLE), prolang=sql, procost=100 (also the default) — a uniform
-- default across the whole family is the signature of an omission. Their bodies are pure
-- read-only SELECT/EXISTS over harness_shared tables plus now(); they write nothing, use
-- no sequences, no temp tables, and call no parallel-unsafe function. They are therefore
-- genuinely PARALLEL SAFE.
--
-- This migration changes planner METADATA only. No function body, signature, or return
-- value is touched, so claim semantics are byte-identical before and after and the
-- currently-deployed release keeps working unchanged. COST is deliberately left alone so
-- that parallelism is the only variable and the effect can be measured cleanly; if the
-- predicate ordering also needs attention it belongs in its own migration.

DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'harness_shared'
       AND p.proname LIKE 'work_item_claim_floors%'
       AND p.proparallel = 'u'
  LOOP
    EXECUTE format('ALTER FUNCTION %s PARALLEL SAFE', r.sig);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'work_item_claim_floors*: marked % function(s) PARALLEL SAFE', n;
END
$$;
