-- 949-coord-presence-state-only-contract.sql
--
-- EI-21399888205771088 / agent-obligation-coupling-and-consult-liveness-2026-08-25:
-- coord_presence is a live, TTL-reaped projection. A historical query that
-- treats a missing presence row as "was absent at time T" produces false
-- positives after the reaper removes old rows. Put that contract in the
-- schema metadata an agent sees while describing the table, not only in a
-- prose runbook.
--
-- Metadata-only and idempotent. The baseline carries the same comments for a
-- fresh database; this migration updates databases that already ran 000.

COMMENT ON TABLE harness_shared.coord_presence IS
  'Live coordination state projection. Rows are TTL-reaped; absence means reaped or never-present, not absence at a historical time. Use append-only event/history records for historical claims.';

COMMENT ON COLUMN harness_shared.coord_presence.owner_id IS
  'Current live-state key. A missing owner row is not evidence that the owner was absent at an earlier time; coord_presence is TTL-reaped.';

COMMENT ON COLUMN harness_shared.coord_presence.heartbeat_at IS
  'Last observed heartbeat for the current live projection. This is not a historical presence record; rows are TTL-reaped after inactivity.';
