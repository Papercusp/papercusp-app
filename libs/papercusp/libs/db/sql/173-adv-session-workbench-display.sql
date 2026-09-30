-- 173-adv-session-workbench-display.sql — pui-reactive-session-panes-2026-06-05 (D-006).
--
-- The "pending workbench launch" tier: the desktop's new-session action RECORDS a
-- session (does not spawn — D-001) and the pui reactively opens a zellij work-area
-- pane for it. Three columns on adv_sessions carry that:
--
--   display      — 'workbench' marks a pane-worthy INTERACTIVE launch (D-002). The
--                  pui panes ONLY these; autonomous fleet:spawn rows leave it NULL.
--   launch_argv  — the exact argv the pui pane runs (a fresh `psu …`), so the
--                  record endpoint is the single source of truth and the pane is a
--                  pure executor. The psu it launches records its OWN row with
--                  display=NULL, so the live session is never re-paned.
--   launched_at  — set when the pui consumes the request by opening its pane. A
--                  PENDING workbench launch is `display='workbench' AND launched_at
--                  IS NULL AND ended_at IS NULL`; once paned it drops out of the
--                  pending set (restart-safe: a consumed request is never re-paned).
--
-- Nullable + idempotent: every existing row reads NULL (a normal, already-spawned
-- session), so the roster's presence-primary behavior is unchanged for them.

ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS display      TEXT,
  ADD COLUMN IF NOT EXISTS launch_argv  JSONB,
  ADD COLUMN IF NOT EXISTS launched_at  TIMESTAMPTZ;

-- Roster pending-launch lookup: workbench requests not yet consumed or ended.
CREATE INDEX IF NOT EXISTS adv_sessions_pending_workbench_idx
  ON harness_shared.adv_sessions (workspace_id, started_at DESC)
  WHERE display = 'workbench' AND launched_at IS NULL AND ended_at IS NULL;
