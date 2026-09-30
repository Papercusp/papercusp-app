-- 595: generation-stamped compact agent control anchor
-- (agent-operability-improvements-implementation-2026-07-13 P-013 / D-004 / D-008).
--
-- Reuse the durable per-owner session_briefs row rather than introducing a
-- parallel session-state table. The canonical state remains in agent_modes,
-- routines, fleet_membership_events, plan_item_claims, and the lane columns on
-- session_briefs; control_state is a deliberately tiny projection used to
-- recover those high-importance facts across compaction. control_generation is
-- incremented only when that semantic projection changes.

ALTER TABLE harness_shared.session_briefs
  ADD COLUMN IF NOT EXISTS control_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS control_state      jsonb,
  ADD COLUMN IF NOT EXISTS control_updated_at timestamptz;

COMMENT ON COLUMN harness_shared.session_briefs.control_generation IS
  'Monotonic generation of the compact CTRL projection. Incremented only when control_state changes; generation-behind consumers must full-resync.';

COMMENT ON COLUMN harness_shared.session_briefs.control_state IS
  'Compact, bounded projection of modes, loop/carry, route, and active scope. Canonical state remains in the owning stores; coord:orient {afterCompaction:true} is the full-resync path.';

COMMENT ON COLUMN harness_shared.session_briefs.control_updated_at IS
  'Timestamp at which control_state last changed semantically (not every read/reconciliation).';
