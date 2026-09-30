-- 479-shared-session-presence-fleet-slug.sql
-- p2p-work-distribution-2026-07-02 P-301 (federate the fleet registry + membership).
--
-- The named-fleet MEMBERSHIP label (fleet_slug / fleet_role) lives on the LOCAL
-- roster (coord_presence, mig 417) but was never carried across machines: the
-- federated session roster (shared_session_presence, mig 434) had no fleet columns,
-- so a fleet whose members span two machines resolved `@fleet:<slug>` to its LOCAL
-- members only — a cross-machine member was invisible to the coord audience.
--
-- This adds the two membership columns to the federated session roster (the exact
-- pair mig 417 added to coord_presence, and mig 475 added to spawned_agents), so the
-- session-presence gossip frame can stamp each remote session's fleet membership and
-- the audience resolver can union cross-machine members + a cross-machine leader.
--
-- Additive + nullable: a session in no named fleet keeps fleet_slug/fleet_role NULL
-- (back-compat); an OLD sender that never stamps the field lands NULL (simply not
-- attributed to a fleet). Fully idempotent.

BEGIN;

ALTER TABLE harness_shared.shared_session_presence
  ADD COLUMN IF NOT EXISTS fleet_slug text;
ALTER TABLE harness_shared.shared_session_presence
  ADD COLUMN IF NOT EXISTS fleet_role text;

-- The federated analogue of coord_presence's fleet-membership read: "live remote
-- sessions carrying fleet F". Partial index (only fleet-attributed rows) keeps the
-- per-send `@fleet:<slug>` federated expansion cheap as the table grows.
CREATE INDEX IF NOT EXISTS shared_session_presence_fleet_idx
  ON harness_shared.shared_session_presence (workspace_id, fleet_slug, last_seen_at DESC)
  WHERE fleet_slug IS NOT NULL;

COMMIT;
