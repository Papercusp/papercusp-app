-- Migration 079 — adv_sessions.
--
-- Lifecycle row for every terminal session the /adv UI launches via
-- the console-launch endpoint (`/api/agent-mcp/console/launch`).
-- The /adv/sessions page reads this table to render the list of
-- active + recent sessions, with focus (live window) and
-- omp --resume (inactive) controls. See plans-admin-ui-2026-05-20.md
-- §Sessions tab (item 6).
--
-- Why a dedicated table rather than re-using audit_log: rows have a
-- mutable lifecycle (ended_at is set on child-exit) and the access
-- pattern is "rows where ended_at IS NULL" + "rows by plan_slug" —
-- neither efficient against audit_log's append-only shape.
--
-- Idempotent + non-destructive.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.adv_sessions (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  -- Slug of the plan this session was launched from. NULL when
  -- launched from outside the Plans tab (legacy nav-bar launchers,
  -- or future /adv surfaces that aren't plan-scoped).
  plan_slug       TEXT NULL,
  -- omp | console — distinguishes power-user OMP agent terminals
  -- from plain superuser shells. Matches the `mode` field on
  -- console-launch POST.
  mode            TEXT NOT NULL CHECK (mode IN ('omp', 'console')),
  -- The terminal binary that was spawned (gnome-terminal, alacritty,
  -- xterm, …) — useful for the focus query (filter wmctrl results
  -- by class).
  terminal_bin    TEXT NULL,
  -- OS pid of the spawned terminal process. Resolved to a window
  -- id at focus-button click time via `wmctrl -lp` / `xdotool
  -- search --pid`.
  pid             INT NULL,
  -- Cached X11/Wayland window id; populated by a background reaper
  -- some time after spawn or left NULL and resolved on demand.
  window_id       TEXT NULL,
  -- OMP `thread_id` captured from the spawned session's first
  -- stdout line; needed for `omp --resume <thread>`. NULL for
  -- console-mode sessions.
  omp_thread_id   TEXT NULL,
  -- Human-readable label shown in the list (e.g. derived from the
  -- plan title at launch time).
  label           TEXT NULL,
  -- The cwd handed to the launched terminal. Used as the fallback
  -- session-matching scope when the OMP session id was not linked yet.
  cwd             TEXT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set by the child-exit listener on the operator process when the
  -- spawned terminal exits. NULL means active.
  ended_at        TIMESTAMPTZ NULL,
  -- Exit code captured at the same time, when available.
  exit_code       INT NULL
);

CREATE INDEX IF NOT EXISTS adv_sessions_workspace_active_idx
  ON harness_shared.adv_sessions(workspace_id, started_at DESC)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS adv_sessions_workspace_recent_idx
  ON harness_shared.adv_sessions(workspace_id, started_at DESC);

CREATE INDEX IF NOT EXISTS adv_sessions_plan_idx
  ON harness_shared.adv_sessions(plan_slug, started_at DESC)
  WHERE plan_slug IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.adv_sessions TO harness_app, harness_admin;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.adv_sessions_id_seq TO harness_app, harness_admin;

COMMIT;
