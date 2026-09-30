-- 417: agent_fleets + presence fleet membership — named SU agent fleets
-- (named-su-agent-fleets-2026-06-29, D-001/D-002/D-003).
--
-- A "fleet" today is an EPHEMERAL derived view (fleet_assignment) over presence
-- + the spawn tree — no name, no id, no persistence. This adds a FIRST-CLASS,
-- PERSISTENT named fleet so a user can create/select one and route a plan to it,
-- and it stays selectable even after every member agent has been killed.
--
-- Two parts, mirroring the hive precedent:
--
--  (1) harness_shared.agent_fleets — the durable registry, modeled
--      column-for-column on harness_shared.hives (mig 184): PK
--      (workspace_id, fleet_slug); RLS workspace isolation (ENABLE not FORCE so
--      the owner bypasses for integration tests). `leader_owner_id` is the
--      CURRENT leader — the agent who created the fleet or last took it on a
--      handoff ("handoff agent becomes leader", D-002). This row persists with
--      ZERO live members, so the fleet stays selectable (D-003).
--
--  (2) shared_presence.fleet_slug / fleet_role — the SOFT, ephemeral membership
--      label an agent carries WHILE ALIVE (mirrors mig 187's hive_slug add).
--      Deliberately NOT an FK to spawned_agents (those get reaped); membership
--      is a label, the durable identity is the registry row. fleet_role is
--      'leader' | 'member' (text, designed extensible). "Available fleet" = a
--      registry row with >=1 live presence (heartbeat within PRESENCE_STALE_MS)
--      carrying its fleet_slug.
--
-- Fully idempotent.

CREATE TABLE IF NOT EXISTS harness_shared.agent_fleets (
    workspace_id    text NOT NULL,
    fleet_slug      text NOT NULL,
    title           text,
    description     text,
    owner           text,
    leader_owner_id text,
    created_at      bigint NOT NULL,
    updated_at      bigint DEFAULT 0 NOT NULL
);

DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_fleets_pkey'
  ) THEN
    ALTER TABLE ONLY harness_shared.agent_fleets
      ADD CONSTRAINT agent_fleets_pkey PRIMARY KEY (workspace_id, fleet_slug);
  END IF;
END
$body$;

ALTER TABLE harness_shared.agent_fleets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_fleets_workspace_isolation ON harness_shared.agent_fleets;
CREATE POLICY agent_fleets_workspace_isolation ON harness_shared.agent_fleets USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- (2) presence membership label (mirrors mig 187 hive_slug). Nullable: an agent
-- not in any named fleet keeps fleet_slug/fleet_role NULL (back-compat).
ALTER TABLE harness_shared.shared_presence ADD COLUMN IF NOT EXISTS fleet_slug text;
ALTER TABLE harness_shared.shared_presence ADD COLUMN IF NOT EXISTS fleet_role text;

CREATE INDEX IF NOT EXISTS shared_presence_fleet_recent_idx
  ON harness_shared.shared_presence USING btree (workspace_id, fleet_slug, last_seen_at DESC);
