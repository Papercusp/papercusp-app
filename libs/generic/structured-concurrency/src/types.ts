/**
 * types — the shared vocabulary of the structured-concurrency toolkit.
 *
 * One durable spawn tree is FOUR things at once: a supervision tree (failure flows
 * up), a structured-concurrency nursery (a node owns its descendants' lifecycle), a
 * blackboard, and a backpressure boundary. These types are the common nouns the four
 * mechanisms (nursery, supervision, governor, saga) share.
 *
 * Generic by construction: the algorithms here interpret only the *structural* fields
 * of a node (id, parent, status, owner, partition, restart bookkeeping). The remaining
 * fields are opaque host annotations the toolkit carries through untouched — see
 * SpawnNode.
 */

/** Lifecycle of a spawn node. running/restarting are ACTIVE; the rest are TERMINAL. */
export type SpawnStatus = 'running' | 'restarting' | 'done' | 'failed' | 'cancelled' | 'reaped';

/**
 * OTP-style restart strategy for a supervised child.
 *  - one_for_one  — independent; a crash restarts only this child.
 *  - one_for_all  — the sibling-set shares an invariant; a crash cancels + restarts all siblings.
 *  - rest_for_one — ordered dependency; a crash restarts this child + every sibling started after it.
 */
export type RestartStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one';

export const ACTIVE_STATUSES = ['running', 'restarting'] as const;
export const TERMINAL_STATUSES = ['done', 'failed', 'cancelled', 'reaped'] as const;

export function isActiveStatus(s: string): boolean {
  return s === 'running' || s === 'restarting';
}
export function isTerminalStatus(s: string): boolean {
  return s === 'done' || s === 'failed' || s === 'cancelled' || s === 'reaped';
}

/**
 * A node in the durable spawn tree, as the toolkit sees it.
 *
 * The algorithms read only the STRUCTURAL fields:
 *   spawnId, parentSpawnId, status, sessionOwner, coordinationDomain,
 *   restartStrategy, restartCount, restartWindowStart, depth.
 *
 * Everything else (workspaceId, harnessSlug, parentRole, childRole, featureId,
 * chunkId, planSlug, itemId) is opaque host metadata the store populates and the
 * toolkit carries through but never interprets — so a host can annotate nodes with
 * whatever its domain needs without coupling the toolkit to it.
 */
export interface SpawnNode {
  spawnId: string;
  parentSpawnId: string | null;
  /** The partition a node's durable state lives in (multi-tenant key). Opaque to the toolkit. */
  workspaceId: string;
  status: SpawnStatus;
  /** Resource-owning identity — the key a host uses to release this node's locks/claims. */
  sessionOwner: string | null;
  /** Lock partition for this node's owner (the host's lock-store namespace). */
  coordinationDomain: string;
  restartStrategy: RestartStrategy;
  restartCount: number;
  restartWindowStart: Date | null;
  /** Depth relative to the query root (0 = the root passed to getSubtree). */
  depth: number;

  // ── opaque host annotations (carried, never interpreted) ──────────────────────
  harnessSlug: string | null;
  parentRole: string | null;
  childRole: string;
  featureId: string | null;
  chunkId: string | null;
  planSlug: string | null;
  itemId: string | null;
  /** Resolved per-spawn model spec/tier (absent/null = no per-spawn override).
      Optional so hosts without per-spawn model selection never touch it. */
  modelSpec?: string | null;
  modelTier?: string | null;
  /** Parent-authored brief that started this spawn (absent/null = none). */
  brief?: string | null;
  /** Supervisor liveness annotations (carried, never interpreted by the
      toolkit): last supervisor heartbeat / last observed child output.
      Optional so hosts without supervision heartbeats never touch them. */
  heartbeatAt?: Date | null;
  lastOutputAt?: Date | null;
}

/** Result of recording one restart against a spawn's sliding intensity window. */
export interface IntensityResult {
  spawnId: string;
  /** Restarts counted in the current window (this one included). */
  count: number;
  windowStart: Date;
  /** The window had lapsed and was reset to start fresh at this restart. */
  windowReset: boolean;
  /** count > maxRestarts — the crash-loop bound is breached. */
  intensityExceeded: boolean;
  maxRestarts: number;
  windowSec: number;
}

export interface CompletionGate {
  canComplete: boolean;
  openChildren: number;
}
