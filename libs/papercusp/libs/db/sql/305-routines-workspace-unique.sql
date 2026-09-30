-- 305-routines-workspace-unique.sql — workspace-data-isolation-leaks-2026-06-17 F-E1 (PHASE 1).
--
-- harness_shared.routines is keyed UNIQUE (install_slug, name) — GLOBAL. So a hive
-- created in workspace B with the same install_slug+routine name as one in workspace A
-- upserts ON CONFLICT (install_slug, name) and CLOBBERS A's routine (flips its
-- workspace_id, reschedules it). routines already carries workspace_id (NOT NULL), so
-- the fix is to let the upsert conflict on (workspace_id, install_slug, name) instead.
--
-- This migration is ADDITIVE: it ADDS the composite unique and KEEPS the old one, so
-- BOTH ON CONFLICT targets stay valid across the deploy — no cutover window. The code
-- (routines-runtime.ts upsertRoutine) chooses the target by the papercusp-routines-per-
-- workspace flag (default OFF = today's ON CONFLICT (install_slug, name), byte-identical).
--
-- Safe to add now: there are ZERO live cross-workspace (install_slug, name) collisions
-- (verified 2026-06-17), so every existing row is already unique on the composite key.
--
-- NOTE phase 2 (separate, staged): to let same-slug routines fully COEXIST across
-- workspaces (rather than the 2nd one's create failing), DROP the old UNIQUE
-- (install_slug, name) AND fold workspace_id into routines.id — done only after the
-- flag is permanently ON (both code paths no longer reference the old unique).

-- A UNIQUE INDEX (idempotent via IF NOT EXISTS) is a valid ON CONFLICT arbiter for
-- ON CONFLICT (workspace_id, install_slug, name) — equivalent to a unique constraint
-- for the upsert, without ALTER TABLE ADD CONSTRAINT's lack of IF NOT EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS routines_workspace_install_slug_name_key
  ON harness_shared.routines (workspace_id, install_slug, name);
