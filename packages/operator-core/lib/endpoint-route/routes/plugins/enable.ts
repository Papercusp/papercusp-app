/**
 * POST /api/plugins/enable — papercusp plugin enable/disable across harnesses.
 * Ported from app/api/plugins/enable/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mirrorHarness } from '../../../plugin-enables-pg';
import { resolvePluginCliSlug } from '../../../plugin-slug';
import {
  pluginAllowsKind,
  readPluginRequiresTemplateKinds,
  resolveTemplateKind,
} from '../../../template-kind';
import { papercuspPath } from '../../../papercusp-root';
import { resolvePapercuspCli } from '../../../papercusp-cli';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { runGovernedOperation } from '../../../resource-governor/execution';

const PAPERCUSP_BIN = resolvePapercuspCli();

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runGovernedOperation(
    {
      workspaceId: activeWorkspaceId(),
      namespace: 'plugin-enable-cli',
      owner: 'plugins:enable',
      admissionClass: 'process',
      demand: { cpuWeight: 0.5, memoryBytes: 128 * 1024 * 1024, fileDescriptors: 3 },
      payloadRef: 'plugins:enable:cli',
      metadata: { binary: cmd },
    },
    async () =>
      new Promise((resolve) => {
        const child = spawn(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      }),
  );
}

function isValidPluginSlug(s: string): boolean {
  return /^@?[a-z0-9][a-z0-9._/-]{0,127}$/i.test(s);
}

function isValidHarnessSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s);
}

function GLOBAL_PLUGINS_DIR() { return papercuspPath('global-plugins'); }

export default defineTool({
  method: 'POST',
  path: '/plugins/enable',
  auth: 'loopback',
  async handler(req) {
    let body: { slug?: string; harnesses?: string[]; disable?: boolean };
    try { body = await req.json(); } catch { return Response.json({ ok: false, error: 'invalid json' }, { status: 400 }); }

    const slug = String(body.slug ?? '').trim();
    if (!isValidPluginSlug(slug)) return Response.json({ ok: false, error: `invalid plugin slug "${slug}"` }, { status: 400 });

    const harnesses = Array.isArray(body.harnesses) ? body.harnesses.map((s) => String(s).trim()).filter(Boolean) : [];
    if (harnesses.length === 0) return Response.json({ ok: false, error: 'harnesses[] required' }, { status: 400 });
    for (const h of harnesses) {
      if (!isValidHarnessSlug(h)) {
        return Response.json({ ok: false, error: `invalid harness slug "${h}"` }, { status: 400 });
      }
    }

    const cliSlug = await resolvePluginCliSlug(slug);
    const verb = body.disable ? 'disable' : 'enable';

    if (verb === 'enable') {
      const required = await readPluginRequiresTemplateKinds(join(GLOBAL_PLUGINS_DIR(), cliSlug));
      if (required && required.length > 0) {
        const incompatible: { harness: string; kind: string }[] = [];
        for (const h of harnesses) {
          const kind = await resolveTemplateKind(h);
          if (!pluginAllowsKind(required, kind)) incompatible.push({ harness: h, kind });
        }
        if (incompatible.length > 0) {
          const list = incompatible.map((i) => `${i.harness} (kind=${i.kind})`).join(', ');
          return Response.json(
            {
              ok: false,
              error: `plugin "${slug}" requires templateKinds=[${required.join(', ')}]; incompatible with ${list}`,
              requiresTemplateKinds: required,
              incompatible,
            },
            { status: 422 },
          );
        }
      }
    }
    const results: Array<{ harness: string; ok: boolean; log: string }> = [];
    let firstFailure: { harness: string; log: string } | null = null;
    for (const h of harnesses) {
      const args = ['plugin', verb, cliSlug, '--harness', h];
      if (verb === 'enable') args.push('--accept-defaults');
      const r = await run(PAPERCUSP_BIN, args);
      const log = [r.stdout, r.stderr].filter(Boolean).join('\n');
      const ok = r.code === 0;
      results.push({ harness: h, ok, log });
      if (!ok && !firstFailure) firstFailure = { harness: h, log };
      try { await mirrorHarness(h); } catch (e) {
        console.warn('[plugins/enable] PG mirror failed for', h, e);
      }
    }
    const allOk = results.every((r) => r.ok);
    return Response.json({
      ok: allOk,
      slug,
      verb,
      results,
      ...(firstFailure ? { error: `${verb} failed for ${firstFailure.harness}` } : {}),
    }, { status: allOk ? 200 : 500 });
  },
});
