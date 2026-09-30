/**
 * agent-chat-lock.ts — durable, cross-process "this chat has an in-flight
 * assistant turn" lock for `POST /api/harness/:slug/agent-chats/:chatId/messages`.
 *
 * ROOT CAUSE (WI-7139, evidenced 2026-08-02 via WI-6818's clustered-state sweep):
 * `agent-chats/index.ts` previously kept this lock in a module-scoped
 * `activeChats` Map, guarding against a second POST for the same chatId
 * spawning a duplicate concurrent agent turn while a prior one is still
 * streaming. `:3070` is a 16-worker `node:cluster` release cluster (standing
 * fact `operator-3070-is-clustered-no-in-process-state`,
 * session-death-claim-release-2026-07-11#D-001) — the SAME bug class already
 * fixed for the carry-respawn marker (migration 716, WI-6756 follow-on). Two
 * requests for the same chatId landing on two different round-robined workers
 * each see an empty local Map, both pass the check, and both spawn an agent
 * turn appending to the same transcript: duplicate LLM spend plus a real risk
 * of interleaved/lost transcript writes.
 *
 * SHAPE DIFFERS FROM THE CARRY-RESPAWN MARKER ON PURPOSE: that marker is
 * written once and consumed (deleted) near-instantly by the very next
 * lifecycle hook. This lock is HELD across an entire streaming turn — seconds
 * to minutes — so a holder that crashes mid-stream (never reaches its
 * `finally`) must not wedge the chat forever. Acquire is therefore a
 * "steal-if-stale" upsert: a lock older than `AGENT_CHAT_LOCK_TTL_MS` is
 * treated as abandoned and can be taken by a new caller. Release is
 * TOKEN-scoped (`DELETE ... WHERE chat_id = $1 AND token = $2`) so a holder
 * whose lock was legitimately stolen for staleness can never delete the new
 * holder's row out from under it in its own `finally` — the classic
 * distributed-lock "delete-what-I-no-longer-own" bug.
 *
 * FAIL-CLOSED ON A PG ERROR (an explicit choice, not a silent default — see
 * WI-7139's own "decide, don't default silently" ask): unlike the
 * carry-respawn marker, where fail-open reverts to the pre-fix, already-safe
 * default, failing open here reverts to the EXACT bug this module fixes —
 * two workers each unable to see the other's lock. Since a PG outage already
 * fails the very next step of this handler (loading the chat row), fail-
 * closed costs nothing extra in practice and never permits the double-spawn
 * this module exists to prevent.
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';

/** A lock older than this is treated as abandoned (its holder crashed mid-stream
 *  and never reached its `finally` release) and may be stolen by a new acquirer.
 *  Generous relative to a normal chat turn (seconds) but bounded well below
 *  "forever", which is what an in-memory Map effectively degrades to on process
 *  restart today. */
export const AGENT_CHAT_LOCK_TTL_MS = 10 * 60_000;

export interface AgentChatLockHandle {
  chatId: string;
  /** Opaque ownership token — pass back to {@link releaseAgentChatLock} so a
   *  stolen lock is never released by its former holder. */
  token: string;
}

/**
 * Attempt to acquire the per-chat streaming lock. Returns a handle on success,
 * or `null` if another worker already holds a live (non-stale) lock for this
 * chat — the caller should return 409, exactly as the old `activeChats.has()`
 * check did.
 *
 * FAILS CLOSED: a PG error is treated as "could not acquire" (returns `null`)
 * rather than silently permitting a duplicate spawn — see the module header.
 */
