-- 322: session_briefs — durable successor-brief for "continue where X left off" (EI-1742).
-- Number reserved via db:next-migration (harness_shared.migration_reservations).
--
-- GAP (EI-1742, filed su-7dcd + lived su-cf7b0 this session): an agent's declared
-- LANE lives only in harness_shared.coord_presence, which the idle-session-reaper
-- DELETEs once the row goes stale. So a successor told "continue where session/owner
-- X left off" has NO durable, queryable record of X's intent/plan/files — it
-- reconstructs the lane from transcript / file-history archaeology (slow + lossy:
-- file-history shows WHAT changed, never the WHY / plan / division). Both real cases
-- (su-226ad rate-limited mid-turn; su-cf7b0's MCP client dropped at an operator
-- restart) died ABRUPTLY with no clean session-end, so a session-end snapshot hook
-- would have captured neither.
--
-- FIX (consensus su-7dcd + su-cf7b0): persist the lane on the WRITE path that already
-- runs throughout a session — coord:declare-intent → writePresence — into this durable
-- table the reaper never touches. The LAST declare-intent before the session dies IS
-- the durable brief; no fragile session-end hook needed. Read side
-- (assembleSpawnHydration injection of a "### Predecessor session brief") is a fail-soft
-- follow-up (Phase 2). Claimed items are NOT duplicated here — they are already durable
-- in harness_shared.work_items (queryable by assignee).
--
-- ADDITIVE + idempotent: a new standalone table (mirrors coord_presence columns) +
-- one partial index. No change to coord_presence read/write/delete semantics, so a
-- failed brief write degrades to exactly today's behavior. native_session_id is
-- nullable today (declare-intent's context carries only ownerId; the Claude session
-- UUID is recorded separately on the bootstrap-su adv row) and is the Phase-2 key for
-- "continue where session <uuid> left off".
--
-- The migration runner wraps each file in its own transaction (and strips psql
-- metacommands), so this file carries NO top-level BEGIN;/COMMIT;/\set
-- (migration-runner.js contract; lint:migrations).

CREATE TABLE IF NOT EXISTS harness_shared.session_briefs (
  owner_id          text        NOT NULL PRIMARY KEY,
  workspace_id      text        NOT NULL DEFAULT 'default',
  owner_label       text        NOT NULL DEFAULT '',
  source            text        NOT NULL DEFAULT '',
  intent            text        NOT NULL DEFAULT '',
  current_plan_slug text,
  current_files     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  harness_slug      text,
  hive_slug         text,
  native_session_id text,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Phase-2 lookup: "continue where session <native_session_id> left off".
CREATE INDEX IF NOT EXISTS session_briefs_native_session_id_idx
  ON harness_shared.session_briefs (native_session_id)
  WHERE native_session_id IS NOT NULL;

-- Recency scans ("most-recent brief on plan X" / housekeeping).
CREATE INDEX IF NOT EXISTS session_briefs_updated_at_idx
  ON harness_shared.session_briefs (updated_at);

COMMENT ON TABLE harness_shared.session_briefs IS
  'Durable per-owner successor brief (EI-1742). Upserted best-effort on each coord:declare-intent (writePresence) so an agent''s last declared lane (intent/plan/files) survives the coord_presence reaper sweep and abrupt session death. Read by a continuing session to seed "continue where X left off" instead of transcript archaeology. Claimed items live in work_items (not duplicated here).';
