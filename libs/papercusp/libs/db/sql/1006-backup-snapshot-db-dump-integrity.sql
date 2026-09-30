-- Migration 1006 — explicit tri-state database-dump integrity for backups.
--
-- EI-21643729038023791
--
-- A Kopia snapshot can succeed while the pre-snapshot pg_dump fails (for
-- example, after the 900s pg_dump watchdog kills the gzip pipeline). The
-- existing `status='degraded'` value is useful for the file artifact, but it
-- is not a durable, queryable statement about database-dump completeness.
--
-- Nullable is intentional. Rows written before this migration, and resumed
-- workflows whose cached pre-snapshot hook result is unavailable, remain
-- UNKNOWN rather than being backfilled as successful or failed.

ALTER TABLE harness_shared.backup_snapshots
  ADD COLUMN IF NOT EXISTS db_dump_ok boolean;

COMMENT ON COLUMN harness_shared.backup_snapshots.db_dump_ok IS
  'Tri-state pre-snapshot database dump outcome: true=landed, false=missing/failed, NULL=unknown for legacy or unavailable hook evidence.';
