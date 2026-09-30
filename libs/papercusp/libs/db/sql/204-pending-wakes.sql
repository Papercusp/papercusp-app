-- 204-pending-wakes.sql
-- hive-agent-tabs-psu-tui-2026-06-09 P-007 / D-005.
--
-- The STAGED-wake queue. When an agent's wake-mode is `manual` (the
-- operator_settings wake_mode store, P-015), `wakeRecipients` (the single
-- inbox-wake chokepoint) STAGES the wake here instead of firing it; the owner
-- reviews + releases / edits / skips them from the agent's pane (P-008/P-009).
-- Gated by HIVE_AGENT_TABS — stays empty + inert when the flag is off / no agent
-- is in manual mode (default auto).
CREATE TABLE IF NOT EXISTS harness_shared.pending_wakes (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id     text NOT NULL,
    summary      text,
    payload      jsonb,
    source       text,
    workspace_id text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- The owner's staged queue, oldest-first (the pane lists + releases in order).
CREATE INDEX IF NOT EXISTS pending_wakes_owner_idx
    ON harness_shared.pending_wakes (owner_id, id);
