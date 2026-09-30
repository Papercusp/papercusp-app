/**
 * GET /api/admin/dogfood-substrate-status — substrate boot diagnostic.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Reports which harnesses have a live Hyperbee substrate handle in
 * the current process — verifying the boot orchestrator successfully
 * attached to each harness in the active workspace.
 *
 * Response:
 *   {
 *     enabled: boolean,        // always true — the substrate always boots (Stage 4d)
 *     booted: Array<{ workspaceId, harnessSlug }>,
 *     bootedCount: number,
 *     reachedSubstrateOwner: boolean, // WI-5307 — false is an explicit blind-spot
 *       // marker (a forked cluster worker, or a request-only host under the
 *       // dedicated-bg-host topology): `booted`/`bootedCount` here are NOT
 *       // ground truth in that case — see in-process-status.ts.
 *   }
 *
 * Public read — no token. The list of harness slugs is already
 * discoverable from the workspace tree.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { isSubstrateOwnerProcess } from '../../../background-workers';
import { listBootedHandles } from '../../../sync/hyperbee/boot-all';
import { resolveEffectiveBootedHandles } from '../../../sync/hyperbee/in-process-status';
import { getCachedRemoteBootedHandles } from '../../../sync/hyperbee/cluster-booted-handles-sync';
import { getPgBootedHandlesSnapshotFallback } from '../../../sync/hyperbee/substrate-booted-handles-pg';

const get = defineTool({
  method: 'GET',
  path: '/admin/dogfood-substrate-status',
  // Admin-only substrate status (consumed by the verified admin insights UI);
  // gated per D3 auth posture (was 'public').
  auth: { trust: ['verified', 'trusted'] },
  async handler() {
    // WI-5307 (mirrors dogfood-substrate-health): this process's own
    // listBootedHandles() is only ground truth when it actually IS the substrate
    // owner — a node:cluster primary that has NOT declared itself request-only.
    // A request-only secondary (the dedicated-bg-host topology's :3070/:3270)
    // never boots the substrate at all, so trusting `local` there silently
    // rendered a false-confident empty `booted:[]`. Fall back to the primary's
    // cached broadcast (a genuine forked worker) when this isn't the owner.
    // EI-18735338283879820: use the SHARED predicate (background-workers.ts)
    // rather than an inline `nodeCluster.isPrimary && !requestOnlyHost()` copy —
    // two copies of one rule is exactly what let the read/write halves of this
    // fix drift apart the first time.
    let { booted, reachedSubstrateOwner } = resolveEffectiveBootedHandles(listBootedHandles(), {
      isSubstrateOwnerProcess: isSubstrateOwnerProcess(),
      resolveRemote: getCachedRemoteBootedHandles,
    });
    // EI-19327550671915579: the node:cluster IPC leg above only ever reaches a
    // forked WORKER of the substrate owner's own process tree — under the
    // dedicated-bg-host topology (:3070/:3270, a separate systemd service from
    // papercup-bg-host) it can never succeed, so `reachedSubstrateOwner` was
    // permanently false there. Fall back to the cross-SERVICE PG snapshot ONLY
    // when the fast in-process/cluster-IPC path came up empty — this keeps the
    // common (true-cluster) case a pure sync read with no PG round-trip.
    if (!reachedSubstrateOwner) {
      const pg = await getPgBootedHandlesSnapshotFallback();
      if (pg) {
        booted = pg.handles;
        reachedSubstrateOwner = true;
      }
    }
    return Response.json({
      // Stage 4d: the substrate always boots (the opt-in gate was removed).
      enabled: true,
      booted,
      bootedCount: booted.length,
      reachedSubstrateOwner,
    });
  },
});

export default [get];
