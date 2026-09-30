/**
 * Read-only harness views that do NOT take a `:slug` path param:
 *
 *   GET /api/harness/identity              — role identity files (PG canonical, FS fallback)
 *   GET /api/harness/needs-human-review    — features flagged for review across all harnesses
 *   GET /api/harness/templates             — list .../harness/templates/projects/<id>
 *   GET /api/harness/templates/:id/file    — single template file (?name=)
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 5).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getLegacyClient } from '@papercusp/db-org';
import { harnessPath } from '../../../harness-paths';
import { rowToFeature, safeRead } from '../../../harness-core';
import { TEMPLATE_DETECT_FILES } from '../../../harness-state-files';
import { defineTool } from '@papercusp/agent-mcp';

const TEMPLATES_DIR = () => harnessPath('templates', 'projects');

const getIdentity = defineTool({
  method: 'GET',
  path: '/harness/identity',
  auth: 'public',
  async handler() {
    // PG-canonical-for-reads (Migration 041). Files at ~/autonomous-harness/
    // identity/<role>.md remain the source of truth for the orchestrator
    // subprocess; the operator-side watcher mirrors them in so the UI
    // doesn't readdir per request and Zero subscribers wake up on changes.
    const { db } = (await import('@papercusp/db-org')).getOrgPg();
    const { generated } = await import('@papercusp/db-org');
    const { asc } = await import('drizzle-orm');
    const idf = generated.identityFilesInHarnessShared;
    const rows = await db
      .select({ role: idf.role, content: idf.content, bytes: idf.bytes, mtime_ms: idf.mtimeMs })
      .from(idf)
      .orderBy(asc(idf.role));
    // FS fallback for the brief window before the watcher's initialSync
    // populates PG on a fresh install.
    if (rows.length === 0) {
      const dir = harnessPath('identity');
      if (existsSync(dir)) {
        const out: Array<{ role: string; content: string; bytes: number; mtimeMs: number }> = [];
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.md')) continue;
          const p = join(dir, f);
          const role = f.replace(/\.md$/, '');
          try {
            const s = statSync(p);
            out.push({ role, content: readFileSync(p, 'utf8'), bytes: s.size, mtimeMs: s.mtimeMs });
          } catch {}
        }
        out.sort((a, b) => a.role.localeCompare(b.role));
        return Response.json({ identities: out });
      }
    }
    return Response.json({
      identities: rows.map((r) => ({
        role: r.role,
        content: r.content,
        bytes: r.bytes,
        mtimeMs: Number(r.mtime_ms) || 0,
      })),
    });
  },
});

const getNeedsHumanReview = defineTool({
  method: 'GET',
  path: '/harness/needs-human-review',
  auth: 'public',
  async handler() {
    try {
      // Cross-harness admin read: a dashboard over every harness's
      // needs-human-review features, with no harness_slug filter at all —
      // harnessQuery/withHarnessSchema are inherently per-harness-schema-scoped
      // and have no equivalent for this shape, so this stays on the no-slug
      // admin client (getOrgPg()). Decision + why: WI-5384, mirroring D-005's
      // per-harness getHarnessPg rationale.
      const dbc = getLegacyClient();
      const rows = await dbc.prepare(`
        SELECT f.*, p.name as project_name, p.budget_cents as project_budget_cents
        FROM all_features f
        LEFT JOIN projects p ON p.id = f.project_id
        WHERE f.needs_human_review = true
        ORDER BY f.created_ts DESC
      `).all() as any[];
      return Response.json({
        count: rows.length,
        features: rows.map((r) => ({
          ...rowToFeature(r),
          harness_slug: r.harness_slug,
          project_name: r.project_name,
          project_budget_cents: r.project_budget_cents == null ? null : Number(r.project_budget_cents),
        })),
      });
    } catch (e) {
      return Response.json({ error: `query failed: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

const getTemplates = defineTool({
  method: 'GET',
  path: '/harness/templates',
  auth: 'public',
  async handler() {
    const dir = TEMPLATES_DIR();
    if (!existsSync(dir)) return Response.json({ templates: [] });
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    const templates = entries.map((d) => {
      const tdir = join(dir, d.name);
      let meta: any = { id: d.name, name: d.name };
      try {
        const raw = safeRead(join(tdir, 'meta.json'));
        if (raw) meta = { ...meta, ...JSON.parse(raw) };
      } catch {}
      const files: string[] = [];
      for (const f of TEMPLATE_DETECT_FILES) {
        if (existsSync(join(tdir, f))) files.push(f);
      }
      return {
        id: d.name,
        name: meta.name ?? d.name,
        description: meta.description ?? '',
        tags: meta.tags ?? [],
        files,
      };
    });
    return Response.json({ templates });
  },
});

const getTemplateFile = defineTool({
  method: 'GET',
  path: '/harness/templates/:id/file',
  auth: 'public',
  async handler(req, ctx) {
    const id = String(ctx.params.id).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) return Response.json({ error: 'invalid id' }, { status: 400 });
    const name = (new URL(req.url).searchParams.get('name') ?? '').replace(/[^A-Za-z0-9_.-]/g, '');
    if (!name) return Response.json({ error: 'name query required' }, { status: 400 });
    const p = join(TEMPLATES_DIR(), id, name);
    if (!existsSync(p)) return Response.json({ error: 'not found' }, { status: 404 });
    const content = safeRead(p);
    if (content === null) return Response.json({ error: 'unreadable' }, { status: 500 });
    return new Response(content, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
});

export default [getIdentity, getNeedsHumanReview, getTemplates, getTemplateFile];
