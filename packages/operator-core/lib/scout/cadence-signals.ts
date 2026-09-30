/**
 * cadence-signals.ts — Scout P-008: the live signal readers the cadence gate
 * ({@link shouldRunScoutCycle}) consumes — idle capacity + accumulated friction.
 *
 * These are the production sources behind {@link ScoutCadenceState}:
 *  - **idle capacity** — derived from fresh su/fleet coordination presence vs a
 *    configured capacity: idleRatio = clamp(1 - live/capacity, 0, 1). Retired
 *    nursery `spawned_agents` rows are deliberately not an input.
 *  - **friction** — the OPEN idea-queue backlog (the self-improvement loop's
 *    captured-but-unaddressed items). A growing backlog IS the colony's
 *    accumulated friction (the plan's "what keeps being deferred"); reusing
 *    {@link readImprovementItems} keeps this schema-correct + scope-aware (P-010).
 *
 * The DB queries mirror already-tested code; the only non-trivial LOGIC (the idle
 * ratio) takes injected deps so it's unit-tested without PG.
 */

import { activeWorkspaceId } from '../workspace-registry';
import { readImprovementItems } from '../harness/improvements/read-items';
import { listPresence } from '../agent-tools/coordination/presence';
// Constant-only import from the PURE package, not the local './presence' re-export (WI-39450).
// `defaultLiveAgentCountDeps` below reads PRESENCE_STALE_MS at MODULE SCOPE, and the local
// module constructs a PgPresenceStore on load, so unit tests blanket-mock it — a factory that
// omits this constant would turn that top-level read into a COLLECTION crash (vitest 4 throws
// at access time), exactly the class that took ~16 suites down via presence-wakeability.ts:88.
// The pure module has no side effects and is unaffected by that mock. `listPresence` above
// legitimately needs the local module; this constant does not.
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';

/** Default fleet capacity for the idle ratio (override: PAPERCUSP_SCOUT_FLEET_CAPACITY). */
export function scoutFleetCapacity(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_FLEET_CAPACITY ?? 12);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

export interface LivePresenceRow {
  ownerId: string;
  heartbeatAt: string;
}

export interface LiveAgentCountDeps {
  listPresence: (opts: { workspaceId: string }) => Promise<LivePresenceRow[]>;
  now: () => number;
  staleMs: number;
}

const defaultLiveAgentCountDeps: LiveAgentCountDeps = {
  listPresence,
  now: Date.now,
  staleMs: PRESENCE_STALE_MS,
};

/**
 * Count distinct live su/fleet members from the coordination roster. A row is
 * live only while its heartbeat is inside the canonical presence window; stale,
 * invalid, and duplicate rows do not consume creative capacity.
 */
export async function countLiveAgents(
  workspaceId: string,
  deps: LiveAgentCountDeps = defaultLiveAgentCountDeps,
): Promise<number> {
  const now = deps.now();
  const live = new Set<string>();
  for (const row of await deps.listPresence({ workspaceId })) {
    const heartbeatMs = new Date(row.heartbeatAt).getTime();
    if (Number.isFinite(heartbeatMs) && now - heartbeatMs < deps.staleMs) live.add(row.ownerId);
  }
  return live.size;
}

export interface IdleRatioDeps {
  countLive: (workspaceId: string) => Promise<number>;
}

/**
 * Fleet idle ratio in [0,1]: 1 = fully idle (no agents running), 0 = at/over the
 * configured capacity. Pure math over the injected live-agent count (production
 * uses {@link countLiveAgents}).
 */
export async function readHiveIdleRatio(
  opts: { workspaceId?: string; capacity?: number } = {},
  deps: IdleRatioDeps = { countLive: countLiveAgents },
): Promise<number> {
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const capacity = opts.capacity && opts.capacity > 0 ? opts.capacity : scoutFleetCapacity();
  const live = await deps.countLive(ws);
  return clamp01(1 - live / capacity);
}

export interface FrictionDeps {
  readOpenImprovements: (harnessSlug?: string) => Promise<{ length: number }>;
}

const defaultFrictionDeps: FrictionDeps = {
  readOpenImprovements: (harnessSlug) =>
    readImprovementItems({ state: 'open', ...(harnessSlug ? { harnessSlug } : {}) }),
};

/**
 * The friction-signal count = the OPEN idea-queue backlog for the harness scope
 * (omit harnessSlug for all scopes). A high count means accumulated, unaddressed
 * friction → the cadence gate's friction trigger.
 */
export async function readFrictionSignalCount(
  opts: { harnessSlug?: string } = {},
  deps: FrictionDeps = defaultFrictionDeps,
): Promise<number> {
  const items = await deps.readOpenImprovements(opts.harnessSlug);
  return items.length;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
