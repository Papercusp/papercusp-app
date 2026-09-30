/**
 * GET /api/harness/:slug/branch/:branch/actions
 *
 * Lists discoverable actions for the branch. Per-branch cache (1s TTL +
 * single-flight) keyed on `${slug}:${branch}`.
 *
 * Ported from app/api/harness/[slug]/branch/[branch]/actions/route.ts.
 * `auth: 'public'`.
 */
import { loadHarnessRegistry } from '../../../harness-registry';
import { papercuspPath } from '../../../papercusp-root';
import { isBranch, listActions, listRuns } from '../../../branch-actions';
import { resolveEnv } from '../../../branch-action-manifest';
import { defineTool } from '@papercusp/agent-mcp';

type Payload = { branch: string; actions: unknown[] };
const ACTIONS_CACHE_TTL_MS = 1000;
type _G = {
  __branchActionsCache?: Map<string, { ts: number; payload: Payload }>;
  __branchActionsInflight?: Map<string, Promise<Payload>>;
};
const _g = globalThis as unknown as _G;
const cache: Map<string, { ts: number; payload: Payload }> =
  _g.__branchActionsCache ?? (_g.__branchActionsCache = new Map());
const inflight: Map<string, Promise<Payload>> =
  _g.__branchActionsInflight ?? (_g.__branchActionsInflight = new Map());

async function compute(slug: string, branch: string): Promise<Payload | { error: string; status: number }> {
  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return { error: 'unknown project', status: 404 };

  const harnessConfigsDir = papercuspPath('harnesses', slug);
  const globalPluginsDir = papercuspPath('global-plugins');

  const actions = await listActions(project.path, branch as 'staging' | 'testing' | 'production', {
    harnessConfigsDir, globalPluginsDir,
  });

  const envReadCache = new Map<string, Promise<unknown>>();

  const enriched = await Promise.all(actions.map(async (a) => {
    const runs = await listRuns(project.path, branch as 'staging' | 'testing' | 'production', a.name);
    const envResolution = a.manifest?.env
      ? await resolveEnv(a.manifest, { harnessConfigsDir, contributingPlugin: a.pluginSlug, readCache: envReadCache })
      : { env: {}, missing: [] };
    return {
      name: a.name,
      source: a.source,
      pluginSlug: a.pluginSlug,
      displayName: a.manifest?.displayName ?? a.name,
      description: a.manifest?.description,
      scriptPath: a.scriptPath,
      env: a.manifest?.env ?? null,
      envStatus: {
        ok: envResolution.missing.length === 0,
        resolved: Object.keys(envResolution.env),
        missing: envResolution.missing,
      },
      lastRun: runs[0] ?? null,
    };
  }));
  return { branch, actions: enriched };
}

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/branch/:branch/actions',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const branch = ctx.params.branch as string;
    if (!isBranch(branch)) {
      return Response.json({ error: 'invalid branch' }, { status: 400 });
    }
    const cacheKey = `${slug}:${branch}`;
    const now = Date.now();
    const hit = cache.get(cacheKey);
    if (hit && now - hit.ts < ACTIONS_CACHE_TTL_MS) {
      return new Response(JSON.stringify(hit.payload), {
        headers: {
          'content-type': 'application/json',
          'X-Cache': 'HIT',
          'X-Cache-Age': String(now - hit.ts),
        },
      });
    }

    const existing = inflight.get(cacheKey);
    if (existing) {
      const payload = await existing;
      return new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json', 'X-Cache': 'COALESCED' },
      });
    }

    const promise = (async () => {
      const result = await compute(slug, branch);
      if ('error' in result) throw result;
      cache.set(cacheKey, { ts: Date.now(), payload: result });
      if (cache.size > 64) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
        if (oldest) cache.delete(oldest);
      }
      return result;
    })();
    inflight.set(cacheKey, promise);
    try {
      const payload = await promise;
      return new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json', 'X-Cache': 'MISS' },
      });
    } catch (e) {
      const err = e as { error?: string; status?: number };
      if (err.error && err.status) {
        return Response.json({ error: err.error }, { status: err.status });
      }
      throw e;
    } finally {
      inflight.delete(cacheKey);
    }
  },
});
