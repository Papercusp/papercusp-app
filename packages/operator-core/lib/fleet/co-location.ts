/**
 * co-location — the Queen's placement policy (hive-coordination-model P-002, D-003).
 *
 * Cross-Swarm coordination is eventually-consistent (a small latency); within a Swarm
 * it is instant. So the Queen places **tight back-and-forth collaborators on the SAME
 * Swarm** and reserves cross-Swarm for loosely-coupled work. This module is the PURE
 * decision: given where a new piece of work's collaborators already run + the Hive's
 * Swarm roster, pick the Swarm to affine the work to. The caller (the `work_items:co_locate`
 * tool) stamps the chosen Swarm as the work-item's `swarm_affinity`; the flag-gated
 * claim path then routes the work to that Swarm (see work-items.ts claimNextWorkItem).
 *
 * Pure + deterministic (no clock, no randomness) so it unit-tests without PG.
 */

/** One Swarm in the Hive's roster, with its current load (lower = more headroom). */
export interface SwarmSlot {
  /** Swarm identity — a device pubkey, or 'local' for the single-instance default. */
  swarm: string;
  /** Current bee/work load on this Swarm (lower = more headroom). */
  load: number;
}

export interface CoLocationInput {
  /**
   * The Swarm(s) this work's tight collaborators already run on — e.g. the
   * `swarm_affinity` of related work-items, or the Swarm a collaborating bee is on.
   * May repeat (the most-frequent Swarm is the dominant collaborator). Empty = no
   * known collaborator.
   */
  collaboratorSwarms: readonly string[];
  /** The Hive's Swarm roster (must include the local Swarm). */
  roster: readonly SwarmSlot[];
  /** The local Swarm id — the always-reachable, instant one (the default placement). */
  localSwarm: string;
  /**
   * true (default) = tight back-and-forth with the collaborators → co-locate.
   * false = loosely-coupled → spread to a DIFFERENT Swarm than the collaborators.
   */
  tight?: boolean;
}

export type CoLocationAction = 'co-locate' | 'spread' | 'local';

export interface CoLocationDecision {
  /**
   * The chosen Swarm to affine the work to. `null` ⇒ "spread wanted but there is no
   * distinct Swarm to spread to — deploy a new one (deploy:pot)".
   */
  swarm: string | null;
  action: CoLocationAction;
  reason: string;
}

/** Distinct Swarm ids in the roster (the reachable set). */
function rosterSwarms(roster: readonly SwarmSlot[]): Set<string> {
  return new Set(roster.map((s) => s.swarm));
}

/** Load of a Swarm (Infinity if not in the roster — i.e. unreachable). */
function loadOf(roster: readonly SwarmSlot[], swarm: string): number {
  const hit = roster.find((s) => s.swarm === swarm);
  return hit ? hit.load : Number.POSITIVE_INFINITY;
}

/**
 * The dominant collaborator Swarm: the one the most collaborators run on, restricted to
 * Swarms that are actually in the roster. Ties broken by lower load, then lexically (for
 * determinism). Returns null when no collaborator is on a reachable Swarm.
 */
function dominantCollaboratorSwarm(input: CoLocationInput): string | null {
  const reachable = rosterSwarms(input.roster);
  const counts = new Map<string, number>();
  for (const s of input.collaboratorSwarms) {
    if (!reachable.has(s)) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]; // higher count first
    const la = loadOf(input.roster, a[0]);
    const lb = loadOf(input.roster, b[0]);
    if (la !== lb) return la - lb; // lower load first
    return a[0] < b[0] ? -1 : 1; // lexical, deterministic
  })[0][0];
}

/** Least-loaded Swarm among `candidates` (must be non-empty). Lexical tiebreak. */
function leastLoaded(roster: readonly SwarmSlot[], candidates: readonly string[]): string {
  return [...candidates].sort((a, b) => {
    const la = loadOf(roster, a);
    const lb = loadOf(roster, b);
    if (la !== lb) return la - lb;
    return a < b ? -1 : 1;
  })[0];
}

/**
 * Decide which Swarm a new piece of work should be affined to.
 *
 * - Single-Swarm roster → everything is co-located locally; affinity is moot ('local').
 * - tight + a dominant collaborator Swarm → co-locate there (instant coordination).
 * - tight + no collaborator → default to the local Swarm.
 * - loose + a dominant collaborator Swarm → spread to the least-loaded OTHER Swarm
 *   (or null = "deploy a new Swarm" when none other exists).
 */
export function decideCoLocation(input: CoLocationInput): CoLocationDecision {
  const swarms = rosterSwarms(input.roster);
  // A roster that is empty or a single Swarm means there is nowhere else to be: all
  // work is co-located on the one instance, so affinity carries no information.
  if (swarms.size <= 1) {
    return {
      swarm: input.localSwarm,
      action: 'local',
      reason: 'single Swarm — all work is co-located on the local instance',
    };
  }

  const tight = input.tight ?? true;
  const dominant = dominantCollaboratorSwarm(input);

  if (tight) {
    if (dominant) {
      return {
        swarm: dominant,
        action: 'co-locate',
        reason: `tight collaborators run on Swarm ${dominant} — co-locate for instant coordination`,
      };
    }
    return {
      swarm: input.localSwarm,
      action: 'local',
      reason: 'no tight collaborator to co-locate with — placed on the local Swarm',
    };
  }

  // Loose: spread to a Swarm that ISN'T hosting collaborators.
  const collabSet = new Set(input.collaboratorSwarms.filter((s) => swarms.has(s)));
  if (collabSet.size === 0) {
    return {
      swarm: input.localSwarm,
      action: 'local',
      reason: 'loose work with no collaborator anchor — placed on the local Swarm',
    };
  }
  const nonCollab = [...swarms].filter((s) => !collabSet.has(s));
  if (nonCollab.length === 0) {
    return {
      swarm: null,
      action: 'spread',
      reason: 'loose work — every Swarm already hosts a collaborator; deploy a new Swarm (deploy:pot) to spread',
    };
  }
  return {
    swarm: leastLoaded(input.roster, nonCollab),
    action: 'spread',
    reason: 'loose work — spread to the least-loaded Swarm not hosting collaborators',
  };
}
