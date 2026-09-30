-- 106-adv-sessions-coord-owner.sql
--
-- adv-sessions-live-roster-2026-06-02 P-001.
--
-- Add coord_owner_id to harness_shared.adv_sessions: the coord identity
-- (PAPERCUSP_SID) the psu launcher bakes into the session env — `su-<uuid>`
-- for an engineer SU session, `role-<uuid>` for a pipeline-role session. It is
-- the deterministic join key to harness_shared.coord_presence.owner_id, so the
-- /adv Sessions roster can enrich a live presence row with its launch metadata
-- (plan/role/feature) and durable history. NULL for console launches and for
-- pre-existing rows (no SID minted at record time) — those show durable
-- metadata only, no live join, until relaunched. (D-001)
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. No \set / BEGIN / COMMIT — the
-- embedded-pg migration runner strips psql metacommands and wraps each file in
-- its own txn.

ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS coord_owner_id TEXT NULL;

-- The roster join is coord_presence.owner_id = adv_sessions.coord_owner_id.
-- Partial index on the join key (only rows that carry one).
CREATE INDEX IF NOT EXISTS adv_sessions_coord_owner_idx
  ON harness_shared.adv_sessions (coord_owner_id)
  WHERE coord_owner_id IS NOT NULL;
