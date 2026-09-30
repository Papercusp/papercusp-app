/**
 * POST /api/internal/skill-snapshot — replace-all skills snapshot.
 * Ported from app/api/internal/skill-snapshot/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, notInArray, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const hsk = generated.harnessSkillsInHarnessShared;

const NAME_RE = /^[A-Za-z0-9_.-]+\.md$/;
const MAX_BODY = 256 * 1024;
const FileEntrySchema = z.object({ name: z.string().regex(NAME_RE), content: z.string().optional().default('') });
const BodySchema = z.object({ files: z.array(FileEntrySchema).optional().default([]) });

export default defineTool({
  method: 'POST',
  path: '/internal/skill-snapshot',
  auth: {},
  async handler(req) {
    const authHeader = req.headers.get('authorization') ?? '';
    const m = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!m) return Response.json({ error: 'missing bearer' }, { status: 401 });
    const token = m[1];
    const { db } = getOrgPg();
    const tokenRows = await db.select({ harness_slug: ti.harnessSlug }).from(ti).where(eq(ti.token, token)).limit(1);
    if (tokenRows.length === 0) return Response.json({ error: 'invalid bearer' }, { status: 401 });
    const slug = tokenRows[0].harness_slug;

    let raw: unknown;
    try { raw = await req.json(); } catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: 'validation failed', issues: parsed.error.issues }, { status: 400 });
    }
    const { files } = parsed.data;
    const ws = activeWorkspaceId();
    const now = Date.now();
    const keep = files.map((f) => {
      let content = f.content;
      if (Buffer.byteLength(content) > MAX_BODY) {
        content = content.slice(0, MAX_BODY) + '\n...[truncated]\n';
      }
      return { name: f.name, content };
    });
    if (keep.length === 0) {
      await db.delete(hsk).where(and(eq(hsk.workspaceId, ws), eq(hsk.harnessSlug, slug)));
    } else {
      const names = keep.map((k) => k.name);
      await db.delete(hsk).where(and(eq(hsk.workspaceId, ws), eq(hsk.harnessSlug, slug), notInArray(hsk.name, names)));
      for (const k of keep) {
        await db.insert(hsk).values({
          workspaceId: ws, harnessSlug: slug, name: k.name, content: k.content, mtimeMs: now,
        }).onConflictDoUpdate({
          target: [hsk.workspaceId, hsk.harnessSlug, hsk.name],
          set: { content: dsql`EXCLUDED.content`, mtimeMs: dsql`EXCLUDED.mtime_ms` },
        });
      }
    }
    void notifySyncInvalidate('harnessSkills.byHarness', { harnessSlug: slug }).catch(() => {});
    return Response.json({ ok: true, count: keep.length });
  },
});
