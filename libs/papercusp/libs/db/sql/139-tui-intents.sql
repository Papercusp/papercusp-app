-- Migration 139 — harness_shared.tui_intents: the agent→`pui` control channel.
--
-- Plan: tui-workbench-ratatui-2026-06-04 (P12b / D-002 A6). The TUI analogue of
-- harness_shared.ui_intents (the browser-tab control channel behind `ui:dispatch`).
-- An agent calls `tui:dispatch { client_id, intent, args }` → INSERT a pending
-- row here; the `pui` instance with that client_id consumes it over the
-- `/api/tui/intents/stream` SSE, applies it to its AppState, and POSTs the result
-- to `/api/tui/intents/:id/result` (status pending→done/error). `tui:dispatch`
-- long-polls the row until it leaves 'pending'. Mirrors ui_intents byte-for-byte
-- in shape so the dispatcher logic is shared muscle.
--
-- No workspace_id / RLS (mirrors ui_intents): client_id IS the addressing +
-- trust boundary, and every path is loopback-gated. Idempotent.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.tui_intents (
    id            BIGSERIAL PRIMARY KEY,
    -- The target pui instance (its workbench owner key).
    client_id     text        NOT NULL,
    -- Intent name (e.g. 'get_state', 'set_tab', 'set_harness', 'select').
    intent        text        NOT NULL,
    args          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- pending → done | error | timeout.
    status        text        NOT NULL DEFAULT 'pending',
    result        jsonb,
    error_message text,
    -- The principal that dispatched (agent role / system).
    requested_by  text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz
);

COMMENT ON TABLE harness_shared.tui_intents IS
    'Agent→pui control channel (tui:dispatch): a pending row per intent, consumed by the targeted pui over /api/tui/intents/stream and resolved via /api/tui/intents/:id/result. The TUI analogue of ui_intents (tui-workbench-ratatui-2026-06-04 P12b/D-002 A6).';

-- Stream hot-path: a client's pending intents in id order.
CREATE INDEX IF NOT EXISTS tui_intents_client_pending_idx
    ON harness_shared.tui_intents USING btree (client_id, status, id);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.tui_intents TO harness_app;
GRANT SELECT ON harness_shared.tui_intents TO harness_zero;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.tui_intents_id_seq TO harness_app;

COMMIT;
