/**
 * cross-hive-drain-action.ts — the periodic cross-Hive outbox drain
 * (hive-network-surface-2026-06-11 P-001, brief B-01).
 *
 * One `system:cross-hive-outbox-drain` action, two phases per fire, both
 * replay-safe (a re-run is one extra reconcile read + one extra backoff-gated
 * drain pass — the outbox deletes on delivery, so nothing double-sends):
 *
 *   1. RECONCILE — `ensureCrossHiveBoundariesWired(ctx.workspaceId)`: wire any
 *      Hive published since the last tick, close any flipped private — this is
 *      what makes publish/visibility changes converge without a restart.
 *   2. DRAIN — one backoff-aware pass over EVERY wired boundary in the process
 *      (other workspaces' wirings drain too — the registry is process-global
 *      and a drain on an empty outbox is one SELECT).
 *
 * SELF-GATING: no published Hives → reconcile finds nothing, the drain loop has
 * nothing to iterate — a clean no-op, so the routine ships ACTIVE. The fast
 * path for an offline peer's return is the transport's HELLO hook (see
 * cross-hive-boundary-boot.ts), not this tick — this is the safety net.
 *
 * payload_template tunables: `baseBackoffMs`, `capBackoffMs` (see
 * cross-hive-outbox-drain.ts defaults: 30s base doubling to a 30min cap).
 *
 * Seed: seed-cross-hive-drain-routine.ts. Registered via register-system-actions.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import {
  ensureCrossHiveBoundariesWired,
  listWiredCrossHiveBoundaries,
  type EnsureCrossHiveBoundariesOpts,
} from '../../cross-hive-boundary-boot';

/**
 * One tick: reconcile this workspace's boundaries, then drain every wired
 * boundary. Exported (with the ensure opts threaded) so the unit test drives it
 * without PG/swarm; the registered action passes only the ctx.
 */
export async function runCrossHiveDrainTick(
  ctx: Pick<SystemActionCtx, 'workspaceId' | 'payloadTemplate'>,
  ensureOpts: EnsureCrossHiveBoundariesOpts = {},
): Promise<{ delivered: number; pendingTotal: number; drainedBoundaries: number }> {
  const baseMs = Number(ctx.payloadTemplate?.baseBackoffMs) || undefined;
  const capMs = Number(ctx.payloadTemplate?.capBackoffMs) || undefined;

  const reconciled = await ensureCrossHiveBoundariesWired(ctx.workspaceId, ensureOpts);
  if (reconciled.wired.length > 0 || reconciled.closed.length > 0) {
     
    console.log(
      `[cross-hive-drain] reconcile: wired=[${reconciled.wired.join(', ')}] closed=[${reconciled.closed.join(', ')}]`,
    );
  }

  let delivered = 0;
  let pendingTotal = 0;
  let drainedBoundaries = 0;
  for (const b of listWiredCrossHiveBoundaries()) {
    try {
      const out = await b.drain({
        ...(baseMs !== undefined ? { baseMs } : {}),
        ...(capMs !== undefined ? { capMs } : {}),
      });
      drainedBoundaries += 1;
      delivered += out.delivered;
      pendingTotal += out.pending;
      if (out.delivered > 0 || out.failedPeers.length > 0) {
         
        console.log(
          `[cross-hive-drain] ${b.workspaceId}/${b.potSlug}: delivered=${out.delivered} ` +
            `pending=${out.pending} offlinePeers=${out.failedPeers.length} backedOff=${out.backedOffPeers.length}`,
        );
      }
    } catch (e) {
       
      console.warn(
        `[cross-hive-drain] drain failed for ${b.workspaceId}/${b.potSlug}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return { delivered, pendingTotal, drainedBoundaries };
}

// `scheduling: 'on-demand'` (EI-18752496371939475): armed per HIVE by
// `arm-hive-cross-hive-drain.ts` as hives are created, not seeded once per workspace. A
// workspace with no hives legitimately has zero rows.
registerSystemAction(
  'cross-hive-outbox-drain',
  async (ctx: SystemActionCtx) => {
    await runCrossHiveDrainTick(ctx);
  },
  { scheduling: 'on-demand' },
);
