/**
 * POST /api/plugins/invoke — direct plugin-action invocation.
 * Ported from app/api/plugins/invoke/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { invokePluginAction } from '../../../plugin-host-runtime';
import { papercuspPath } from '../../../papercusp-root';
import { defineTool } from '@papercusp/agent-mcp';

const PLUGIN_SLUG = /^@?[a-z0-9][a-z0-9._/-]{0,127}$/i;
const HARNESS_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ACTION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

async function resolveProjectPath(slug: string): Promise<string | null> {
  const { loadHarnessRegistry } = await import('../../../harness-registry');
  return (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
}

export default defineTool({
  method: 'POST',
  path: '/plugins/invoke',
  auth: 'loopback',
  async handler(req) {
    let body: { slug?: string; action?: string; harness?: string; params?: Record<string, unknown> };
    try { body = await req.json(); } catch { return Response.json({ ok: false, error: 'invalid json' }, { status: 400 }); }

    const slug = String(body.slug ?? '').trim();
    const action = String(body.action ?? '').trim();
    const harness = String(body.harness ?? '').trim();

    if (!PLUGIN_SLUG.test(slug)) return Response.json({ ok: false, error: `invalid plugin slug` }, { status: 400 });
    if (!ACTION_ID.test(action)) return Response.json({ ok: false, error: `invalid action id` }, { status: 400 });
    if (!HARNESS_SLUG.test(harness)) return Response.json({ ok: false, error: `invalid harness slug` }, { status: 400 });

    const harnessDataDir = papercuspPath('harnesses', harness);
    if (!existsSync(harnessDataDir)) {
      return Response.json({
        ok: false, slug, action, harness,
        error: `harness "${harness}" data dir missing at ${harnessDataDir} — has it been provisioned via 'papercusp project add'?`,
      }, { status: 404 });
    }

    const projectPath = await resolveProjectPath(harness);
    const stateDir = projectPath ? join(projectPath, '.papercusp') : harnessDataDir;
    const projectDir = projectPath ?? harnessDataDir;
    const pluginDataDirOverride = join(harnessDataDir, 'plugin-data', slug);

    try {
      const r = await invokePluginAction({
        pluginName: slug,
        actionName: action,
        installSlug: harness,
        projectDir,
        stateDir,
        pluginDataDirOverride,
        params: body.params,
        triggerSource: 'ui',
      });
      if (!r.ok) {
        return Response.json({
          ok: false, slug, action, harness,
          error: r.error ?? 'unknown error',
          result: r.result,
        }, { status: 500 });
      }
      const resultStr = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
      return Response.json({
        ok: true, slug, action, harness,
        result: resultStr,
        structuredResult: r.result,
      });
    } catch (e: any) {
      return Response.json({
        ok: false, slug, action, harness,
        error: e?.message ?? String(e),
      }, { status: 500 });
    }
  },
});
