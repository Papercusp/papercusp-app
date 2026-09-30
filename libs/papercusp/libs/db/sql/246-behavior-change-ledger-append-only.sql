-- 246-behavior-change-ledger-append-only.sql
--
-- self-learning-frontier-2026-06-12 (P-004 / FB-02 follow-up): ENFORCE the
-- append-only invariant 242 declared. 242 granted harness_app SELECT + INSERT
-- only, but the baseline's ALTER DEFAULT PRIVILEGES in harness_shared hands
-- harness_app ALL on every new table at CREATE time — so the live grant set
-- silently widened to SELECT/INSERT/UPDATE/DELETE. A ledger row is history:
-- a mutation happened or it didn't; nothing running as the app role may
-- rewrite it.
--
-- Idempotent (REVOKE is); additive-safe; fresh-migrate-safe (runs after 242).

REVOKE UPDATE, DELETE, TRUNCATE ON harness_shared.behavior_change_ledger FROM harness_app;
REVOKE UPDATE, DELETE, TRUNCATE ON harness_shared.behavior_change_ledger FROM harness_zero;
