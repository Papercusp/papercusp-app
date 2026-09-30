-- 294: hive_directory_tombstones — withdrawal-tombstone watermarks for the P2P
-- hive directory (one JSONB row per workspace, the operator-state pattern).
-- Plan hive-from-repo-hardening-2026-06-11 P-005. Payload shape:
--   { tombstones: Record<hiveId, withdrawnAtMs> }  (so a reboot can't resurrect
--   a withdrawn hive from the offline cache).
--
-- BUG FIX: operator-state-pg.ts stores each StateTable in its OWN
-- `harness_shared.<name>` table (the read is `SELECT payload FROM
-- harness_shared.hive_directory_tombstones`). The StateTable union declared
-- 'hive_directory_tombstones' with a "same row mechanics as the cache; no new
-- migration needed" note — but that was wrong: each state name needs its own
-- table. Migration 182 created hive_directory_cache only, so every
-- read/writeOperatorState('hive_directory_tombstones') failed with
-- `relation "harness_shared.hive_directory_tombstones" does not exist` (the
-- calls are .catch()-wrapped, so it degraded to "no tombstones" + log spam).
-- This is the missing table. Idempotent; mirrors 182-hive-directory-cache.sql.

CREATE TABLE IF NOT EXISTS harness_shared.hive_directory_tombstones (
    workspace_id text NOT NULL,
    payload jsonb NOT NULL,
    updated_at bigint DEFAULT 0 NOT NULL
);

DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hive_directory_tombstones_pkey'
  ) THEN
    ALTER TABLE ONLY harness_shared.hive_directory_tombstones
      ADD CONSTRAINT hive_directory_tombstones_pkey PRIMARY KEY (workspace_id);
  END IF;
END
$body$;

ALTER TABLE harness_shared.hive_directory_tombstones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hive_directory_tombstones_workspace_isolation ON harness_shared.hive_directory_tombstones;
CREATE POLICY hive_directory_tombstones_workspace_isolation ON harness_shared.hive_directory_tombstones USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
