-- WI-9313 / db-performance-remediation-2026-07-26 D-033: let harness_admin reclaim
-- pg_stat_statements entries belonging to DROPPED databases.
--
-- THE LEAK
-- --------
-- pg_stat_statements has no DROP DATABASE hook. An entry is keyed on
-- (userid, dbid, queryid, toplevel), and when its database is dropped the entry is
-- simply retained — forever. Backups/dumps run against TRANSIENT databases, so every
-- such dump permanently consumes entry slots that nothing will ever reclaim.
--
-- Measured live 2026-08-03: 3,303 of 9,791 entries (33.7%) carried a dbid that returns
-- NO row from pg_database, spread over 23 dropped databases (oids 13,123,820 …
-- 16,006,737 — recently-created, short-lived). Their content is unmistakably pg_dump:
-- `PREPARE dumpFunc(pg_catalog.oid)`, `pg_catalog.pg_get_viewdef`,
-- `pg_catalog.format_type`, `COPY harness_shared.operator_first_run … TO stdout`.
--
-- WHY IT MATTERS (measurement integrity, not housekeeping)
-- -------------------------------------------------------
-- pg_stat_statements.max is 10000 and is POSTMASTER-context (a restart to change).
-- At 97.9% full Postgres begins evicting, and it evicts by LOW USAGE — so it discards
-- REAL application statistics. Measured dealloc: 332 over 24.6 days = 13.5/day. An
-- evicted-then-recreated entry's next delta reads as a PHANTOM SPIKE, which is exactly
-- the measurement defect db-performance-remediation-2026-07-26 already fought and fixed
-- once. The leak therefore attacks the plan's own instrument.
--
-- WHY A GRANT IS NEEDED
-- --------------------
-- pg_stat_statements_reset() is superuser-only by default. harness_admin (the role the
-- operator, dev:pg_query and every agent DB tool connect as) holds only
-- pg_read_all_stats (granted by migration 733) — that is READ access to the stats
-- views and does NOT permit reset. Verified 2026-08-03:
--   has_function_privilege('harness_admin', 'pg_stat_statements_reset(...)', 'EXECUTE')
--   => false;  rolsuper('harness_admin') => false.
-- Without this grant the reclaim sweep can only ever report 'no-privilege' and the
-- residue grows unbounded.
--
-- SCOPE OF WHAT THIS GRANTS
-- -------------------------
-- EXECUTE on one function that discards MONITORING COUNTERS. It confers no DML, no DDL,
-- no data access, and cannot affect correctness of anything but perf statistics — the
-- minimum privilege that makes the reclaim possible. The sweep itself refuses to pass
-- dbid = 0 (which means "ALL databases" to this function) and only ever targets a dbid
-- absent from pg_database; see db-pgss-orphan-stats-reclaim.ts.
--
-- Signature is pinned to pg_stat_statements 1.12 (PG 18), which takes FOUR arguments:
--   pg_stat_statements_reset(userid oid, dbid oid, queryid bigint, minmax_only boolean)
-- The 3-arg form of earlier versions does NOT exist here — verified by pg_proc.
--
-- Defensive by design: the grant requires ownership of the function (postgres_app) or
-- superuser. Migration 733 proves the runner can grant a predefined ROLE membership,
-- but function-ownership is a DIFFERENT privilege, so a failure here must not red the
-- whole deploy — the sweep degrades to a named 'no-privilege' skip and says so in its
-- log line rather than silently doing nothing. Idempotent: re-granting is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
    RAISE NOTICE '[756] pg_stat_statements not installed; nothing to grant';
    RETURN;
  END IF;

  BEGIN
    GRANT EXECUTE ON FUNCTION pg_stat_statements_reset(oid, oid, bigint, boolean)
      TO harness_admin;
    RAISE NOTICE '[756] granted EXECUTE on pg_stat_statements_reset to harness_admin';
  EXCEPTION
    WHEN insufficient_privilege OR undefined_function THEN
      -- Not fatal: the reclaim sweep checks has_function_privilege() before acting and
      -- reports skipped='no-privilege', so the system stays correct — it just cannot
      -- reclaim until a superuser runs this GRANT by hand.
      RAISE WARNING '[756] could NOT grant EXECUTE on pg_stat_statements_reset to harness_admin (%). The pgss orphan-stats reclaim sweep will report skipped=no-privilege until a superuser runs: GRANT EXECUTE ON FUNCTION pg_stat_statements_reset(oid,oid,bigint,boolean) TO harness_admin;', SQLERRM;
  END;
END
$$;
