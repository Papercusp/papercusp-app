/**
 * Per-harness brainstorm surfaces (Migration 033 — PG-canonical via
 * `harness_shared.harness_brainstorm`, FS mirror best-effort):
 *
 *   GET/PUT /api/harness/:slug/brainstorm           — brainstorm.md (text)
 *   GET/PUT /api/harness/:slug/brainstorm-canvas    — brainstorm.canvas.json
 *   GET/PUT /api/harness/:slug/brainstorm-mindmap   — brainstorm.mindmap.json
 *
 * The `POST /:slug/brainstorm/promote` route stays in `_hono/harness.ts`
 * for a later batch — it depends on the features/issues helpers
 * (`auditFeatureChange`, `loadIssuesOrSeed`, `saveIssues`) not yet
 * relocated.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 18).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harnessTransaction } from '@papercusp/db-org';
import { resolvePhasedProject, harnessDir, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { loadIssuesOrSeed, saveIssues } from '../../../harness-issues';
import { auditFeatureChange } from '../../../feature-audit';
import type { ProjectEntry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

const brainstormPath = (p: ProjectEntry) => join(harnessDir(p), 'brainstorm.md');
const brainstormCanvasPath = (p: ProjectEntry) => join(harnessDir(p), 'brainstorm.canvas.json');
const brainstormMindmapPath = (p: ProjectEntry) => join(harnessDir(p), 'brainstorm.mindmap.json');

/**
 * Migration 033: brainstorm.{md,canvas.json,mindmap.json} are PG-canonical
 * via harness_shared.harness_brainstorm. The PG row is authoritative if it
 * exists; otherwise we fall back to the FS file (legacy harnesses).
 */
async function loadBrainstorm(slug: string): Promise<{ content: string; canvas: unknown; mindmap: unknown }> {
  const { db } = (await import('@papercusp/db-org')).getOrgPg();
  const { generated } = await import('@papercusp/db-org');
  const { and, eq } = await import('drizzle-orm');
  const hb = generated.harnessBrainstormInHarnessShared;
  const rows = await db
    .select({ content: hb.content, canvas: hb.canvas, mindmap: hb.mindmap })
    .from(hb)
    .where(and(eq(hb.harnessSlug, slug), eq(hb.phase, 'staging')))
    .limit(1);
  return rows[0] ?? { content: '', canvas: null, mindmap: null };
}

async function saveBrainstorm(slug: string, patch: { content?: string; canvas?: unknown; mindmap?: unknown }): Promise<void> {
  const { db } = (await import('@papercusp/db-org')).getOrgPg();
  const { generated } = await import('@papercusp/db-org');
  const { sql: dsql } = await import('drizzle-orm');
  const hb = generated.harnessBrainstormInHarnessShared;
  const now = Date.now();
  await db
    .insert(hb)
    .values({
      harnessSlug: slug,
      phase: 'staging',
      content: patch.content ?? '',
      canvas: (patch.canvas ?? null) as any,
      mindmap: (patch.mindmap ?? null) as any,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [hb.harnessSlug, hb.phase],
      set: {
        content: dsql`COALESCE(${patch.content ?? null}, ${hb.content})`,
        canvas: dsql`COALESCE(${patch.canvas !== undefined ? JSON.stringify(patch.canvas) : null}::text::jsonb, ${hb.canvas})`,
        mindmap: dsql`COALESCE(${patch.mindmap !== undefined ? JSON.stringify(patch.mindmap) : null}::text::jsonb, ${hb.mindmap})`,
        updatedAt: now,
      },
    });
  const { notifySyncInvalidate } = await import('../../../sync-sse');
  await notifySyncInvalidate('harnessBrainstorm.byHarness', { harnessSlug: slug });
}

const getBrainstorm = defineTool({
  method: 'GET',
  path: '/harness/:slug/brainstorm',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const row = await loadBrainstorm(slug);
    const content = row.content || (safeRead(brainstormPath(project)) ?? '');
    return Response.json({ content });
  },
});

const putBrainstorm = defineTool({
  method: 'PUT',
  path: '/harness/:slug/brainstorm',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = await req.json().catch(() => ({} as any));
    if (typeof body.content !== 'string') return Response.json({ error: 'content required' }, { status: 400 });
    await saveBrainstorm(slug, { content: body.content });
    await writeFile(brainstormPath(project), body.content, 'utf8').catch(() => {});
    return Response.json({ ok: true, bytes: body.content.length });
  },
});

const getCanvas = defineTool({
  method: 'GET',
  path: '/harness/:slug/brainstorm-canvas',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const row = await loadBrainstorm(slug);
    if (row.canvas) return Response.json({ scene: row.canvas });
    const raw = safeRead(brainstormCanvasPath(project));
    if (!raw) return Response.json({ scene: null });
    try { return Response.json({ scene: JSON.parse(raw) }); }
    catch { return Response.json({ scene: null }); }
  },
});

