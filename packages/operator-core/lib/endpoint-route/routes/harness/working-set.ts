/**
 * Feature working-set endpoints — Phase 6 P-038 (manual "set active").
 *
 *   GET  /api/harness/:slug/working-set
 *        ?feature_ids=F-1,F-2   (optional comma-sep filter)
 *        → { working: { [feature_id]: WorkingSetMember[] } }
 *
 *   POST /api/harness/:slug/working-set/:featureId/set-active
 *        body: { github_user_id: number }
 *        → { ok: true }
 *
 *   POST /api/harness/:slug/working-set/:featureId/clear-active
 *        body: { github_user_id: number }
 *        → { ok: true }
 *
 * Writes go through the substrate (Hyperbee append → PG projection);
 * reads hit PG directly. substrate-off → { ok: false,
 * reason: 'substrate-off' } so the UI degrades cleanly pre-flag-flip.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getBootedHarness } from '../../../sync/hyperbee/boot-all';
import {
  setActiveFeature,
  clearActiveFeature,
} from '../../../sync/hyperbee/write-working-set';
import { loadWorkingSet } from '../../../sync/hyperbee/load-working-set';
import { resolveMyPubkey } from '../../../orchestrator/distributed-claim';

const getWorking = defineTool({
  method: 'GET',
  path: '/harness/:slug/working-set',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const url = new URL(req.url);
    const featureIdsRaw = url.searchParams.get('feature_ids');
    const feature_ids = featureIdsRaw
      ? featureIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const { sql } = getOrgPg();
    const runQuery = async <T,>(query: string, paramsArr: unknown[]): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
    const working = await loadWorkingSet({
      workspace_id: workspaceId,
      harness_slug: slug,
      feature_ids,
      runQuery,
    });
    return Response.json({ working });
  },
});

interface WriteBody {
  github_user_id?: unknown;
}

export function parseWriteBody(
  body: unknown,
): { ok: true; userId: number } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const raw = (body as WriteBody).github_user_id;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: 'github_user_id must be positive integer' };
  }
  return { ok: true, userId: n };
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

const postSetActive = defineTool({
  method: 'POST',
  path: '/harness/:slug/working-set/:featureId/set-active',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const featureId = ctx.params.featureId as string;
    const workspaceId = activeWorkspaceId();
    const parsed = parseWriteBody(await readJsonBody(req));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    const handle = getBootedHarness(workspaceId, slug);
    if (!handle) return Response.json({ ok: false, reason: 'substrate-off' }, { status: 200 });
    await setActiveFeature({
      handle,
      githubUserId: parsed.userId,
      featureId,
      writerPubkey: resolveMyPubkey(handle) ?? undefined,
    });
    return Response.json({ ok: true });
  },
});

const postClearActive = defineTool({
  method: 'POST',
  path: '/harness/:slug/working-set/:featureId/clear-active',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const featureId = ctx.params.featureId as string;
    const workspaceId = activeWorkspaceId();
    const parsed = parseWriteBody(await readJsonBody(req));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    const handle = getBootedHarness(workspaceId, slug);
    if (!handle) return Response.json({ ok: false, reason: 'substrate-off' }, { status: 200 });
    await clearActiveFeature({
      handle,
      githubUserId: parsed.userId,
      featureId,
      writerPubkey: resolveMyPubkey(handle) ?? undefined,
    });
    return Response.json({ ok: true });
  },
});

export default [getWorking, postSetActive, postClearActive];
