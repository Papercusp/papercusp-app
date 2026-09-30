/**
 * Per-user memory PAUSE — the "stop remembering things about me" switch
 * (EI-10355).
 *
 * The memory surface already lets a user SEE (GET /user/memory), EDIT
 * (PATCH), DELETE (DELETE ?id= / ?all=1) and EXPORT (GET
 * /user/memory/export) everything remembered about them. The one control
 * that was missing is the ability to STOP new memories being written —
 * the restriction/object right. Before this, the only "off" was
 * `PAPERCUSP_MEMORY_BACKEND=noop`: an OPERATOR-WIDE env var needing a
 * process restart (see backend-selection.ts, which is explicit that it is
 * "an infra choice over the whole store"). That is an infra kill-switch,
 * not a user control.
 *
 * Persisted per-user in the SAME `harness_shared.operator_settings` k/v
 * table backend-selection uses, under the key `memory_paused:<userId>` —
 * so this ships with NO migration, and stays per-user (correct for a
 * multi-user install) rather than adding a second global switch.
 *
 * ## What a pause does and does NOT do
 * - Gates the AGENT write paths (`memory:remember`,
 *   `memory:recover-from-transcripts`) — the ways things get remembered
 *   ABOUT you without you asking.
 * - Does NOT gate list / edit / delete / export. Pausing must never lock a
 *   user out of their own data: while paused you can still read, correct
 *   and erase everything already stored.
 *
 * ## Fail-open, deliberately
 * A read failure (PG down, table absent on a fresh install) resolves to
 * NOT paused, so memory keeps working out of the box. This is safe because
 * a pause is only ever ON if someone explicitly turned it on: the failure
 * mode is "the store we could not reach also could not have been written
 * to" — the same PG backs both this setting and the memory rows, so a PG
 * outage fails the write anyway. Failing CLOSED here would instead make a
 * transient PG blip look like a silent, permanent memory outage.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

/** The per-user settings key. Namespaced so it can never collide with an operator-wide key. */
export function memoryPauseKey(userId: string): string {
  return `memory_paused:${userId}`;
}

/**
 * Cache the resolved state per user, so the gate does NOT put a PG round-trip
 * on every single memory write (the write path is hot; a settings lookup per
 * fact is a silly cost). The TTL bounds how long a flip can go unseen by a
 * process that already warmed its cache — a pause set in the settings route is
 * applied to THIS process's cache immediately by setMemoryPaused(), so the TTL
 * only matters for a *different* operator process, where 10s of staleness is
 * an acceptable ceiling for a consent flag.
 */
const PAUSE_TTL_MS = 10_000;
const cache = new Map<string, { value: boolean; at: number }>();

/**
 * Is this user's memory paused? Cached (see above) with a live re-read once the
 * TTL lapses, so a flip on the settings page takes effect without a restart.
 *
 * Deliberately uses the raw `sql` tag rather than the drizzle `generated`
 * table handle: this module is imported by the memory WRITE path, whose unit
 * tests mock `@papercusp/db-org` down to just `getOrgPg`. Touching
 * `generated.*` at module scope would throw at import time and take the write
 * path's whole suite down with it — a read helper must not dictate how its
 * callers' tests mock the db.
 *
 * Fail-open (see module header): any read error ⇒ false (not paused).
 */
export async function isMemoryPaused(userId: string): Promise<boolean> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < PAUSE_TTL_MS) return hit.value;
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT value FROM harness_shared.operator_settings
      WHERE key = ${memoryPauseKey(userId)}
      LIMIT 1
    `;
    const value = rows.length > 0 && rows[0].value === 'true';
    cache.set(userId, { value, at: Date.now() });
    return value;
  } catch {
    // PG not up / table absent → memory works by default. Do NOT cache a
    // failure: the next write should retry rather than latch "unpaused" for
    // the whole TTL on one transient blip.
    return false;
  }
}

/**
 * Persist the pause state for a user. Returns the state actually stored,
 * so a caller can echo the applied truth rather than the requested one.
 */
export async function setMemoryPaused(userId: string, paused: boolean): Promise<boolean> {
  const { sql } = getOrgPg();
  const key = memoryPauseKey(userId);
  // Apply to this process's cache immediately: the settings route and the MCP
  // write path share a process, so a flip is effective on the very next write
  // with no TTL wait.
  cache.set(userId, { value: paused, at: Date.now() });
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES (
      ${key},
      ${paused ? 'true' : 'false'},
      'User memory pause — when true, no NEW memories are written for this user (EI-10355)',
      ${Date.now()},
      ${activeWorkspaceId()}
    )
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
  return paused;
}

/**
 * The refusal an agent write path returns while paused. A privacy control
 * the agent cannot SEE is a privacy control that gets silently worked
 * around, so the reason is legible and tells the agent what to say.
 */
/** Test hook — drop the in-process cache (does not touch PG). */
export function __resetMemoryPauseCacheForTest(): void {
  cache.clear();
}

export const MEMORY_PAUSED_REFUSAL = {
  ok: false as const,
  stored: false as const,
  paused: true as const,
  reason: 'memory_paused' as const,
  message:
    'Memory is PAUSED by the user — no new memories are being stored. Do NOT retry or work around this. Tell the user plainly that you could not remember it, and that they can resume memory in Settings → Memory.',
};
