/**
 * Feature-queue endpoints — Phase 5b P-032.
 *
 *   GET  /api/harness/:slug/feature-queue-membership
 *        ?feature_ids=F-1,F-2   (optional; comma-sep filter)
 *        → { membership: { [feature_id]: QueueMember[] } }
 *
 *   POST /api/harness/:slug/feature-queue/:featureId/enqueue
 *        body: { github_user_id: number }
 *        → { ok: true }
 *
 *   POST /api/harness/:slug/feature-queue/:featureId/dequeue
 *        body: { github_user_id: number }
 *        → { ok: true }
 *
 * Writes go through the substrate (Hyperbee append → PG projection).
 * Reads go straight at PG (cheap, no substrate round-trip).
 *
 * The write endpoints are no-ops with `{ ok: false, reason: 'substrate-off' }`
 * when the substrate isn't booted — keeps the UI happy without 500s
 * during pre-flag-flip exploration.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getBootedHarness } from '../../../sync/hyperbee/boot-all';
import {
  enqueueFeature,
  dequeueFeature,
} from '../../../sync/hyperbee/write-feature-queue';
import { loadQueueMembership } from '../../../sync/hyperbee/load-queue-membership';
import { resolveMyPubkey } from '../../../orchestrator/distributed-claim';

// ─── GET membership ────────────────────────────────────────────────

const getMembership = defineTool({
  method: 'GET',
  path: '/harness/:slug/feature-queue-membership',
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
    const runQuery = async <T,>(
      query: string,
      paramsArr: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
    const membership = await loadQueueMembership({
      workspace_id: workspaceId,
      harness_slug: slug,
      feature_ids,
      runQuery,
    });
    return Response.json({ membership });
  },
});

// ─── shared write-path validation ─────────────────────────────────

interface WriteBody {
  github_user_id?: unknown;
}

export function parseWriteBody(body: unknown): { ok: true; userId: number } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const b = body as WriteBody;
  const raw = b.github_user_id;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'github_user_id must be positive integer' };
  return { ok: true, userId: n };
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ─── POST enqueue ──────────────────────────────────────────────────

const postEnqueue = defineTool({
  method: 'POST',
  path: '/harness/:slug/feature-queue/:featureId/enqueue',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const featureId = ctx.params.featureId as string;
    const workspaceId = activeWorkspaceId();
    const parsed = parseWriteBody(await readJsonBody(req));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const handle = getBootedHarness(workspaceId, slug);
    if (!handle) {
      return Response.json({ ok: false, reason: 'substrate-off' }, { status: 200 });
    }
    await enqueueFeature({
      handle,
      githubUserId: parsed.userId,
      featureId,
      // Pass through so the clobber-events tracker can fire a toast
      // if a remote override of the same row arrives within 60s.
      writerPubkey: resolveMyPubkey(handle) ?? undefined,
    });
    return Response.json({ ok: true });
  },
});

// ─── POST dequeue ──────────────────────────────────────────────────

const postDequeue = defineTool({
  method: 'POST',
  path: '/harness/:slug/feature-queue/:featureId/dequeue',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const featureId = ctx.params.featureId as string;
    const workspaceId = activeWorkspaceId();
    const parsed = parseWriteBody(await readJsonBody(req));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const handle = getBootedHarness(workspaceId, slug);
    if (!handle) {
      return Response.json({ ok: false, reason: 'substrate-off' }, { status: 200 });
    }
    await dequeueFeature({
      handle,
      githubUserId: parsed.userId,
      featureId,
      writerPubkey: resolveMyPubkey(handle) ?? undefined,
    });
    return Response.json({ ok: true });
  },
});

export default [getMembership, postEnqueue, postDequeue];
