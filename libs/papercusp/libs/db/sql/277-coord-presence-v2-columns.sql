-- Migration 277 — presence-v2 Phase 1 columns (presence-v2-2026-06-14 P-001, D-003/D-004).
--
-- last_active_at: the GENUINE-activity timestamp, distinct from heartbeat_at —
--   which is keepalive-polluted (the 60s psu-launcher supervisor beat bumps
--   heartbeat_at purely for process-aliveness, so heartbeat_at means "process
--   alive", not "last active"). last_active_at is bumped ONLY by real activity
--   (tool dispatch via dispatch-heartbeat, declare-intent, inbox reads) — the
--   write-path split lives in @papercusp/coordination PgPresenceStore
--   (touchActivity bumps both; touchHeartbeat bumps heartbeat_at only). Nullable:
--   existing rows carry NULL until their next activity write; the read derives
--   lastActiveSecAgo only when it is set.
-- agent_role: the agent's durable role (today only INFERRED from `source`);
--   resolved + written by the operator presence adapter.
-- hive_slug: the agent's home Hive (hiveHomeSlugForHarness). coord_presence was
--   workspace-scoped only; this attributes a local row to a Hive so the
--   hive-scoped read (Phase 2) can filter cheaply. NULL = standalone / no hive.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; — an inner COMMIT would end the wrapper
-- txn early and break apply+ledger atomicity (migration-runner contract;
-- lint:migrations, files >=215).

ALTER TABLE harness_shared.coord_presence
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_role     text,
  ADD COLUMN IF NOT EXISTS hive_slug      text;

-- Partial index for the Phase-2 hive-scoped read default (local rows WHERE
-- hive_slug = caller's hive). Partial on (hive_slug IS NOT NULL) keeps it small —
-- SU / standalone rows (NULL hive) don't bloat it.
CREATE INDEX IF NOT EXISTS coord_presence_hive_idx
  ON harness_shared.coord_presence (workspace_id, hive_slug)
  WHERE hive_slug IS NOT NULL;
