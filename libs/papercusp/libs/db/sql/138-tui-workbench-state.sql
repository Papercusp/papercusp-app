-- Migration 138 — harness_shared.tui_*: pui (apps/tui) workbench persistence.
--
-- Plan: tui-workbench-ratatui-2026-06-04 (P12 / D-002).
--
-- WHAT THIS IS: per-user persistence for the `pui` terminal workbench. D-002
-- names three persisted concepts (two user-facing, one quiet):
--   • tui_layouts    — a named LAYOUT = the zellij pane arrangement, stored as
--                      the KDL the workbench restores with (`zellij --layout`).
--   • tui_crews      — a named CREW = the saved SET of agent sessions in those
--                      panes ([{slot, agent, resume_id, harness, plan}]),
--                      restorable via `psu --resume`. May reference a companion
--                      layout (layout_name) so "restore my crew" brings back the
--                      whole working environment (layout + the agents) at once.
--   • tui_view_state — the QUIET UI/nav state (active tab, selections, filters,
--                      active harness/doc). One row per user; not a user-named
--                      artifact — persisted silently so a relaunch resumes where
--                      you were.
--
-- Keyed per user via owner_id (the pui owner key — the same stable id the HUD
-- uses for coord). Workspace-scoped + RLS-isolated exactly like snapshot_index
-- (migration 134) and blueprints (133): the operator connects as a SUPERUSER
-- role (harness_admin) which bypasses RLS and supplies workspace_id explicitly
-- (activeWorkspaceId()); the policy keeps any non-superuser path scoped.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS; DROP POLICY IF EXISTS before
-- CREATE; repeatable GRANTs. Composes onto 000-baseline.sql for fresh/embedded-pg
-- boots and applies cleanly on the native :5432 dev box.

\set ON_ERROR_STOP on
BEGIN;

-- ─── tui_layouts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.tui_layouts (
    workspace_id text NOT NULL,
    -- The pui owner key (stable per user; the same id the coord HUD filters on).
    owner_id     text NOT NULL,
    -- User-chosen layout name (the save/restore handle).
    name         text NOT NULL,
    -- The zellij KDL layout snapshot (`zellij action dump-layout` output); opaque
    -- text restored via `zellij --layout`.
    kdl          text NOT NULL,
    description  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, owner_id, name)
);

COMMENT ON TABLE harness_shared.tui_layouts IS
    'Named zellij pane-arrangement (KDL) snapshots for the pui workbench, per user (tui-workbench-ratatui-2026-06-04 D-002). Workspace-scoped; restored via `zellij --layout`.';

CREATE INDEX IF NOT EXISTS tui_layouts_owner_idx
    ON harness_shared.tui_layouts USING btree (workspace_id, owner_id, updated_at DESC);

ALTER TABLE harness_shared.tui_layouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tui_layouts_workspace_isolation ON harness_shared.tui_layouts;
CREATE POLICY tui_layouts_workspace_isolation ON harness_shared.tui_layouts
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.tui_layouts TO harness_app;
GRANT SELECT ON harness_shared.tui_layouts TO harness_zero;

-- ─── tui_crews ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.tui_crews (
    workspace_id text NOT NULL,
    owner_id     text NOT NULL,
    name         text NOT NULL,
    -- The saved set of agent sessions: [{slot, agent, resume_id, harness, plan,
    -- cwd?}] — restorable via `psu --resume`.
    members      jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Optional companion layout (a tui_layouts.name) so restoring a crew also
    -- restores its pane arrangement — the "whole working environment back in one
    -- command" (D-002).
    layout_name  text,
    description  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, owner_id, name)
);

COMMENT ON TABLE harness_shared.tui_crews IS
    'Named saved sets of pui agent sessions (members jsonb, restorable via `psu --resume`), per user, optionally bound to a companion tui_layouts.name (tui-workbench-ratatui-2026-06-04 D-002).';

CREATE INDEX IF NOT EXISTS tui_crews_owner_idx
    ON harness_shared.tui_crews USING btree (workspace_id, owner_id, updated_at DESC);

ALTER TABLE harness_shared.tui_crews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tui_crews_workspace_isolation ON harness_shared.tui_crews;
CREATE POLICY tui_crews_workspace_isolation ON harness_shared.tui_crews
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.tui_crews TO harness_app;
GRANT SELECT ON harness_shared.tui_crews TO harness_zero;

-- ─── tui_view_state ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.tui_view_state (
    workspace_id text NOT NULL,
    owner_id     text NOT NULL,
    -- Quiet UI/nav state: active tab, per-tab selections, filters, active
    -- harness/doc — whatever the workbench resumes on relaunch. Single row/user.
    state        jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, owner_id)
);

COMMENT ON TABLE harness_shared.tui_view_state IS
    'Quiet per-user UI/nav state for the pui workbench (active tab, selections, filters), one row per user — persisted silently so a relaunch resumes where you were (tui-workbench-ratatui-2026-06-04 D-002).';

ALTER TABLE harness_shared.tui_view_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tui_view_state_workspace_isolation ON harness_shared.tui_view_state;
CREATE POLICY tui_view_state_workspace_isolation ON harness_shared.tui_view_state
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.tui_view_state TO harness_app;
GRANT SELECT ON harness_shared.tui_view_state TO harness_zero;

COMMIT;
