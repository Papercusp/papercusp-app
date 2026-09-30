/**
 * dev:dogfood_substrate_status — substrate diagnostic for SU shells.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Exposes the same shape as /api/admin/dogfood-substrate-health
 * via the MCP tool surface so SU shells (Claude Code, OMP, Codex)
 * can query the substrate without going through HTTP.
 *
 * Wraps `getInProcessSubstrateStatus` with a PG-backed
 * `resolveClaimStats` so claim error rates feed into the verdict.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getInProcessSubstrateStatus } from '../../sync/hyperbee/in-process-status';
import { getBootedHarness } from '../../sync/hyperbee/boot-all';
import { getCachedRemoteBootedHandles } from '../../sync/hyperbee/cluster-booted-handles-sync';
import { getPgBootedHandlesSnapshotFallback } from '../../sync/hyperbee/substrate-booted-handles-pg';
import { loadClaimAttemptStats } from '../../orchestrator/load-claim-attempts';
import {
  loadSubstrateDrainStats,
  type SubstrateDrainStat,
} from '../../sync/hyperbee/load-drain-stats';
import { getOrgPg } from '@papercusp/db-org';

/**
 * WI-37387: the composer's `resolveDrainStats` seam DEFAULTS to zero-drain
 * (`in-process-status.ts` ZERO_DRAIN) because that module is pure/PG-free, and
 * this tool used to leave it defaulted at every call site. That is not a missing
 * nicety — per the seam's own doc-comment it "is what flips a stuck
 * (captured-but-not-federating) harness off 'healthy'", so omitting it made the
 * drain leg of the verdict structurally unable to fire: every harness reported
 * `undrainedCount: 0` and "no issues detected" regardless of the real backlog
 * (measured live: papercusp at 34,491 undrained rows still rendered healthy).
 *
 * The HTTP route this tool's description claims to mirror
 * (`build-federation-status.ts`) and `run-drain-reconcile.ts` both wire it, so
 * agent callers were getting a strictly weaker verdict than HTTP callers.
 *
 * NB scope: the map is keyed `${workspace_id}::${harness_slug}` and BOTH parts
 * matter — `substrate_outbox` is multi-tenant and the same slug exists under
 * more than one workspace (papercusp is live under both `papercusp-workspace`
 * and `default`), so a slug-only lookup would silently mix tenants.
 */
const ZERO_DRAIN: SubstrateDrainStat = { undrainedCount: 0, oldestUndrainedAgeMs: null };

const targetHarnessSchema = z.object({
  workspaceId: z.string().min(1),
  harnessSlug: z.string().min(1),
});

const ownLogProbeSchema = targetHarnessSchema.extend({
  index: z.number().int().nonnegative(),
});

type OwnLogProbe = z.infer<typeof ownLogProbeSchema>;
type TargetHarness = z.infer<typeof targetHarnessSchema>;

/**
 * Registered machine-readable shape for the substrate diagnostic. The nested
 * per-harness diagnostics evolve with the substrate probes, so their stable
 * collection roots are declared here while the row contracts remain open.
 */
export const substrateStatusResultSchema = z
  .object({
    substrateActive: z.boolean().optional(),
    bootedCount: z.number().int().nonnegative().optional(),
    summary: z.unknown().optional(),
    harnesses: z.array(z.unknown()).optional(),
    logStats: z.array(z.unknown()).optional(),
    replicationLiveness: z.array(z.unknown()).optional(),
    contentConnectivity: z.array(z.unknown()).optional(),
    reachedSubstrateOwner: z.boolean().optional(),
    healthInputsObserved: z.boolean().optional(),
    ownLogProbe: z.unknown().optional(),
  })
  .passthrough();

/**
 * Narrow every per-harness diagnostic array before dispatch-level result
 * shaping. Aggregate fields (`bootedCount`, `summary`) intentionally remain
 * workspace-wide; the filter exists so a caller that needs one exact row does
 * not lose it when a large booted set crosses the result door.
 *
 * A targeted read with no matching row is different from an un-targeted idle
 * workspace. The latter is a measured empty state and may be healthy; the
 * former is an absent required target and must not inherit that healthy
 * verdict. Preserve the source population counts, but downgrade a healthy
 * aggregate to `degraded` as an explicit unknown/absent-target sentinel.
 */
