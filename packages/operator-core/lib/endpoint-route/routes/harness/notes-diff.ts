/**
 * Read-only per-harness notes + working-tree diff:
 *
 *   GET /api/harness/:slug/scoper-result/:invocationId  — background scoper output
 *   GET /api/harness/:slug/debug-notes/:id              — one debug note
 *   GET /api/harness/:slug/synthesis-notes/:id          — one synthesis note
 *   GET /api/harness/:slug/debug-notes                  — debug note index
 *   GET /api/harness/:slug/diff/working                 — `git diff HEAD` + status
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 8).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { resolveProject, resolvePhasedProject, harnessDir, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { defineTool } from '@papercusp/agent-mcp';

const execFileP = promisify(execFile);

const getScoperResult = defineTool({
  method: 'GET',
  path: '/harness/:slug/scoper-result/:invocationId',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const invocationId = ctx.params.invocationId as string;
    const project = await resolveProject(slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const dir = join(harnessDir(project), 'scoper-results');
    // The mode prefix isn't in the path; scan for the matching file.
    // Files are <mode>-<id>.log and ids are unique per millisecond+rand.
    let logPath: string | null = null;
    try {
      const entries = await readdir(dir);
      const match = entries.find((e) => e.endsWith(`-${invocationId}.log`));
      if (match) logPath = join(dir, match);
    } catch { /* dir missing → 404 below */ }
    if (!logPath) return Response.json({ done: false }, { status: 404 });
    const text = await readFile(logPath, 'utf8').catch(() => '');
    const done = text.includes('__INVOCATION_DONE__');
    if (!done) return Response.json({ done: false });
    const lines = text.replace(/__INVOCATION_DONE__\s*$/m, '').trim().split(/\r?\n/);
    const tail = lines.slice(-20).join('\n');
    const counts: Record<string, number> = {};
    for (const m of tail.matchAll(/\b(added|deprecated|modified|consolidated|skipped)\s*:\s*(\d+)/gi)) {
      counts[m[1].toLowerCase()] = parseInt(m[2], 10);
    }
    return Response.json({
      done: true,
      summary: tail.slice(0, 1200),
      counts: Object.keys(counts).length ? counts : undefined,
    });
  },
});

function noteByIdRoute(routePath: string, subdir: string) {
  return defineTool({
    method: 'GET',
    path: routePath,
    auth: 'public',
    async handler(_req, ctx) {
      const project = await resolveProject(ctx.params.slug as string);
      if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
      const id = String(ctx.params.id).replace(/[^A-Za-z0-9_-]/g, '');
      if (!id) return Response.json({ error: 'invalid feature id' }, { status: 400 });
      const p = join(harnessDir(project), subdir, `${id}.md`);
      let mtimeMs: number | null = null;
      try { mtimeMs = statSync(p).mtimeMs; } catch {}
      return Response.json({ content: safeRead(p), mtimeMs });
    },
  });
}

const getDebugNote = noteByIdRoute('/harness/:slug/debug-notes/:id', 'debug');
const getSynthesisNote = noteByIdRoute('/harness/:slug/synthesis-notes/:id', 'synthesis-notes');

const getDebugNotes = defineTool({
  method: 'GET',
  path: '/harness/:slug/debug-notes',
  auth: 'public',
  async handler(_req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const dir = join(harnessDir(project), 'debug');
    if (!existsSync(dir)) return Response.json({ notes: [] });
    const notes = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const full = join(dir, f);
        let size = 0, ts = 0;
        try { const s = statSync(full); size = s.size; ts = s.mtimeMs; } catch {}
        return { featureId: f.replace(/\.md$/, ''), sizeBytes: size, ts };
      })
      .sort((a, b) => b.ts - a.ts);
    return Response.json({ notes });
  },
});

const getDiffWorking = defineTool({
  method: 'GET',
  path: '/harness/:slug/diff/working',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const project = await resolvePhasedProject(slug, phasePhaseLabel(url.searchParams.get('phase') ?? undefined));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });

    let stat: string;
    try {
      const r = await execFileP('git', ['diff', '--stat=200', 'HEAD'], { cwd: project.path, maxBuffer: 4 * 1024 * 1024 });
      stat = r.stdout;
    } catch (err: any) {
      return Response.json({ error: `git error: ${String(err?.message || err).slice(0, 200)}` }, { status: 500 });
    }

    let diff: string;
    try {
      const r = await execFileP('git', ['diff', 'HEAD'], { cwd: project.path, maxBuffer: 8 * 1024 * 1024 });
      diff = r.stdout;
    } catch {
      return Response.json({ stat, diff: '', error: 'diff too large' });
    }

    let status = '';
    try {
      const r = await execFileP('git', ['status', '--porcelain'], { cwd: project.path, maxBuffer: 1024 * 1024 });
      status = r.stdout;
    } catch { /* status best-effort */ }

    return Response.json({ stat, diff, status, branch: '' });
  },
});

export default [getScoperResult, getDebugNote, getSynthesisNote, getDebugNotes, getDiffWorking];
