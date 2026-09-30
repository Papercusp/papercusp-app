/**
 * Per-harness screenshot store:
 *
 *   GET    /api/harness/:slug/screenshots/:id   — serve the image bytes
 *   POST   /api/harness/:slug/screenshots       — multipart upload
 *   DELETE /api/harness/:slug/screenshots/:id   — remove file + PG row
 *
 * Files live in `.papercusp/screenshots/`; PG mirror is
 * `harness_shared.harness_screenshots` written producer-side.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 12).
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { resolvePhasedProject, harnessDir } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const SCREENSHOT_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const;

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

const getScreenshot = defineTool({
  method: 'GET',
  path: '/harness/:slug/screenshots/:id',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = String(ctx.params.id).replace(/[^A-Za-z0-9_.\-]/g, '');
    if (!id || !SCREENSHOT_EXTS.some((ext) => id.toLowerCase().endsWith(ext))) {
      return Response.json({ error: 'invalid screenshot id' }, { status: 400 });
    }
    const full = join(harnessDir(project), 'screenshots', id);
    if (!existsSync(full)) return Response.json({ error: 'not found' }, { status: 404 });
    const buf = readFileSync(full);
    const ext = id.toLowerCase().slice(id.lastIndexOf('.'));
    const contentType =
      ext === '.png'  ? 'image/png'  :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.gif'  ? 'image/gif'  :
      ext === '.webp' ? 'image/webp' : 'application/octet-stream';
    return new Response(buf, { headers: { 'content-type': contentType, 'cache-control': 'no-cache' } });
  },
});

const postScreenshot = defineTool({
  method: 'POST',
  path: '/harness/:slug/screenshots',
  auth: 'loopback',
  async handler(req, ctx) {
    const phase = phaseFromReq(req);
    const project = await resolvePhasedProject(ctx.params.slug as string, phase);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const form = await req.formData();
    const file = form.get('file');
    const rawName = form.get('name');
    if (!(file instanceof File)) {
      return Response.json({ error: 'file field required (multipart)' }, { status: 400 });
    }

    const givenName = typeof rawName === 'string' && rawName ? rawName : file.name;
    const safeName = givenName.replace(/[^A-Za-z0-9_.\-]/g, '_');
    if (!SCREENSHOT_EXTS.some((ext) => safeName.toLowerCase().endsWith(ext))) {
      return Response.json({ error: `file must end with one of ${SCREENSHOT_EXTS.join(', ')}` }, { status: 400 });
    }

    const dir = join(harnessDir(project), 'screenshots');
    await mkdir(dir, { recursive: true });
    const dest = join(dir, safeName);
    const tmp = `${dest}.tmp.${Date.now()}`;
    const ab = await file.arrayBuffer();
    await writeFile(tmp, Buffer.from(ab));
    await rename(tmp, dest);
    // Producer-time PG write — replaces the chokidar replace-all mirror.
    {
      const { db } = getOrgPg();
      const { generated } = await import('@papercusp/db-org');
      const { sql: dsql } = await import('drizzle-orm');
      const hsh = generated.harnessScreenshotsInHarnessShared;
      const ws = activeWorkspaceId();
      await db
        .insert(hsh)
        .values({
          harnessSlug: project.slug,
          phase,
          id: safeName,
          sizeBytes: ab.byteLength,
          ts: Date.now(),
          workspaceId: ws,
        })
        .onConflictDoUpdate({
          target: [hsh.harnessSlug, hsh.phase, hsh.id],
          set: {
            sizeBytes: dsql`EXCLUDED.size_bytes`,
            ts: dsql`EXCLUDED.ts`,
            workspaceId: dsql`EXCLUDED.workspace_id`,
          },
        });
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      void notifySyncInvalidate('harnessScreenshots.byHarness', { harnessSlug: project.slug, phase }).catch(() => {});
    }
    return Response.json({ ok: true, id: safeName, sizeBytes: ab.byteLength });
  },
});

const deleteScreenshot = defineTool({
  method: 'DELETE',
  path: '/harness/:slug/screenshots/:id',
  auth: 'loopback',
  async handler(req, ctx) {
    const phase = phaseFromReq(req);
    const project = await resolvePhasedProject(ctx.params.slug as string, phase);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = String(ctx.params.id).replace(/[^A-Za-z0-9_.\-]/g, '');
    if (!id || !SCREENSHOT_EXTS.some((ext) => id.toLowerCase().endsWith(ext))) {
      return Response.json({ error: 'invalid screenshot id' }, { status: 400 });
    }
    let deleted = false;
    try {
      await unlink(join(harnessDir(project), 'screenshots', id));
      deleted = true;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') return Response.json({ error: String(err) }, { status: 500 });
    }
    // Drop the PG row regardless; if the file was already gone, the row
    // may still be lingering from a previous fs.watch race.
    {
      const { db } = getOrgPg();
      const { generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const hsh = generated.harnessScreenshotsInHarnessShared;
      await db
        .delete(hsh)
        .where(and(eq(hsh.harnessSlug, project.slug), eq(hsh.phase, phase), eq(hsh.id, id)));
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      void notifySyncInvalidate('harnessScreenshots.byHarness', { harnessSlug: project.slug, phase }).catch(() => {});
    }
    return Response.json({ ok: true, deleted });
  },
});

export default [getScreenshot, postScreenshot, deleteScreenshot];
