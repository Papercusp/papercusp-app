-- 365-decision-ledger-autovacuum.sql
--
-- WI-406: per-table autovacuum tuning for harness_shared.decision_ledger.
--
-- ROOT CAUSE (WI-406): decision_ledger is a large (~778k-row) APPEND-MOSTLY ledger
-- (one row per governed action; n_tup_del=0, few updates). PostgreSQL derives the
-- autovacuum trigger threshold from pg_class.reltuples, so with the DEFAULT scale
-- factors it needs:
--   * VACUUM : 50 + 0.2 * reltuples(~741660) ~= 148,000 dead tuples
--   * ANALYZE: 50 + 0.1 * reltuples(~741660) ~=  74,000 modifications
-- A table that accrues only ~10k dead tuples between churn never reaches those, so the
-- daemon effectively NEVER (auto)vacuums or (auto)analyzes it: planner stats go stale
-- (last_analyze = NULL, planner blind) and the (small) dead tuples from updates are
-- never reclaimed. The "528 MB / 73.9% dead" alarm that opened WI-406 was a STALE-pgstat
-- artifact (counters reset by an unclean shutdown), NOT real bloat: a manual
-- VACUUM (ANALYZE) showed 778,009 live rows / 0 dead.
--
-- FIX: tune the scale factors DOWN per-table so the daemon maintains it at a sane
-- cadence regardless of size (mirrors su-16469's documented criterion: prefer a per-table
-- `ALTER TABLE SET` over reviving a manual-VACUUM routine). At ~778k rows this triggers:
--   * VACUUM  ~ 2000 + 0.02 * 778k ~= 17,500 dead tuples
--   * ANALYZE ~ 2000 + 0.02 * 778k ~= 17,500 modifications  (keeps planner stats fresh)
--   * INSERT-triggered VACUUM ~ 5000 + 0.05 * 778k ~= 44,000 inserts (visibility map / freeze)
--
-- `ALTER TABLE ... SET (storage params)` takes only SHARE UPDATE EXCLUSIVE (no table
-- rewrite, does not block reads/writes) and is naturally idempotent.

ALTER TABLE IF EXISTS harness_shared.decision_ledger SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 2000,
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_analyze_threshold = 2000,
    autovacuum_vacuum_insert_scale_factor = 0.05,
    autovacuum_vacuum_insert_threshold = 5000
);
