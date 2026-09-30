/**
 * Claim-audit read endpoint — Phase 6 diagnostic.
 *
 *   GET /api/harness/:slug/claim-attempts
 *   query:
 *     ?stats=1               → returns { stats: { total, won, lost, error } }
 *     ?stats=0               → returns { attempts: ClaimAttemptRow[] }
 *     ?feature_id=F-1        → filter to one feature
 *     ?outcome=won|lost|error
 *     ?limit=N (default 50, capped at 200)
 *
 * Reads harness_shared.claim_audit. Public — same shape as other
 * harness diagnostic endpoints. Defensive: missing table yields the
 * empty / zero shape (no 500s).
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';
import {
  loadClaimAttemptStats,
  loadRecentClaimAttempts,
} from '../../../orchestrator/load-claim-attempts';

const get = defineTool({
  method: 'GET',
  path: '/harness/:slug/claim-attempts',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const url = new URL(req.url);
    const wantStats = url.searchParams.get('stats') === '1';
    const featureId = url.searchParams.get('feature_id') ?? undefined;
    const outcomeRaw = url.searchParams.get('outcome');
    const outcome =
      outcomeRaw === 'won' || outcomeRaw === 'lost' || outcomeRaw === 'error'
        ? outcomeRaw
        : undefined;
    const rawLimit = Number.parseInt(
      url.searchParams.get('limit') ?? '50',
      10,
    );
    const limit = Math.max(
      1,
      Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50),
    );
    const { sql } = getOrgPg();
    const runQuery = async <T,>(
      query: string,
      paramsArr: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
    if (wantStats) {
      const stats = await loadClaimAttemptStats({
        workspace_id: workspaceId,
        harness_slug: slug,
        runQuery,
      });
      return Response.json({ stats });
    }
    const attempts = await loadRecentClaimAttempts({
      workspace_id: workspaceId,
      harness_slug: slug,
      feature_id: featureId,
      outcome,
      limit,
      runQuery,
    });
    return Response.json({ attempts });
  },
});

export default [get];
