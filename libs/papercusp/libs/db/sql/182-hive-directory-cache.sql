-- 182: hive_directory_cache — the offline cache for the P2P hive directory
-- (one JSONB row per workspace, the operator-state pattern). Plan
-- p2p-hive-directory-2026-06-06 P-003. Payload shape:
--   { hives: DiscoveredHive[] }  (the verified discovered set, for offline
--   listing before the swarm reconnects — a CACHE, never the transport).
-- Idempotent; mirrors operator_voice_channels (PK + RLS workspace isolation).

CREATE TABLE IF NOT EXISTS harness_shared.hive_directory_cache (
    workspace_id text NOT NULL,
    payload jsonb NOT NULL,
    updated_at bigint DEFAULT 0 NOT NULL
);

DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hive_directory_cache_pkey'
  ) THEN
    ALTER TABLE ONLY harness_shared.hive_directory_cache
      ADD CONSTRAINT hive_directory_cache_pkey PRIMARY KEY (workspace_id);
  END IF;
END
$body$;

ALTER TABLE harness_shared.hive_directory_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hive_directory_cache_workspace_isolation ON harness_shared.hive_directory_cache;
CREATE POLICY hive_directory_cache_workspace_isolation ON harness_shared.hive_directory_cache USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
