/**
 * wake-executor-fresh-context — the bee-context-efficiency Phase-1 keystone fork
 * (P-005; D-001, D-018, D-019, D-020, D-021, D-022).
 *
 * THE PROBLEM (D-011): a warm-inject of a DRAINED bee re-wakes it via the
 * wake-executor `--resume <sessionId>` path (Channel 2), which reloads the bee's
 * full prior-task transcript every turn (~138K tokens/turn, 97.4% of the prompt =
 * dead weight from finished tasks). This is the exact `--resume` failure mode the
 * Queen abandoned (queen-brief-cache).
 *
 * THE FORK: when a drained (process-exited) bee is warm-injected a NEW work-item and
 * the CUP_FRESH_CONTEXT_WARM_INJECT flag is on, re-route AWAY from `--resume` to a
 * FRESH spawn for that work-item — which already mints a fresh `--session-id`, pipes
 * the full bee preamble (buildPrompt), and runs assembleSpawnHydration (the dossier
 * P-008 + the work-item CHECKPOINT P-011 + predecessor handoff). The grown transcript
 * is dropped; CONTINUITY rides the work-item checkpoint (D-002), not the bee identity
 * (D-021 collapse to D-001 (b): the bee process is always exited between warm-inject
 * tasks, so there is no live warm process to preserve — fresh-context = fresh-spawn
 * reusing the work-item's claim, not the session).
 *
 * D-005 SAFETY: the caller invokes this ONLY at the Channel-2 boundary — i.e. for a
 * process-EXITED bee. A LIVE session PARKs upstream (never resumed), so within-task
 * wakes never reach this fork. The fork therefore only ever fires at a task boundary.
 *
 * FAIL-SOFT: anything that goes wrong (flag read, spawn over-cap, DB hiccup) returns
 * `false` and the caller falls through to the legacy `--resume` — the fork is purely
 * additive and never strands a wake. Flag OFF ⇒ this is never reached (the marker
 * payload is only stamped by place_batch when the flag is on), so the legacy carry is
 * byte-identical to today (the warm-inject-carry-seam.test oracle).
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { DeliveryWork } from './types';

/** The new-task target carried on the wake delivery's payload (stamped by place_batch). */
export interface FreshContextTarget {
  workItemId: string;
  harness: string;
  brief: string | null;
}

/**
 * Read the fresh-context warm-inject marker off a wake delivery's payload. place_batch
 * stamps `freshContextWorkItem`/`freshContextHarness`/`freshContextBrief` ONLY when the
 * flag is on, so the marker's mere presence signals "this drained bee is being
 * warm-injected a NEW work-item." Returns null when this is an ordinary wake.
 */
export function freshContextWarmInjectTarget(d: DeliveryWork): FreshContextTarget | null {
  const p = d.payload as
    | { freshContextWorkItem?: unknown; freshContextHarness?: unknown; freshContextBrief?: unknown }
    | null
    | undefined;
  if (!p || typeof p !== 'object') return null;
  const workItemId = typeof p.freshContextWorkItem === 'string' ? p.freshContextWorkItem : null;
  const harness = typeof p.freshContextHarness === 'string' ? p.freshContextHarness : null;
  if (!workItemId || !harness) return null;
  return { workItemId, harness, brief: typeof p.freshContextBrief === 'string' ? p.freshContextBrief : null };
}

/** DI seam for the fork (real bindings below; injected in tests so no spawn/DB fires). */
export interface FreshContextDeps {
  /** Default: getFlag(CUP_FRESH_CONTEXT_WARM_INJECT). The fork double-checks the flag
   *  (defence in depth — the payload should only exist when on). */
  enabled?: () => Promise<boolean>;
  /** Default: spawnAgentInHarness (operator-spawn) — fresh session + full preamble +
   *  the hydration tail (dossier + checkpoint + handoff). */
  spawnFreshBee?: (input: {
    workspaceId: string;
    harness: string;
    workItemId: string;
    brief: string | null;
    parentSpawnId: string;
  }) => Promise<{ ok: boolean; spawnId?: string | null }>;
  /** Default: releaseWorkItem — free the exited bee's stale claim so the fresh bee
   *  self-claims the work-item on boot (mirrors place_batch's woken:0 ladder). */
  releaseClaim?: (workItemId: string, harness: string) => Promise<void>;
}

export async function defaultFreshContextEnabled(): Promise<boolean> {
  return getFlag(FLAGS.CUP_FRESH_CONTEXT_WARM_INJECT, 'system').catch(() => false);
}

async function defaultSpawnFreshBee(input: {
  workspaceId: string;
  harness: string;
  workItemId: string;
  brief: string | null;
  parentSpawnId: string;
}): Promise<{ ok: boolean; spawnId?: string | null }> {
  // Dynamic import: avoids a static events/await → fleet import cycle (operator-spawn
  // does not import wake-executor, so this is one-directional at call time).
  const { spawnAgentInHarness } = await import('../../fleet/operator-spawn');
  const res = await spawnAgentInHarness({
    // Descriptive attribution for the observe-only governor receipt (D-011).
    // P-011 names this the riskiest caller to bind, so its share of the live
    // baseline is the number that decides whether Phase 3 is safe here.
    spawnCaller: 'events/await/wake-executor-fresh-context',
    workspaceId: input.workspaceId,
    harness: input.harness,
    role: 'cup',
    featureId: input.workItemId,
    brief: input.brief,
    parentSpawnId: input.parentSpawnId,
    parentRole: 'operator',
  });
  return { ok: res.ok, spawnId: res.spawnId };
}

async function defaultReleaseClaim(workItemId: string, harness: string): Promise<void> {
  const { releaseWorkItem } = await import('../../work-items');
  await releaseWorkItem(workItemId, { harness });
}

/**
 * Run the fresh-context fork for a drained bee being warm-injected `target`. Returns
 * `true` when a fresh bee was spawned (the caller returns delivered, NOT resumed);
 * `false` on flag-off / over-cap / any error (the caller falls through to `--resume`).
 */
export async function runFreshContextWarmInject(
  d: DeliveryWork,
  target: FreshContextTarget,
  deps: FreshContextDeps = {},
  log: (m: string) => void = () => {},
): Promise<boolean> {
  const enabled = deps.enabled ?? defaultFreshContextEnabled;
  if (!(await enabled().catch(() => false))) return false;

  const spawnFreshBee = deps.spawnFreshBee ?? defaultSpawnFreshBee;
  const releaseClaim = deps.releaseClaim ?? defaultReleaseClaim;
  try {
    const res = await spawnFreshBee({
      workspaceId: d.workspaceId,
      harness: target.harness,
      workItemId: target.workItemId,
      brief: target.brief,
      // Lineage: the fresh bee succeeds the exited one (its ownerId IS a spawn id).
      parentSpawnId: d.subscriberId,
    });
    if (!res.ok) {
      log(`fresh-context warm-inject: fresh spawn for ${target.workItemId} not admitted — falling back to --resume`);
      return false;
    }
    // The exited bee's claim is stale; free it so the fresh bee self-claims the item on
    // boot (the same release→fresh-spawn handoff as place_batch's woken:0 ladder).
    await releaseClaim(target.workItemId, target.harness).catch((e) =>
      log(`fresh-context warm-inject: release claim ${target.workItemId} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`),
    );
    log(`fresh-context warm-inject: ${d.subscriberId} drained → fresh bee ${res.spawnId} on ${target.workItemId} (no transcript carry)`);
    return true;
  } catch (e) {
    log(`fresh-context warm-inject: errored (${e instanceof Error ? e.message : String(e)}) — falling back to --resume`);
    return false;
  }
}
