-- 500-agent-modes.sql — official session modes as first-class data
-- (modes-and-intake-ux-2026-07-05 P-005; owner directive 2026-07-05).
--
-- agent_modes: the CURRENT mode set per agent, one row per (owner, axis-key).
-- Axis semantics (D-006): modes live on axes; same-axis modes exclude each
-- other (mode:set auto-switches, recording the displaced mode in the audit),
-- cross-axis modes stack. axis_key values:
--   'autonomy'      — auto | cold-auto        (one of; absence = manual)
--   'work-source'   — ideate | drain          (one of; absence = directed)
--   'overlay:<id>'  — grade, future overlays  (each overlay its own key ⇒ stackable)
--
-- owner_directed marks a mode the human owner explicitly instructed (the
-- owner-sticky carve-out, D-003): a PEER's mode:set cannot override it — the
-- attempt is rejected and downgraded to a request message.
--
-- agent_mode_changes: append-only audit of every transition (incl. the
-- auto-switch displacements), the "who flipped whom, from what, to what, why".

CREATE TABLE IF NOT EXISTS harness_shared.agent_modes (
    workspace_id   text NOT NULL DEFAULT 'default',
    owner_id       text NOT NULL,
    axis_key       text NOT NULL,
    mode           text NOT NULL,
    reason         text NOT NULL DEFAULT '',
    set_by         text NOT NULL,
    owner_directed boolean NOT NULL DEFAULT false,
    set_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, owner_id, axis_key)
);

CREATE INDEX IF NOT EXISTS agent_modes_owner_idx
    ON harness_shared.agent_modes (owner_id);

CREATE TABLE IF NOT EXISTS harness_shared.agent_mode_changes (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id   text NOT NULL DEFAULT 'default',
    owner_id       text NOT NULL,
    axis_key       text NOT NULL,
    old_mode       text,
    new_mode       text,
    reason         text NOT NULL DEFAULT '',
    set_by         text NOT NULL,
    owner_directed boolean NOT NULL DEFAULT false,
    changed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_mode_changes_owner_idx
    ON harness_shared.agent_mode_changes (workspace_id, owner_id, changed_at DESC);
