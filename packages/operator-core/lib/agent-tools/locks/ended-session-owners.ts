/**
 * ended-session-owners — the SESSION-LIVENESS half of the dead-holder reclaim
 * predicate (EI-22078335832051825).
 *
 * `reclaimDeadExclusiveHolders` (resource-acquire-wait.ts) originally judged a
 * blocking exclusive holder dead by ONE instrument: `process.kill(pid, 0)` on a
 * host-local pid embedded in the owner string. That is the right instrument for
 * a crashed deploy-cli or a killed bg-host (`release-deploy:<pid>:…`,
 * `system:git-sync:<pid>:…`), and structurally blind to the class this module
 * closes: a lock held by an AGENT SESSION (`su-…`) whose session has ENDED while
 * nothing about the owner string names a pid — or whose process is still warm.
 * Measured 2026-09-01: git-sync:portal skipped `held_exclusive` on every tick
 * for the holder's full TTL while coord:presence reported that holder `ended`.
 *
 * The liveness verdict this repo trusts is `sessionState` from the ONE shared
 * oracle (`resolveSessionStates`, presence-derivation-unification-2026-07-17) —
 * the same derivation behind coord:presence, fleet:status and the send-miss
 * report. This module asks that oracle, and nothing else, so a lock reclaim can
 * never disagree with the roster about whether its holder is alive.
 *
 * Two rails make it safe to consult at acquire time:
 *
 *  1. IDENTITY-GATED. The oracle's pure model reads "no wake registered, no turn
 *     in flight" as `ended` — correct for a session, and a FALSE death verdict
 *     for an owner that was never a session at all (a peer host's
 *     `system:git-sync:<pid>:<uuid>` lease, a deploy-cli owner, a legacy uuid).
 *     A presence row proves the owner is a session and admits it to the shared
 *     liveness oracle. When presence is already gone, a correlated agent-session
 *     task row is the second proof: only a latest TERMINAL row with no live row
 *     under that exact coordOwnerId is dead. An opaque owner with neither proof
 *     stays UNKNOWN, so system/PID/peer owners retain the original safety rail.
 *  2. `ended` ONLY. `suspect` (dead-but-holding-claims), `draining`, `parked`,
 *     `live`, `recorded` and the in-band unknown (`sessionState: null` /
 *     `signalMissing`) all keep the holder. A verdict the oracle itself hedges
 *     is not a licence to take its lock.
 *
 * This is deliberately NOT the idle-session-reaper's `gatherProtectedSessionOwners`
 * set: that predicate treats a fresh heartbeat as protection, which is exactly
 * why the warm-dead holder above sat until TTL — the session-end hook retried
 * against it three times and gave up `owner-live`. The oracle is the instrument
 * that already knew.
 *
 * Fail-safe by construction: any store/oracle failure returns the EMPTY set
 * (nothing reclaimed; the TTL and the reaper remain the backstop), never a
 * partial answer that could read as "everyone else is dead".
 */

import { getPresence, type PresenceRecord } from '../coordination/presence';
import { resolveSessionStates, type LivenessSubject, type LivenessVerdict } from '../coordination/liveness-oracle';
import { listTasks } from '../../task-manager/store';
import { isTerminalState, type TaskState } from '../../task-manager/types';

/**
 * The shape `reclaimDeadExclusiveHolders` consumes: given candidate owner
 * strings, the subset that is DEFINITIVELY dead. Any owner absent from the
 * result is left alone — absence means "unknown or alive", never a verdict.
 */
export type DeadOwnerOracle = (owners: readonly string[]) => Promise<ReadonlySet<string>>;

export interface EndedSessionOwnersDeps {
  getPresenceFn?: (ownerId: string) => Promise<PresenceRecord | null>;
  resolveSessionStatesFn?: (subjects: readonly LivenessSubject[]) => Promise<Map<string, LivenessVerdict>>;
  /** Read the newest agent-session task for an owner, optionally restricted to
   * states. The default delegates to task-manager's canonical ledger reader. */
  readAgentTasksFn?: (ownerId: string, states?: readonly TaskState[]) => Promise<readonly { state: TaskState }[]>;
}

/** PURE: the one verdict that counts as dead here. Exported so the boundary is
 *  pinned directly — a widening (e.g. to `suspect`) must be a deliberate edit of
 *  this line, never an accident of a refactor elsewhere. */
export function isDefinitivelyEndedVerdict(verdict: LivenessVerdict | undefined): boolean {
  return verdict != null && verdict.signalMissing !== true && verdict.sessionState === 'ended';
}

/**
 * THE oracle adapter: which of `owners` are agent sessions the shared liveness
 * oracle calls `ended`. See the module header for the two rails.
 */
export async function endedSessionOwners(
  owners: readonly string[],
  deps: EndedSessionOwnersDeps = {},
): Promise<ReadonlySet<string>> {
  const dead = new Set<string>();
  const distinct = Array.from(new Set(owners.filter((o) => typeof o === 'string' && o.length > 0)));
  if (distinct.length === 0) return dead;
  const getPresenceFn = deps.getPresenceFn ?? getPresence;
  const resolve = deps.resolveSessionStatesFn ?? resolveSessionStates;
  const readAgentTasks =
    deps.readAgentTasksFn ??
    (async (ownerId: string, states?: readonly TaskState[]) =>
      listTasks({
        coordOwnerId: ownerId,
        classes: ['agent-session'],
        ...(states ? { states } : {}),
        includeEnded: true,
        limit: 1,
      }));

  try {
    // Rail 1a: only owners the roster knows as sessions are oracle subjects.
    // Keep store failures distinct from an honest "no row": a failed presence
    // read is UNKNOWN and must not fall through to a different instrument.
    const rows = await Promise.all(
      distinct.map(async (ownerId) => {
        try {
          return { ownerId, presence: await getPresenceFn(ownerId), readFailed: false };
        } catch {
          return { ownerId, presence: null, readFailed: true };
        }
      }),
    );
    const subjects: LivenessSubject[] = [];
    const taskCandidates: string[] = [];
    for (const row of rows) {
      const p = row.presence;
      if (!p) {
        if (!row.readFailed) taskCandidates.push(row.ownerId);
        continue;
      }
      subjects.push({
        ownerId: p.ownerId,
        heartbeatAt: p.heartbeatAt,
        host: p.host,
        pid: p.pid,
        source: p.source,
        agentRole: p.agentRole,
      });
    }

    if (subjects.length > 0) {
      const verdicts = await resolve(subjects);
      for (const s of subjects) {
        // Rail 2: `ended` and nothing else.
        if (isDefinitivelyEndedVerdict(verdicts.get(s.ownerId))) dead.add(s.ownerId);
      }
    }

    // Rail 1b: presence may have been reaped before its resource lease. A task
    // row stamped with the same route-owned coordOwnerId proves this was an
    // agent-session owner. Require BOTH a latest terminal row and the absence of
    // any live row; non-terminal/unknown states and opaque system owners stay.
    for (const ownerId of taskCandidates) {
      const latest = (await readAgentTasks(ownerId))[0];
      if (!latest || !isTerminalState(latest.state)) continue;
      const live = await readAgentTasks(ownerId, ['pending', 'running']);
      if (live.length === 0) dead.add(ownerId);
    }
    return dead;
  } catch {
    // Whole-batch failure: no verdict is the only honest verdict.
    return new Set<string>();
  }
}
