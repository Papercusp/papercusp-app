/**
 * Read-only text views over per-harness state:
 *
 *   GET /api/harness/:slug/issues    — issues.md (PG canonical, FS fallback)
 *   GET /api/harness/:slug/summary   — summary.md (PG canonical, FS fallback)
 *   GET /api/harness/:slug/logs/run  — last 128 KB of .papercusp/logs/run.log
 *
 * Migration 035: issues.md + summary.md are PG-canonical via
 * harness_shared.text_artifacts; disk copies are best-effort mirrors.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 3).
 */
import { join } from 'node:path';
import {
  resolvePhasedProject,
  harnessDir,
  safeRead,
  tailFile,
} from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

const getIssues = defineTool({
  method: 'GET',
  path: '/harness/:slug/issues',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const { loadTextArtifact } = await import('../../../text-artifacts');
    const pg = await loadTextArtifact(slug, 'issues.md');
    return Response.json({ issues: pg ?? safeRead(join(harnessDir(project), 'issues.md')) });
  },
});

const getSummary = defineTool({
  method: 'GET',
  path: '/harness/:slug/summary',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const { loadTextArtifact } = await import('../../../text-artifacts');
    const pg = await loadTextArtifact(slug, 'summary.md');
    return Response.json({ summary: pg ?? safeRead(join(harnessDir(project), 'summary.md')) });
  },
});

const getLogsRun = defineTool({
  method: 'GET',
  path: '/harness/:slug/logs/run',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const tail = tailFile(join(harnessDir(project), 'logs', 'run.log'), 128 * 1024);
    return Response.json({ log: tail });
  },
});

export default [getIssues, getSummary, getLogsRun];
