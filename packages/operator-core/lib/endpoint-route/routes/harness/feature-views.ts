/**
 * Read-only per-feature views:
 *
 *   GET /api/harness/:slug/feature/:id/lineage    — feature ancestry (md|json)
 *   GET /api/harness/:slug/features/:id/audit     — field-change audit log
 *   GET /api/harness/:slug/features/:id/timeline  — synthesized event timeline
 *   GET /api/harness/:slug/features/:id/diff      — git diff base...papercusp/<id>
 *
 * Note `/feature/` (singular) for lineage vs `/features/` (plural) for the
 * rest — preserved verbatim from the legacy routes.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 9).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import {
  harnessQuery,
  slugToSchemaName,
  getFeatureLineage,
  formatLineageForPrompt,
} from '@papercusp/db-org';
import { resolveProject, resolvePhasedProject, harnessDir } from '../../../harness-core';
import { readEffectiveHarnessConfig } from '../../../harness-effective-config';
import { activeWorkspaceId } from '../../../workspace-registry';
import { phasePhaseLabel } from '../../../harness-phases';
import { defineTool } from '@papercusp/agent-mcp';

const execFileP = promisify(execFile);

export type FeatureTimelineEvent = { ts: number; iso: string; kind: string; detail: string };

export async function getFeatureTimeline(slug: string, rawFeatureId: string): Promise<{
  ok: true;
  featureId: string;
  events: FeatureTimelineEvent[];
} | { ok: false; status: number; error: string }> {
  const project = await resolveProject(slug);
  if (!project) return { ok: false, status: 404, error: 'unknown project' };
  const fid = String(rawFeatureId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!fid) return { ok: false, status: 400, error: 'invalid feature id' };

  const events: FeatureTimelineEvent[] = [];

  // 1. Status transitions from snapshots/
  const snapDir = join(harnessDir(project), 'snapshots');
  if (existsSync(snapDir)) {
    let prevStatus: string | null = null;
    const snaps = readdirSync(snapDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const snapName of snaps) {
      const featPath = join(snapDir, snapName, 'features.json');
      try {
        const raw = readFileSync(featPath, 'utf8');
        const parsed = JSON.parse(raw);
        const feats = (parsed.features ?? parsed) as Array<{ id?: string; status?: string }>;
        const f = feats.find((x) => x.id === fid);
        if (!f) continue;
        if (prevStatus !== null && f.status !== prevStatus) {
          const match = snapName.match(/^(\d+)-iter-(\d+)$/);
          const ts = match ? Number(match[1]) * 1000 : 0;
          events.push({
            ts,
            iso: new Date(ts).toISOString(),
            kind: 'status_change',
            detail: `${prevStatus} → ${f.status}`,
          });
        }
        prevStatus = f.status ?? null;
      } catch {}
    }
  }

  // 2. Agent runs for this feature (filename contains -<FID>)
  const logDir = join(harnessDir(project), 'logs');
  if (existsSync(logDir)) {
    for (const f of readdirSync(logDir)) {
      if (!f.endsWith('.out')) continue;
      const stem = f.replace(/\.out$/, '');
      const match = stem.match(/^(\d+)-([a-z]+)(?:-(F-[A-Z0-9-]+))?$/);
      if (!match) continue;
      if (match[3] !== fid) continue;
      const ts = Number(match[1]) * 1000;
      events.push({
        ts,
        iso: new Date(ts).toISOString(),
        kind: 'agent_run',
        detail: `${match[2]} invoked`,
      });
    }
  }

  // 3. Debug note creation
  const debugPath = join(harnessDir(project), 'debug', `${fid}.md`);
  if (existsSync(debugPath)) {
    try {
      const s = statSync(debugPath);
      events.push({
        ts: s.mtimeMs,
        iso: new Date(s.mtimeMs).toISOString(),
        kind: 'debug_note',
        detail: 'debugger role investigated',
      });
    } catch {}
  }

  // 4. PR URL creation
  try {
    const prs = JSON.parse(readFileSync(join(harnessDir(project), 'prs.json'), 'utf8'));
    const entry = prs?.prs?.[fid];
    if (entry?.url && typeof entry.created_at === 'number') {
      events.push({
        ts: entry.created_at * 1000,
        iso: new Date(entry.created_at * 1000).toISOString(),
        kind: 'pr_opened',
        detail: entry.url,
      });
    }
  } catch {}

  events.sort((a, b) => a.ts - b.ts);
  return { ok: true, featureId: fid, events };
}

const getLineage = defineTool({
  method: 'GET',
  path: '/harness/:slug/feature/:id/lineage',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = ctx.params.id as string;
    const format = new URL(req.url).searchParams.get('format') ?? 'md';
    const schemaName = slugToSchemaName(project.slug);
    try {
      const rows = await harnessQuery(project.slug, (q) =>
        getFeatureLineage(q, schemaName, project.slug, id),
      );
      if (rows.length === 0) {
        return Response.json({ error: 'feature not found or no lineage' }, { status: 404 });
      }
      if (format === 'json') {
        return Response.json({ slug: project.slug, featureId: id, lineage: rows });
      }
      return new Response(formatLineageForPrompt(rows), {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });
    } catch (err: any) {
      return Response.json({ error: 'lineage lookup failed', detail: String(err?.message ?? err) }, { status: 500 });
    }
  },
});

const getAudit = defineTool({
  method: 'GET',
  path: '/harness/:slug/features/:id/audit',
  auth: 'public',
  async handler(_req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = ctx.params.id as string;
    // PG-canonical via harness_shared.feature_audit_consolidated; falls
    // back to the per-harness table for rows pre-dating the cutover.
    try {
      const { db } = (await import('@papercusp/db-org')).getOrgPg();
      const { generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const fa = generated.featureAuditConsolidatedInHarnessShared;
      const rows = await db
        .select({ ts: fa.ts, field: fa.field, old_value: fa.oldValue, new_value: fa.newValue, actor: fa.actor })
        .from(fa)
        .where(and(eq(fa.harnessSlug, project.slug), eq(fa.featureId, id)))
        .orderBy(desc(fa.ts))
        .limit(200);
      if (rows.length > 0) {
        return Response.json({
          slug: project.slug, feature_id: id, count: rows.length,
          audit: rows.map((r) => ({
            ts: typeof r.ts === 'bigint' ? Number(r.ts) : r.ts,
            field: r.field,
            old: r.old_value ? JSON.parse(r.old_value) : null,
            new: r.new_value ? JSON.parse(r.new_value) : null,
            actor: r.actor,
          })),
        });
      }
    } catch { /* fall through to per-harness */ }
    try {
      const rows = await harnessQuery(project.slug, (sql) => sql`
        SELECT * FROM feature_audit
        WHERE harness_slug = ${project.slug} AND feature_id = ${id}
        ORDER BY ts DESC LIMIT 200
      `) as any[];
      return Response.json({
        slug: project.slug, feature_id: id, count: rows.length,
        audit: rows.map((r) => ({
          ts: typeof r.ts === 'bigint' ? Number(r.ts) : r.ts,
          field: r.field,
          old: r.old_value ? JSON.parse(r.old_value) : null,
          new: r.new_value ? JSON.parse(r.new_value) : null,
          actor: r.actor,
        })),
      });
    } catch (e) {
      return Response.json({ error: `audit query failed: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

const getTimeline = defineTool({
  method: 'GET',
  path: '/harness/:slug/features/:id/timeline',
  auth: 'public',
  async handler(_req, ctx) {
    const result = await getFeatureTimeline(ctx.params.slug as string, ctx.params.id as string);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ featureId: result.featureId, events: result.events });
  },
});

const getDiff = defineTool({
  method: 'GET',
  path: '/harness/:slug/features/:id/diff',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = String(ctx.params.id).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) return Response.json({ error: 'invalid feature id' }, { status: 400 });
    const branch = `harness/${id}`;
    let base = 'main';
    try {
      const cfg = await readEffectiveHarnessConfig(project.slug, activeWorkspaceId(), project.path);
      if (cfg?.branchIsolation?.baseBranch) base = String(cfg.branchIsolation.baseBranch);
    } catch {}

    let stat: string;
    try {
      const r = await execFileP('git', ['diff', '--stat=200', `${base}...${branch}`], { cwd: project.path, maxBuffer: 4 * 1024 * 1024 });
      stat = r.stdout;
    } catch (err: any) {
      return Response.json(
        { error: `branch not found or git error: ${String(err?.message || err).slice(0, 200)}` },
        { status: 404 },
      );
    }
    let diff: string;
    try {
      const r = await execFileP('git', ['diff', `${base}...${branch}`], { cwd: project.path, maxBuffer: 8 * 1024 * 1024 });
      diff = r.stdout;
    } catch {
      return Response.json({ stat, diff: '', error: 'diff too large' });
    }
    return Response.json({ stat, diff, base, branch });
  },
});

export default [getLineage, getAudit, getTimeline, getDiff];
