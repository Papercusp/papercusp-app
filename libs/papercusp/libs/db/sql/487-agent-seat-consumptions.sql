-- 487-agent-seat-consumptions.sql — agent-allocation-framework-2026-07-03 P-005.
-- WHICH live session consumes WHICH delegated agent seat (D-002's agent_slot
-- allotments, mig 486): launch-from-seats spawns a member with `psu --seat=<ref>`
-- and bootstrap-su records the consumption here, keyed to the session's coord
-- owner id, BEFORE any other bookkeeping (same no-ghost ordering as the WI-1893
-- fleet stamp).
--
-- consumed-vs-available is a LIVENESS-JOINED read, not a decrement: a seat is
-- consumed while its owner row is fresh in coord_presence (or still inside the
-- boot-grace window — a booting member has a consumption row before its first
-- presence write). A dead member's presence goes stale/reaped → its seat frees
-- itself, no release call needed (self-healing, mirrors the fleet member-count
-- semantics in fleet-roster.ts). Old+dead rows are lazily purged on read
-- (seat-accounting.ts countConsumedSeats).
--
-- One seat per session: owner_id is the PK — a session cannot consume two seats,
-- and a bootstrap retry upserts rather than double-counting.
--
-- LOCAL, per-machine (M19) like resource_allotments — Phase 3 federates seat
-- OFFERS via the offer-store/directory (D-005), never these rows.
--
-- Idempotent; apply via the runner (db:migrate) or psql + a schema_migrations
-- row in one txn.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.agent_seat_consumptions (
  owner_id     text PRIMARY KEY,
  workspace_id text NOT NULL,
  fleet_slug   text NOT NULL,
  -- The slot template '<model>:<effort>:<account>' (resource_allotments.resource_ref
  -- for the agent_slot row; derived by agentSlotRef so ref↔axis cannot disagree).
  seat_ref     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The consumed-count read: (workspace, fleet[, seat_ref]) grouped counts.
CREATE INDEX IF NOT EXISTS agent_seat_consumptions_fleet_idx
  ON harness_shared.agent_seat_consumptions (workspace_id, fleet_slug, seat_ref);

COMMENT ON TABLE harness_shared.agent_seat_consumptions IS
  'agent-allocation-framework P-005: live seat consumption for agent_slot allotments (mig 486). One row per seat-consuming session (owner_id PK), written at bootstrap-su; consumed = rows with fresh coord_presence or inside the boot grace. Lazily purged when old+dead (seat-accounting.ts).';

COMMIT;
