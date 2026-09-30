/**
 * POST /api/installed/prune
 *
 * Removes registry entries whose `path` no longer exists on disk.
 * Body (optional): { dryRun?: boolean, slugs?: string[] }.
 *
 * Ported from app/api/installed/prune/route.ts. The pure `pruneRegistry`
 * helper is re-exported (a test covers it) — see __tests__/prune.test.ts.
 */
import { existsSync } from 'node:fs';
import { loadHarnessRegistry, saveHarnessRegistry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

interface RegistryShape {
  projects: Array<{ slug: string; path: string; harnessKind?: string; addedAt?: string }>;
}

interface PruneOptions {
  dryRun?: boolean;
  slugs?: string[];
}

interface PruneResult {
  removed: string[];
  kept: RegistryShape['projects'];
}

/**
 * Pure prune logic — drops entries whose `path` does not exist on disk.
 * `existsCheck` is injectable for tests; defaults to fs.existsSync.
 */
export function pruneRegistry(
  reg: RegistryShape,
  opts: PruneOptions = {},
  existsCheck: (path: string) => boolean = existsSync,
): PruneResult {
  const restrictTo =
    Array.isArray(opts.slugs) && opts.slugs.length > 0 ? new Set(opts.slugs) : null;
  const kept: RegistryShape['projects'] = [];
  const removed: string[] = [];
  for (const p of reg.projects) {
    const isStale = !existsCheck(p.path);
    const inScope = restrictTo === null || restrictTo.has(p.slug);
    if (isStale && inScope) removed.push(p.slug);
    else kept.push(p);
  }
  return { removed, kept };
}

export default defineTool({
  method: 'POST',
  path: '/installed/prune',
  auth: 'loopback',
  async handler(req) {
    let body: PruneOptions = {};
    try {
      body = await req.json();
    } catch {
      /* empty body is fine */
    }
    const reg = await loadHarnessRegistry();
    const { removed, kept } = pruneRegistry(reg, body);
    if (!body.dryRun && removed.length > 0) {
      // Prune is an intentional-removal path: a registry whose every
      // entry is stale legitimately prunes to empty.
      await saveHarnessRegistry({ projects: kept }, undefined, { allowEmpty: true });
    }
    return Response.json({ ok: true, removed, remaining: kept.length, dryRun: !!body.dryRun });
  },
});
