/**
 * POST /api/harness/:slug/branch/:branch/action/:name/run
 *
 * Path-based variant of action-run (simple, name in URL).
 *
 * Ported from app/api/harness/[slug]/branch/[branch]/action/[name]/run/route.ts.
 * `auth: 'loopback'` (auth-tier Wave 1). (Awaits loadHarnessRegistry — original was missing the await;
 * preserving the bug would break the route entirely.)
 */
import { loadHarnessRegistry } from '../../../harness-registry';
import { phasePath } from '../../../harness-phases';
import { isBranch, runAction } from '../../../branch-actions';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/harness/:slug/branch/:branch/action/:name/run',
  auth: 'loopback',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const branch = ctx.params.branch as string;
    const name = ctx.params.name as string;
    if (!isBranch(branch)) return Response.json({ error: 'invalid branch' }, { status: 400 });

    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });

    const phasePathDir = phasePath(project, branch);

    let handle;
    try {
      handle = await runAction({
        stagingPath: project.path,
        phasePath: phasePathDir,
        harness: slug,
        branch,
        name,
      });
    } catch (e) {
      return Response.json({ error: String((e as Error).message) }, { status: 400 });
    }

    handle.done.catch(() => undefined);

    return Response.json({ ok: true, runId: handle.runId, meta: handle.meta });
  },
});
