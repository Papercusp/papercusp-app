/**
 * Read-only per-harness run views:
 *
 *   GET /api/harness/:slug/runs           — list .papercusp/runs/*.md
 *   GET /api/harness/:slug/runs/:name     — one runs/*.md file
 *   GET /api/harness/:slug/escalation     — current escalation note
 *   GET /api/harness/:slug/competitions   — same-feature-race manifests
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 4).
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProject, harnessDir, safeRead } from '../../../harness-core';
import { defineTool } from '@papercusp/agent-mcp';

const getRuns = defineTool({
  method: 'GET',
  path: '/harness/:slug/runs',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolveProject(slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const runsDir = join(harnessDir(project), 'runs');
    if (!existsSync(runsDir)) return Response.json({ runs: [] });
    const url = new URL(req.url);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    let files: string[] = [];
    try { files = readdirSync(runsDir).filter((f) => f.endsWith('.md')); }
    catch { return Response.json({ runs: [] }); }
    const runs = files
      .map((name) => {
        const fullPath = join(runsDir, name);
        let mtimeMs = 0;
        try { mtimeMs = statSync(fullPath).mtimeMs; } catch {}
        const content = safeRead(fullPath) ?? '';
        const tsMatch = content.match(/^- ts: (.+)$/m);
        const roleMatch = content.match(/^- role: (.+)$/m);
        const decisionMatch = content.match(/^- decision_line: `(.+?)`$/m);
        const exitMatch = content.match(/^- exit_code: (\d+)$/m);
        return {
          name,
          path: fullPath,
          mtimeMs,
          ts: tsMatch?.[1] ?? null,
          role: roleMatch?.[1] ?? null,
          decisionLine: decisionMatch?.[1] ?? null,
          exitCode: exitMatch ? Number(exitMatch[1]) : null,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
    return Response.json({ runs });
  },
});

const getRunByName = defineTool({
  method: 'GET',
  path: '/harness/:slug/runs/:name',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolveProject(slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const name = String(ctx.params.name).replace(/[^A-Za-z0-9_.:-]/g, '');
    if (!name || !name.endsWith('.md')) {
      return Response.json({ error: 'invalid name' }, { status: 400 });
    }
    const path = join(harnessDir(project), 'runs', name);
    if (!existsSync(path)) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json({ name, content: safeRead(path) });
  },
});

const getEscalation = defineTool({
  method: 'GET',
  path: '/harness/:slug/escalation',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const { getEscalation: read } = await import('../../../harness-readers');
    const url = new URL(req.url);
    const result = await read(slug, url.searchParams.get('phase') ?? undefined);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const getCompetitions = defineTool({
  method: 'GET',
  path: '/harness/:slug/competitions',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolveProject(slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const hd = harnessDir(project);
    if (!existsSync(hd)) return Response.json({ competitions: [] });
    const out: Array<any> = [];
    for (const f of readdirSync(hd)) {
      const m = f.match(/^competition-([A-Za-z0-9_.-]+)\.json$/);
      if (!m) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(hd, f), 'utf8'));
        const lanes = (manifest.lanes ?? []).map((lane: any) => {
          const wtExists = existsSync(lane.worktree);
          let lastCommitMs = 0;
          try {
            const headPath = join(lane.worktree, '.git');
            if (existsSync(headPath)) {
              const s = statSync(headPath);
              lastCommitMs = s.mtimeMs;
            }
          } catch {}
          return { ...lane, worktreeExists: wtExists, lastActivityMs: lastCommitMs };
        });
        let mtimeMs = 0;
        try { mtimeMs = statSync(join(hd, f)).mtimeMs; } catch {}
        out.push({
          parentFeatureId: manifest.parentFeatureId,
          n: manifest.n,
          lanes,
          startedMs: mtimeMs,
        });
      } catch {}
    }
    return Response.json({ competitions: out });
  },
});

export default [getRuns, getRunByName, getEscalation, getCompetitions];
