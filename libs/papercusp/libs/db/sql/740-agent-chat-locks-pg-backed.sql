-- 740-agent-chat-locks-pg-backed.sql
--
-- WI-7139: `agent-chats/index.ts`'s "already streaming" lock (`activeChats`
-- module-scoped Map) is per-PROCESS, but :3070 is a 16-worker `node:cluster`
-- release cluster (standing fact `operator-3070-is-clustered-no-in-process-state`,
-- session-death-claim-release-2026-07-11#D-001). Two POST
-- /api/harness/:slug/agent-chats/:chatId/messages requests for the SAME chatId
-- landing on two different workers both read an empty local Map, both pass the
-- 409 check, and both spawn a concurrent agent turn appending to the same chat
-- transcript — the exact "duplicate spawn-and-append race" the lock exists to
-- prevent, defeated by clustering. Same bug CLASS as migration 716
-- (carry-respawn-marker.ts / session_respawn_expected): move the lock to a
-- substrate every worker can see.
--
-- TOKEN-SCOPED, not a bare presence row (differs from 716's simpler
-- consumed-once marker): a lock here is HELD across a whole streaming turn
-- (seconds to minutes, not consumed instantly), so a second acquirer must be
-- able to safely STEAL a stale lock (holder crashed mid-stream, never reached
-- its `finally`) without racing the original holder's own eventual release.
-- The `token` column makes release OWNER-SCOPED (`DELETE ... WHERE chat_id=$1
-- AND token=$2`): if worker B legitimately steals a stale lock and installs a
-- new token, worker A's original `finally` release (still holding the OLD
-- token) becomes a harmless no-op instead of deleting the wrong owner's lock
-- out from under it.
--
-- Acquire is `INSERT ... ON CONFLICT (chat_id) DO UPDATE ... WHERE
-- <existing row is stale> RETURNING token` — atomic across workers: the WHERE
-- clause on the conflict action means the UPDATE (and therefore the RETURNING
-- row) only fires when no live holder exists, so at most one caller ever wins
-- a given acquire attempt. See agent-chat-lock.ts.

CREATE TABLE IF NOT EXISTS harness_shared.agent_chat_locks (
  chat_id      text PRIMARY KEY,
  workspace_id text,
  token        text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_chat_locks_started_at
  ON harness_shared.agent_chat_locks (started_at);

COMMENT ON TABLE harness_shared.agent_chat_locks IS
  'Cross-process per-chat "already streaming" lock for POST .../agent-chats/:chatId/messages. Replaces an in-memory Map that was defeated by the 16-worker :3070 cluster (WI-7139). Acquire is a stale-steal upsert (ON CONFLICT ... WHERE started_at < now() - TTL); release is token-scoped so a stolen lock is never deleted by its former, since-superseded holder. See agent-chat-lock.ts.';