export async function acquireAgentChatLock(
  chatId: string,
  workspaceId: string | null,
  opts: { sql?: Sql; ttlMs?: number; waitMs?: number; retryMs?: number } = {},
): Promise<AgentChatLockHandle | null> {
  if (!chatId?.trim()) return null;
  const ttlMs = Math.max(0, opts.ttlMs ?? AGENT_CHAT_LOCK_TTL_MS);
  const ttlSec = Math.max(0, Math.round(ttlMs / 1000));
  const waitMs = Math.max(0, opts.waitMs ?? 0);
  const retryMs = Math.max(10, opts.retryMs ?? 50);
  const deadline = Date.now() + waitMs;

  while (true) {
    const token = randomUUID();
    try {
      const sql = opts.sql ?? getOrgPg().sql;
      // ON CONFLICT ... DO UPDATE ... WHERE <stale> is the atomic "steal only if
      // abandoned" upsert: the WHERE clause gates the UPDATE itself, so at most
      // one concurrent acquirer's UPDATE (and therefore RETURNING row) ever
      // fires for a chat with a live holder. A fresh chat (no conflict) always
      // inserts and wins.
      const rows = await sql<Array<{ token: string }>>`
        INSERT INTO harness_shared.agent_chat_locks (chat_id, workspace_id, token, started_at)
        VALUES (${chatId}, ${workspaceId}, ${token}, now())
        ON CONFLICT (chat_id) DO UPDATE
          SET workspace_id = EXCLUDED.workspace_id,
              token = EXCLUDED.token,
              started_at = now()
          WHERE harness_shared.agent_chat_locks.started_at < now() - make_interval(secs => ${ttlSec})
        RETURNING token`;
      const row = rows[0];
      if (row?.token === token) return { chatId, token };
    } catch (e) {
      console.warn(
        `[agent-chat-lock] acquire failed for chat ${chatId} — failing CLOSED (treated as locked) to avoid a duplicate spawn: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs, remainingMs)));
  }
}

/**
 * Release a previously-acquired lock. TOKEN-scoped: a no-op (not an error) if
 * this handle's token no longer matches the live row — that means the lock was
 * already stolen for staleness by a new holder, which must keep it.
 *
 * Never throws: a failed release leaves a row that the TTL-based steal-if-stale
 * check on the next acquire will clear anyway, so the chat is never wedged
 * forever — it can just take up to `AGENT_CHAT_LOCK_TTL_MS` to recover, same as
 * the crash-mid-stream case this module already has to tolerate.
 */
export async function releaseAgentChatLock(
  handle: AgentChatLockHandle | null | undefined,
  opts: { sql?: Sql } = {},
): Promise<void> {
  if (!handle?.chatId?.trim() || !handle.token) return;
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    await sql`
      DELETE FROM harness_shared.agent_chat_locks
       WHERE chat_id = ${handle.chatId} AND token = ${handle.token}`;
  } catch (e) {
    console.warn(
      `[agent-chat-lock] release failed for chat ${handle.chatId} — the lock will clear via TTL on the next acquire attempt instead: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
}

/**
 * Read-only: is `chatId` currently locked by a LIVE (non-stale) holder? Useful
 * for a cheap pre-check or a status surface; the authoritative check is still
 * the atomic acquire above — this can race a concurrent acquire/release and
 * must never be used as the sole gate before spawning a turn.
 */
export async function isAgentChatLocked(
  chatId: string,
  opts: { sql?: Sql; ttlMs?: number; nowMs?: number } = {},
): Promise<boolean> {
  if (!chatId?.trim()) return false;
  const ttlMs = Math.max(0, opts.ttlMs ?? AGENT_CHAT_LOCK_TTL_MS);
  const ttlSec = Math.max(0, Math.round(ttlMs / 1000));
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    const rows = await sql<Array<{ chat_id: string }>>`
      SELECT chat_id FROM harness_shared.agent_chat_locks
       WHERE chat_id = ${chatId}
         AND started_at >= now() - make_interval(secs => ${ttlSec})`;
    return rows.length > 0;
  } catch {
    // Read-only best-effort: an unknown state is reported as "not locked" —
    // the caller must not treat this function as authoritative anyway.
    return false;
  }
}

/** Test-only — drop every lock row (isolate suites that share this table). */
export async function __resetAgentChatLocks(opts: { sql?: Sql } = {}): Promise<void> {
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    await sql`DELETE FROM harness_shared.agent_chat_locks`;
  } catch {
    // best-effort test helper
  }
}
