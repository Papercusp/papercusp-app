/**
 * GET /api/admin/dogfood-substrate-health — per-harness verdict.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Aggregates flag state + boot map + per-harness claim stats + per-
 * harness bootstrap progress into a single
 * { workspaceId, harnessSlug, verdict, reasons }[] envelope.
 *
 * Used by monitoring scripts + the admin diagnostic page. Public read.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { isSubstrateOwnerProcess } from '../../../background-workers';
import { listBootedHandles } from '../../../sync/hyperbee/boot-all';
import { listBootstrapProgress } from '../../../sync/hyperbee/bootstrap-progress';
import { loadSubstrateDrainStats } from '../../../sync/hyperbee/load-drain-stats';
import { loadClaimAttemptStats } from '../../../orchestrator/load-claim-attempts';
import {
  assessHarnessSubstrateHealth,
  type SubstrateHealthVerdict,
} from '../../../sync/hyperbee/health';
import { summariseWorkspaceSubstrate } from '../../../sync/hyperbee/summary';
import { resolveEffectiveBootedHandles } from '../../../sync/hyperbee/in-process-status';
import { getCachedRemoteBootedHandles } from '../../../sync/hyperbee/cluster-booted-handles-sync';
import { getPgBootedHandlesSnapshotFallback } from '../../../sync/hyperbee/substrate-booted-handles-pg';

interface HarnessHealthRow {
  workspaceId: string;
  harnessSlug: string;
  verdict: SubstrateHealthVerdict;
  reasons: string[];
}

const get = defineTool({
  method: 'GET',
  path: '/admin/dogfood-substrate-health',
  // Admin-only substrate health (verified admin insights UI); gated per D3 (was 'public').
  // unverified-loopback: cookie-less desktop webview (EI-338) — the packaged Mac/Windows
  // desktop app hits this route as a diagnostic from localhost with no session cookie to
  // present, so it only ever resolves to 'unverified-loopback' trust, never 'verified'/
  // 'trusted'. Without this the route 403s for exactly the audience (packaged-desktop
  // diagnosability) it exists to serve (EI-8816) — mirrors the same fix already applied to
  // deploy-accounts-link-* and other loopback-only admin routes for the identical reason.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler() {
    // Stage 4d: the substrate always boots (the opt-in gate was removed).
    const flagEnabled = true;
    // EI-8816: on a request-only cluster worker, listBootedHandles() is always empty
    // (the substrate boots only on the primary) — fall back to the primary's cached
    // broadcast rather than silently reporting an empty `harnesses: []`.
    // WI-5307: `nodeCluster.isPrimary` alone is NOT "did this process boot the substrate"
    // — under the dedicated-bg-host topology, :3070/:3270 are each their own unforked
    // primary (isPrimary:true) that DECLARED itself request-only and never boots the
    // substrate at all (bg-host does). Blindly trusting `local` there rendered a
    // false-confident `reachedSubstrateOwner:true, bootedCount:0` even while the substrate
    // was genuinely live on bg-host. `requestOnlyHost()` excludes that case.
    // EI-18735338283879820: use the SHARED predicate (background-workers.ts) rather than
    // an inline copy — two copies of one rule is exactly what let the read/write halves
    // of this fix drift apart the first time.
    let { booted, reachedSubstrateOwner } = resolveEffectiveBootedHandles(listBootedHandles(), {
      isSubstrateOwnerProcess: isSubstrateOwnerProcess(),
      resolveRemote: getCachedRemoteBootedHandles,
    });
    // EI-19327550671915579: see dogfood-substrate-status.ts's identical comment —
    // node:cluster IPC can't cross the dedicated-bg-host service boundary, so fall
    // back to the cross-SERVICE PG snapshot only when the fast path found nothing.
    if (!reachedSubstrateOwner) {
      const pg = await getPgBootedHandlesSnapshotFallback();
      if (pg) {
        booted = pg.handles;
        reachedSubstrateOwner = true;
      }
    }
    const progress = listBootstrapProgress();
    const progressByKey = new Map<
      string,
      ReturnType<typeof listBootstrapProgress>[number]
    >();
    for (const p of progress) {
      progressByKey.set(`${p.workspaceId}::${p.harnessSlug}`, p);
    }

    const { sql } = getOrgPg();
    const runQuery = async <T,>(
      query: string,
      paramsArr: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
    const drainByKey = await loadSubstrateDrainStats({ runQuery });

    const rows: HarnessHealthRow[] = await Promise.all(
      booted.map(async (h) => {
        const stats = await loadClaimAttemptStats({
          workspace_id: h.workspaceId,
          harness_slug: h.harnessSlug,
          runQuery,
        });
        const bp = progressByKey.get(`${h.workspaceId}::${h.harnessSlug}`);
        const drainStats = drainByKey.get(`${h.workspaceId}::${h.harnessSlug}`) ?? {
          undrainedCount: 0,
          oldestUndrainedAgeMs: null,
        };
        const { verdict, reasons } = assessHarnessSubstrateHealth({
          flagEnabled,
          handlePresent: true,
          claimStats: stats,
          bootstrapProgress: bp ?? null,
          drainStats,
        });
        return {
          workspaceId: h.workspaceId,
          harnessSlug: h.harnessSlug,
          verdict,
          reasons,
        };
      }),
    );

    // Zero booted harnesses is the idle ground state. The substrate is
    // always-on (the flag was removed), so there is no workspace-level
    // "disabled" verdict to synthesise and no phantom placeholder row:
    // `harnesses: []` lets the UI render its empty state ("No shared
    // harnesses booted yet"), and the summary reports worstVerdict
    // 'healthy' — nothing is wrong, there is simply nothing booted.
    const summary = summariseWorkspaceSubstrate(flagEnabled, rows);
    return Response.json({
      flagEnabled,
      summary,
      harnesses: rows,
      // EI-8816: explicit blind-spot marker — false means this read did NOT reach the
      // substrate-owning process's real state (a cluster worker with no/stale cached
      // broadcast), so an empty `harnesses` here is NOT the same as "nothing booted".
      reachedSubstrateOwner,
    });
  },
});

export default [get];