const putCanvas = defineTool({
  method: 'PUT',
  path: '/harness/:slug/brainstorm-canvas',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = await req.json().catch(() => ({} as any));
    if (!body.scene) return Response.json({ error: 'scene required' }, { status: 400 });
    await saveBrainstorm(slug, { canvas: body.scene });
    await writeFile(brainstormCanvasPath(project), JSON.stringify(body.scene, null, 2), 'utf8').catch(() => {});
    return Response.json({ ok: true });
  },
});

const getMindmap = defineTool({
  method: 'GET',
  path: '/harness/:slug/brainstorm-mindmap',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const row = await loadBrainstorm(slug);
    if (row.mindmap) return Response.json({ tree: row.mindmap });
    const raw = safeRead(brainstormMindmapPath(project));
    if (!raw) return Response.json({ tree: null });
    try { return Response.json({ tree: JSON.parse(raw) }); }
    catch { return Response.json({ tree: null }); }
  },
});

const putMindmap = defineTool({
  method: 'PUT',
  path: '/harness/:slug/brainstorm-mindmap',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = await req.json().catch(() => ({} as any));
    if (!body.tree) return Response.json({ error: 'tree required' }, { status: 400 });
    await saveBrainstorm(slug, { mindmap: body.tree });
    await writeFile(brainstormMindmapPath(project), JSON.stringify(body.tree, null, 2), 'utf8').catch(() => {});
    return Response.json({ ok: true });
  },
});

/**
 * Brainstorm promote — routes brainstorm content into a feature
 * (F-IDEA-### row in harness_features) or an issue (new I-#### row).
 * The `spec` target (append to SPEC.md) was removed when SPEC.md was
 * deprecated (D-004); promoting brainstorm content into a plan is a
 * separate follow-up. Was deferred in batch 18 because it
 * depended on `auditFeatureChange` + `loadIssuesOrSeed` + `saveIssues`
 * that still lived in harness.ts; ships now that 25a + 26a relocated
 * those helpers to lib/.
 */
const promote = defineTool({
  method: 'POST',
  path: '/harness/:slug/brainstorm/promote',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = await req.json().catch(() => ({} as any));
    const target = body.target as 'feature' | 'issue';
    const content = typeof body.content === 'string' ? body.content : '';
    if (!target || !content.trim()) {
      return Response.json({ error: 'target + content required' }, { status: 400 });
    }

    if (target === 'feature') {
      // PG-canonical: F-IDEA-### entry in harness_features (same shape as
      // the issue-promote path). SELECT (next idea id) + INSERT are related
      // (id computed then used), so one transaction avoids a TOCTOU gap
      // between the two round-trips.
      const [firstLine, ...rest] = content.trim().split('\n');
      const title = firstLine.trim().slice(0, 200);
      const notes = rest.join('\n').trim() || null;
      const ts = Date.now();
      const id = await harnessTransaction(project.slug, async (tx) => {
        const ideaRows = await tx`
          SELECT feature_id FROM harness_features
           WHERE harness_slug = ${project.slug} AND feature_id LIKE 'F-IDEA-%'
        ` as Array<{ feature_id: string }>;
        const existingIdeaIds = ideaRows
          .map((r) => Number(r.feature_id.slice(7)))
          .filter((n) => Number.isFinite(n));
        const n = (existingIdeaIds.length ? Math.max(...existingIdeaIds) : 0) + 1;
        const newId = `F-IDEA-${String(n).padStart(3, '0')}`;
        await tx`
          INSERT INTO harness_features
            (harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata,
             kind, project_id, expected_cost_cents, tags, needs_human_review,
             ts, created_ts, updated_ts)
          VALUES (${project.slug}, ${newId}, ${title}, NULL, 'todo', 0, NULL, ${notes},
            ${JSON.stringify({ source: 'brainstorm' })}::text::jsonb,
            NULL, NULL, NULL, NULL, false, ${ts}, ${ts}, ${ts})
        `;
        return newId;
      });
      auditFeatureChange(
        project.slug, id, '__created', null,
        { id, title, source: 'brainstorm' },
        req.headers.get('x-actor') ?? 'brainstorm-promote',
      );
      return Response.json({ ok: true, id, target });
    }


    if (target === 'issue') {
      const file = await loadIssuesOrSeed(project);
      const id = `I-${String(file.nextId).padStart(4, '0')}`;
      const [firstLine, ...rest] = content.trim().split('\n');
      file.issues.unshift({
        id,
        title: firstLine.trim().slice(0, 200),
        severity: 'minor',
        source: 'human',
        foundAt: new Date().toISOString(),
        status: 'open',
        evidence: rest.join('\n').trim(),
        attempts: 0,
        notes: [],
      });
      file.nextId += 1;
      await saveIssues(project, file);
      return Response.json({ ok: true, id, target });
    }

    return Response.json({ error: 'unknown target' }, { status: 400 });
  },
});

export default [getBrainstorm, putBrainstorm, getCanvas, putCanvas, getMindmap, putMindmap, promote];
