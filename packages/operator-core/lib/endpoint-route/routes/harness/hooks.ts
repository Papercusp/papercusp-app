/**
 * Per-harness lifecycle hook scripts (`.papercusp/hooks/<name>.sh`):
 *
 *   GET    /api/harness/:slug/hooks               — all known hooks + content
 *   PUT    /api/harness/:slug/hooks/:name         — write a hook (chmod +x)
 *   DELETE /api/harness/:slug/hooks/:name         — remove a hook
 *   GET    /api/harness/:slug/hook-logs/:logId    — read a hook-run log
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 14).
 */
import { statSync } from 'node:fs';
import { mkdir, writeFile, chmod, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject, harnessDir, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { getKnownHooks } from '../../../known-hooks';
import type { ProjectEntry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

function hookPath(project: ProjectEntry, name: string): string {
  return join(harnessDir(project), 'hooks', `${name}.sh`);
}

const getHooks = defineTool({
  method: 'GET',
  path: '/harness/:slug/hooks',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const hooks = getKnownHooks().map((name) => {
      const path = hookPath(project, name);
      let exists = false;
      let executable = false;
      let content: string | null = null;
      try {
        const s = statSync(path);
        exists = s.isFile();
        executable = (s.mode & 0o111) !== 0;
        content = safeRead(path);
      } catch {}
      return { name, exists, executable, content };
    });
    return Response.json({ hooks });
  },
});

const putHook = defineTool({
  method: 'PUT',
  path: '/harness/:slug/hooks/:name',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const name = ctx.params.name as string;
    if (!getKnownHooks().includes(name)) {
      return Response.json({ error: `unknown hook: ${name}` }, { status: 400 });
    }
    const body = (await req.json()) as { content?: string };
    if (typeof body.content !== 'string') {
      return Response.json({ error: 'content required' }, { status: 400 });
    }
    const dir = join(harnessDir(project), 'hooks');
    await mkdir(dir, { recursive: true });
    const dest = hookPath(project, name);
    const tmp = `${dest}.tmp.${Date.now()}`;
    await writeFile(tmp, body.content, 'utf8');
    await chmod(tmp, 0o755);
    await rename(tmp, dest);
    return Response.json({ ok: true, path: dest, executable: true });
  },
});

const deleteHook = defineTool({
  method: 'DELETE',
  path: '/harness/:slug/hooks/:name',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const name = ctx.params.name as string;
    if (!getKnownHooks().includes(name)) {
      return Response.json({ error: `unknown hook: ${name}` }, { status: 400 });
    }
    try {
      await unlink(hookPath(project, name));
      return Response.json({ ok: true, deleted: true });
    } catch (err: any) {
      if (err?.code === 'ENOENT') return Response.json({ ok: true, deleted: false });
      return Response.json({ error: String(err) }, { status: 500 });
    }
  },
});

const getHookLog = defineTool({
  method: 'GET',
  path: '/harness/:slug/hook-logs/:logId',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const logId = String(ctx.params.logId).replace(/[^A-Za-z0-9_.-]/g, '');
    if (!logId) return Response.json({ error: 'invalid logId' }, { status: 400 });
    const full = join(harnessDir(project), 'logs', 'hooks', `${logId}.log`);
    const content = safeRead(full);
    if (content === null) return Response.json({ error: 'log not found' }, { status: 404 });
    return Response.json({ logId, content });
  },
});

export default [getHooks, putHook, deleteHook, getHookLog];
