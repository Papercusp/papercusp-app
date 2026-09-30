-- 410-pty-viewer-heartbeats.sql
-- PTY-panel viewer-attach signal — the deferred sibling of the on-desktop reaper
-- exemption (agent-insights/on-desktop-sessions-reaper-exemption, 2026-06-29).
--
-- The wmctrl-based on-desktop signal only sees sessions with a real OS window. An
-- agent session a user is watching inside the operator web/Tauri terminal PANEL has
-- NO OS window, so the idle-session reaper could still SIGKILL it after 4h idle even
-- while it is on screen. This table carries the cross-process "a human is CURRENTLY
-- viewing this session's terminal" signal so the reaper can hard-exempt it.
--
-- WHY a table: the PTY WebSocket server runs IN the :3070 operator process (a
-- per-process in-memory pty registry), but the reaper runs on the SEPARATE bg-host
-- (bg-host-3270) — so the attach state must be PERSISTED for the reaper to read it
-- cross-process. One row per live viewer CONNECTION (pty_id), carrying the coord
-- owner (owner_sid) the reaper protects by — so multiple PTYs/viewers per owner each
-- get a row and one viewer detaching never clears another's protection. The row is
-- heartbeat-refreshed on the pty-ws 30s pong and deleted on close; the reader applies
-- a short TTL (3x the ping) so an ungraceful disconnect expires on its own.
--
-- IDEMPOTENT + non-destructive: a brand-new table, no existing-row impact. The reaper
-- reads it best-effort (a missing table / empty set just means "nobody is viewing",
-- so the gate behaves exactly as before until a viewer attaches). Re-runnable.

CREATE TABLE IF NOT EXISTS harness_shared.pty_viewer_heartbeats (
  pty_id             text PRIMARY KEY,
  owner_sid          text NOT NULL,
  viewer_attached_at timestamptz NOT NULL DEFAULT now()
);

-- The reaper's only read: SELECT DISTINCT owner_sid WHERE viewer_attached_at > now()-ttl.
-- Index leads with viewer_attached_at (the freshness filter) and covers owner_sid.
CREATE INDEX IF NOT EXISTS pty_viewer_heartbeats_fresh_idx
  ON harness_shared.pty_viewer_heartbeats (viewer_attached_at, owner_sid);
