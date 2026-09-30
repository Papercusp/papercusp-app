/**
 * rebind-owner — migrate SU-locks owner-keyed rows from a dead compaction
 * predecessor sid to the live successor (EI-8999 / compaction-survival test
 * class, fleet-reliability-verification-2026-07-10 P-002).
 *
 * WHY: `@papercusp/locks` owns its OWN side-database (`papercusp_su`),
 * entirely separate from `harness_shared` — so operator-core's
 * `rebindIdentity` (which only touches `harness_shared` via `getOrgPg()`,
 * see `agent-tools/coordination/rebind-identity.ts`) can never reach it on
 * its own. A file lock held by a session that then compacts (mints a new
 * sid) is silently stranded under the dead sid: the live successor never
 * re-acquires it (as far as it knows it holds nothing new), and no reaper
 * frees it until its TTL lapses (up to 20 minutes, `DEFAULT_TTL_SEC` in
 * `coordinator.ts`) — a phantom hold blocking every other agent that wants
 * that path in the meantime. Exactly the WI-3642 class of bug, on a
 * different database.
 *
 * SCOPE: covers the two tables whose primary key does NOT include `owner`
 * (agent_file_locks: (coordination_domain, path); agent_lock_waiters:
 * ticket_id) — a plain re-key can never collide with an existing row on
 * either. `agent_granular_locks` / `agent_resource_locks` /
 * `agent_resource_waiters` key `owner` INTO their primary key, so a
 * same-key collision needs the same drop-vs-move semantics
 * rebindIdentity's claim-spec/watermarks surfaces use (rebind-identity.ts
 * steps 6/10) — deliberately left for a follow-up rather than folded in
 * here half-tested; the file-lock hot path (every agent's edit-lock) is
 * the safety-critical piece named in the P-002 plan item and covered
 * below.
 *
 * SHAPE: no coordination-domain predicate, matching rebindIdentity's own
 * design (see its module doc) — a sid is globally unique, so the move can
 * never cross tenants, and scoping it would silently strand rows in
 * domains the caller didn't think to pass.
 */
import { ensureBootstrap, getTxPool } from './su-lock-store';

export interface RebindLockOwnerResult {
  ok: boolean;
  from: string;
  to: string;
  /** agent_file_locks rows re-keyed. */
  fileLocksMoved: number;
  /** agent_lock_waiters rows re-keyed. */
  waitersMoved: number;
}

export async function rebindLockOwner(from: string, to: string): Promise<RebindLockOwnerResult> {
  const f = from.trim();
  const t = to.trim();
  if (!f || !t || f === t) {
    return { ok: false, from: f, to: t, fileLocksMoved: 0, waitersMoved: 0 };
  }

  await ensureBootstrap();
  const sql = getTxPool();

  // Straight re-key: `owner` is not part of either table's primary key, so
  // moving it can never collide with an existing row under the target id.
  const movedLocks = await sql<Array<{ path: string }>>`
    UPDATE agent_file_locks SET owner = ${t} WHERE owner = ${f} RETURNING path
  `;
  const movedWaiters = await sql<Array<{ ticket_id: string }>>`
    UPDATE agent_lock_waiters SET owner = ${t} WHERE owner = ${f} RETURNING ticket_id
  `;

  return {
    ok: true,
    from: f,
    to: t,
    fileLocksMoved: movedLocks.length,
    waitersMoved: movedWaiters.length,
  };
}
