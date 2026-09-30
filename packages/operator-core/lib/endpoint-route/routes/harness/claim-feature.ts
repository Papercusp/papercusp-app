/**
 * Distributed-claim HTTP wrapper — Model B Stage-5 production wiring.
 *
 *   POST /api/harness/:slug/claim-feature
 *     body: { feature_id: string, github_user_id: number }
 *     →
 *       { strategy: 'distributed' | 'single-writer',
 *         reason?: 'attempted' | 'substrate-not-booted' | 'pubkey-unresolved'
 *                 | 'single-writer-fallback' | 'manually-active',
 *         claimed: boolean,
 *         my_pubkey?: string,
 *         audit_outcome?: 'won' | 'lost' | 'timeout' | 'error',
 *         audit_recorded?: boolean,
 *         audit_error?: string }
 *
 * Purpose: the subprocess orchestrator can't access the operator's
 * in-process substrate handles directly. It calls this endpoint
 * before dispatching a worker on a feature.
 *
 * D-002: the claim is an ADVISORY hint, not a race — appending it always
 * succeeds (`claimed: true`). It records one row in the APPEND-ONLY
 * `feature_claims` audit history (keyed `<feature_id>/<seq>`); claims do not
 * cross-author-collide, so there is no LWW-clobber and no clobber-toast on
 * this path (and no `won:false`). The orchestrator dispatches on `claimed`;
 * who currently holds a feature is derived separately (latest `claimed_at`)
 * and the GitHub PR merge is the real authority. The only `claimed:false`
 * is `manually-active` (a human flipped the feature to working) — that
 * still blocks pickup.
 *
 * Public (auth=public) — same tier as the rest of the harness API
 * during pre-alpha.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getClaimStrategy } from '../../../orchestrator/get-claim-strategy';
import { attemptDistributedClaim } from '../../../orchestrator/distributed-claim';
import { loadWorkingSet } from '../../../sync/hyperbee/load-working-set';

interface ClaimBody {
  feature_id?: unknown;
  github_user_id?: unknown;
}

export function parseClaimBody(
  body: unknown,
): { ok: true; featureId: string; userId: number } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const b = body as ClaimBody;
  if (typeof b.feature_id !== 'string' || b.feature_id.length === 0) {
    return { ok: false, error: 'feature_id required' };
  }
  const rawUser = b.github_user_id;
  const n = typeof rawUser === 'number' ? rawUser : Number.parseInt(String(rawUser), 10);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: 'github_user_id must be positive integer' };
  }
  return { ok: true, featureId: b.feature_id, userId: n };
}

const post = defineTool({
  method: 'POST',
  path: '/harness/:slug/claim-feature',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const parsed = parseClaimBody(await req.json().catch(() => null));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    // P-038b — orchestrator eligibility exclusion. If a human has
    // manually flipped this feature to "working" (non-empty working
    // set, excluding the claimer themselves), the orchestrator must
    // NOT pick it up. Checked before the distributed claim so a
    // manual flip wins regardless of substrate strategy.
    try {
      const { sql } = getOrgPg();
      const runQuery = async <T,>(query: string, paramsArr: unknown[]): Promise<T[]> => {
        return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
      };
      const working = await loadWorkingSet({
        workspace_id: workspaceId,
        harness_slug: slug,
        feature_ids: [parsed.featureId],
        runQuery,
      });
      const members = working[parsed.featureId] ?? [];
      const othersActive = members.filter((m) => m.github_user_id !== parsed.userId);
      if (othersActive.length > 0) {
        return Response.json({
          strategy: 'distributed',
          claimed: false,
          reason: 'manually-active',
          active_users: othersActive.map((m) => m.github_user_id),
        });
      }
    } catch {
      // Working-set lookup failed (table missing / PG hiccup) — don't
      // block the claim on a diagnostic read. Fall through to the
      // normal claim path.
    }

    const strategy = getClaimStrategy({ workspaceId, harnessSlug: slug });
    if (strategy === 'single-writer') {
      // Substrate is off / handle not booted for this harness. Caller
      // should fall back to its legacy claim path (PG-only, single-
      // writer race-free because there's only one writer).
      return Response.json({
        strategy,
        claimed: true,
        reason: 'single-writer-fallback',
      });
    }
    const r = await attemptDistributedClaim({
      workspaceId,
      harnessSlug: slug,
      feature_id: parsed.featureId,
      claimer_github_user_id: parsed.userId,
    });

    if (r.reason === 'substrate-not-booted' || r.reason === 'pubkey-unresolved') {
      // Per-harness handle disappeared between strategy check and
      // claim attempt — race, but recoverable. Tell the caller to
      // fall back as if single-writer.
      return Response.json({
        strategy: 'single-writer',
        claimed: true,
        reason: r.reason,
      });
    }
    // reason === 'attempted' — the advisory claim was appended as one row in
    // the append-only feature_claims audit history. claimed is always true;
    // claims don't cross-author-collide, so there's no downstream clobber.
    return Response.json({
      strategy: 'distributed',
      reason: r.reason,
      claimed: r.claimed,
      my_pubkey: r.my_pubkey,
      audit_outcome: r.audit_outcome,
      audit_recorded: r.audit_recorded,
      audit_error: r.audit_error,
    });
  },
});

export default [post];
