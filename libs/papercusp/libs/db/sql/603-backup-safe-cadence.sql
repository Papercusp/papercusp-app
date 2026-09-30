-- Five-minute `both` cadence was unsafe as a default: every configured
-- workspace dumped the same harness_shared database, so four workspaces could
-- run pg_dump concurrently and snapshot a fresh large artifact every five
-- minutes. Make event-driven snapshots the safe default. Existing custom
-- interval choices are preserved; only rows still carrying the old unsafe
-- default are migrated. `enabled` is deliberately untouched, including rows
-- disabled by an operator during disk-pressure recovery.
--
-- No top-level BEGIN/COMMIT: the migration runner wraps each file in its own
-- transaction (a nested pair breaks its lock_timeout handling — lint P-038).

ALTER TABLE harness_shared.workspace_backup_settings
  ALTER COLUMN cadence_mode SET DEFAULT 'event',
  ALTER COLUMN cadence_minutes SET DEFAULT 60;

UPDATE harness_shared.workspace_backup_settings
SET cadence_mode = 'event',
    cadence_minutes = 60,
    updated_at = now()
WHERE cadence_mode = 'both'
  AND cadence_minutes = 5;