function filterToTargetHarness(
  status: ReturnType<typeof getInProcessSubstrateStatus>,
  target?: TargetHarness,
): ReturnType<typeof getInProcessSubstrateStatus> {
  if (!target) return status;
  const matches = (row: { workspaceId: string; harnessSlug: string }): boolean =>
    row.workspaceId === target.workspaceId && row.harnessSlug === target.harnessSlug;
  const harnesses = status.harnesses.filter(matches);
  const summary =
    harnesses.length === 0 && status.summary.worstVerdict === 'healthy'
      ? { ...status.summary, worstVerdict: 'degraded' as const }
      : status.summary;
  return {
    ...status,
    summary,
    harnesses,
    logStats: status.logStats.filter(matches),
    replicationLiveness: status.replicationLiveness.filter(matches),
    contentConnectivity: status.contentConnectivity.filter(matches),
  };
}

/**
 * Attach one exact indexed own-log read to the existing status diagnostic.
 * The in-process handle reads its already-open Corestore; a relocated handle's
 * `OwnLog.get` routes over the bounded `substrate:getOwnLogOp` RPC. Either way,
 * this never opens a second Corestore or joins transport just to inspect a row.
 */
async function attachOwnLogProbe<T extends object>(status: T, probe?: OwnLogProbe): Promise<T | (T & { ownLogProbe: unknown })> {
  if (!probe) return status;
  const handle = getBootedHarness(probe.workspaceId, probe.harnessSlug);
  if (!handle) {
    return {
      ...status,
      ownLogProbe: {
        ...probe,
        available: false,
        reason: 'booted harness handle is not available in this process',
      },
    };
  }
  try {
    const op = await handle.ownLog.get(probe.index);
    return {
      ...status,
      ownLogProbe: {
        ...probe,
        available: true,
        keyHex: handle.ownLog.keyHex,
        length: handle.ownLog.length,
        op,
      },
    };
  } catch (error) {
    return {
      ...status,
      ownLogProbe: {
        ...probe,
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * EI-19327550671915579: when the cheap sync path (this process's own boot map,
 * or the node:cluster IPC cache) didn't reach the substrate owner, fall back to
 * the cross-SERVICE PG snapshot — the leg that actually reaches a request-only
 * host under the dedicated-bg-host topology, where node:cluster IPC can never
 * apply at all (bg-host is a separate systemd service). Re-runs the pure sync
 * composer with the PG-derived snapshot handed in as a plain closure, so
 * `getInProcessSubstrateStatus` itself never has to become async.
 */
async function withPgBootedHandlesFallback(
  status: ReturnType<typeof getInProcessSubstrateStatus>,
  recompute: (resolveRemoteBootedHandles: () => ReturnType<typeof getCachedRemoteBootedHandles>) => ReturnType<typeof getInProcessSubstrateStatus>,
): Promise<ReturnType<typeof getInProcessSubstrateStatus>> {
  if (status.reachedSubstrateOwner) return status;
  const pg = await getPgBootedHandlesSnapshotFallback();
  if (!pg) return status;
  return recompute(() => pg);
}

export default defineTool({
  name: 'dev:dogfood_substrate_status',
  profile: 'engineer',
  description:
    'Hyperbee substrate diagnostic: booted harnesses, per-row health verdict, workspace summary. The substrate is always active (no flag gate). Mirrors /api/admin/dogfood-substrate-health.',
  capability: 'intel:read',
  guidance: {
    when: `Investigating substrate boot state, claim error rates, or workspace-level dogfood health. The substrate always boots, so run this any time after the operator has started.`,
    notWhen: `For per-harness Insights or feature-level data, use the harness:* tools. This is the dogfood substrate layer specifically.`,
    chaining: `Pair with reading the agent-insights/substrate-flag-flip-runbook page for what to do if verdicts come back degraded/unhealthy. Any \`replicationLiveness[].logs[]\` row with \`stale:true\` (verdict 'sampling_stale') has every live-looking field (mergedPosition, knownLength, msSince* etc.) nulled out — the merge loop hasn't fed its registry entry recently, so those numbers are frozen and comparing two stale reads proves nothing (EI-19328421457282435). For actual merge progress on a stale row, query \`harness_shared.substrate_merge_cursor\` (position + updated_at) directly — it's the ground truth this diagnostic's sampler can silently fall behind.`,
    returns:
      '{ substrateActive, bootedCount, summary, harnesses[], logStats[], replicationLiveness[], contentConnectivity[], reachedSubstrateOwner, healthInputsObserved, ownLogProbe? }. ' +
      '`harnesses[]` is the per-harness verdict collection; aggregate counts remain in `summary` and `bootedCount`. Pass `targetHarness` to narrow per-harness arrays to one exact workspace/harness pair.',
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    ownLogProbe: ownLogProbeSchema.optional(),
    targetHarness: targetHarnessSchema.optional(),
  }),
  result: substrateStatusResultSchema,
  async handler(args) {
    const { sql } = getOrgPg();
    const runQuery = async <T,>(
      query: string,
      paramsArr: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
    // WI-37387: prefetch drain stats ONCE, before the first compose, so every
    // call site below can resolve them synchronously. `loadSubstrateDrainStats`
    // swallows a missing table into an empty map, so this degrades to honest
    // zero-drain rather than throwing the diagnostic read.
    const drainByKey = await loadSubstrateDrainStats({ runQuery }).catch(
      () => new Map<string, SubstrateDrainStat>(),
    );
    const resolveDrainStats = (ws: string, slug: string): SubstrateDrainStat =>
      drainByKey.get(`${ws}::${slug}`) ?? ZERO_DRAIN;
    let status = await Promise.resolve(
      getInProcessSubstrateStatus({
        resolveClaimStats: () => ({ total: 0, won: 0, lost: 0, error: 0 }),
        resolveDrainStats,
        // EI-8816: on a request-only cluster worker, listBootedHandles() is always
        // empty (the substrate boots only on the primary) — fall back to the
        // primary's cached broadcast rather than silently reporting bootedCount:0.
        resolveRemoteBootedHandles: getCachedRemoteBootedHandles,
      }),
    );
    status = await withPgBootedHandlesFallback(status, (resolveRemoteBootedHandles) =>
      getInProcessSubstrateStatus({
        resolveClaimStats: () => ({ total: 0, won: 0, lost: 0, error: 0 }),
        resolveDrainStats,
        resolveRemoteBootedHandles,
      }),
    );
    // Second pass: for any booted harness, refresh the stats with the
    // real PG numbers and re-derive the verdict. Done in a second pass
    // so the in-process composer stays sync + PG-free.
    if (status.harnesses.length > 0) {
      const realStats = await Promise.all(
        status.harnesses.map(async (h) => ({
          key: `${h.workspaceId}::${h.harnessSlug}`,
          stats: await loadClaimAttemptStats({
            workspace_id: h.workspaceId,
            harness_slug: h.harnessSlug,
            runQuery,
          }).catch(() => ({ total: 0, won: 0, lost: 0, error: 0 })),
        })),
      );
      const statsByKey = new Map(realStats.map((s) => [s.key, s.stats]));
      let refreshed = getInProcessSubstrateStatus({
        resolveClaimStats: (wsId, slug) =>
          statsByKey.get(`${wsId}::${slug}`) ?? {
            total: 0,
            won: 0,
            lost: 0,
            error: 0,
          },
        resolveDrainStats,
        resolveRemoteBootedHandles: getCachedRemoteBootedHandles,
      });
      refreshed = await withPgBootedHandlesFallback(refreshed, (resolveRemoteBootedHandles) =>
        getInProcessSubstrateStatus({
          resolveClaimStats: (wsId, slug) =>
            statsByKey.get(`${wsId}::${slug}`) ?? {
              total: 0,
              won: 0,
              lost: 0,
              error: 0,
            },
          resolveDrainStats,
          resolveRemoteBootedHandles,
        }),
      );
      const filtered = filterToTargetHarness(refreshed, args.targetHarness);
      const output = await attachOwnLogProbe(filtered, args.ownLogProbe);
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
      };
    }
    const filtered = filterToTargetHarness(status, args.targetHarness);
    const output = await attachOwnLogProbe(filtered, args.ownLogProbe);
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
    };
  },
});
