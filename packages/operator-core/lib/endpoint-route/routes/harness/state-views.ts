/**
 * Read-only per-harness JSON state views:
 *
 *   GET /api/harness/:slug/health      — orchestrator/process health snapshot
 *   GET /api/harness/:slug/lanes       — parallel-worker lane PIDs + liveness
 *   GET /api/harness/:slug/knowledge   — PG-canonical knowledge.md (FS fallback)
 *   PUT /api/harness/:slug/knowledge   — write knowledge.md (PG + disk mirror)
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 7).
 *
 * NOTE: GET /harness/:slug/prs was here as a prs.json file reader but is
 * superseded by harness/prs.ts which reads live from GitHub.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePhasedProject, harnessDir, safeRead } from '../../../harness-core';
import { readEffectiveHarnessConfig } from '../../../harness-effective-config';
import { activeWorkspaceId } from '../../../workspace-registry';
import { phasePhaseLabel } from '../../../harness-phases';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

const getHealth = defineTool({
  method: 'GET',
  path: '/harness/:slug/health',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const { getHealth: read } = await import('../../../harness-readers');
    const result = await read(slug);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const getLanes = defineTool({
  method: 'GET',
  path: '/harness/:slug/lanes',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const p = join(harnessDir(project), 'lanes.json');
    if (!existsSync(p)) return Response.json({ lanes: [], max: 1 });
    let raw: any;
    try { raw = JSON.parse(readFileSync(p, 'utf8')); }
    catch { return Response.json({ lanes: [], max: 1 }); }
    const nowMs = Date.now();
    const lanes: Array<{ pid: number; featureId: string; startedAt: number; elapsedSeconds: number; alive: boolean }> = [];
    for (const l of raw.lanes ?? []) {
      if (typeof l.pid !== 'number' || typeof l.feature_id !== 'string') continue;
      let alive = false;
      try { process.kill(l.pid, 0); alive = true; } catch {}
      const ts = typeof l.started_at === 'number' ? l.started_at * 1000 : nowMs;
      lanes.push({
        pid: l.pid,
        featureId: l.feature_id,
        startedAt: ts,
        elapsedSeconds: Math.max(0, Math.floor((nowMs - ts) / 1000)),
        alive,
      });
    }
    let max = 1;
    try {
      const cfg = await readEffectiveHarnessConfig(project.slug, activeWorkspaceId(), project.path);
      const pw = cfg?.parallelWorkers as Record<string, unknown> | undefined;
      if (typeof pw?.max === 'number' && pw.max > 0) max = pw.max;
    } catch {}
    return Response.json({ lanes, max });
  },
});

const getKnowledge = defineTool({
  method: 'GET',
  path: '/harness/:slug/knowledge',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const { loadTextArtifact } = await import('../../../text-artifacts');
    const p = join(harnessDir(project), 'knowledge.md');
    const fromPg = await loadTextArtifact(slug, 'knowledge.md');
    let mtimeMs: number | null = null;
    try { mtimeMs = statSync(p).mtimeMs; } catch {}
    return Response.json({ content: fromPg ?? safeRead(p), mtimeMs });
  },
});

const putKnowledge = defineTool({
  method: 'PUT',
  path: '/harness/:slug/knowledge',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { content?: string };
    if (typeof body.content !== 'string') {
      return Response.json({ error: 'content required' }, { status: 400 });
    }
    const { saveTextArtifact } = await import('../../../text-artifacts');
    await saveTextArtifact(slug, 'knowledge.md', body.content);
    return Response.json({ ok: true });
  },
});

export default [getHealth, getLanes, getKnowledge, putKnowledge];
