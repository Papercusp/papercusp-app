/**
 * POST /api/harness/:slug/branch/:branch/action-run?name=<name>
 *
 * Starts an action run. Name in query string (not path) because plugin
 * names can contain `/` and `:`. Returns 412 with missing[] when env
 * is incomplete; `?force=1` overrides.
 *
 * Ported from app/api/harness/[slug]/branch/[branch]/action-run/route.ts.
 * `auth: 'loopback'` (auth-tier Wave 1).
 */
import { loadHarnessRegistry } from '../../../harness-registry';
import { phasePath } from '../../../harness-phases';
import { papercuspPath } from '../../../papercusp-root';
import { isBranch, runAction, MissingEnvError } from '../../../branch-actions';
import { recordUserAction, updateUserAction } from '../../../user-actions';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/harness/:slug/branch/:branch/action-run',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const branch = ctx.params.branch as string;
    if (!isBranch(branch)) return Response.json({ error: 'invalid branch' }, { status: 400 });

    const url = new URL(req.url);
    const name = url.searchParams.get('name') ?? '';
    if (!name) return Response.json({ error: 'name required' }, { status: 400 });
    const force = url.searchParams.get('force') === '1';

    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });

    const phasePathDir = phasePath(project, branch);
    const harnessConfigsDir = papercuspPath('harnesses', slug);
    const globalPluginsDir = papercuspPath('global-plugins');

    let handle;
    try {
      handle = await runAction({
        stagingPath: project.path,
        phasePath: phasePathDir,
        harness: slug,
        branch,
        name,
        harnessConfigsDir,
        globalPluginsDir,
        skipEnvCheck: force,
      });
    } catch (e) {
      if (e instanceof MissingEnvError) {
        return Response.json(
          { ok: false, error: 'missing required env', missing: e.missing },
          { status: 412 },
        );
      }
      return Response.json({ error: String((e as Error).message) }, { status: 400 });
    }

    recordUserAction(slug, 'branch.action', async (id) => {
      handle.done
        .then(async (final) => {
          await updateUserAction({
            id,
            status: final.status === 'completed' ? 'succeeded' : 'failed',
            summary: `${branch}/${name} → ${final.status} (${final.exitCode ?? 'no-exit'}, ${final.durationMs ?? 0}ms)`,
            detailUrl: `/harness/${slug}?actionRun=${encodeURIComponent(handle.runId)}`,
            errorText: final.status === 'failed' ? `exit ${final.exitCode}` : undefined,
          }).catch(() => undefined);
        })
        .catch(() => undefined);
      return {
        summary: `Running ${branch}/${name}`,
        detailUrl: `/harness/${slug}?actionRun=${encodeURIComponent(handle.runId)}`,
        invocationId: handle.runId,
        result: undefined,
      };
    }, { async: true }).catch(() => undefined);

    handle.done.catch(() => undefined);

    return Response.json({ ok: true, runId: handle.runId, meta: handle.meta });
  },
});
