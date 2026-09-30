-- 596: one-shot, generation-watermarked CTRL transition delivery
-- (agent-operability-improvements-implementation-2026-07-13 P-014 / D-004 / D-008).
--
-- Extend P-013's existing per-owner session_briefs projection. A semantic
-- control-state change replaces the pending transition; the turn-start hook
-- atomically advances control_delivered_generation when it injects either the
-- exact next transition or a full resync. Canonical state remains in the
-- owning mode/loop/fleet/scope stores.

ALTER TABLE harness_shared.session_briefs
  ADD COLUMN IF NOT EXISTS control_transition           jsonb,
  ADD COLUMN IF NOT EXISTS control_delivered_generation bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN harness_shared.session_briefs.control_transition IS
  'Latest typed CTRL transition (state + previous/current generation + provenance). Superseded or generation-behind payloads are never merged; the consumer emits a full resync.';

COMMENT ON COLUMN harness_shared.session_briefs.control_delivered_generation IS
  'Highest CTRL generation atomically delivered by the turn-start hook. A gap or stale pending transition forces full-state replacement.';
