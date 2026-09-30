-- 575-agent-fleets-control-state.sql
-- coord-authority-hardening-2026-07-11 P-009 (H4): a typed fleet CONTROL STATE
-- on the durable registry row, so "the fleet is winding down" is platform state
-- every member (and every LATE JOINER, at orient) reads from the registry —
-- not a free-text broadcast that only live members happen to see (the EI-9501
-- class: control semantics carried in prose).
--
--   control_state  : 'active' (default) | 'winding-down'
--   control_reason : the invoker's stated reason (free text, advisory)
--   control_by     : coord owner-id of the invoker (audit)
--   control_at     : epoch ms of the flip (matches created_at/updated_at style)
--
-- fleet:wind-down / fleet:resume (fleet:pause = alias of wind-down) are the
-- only writers; invokers restricted to owner / that fleet's leader / queen.

ALTER TABLE harness_shared.agent_fleets
  ADD COLUMN IF NOT EXISTS control_state  text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS control_reason text,
  ADD COLUMN IF NOT EXISTS control_by     text,
  ADD COLUMN IF NOT EXISTS control_at     bigint;

COMMENT ON COLUMN harness_shared.agent_fleets.control_state IS
  'Typed fleet control state (P-009 H4): active | winding-down. Set by fleet:wind-down / fleet:resume; surfaced to members at orient.';
COMMENT ON COLUMN harness_shared.agent_fleets.control_reason IS
  'Invoker-stated reason for the current control state (advisory free text).';
COMMENT ON COLUMN harness_shared.agent_fleets.control_by IS
  'Coord owner-id that set the current control state (audit).';
COMMENT ON COLUMN harness_shared.agent_fleets.control_at IS
  'Epoch ms when the current control state was set.';
