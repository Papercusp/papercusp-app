/**
 * activity-claim-renewal — the D-003 per-turn auto-renewal of plan-item ACTIVITY
 * claims, driven by the cross-CLI activity bridge.
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (D-003, the integration su-119ce
 * surfaced as "heartbeat{kind:activity} → the per-turn activity bridge").
 *
 * D-003: on a SHARED harness a claim is held by ACTIVITY-liveness — its lease renews on
 * each completed agent turn, and lapses on inactivity so an idle claim returns to the
 * pool. The per-CLI hooks already report every turn to the activity bridge
 * (`activity:report` → harness_shared.agent_activity → NOTIFY agent_activity), which the
 * `agent-activity-bus` fans out. This consumer rides that SAME bus: on each activity
 * wake for an owner, it renews that owner's non-expired activity-mode claims — so an
 * agent that is producing turns keeps its claims without a manual heartbeat, and an
 * agent that goes idle lets them lapse. The explicit `plan_items:heartbeat {kind:'activity'}`
 * tool remains the manual path (+ `kind:'extend'` for a long single op); this just makes
 * the common case automatic.
 *
 * Decoupled CONSUMER: it subscribes to the bus + calls the claim store — zero edits to
 * the activity bridge (papercusp-worker-integration's surface). Host-only (the bus opens
 * a PG LISTEN), so it is armed from the host boot (`dbos/bootstrap.ts`), never a tool
 * barrel that might load in a non-host bundle. Cheap on the hot path: a per-owner THROTTLE
 * (an in-memory last-renew map) collapses an owner's burst of per-tool-call activity into
 * at most one renewal per interval, and the renewal is a no-op UPDATE for the (common)
 * owners that hold no activity claims.
 */
import { onAgentActivity } from '../agent-activity-bus';
import { runWithWorkspace } from '../workspace-als';
import { orchestratorWorkspaceIds } from '../dbos/orchestrator-loop';
import { renewOwnerActivityClaims } from './claims';

/** At most one renewal per owner per this window — the lease TTL (≥20m) dwarfs it, so a
 *  coarse throttle keeps the per-tool-call bus cheap without risking a lapse. */
export const ACTIVITY_RENEW_THROTTLE_MS = Number(
  process.env.PAPERCUSP_PLAN_ITEM_ACTIVITY_RENEW_THROTTLE_MS ?? 60_000,
);

/**
 * A per-key leading-edge throttle: returns true at most once per `intervalMs` for a
 * given key. Pure over an injected clock so it is unit-testable with a fake clock.
 */
export function makeThrottle(intervalMs: number): (key: string, nowMs: number) => boolean {
  const last = new Map<string, number>();
  return (key, nowMs) => {
    const prev = last.get(key);
    if (prev !== undefined && nowMs - prev < intervalMs) return false;
    last.set(key, nowMs);
    return true;
  };
}

let unsubscribe: (() => void) | null = null;

/**
 * Arm the activity-driven claim renewal. Idempotent (a second call is a no-op while
 * armed). Returns the unsubscribe so the host can tear it down. Best-effort: a renewal
 * failure for one owner is logged, never thrown (it must not wedge the activity bus).
 */
export function startPlanItemActivityRenewal(now: () => number = Date.now): () => void {
  if (unsubscribe) return unsubscribe;
  const passes = makeThrottle(ACTIVITY_RENEW_THROTTLE_MS);
  unsubscribe = onAgentActivity((owner) => {
    if (!owner) return;
    if (!passes(owner, now())) return;
    void renewForOwner(owner);
  });
  return unsubscribe;
}

async function renewForOwner(owner: string): Promise<void> {
  try {
    // The owner is globally unique (PAPERCUSP_SID); renew its activity claims in each
    // managed workspace (each runWithWorkspace selects that workspace's org connection).
    // A no-op where the owner holds no activity claims.
    for (const workspaceId of orchestratorWorkspaceIds()) {
      await runWithWorkspace(workspaceId, () => renewOwnerActivityClaims(workspaceId, owner));
    }
  } catch (err) {
     
    console.warn(
      '[plan-item-claim] activity renewal failed for',
      owner,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Test-only: tear down the subscription + reset state. */
export function _stopPlanItemActivityRenewalForTests(): void {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}
