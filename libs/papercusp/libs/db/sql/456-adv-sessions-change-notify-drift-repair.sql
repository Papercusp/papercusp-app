-- 456-adv-sessions-change-notify-drift-repair.sql
--
-- WI-418 verification finding: migration 396 (coord-links-change-notify.sql) recorded two
-- CREATE OR REPLACE TRIGGER statements — one on harness_shared.coord_links (the AUDIT-BLOCKER
-- this migration exists for) and one on harness_shared.adv_sessions (P-005 trigger-coverage
-- fast-follow, adv_sessions.list / advRoster.list cache invalidation). 396 IS recorded as
-- applied (schema_migrations, 2026-06-24), and the coord_links trigger IS live
-- (pg_trigger confirms emit_change_notify_trg on harness_shared.coord_links) — but the
-- adv_sessions trigger is ABSENT live (confirmed via information_schema.triggers: zero rows
-- for adv_sessions). Root cause not reproducible after the fact (statement-level drift on a
-- multi-statement migration file, not a code defect in THIS migration's SQL — the CREATE OR
-- REPLACE TRIGGER syntax is correct and adv_sessions is an ordinary table (relkind 'r') with
-- an `id` PK, so nothing about the statement itself explains the gap). Whatever the cause,
-- the effect is real schema drift: raw-SQL / FEDERATED writes to adv_sessions do NOT
-- invalidate the adv_sessions.list / advRoster.list sync queries.
--
-- This migration is the DURABLE repair: idempotently (re-)create the trigger so a fresh
-- deploy / any environment that also drifted converges to the documented state regardless of
-- history. Idempotent (CREATE OR REPLACE TRIGGER; safe to re-run / re-deploy).

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.adv_sessions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
