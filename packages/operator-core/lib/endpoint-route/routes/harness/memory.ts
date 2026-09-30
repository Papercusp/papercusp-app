/**
 * Harness Memory tab — list + view + edit the artifacts that function as
 * harness memory:
 *
 *   GET /api/harness/:slug/memory        — memory-map list + tier/size/mtime
 *   GET /api/harness/:slug/memory-file   — one file's content (?path=)
 *   PUT /api/harness/:slug/memory-file   — edit a file (tier-gated; red is
 *                                          locked while the harness runs)
 *
 * memory files are PG-canonical (Migration 035) via text-artifacts with
 * a best-effort FS mirror.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 23). The memory-map data + helpers live in
 * `@/lib/harness-memory-map`.
 */
import { readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject } from '../../../harness-core';
import { readEffectiveHarnessConfig } from '../../../harness-effective-config';
import { activeWorkspaceId } from '../../../workspace-registry';
import { phasePhaseLabel } from '../../../harness-phases';
import {
  MEMORY_MAP,
  type MemoryFileMeta,
  resolveMemoryPath,
  detectTier,
  isHarnessAlive,
} from '../../../harness-memory-map';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

const getMemory = defineTool({
  method: 'GET',
  path: '/harness/:slug/memory',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });

    // Extras from config.json.memory.files[] — merge non-duplicate paths.
    const extras: MemoryFileMeta[] = [];
    try {
      const cfg = await readEffectiveHarnessConfig(project.slug, activeWorkspaceId(), project.path);
      const cfgFiles = (cfg?.memory as Record<string, unknown> | undefined)?.files;
      if (Array.isArray(cfgFiles)) {
        for (const e of cfgFiles) {
          if (typeof e?.path !== 'string') continue;
          if (MEMORY_MAP.some((m) => m.path === e.path)) continue;
          extras.push({
            path: e.path,
            purpose: String(e.purpose ?? ''),
            writtenBy: Array.isArray(e.writtenBy) ? e.writtenBy : [],
            readBy: Array.isArray(e.readBy) ? e.readBy : [],
            tier: ['green', 'yellow', 'red'].includes(e.tier) ? e.tier : 'yellow',
            language: ['markdown', 'json', 'jsonl', 'text'].includes(e.language) ? e.language : 'text',
            optional: true,
          });
        }
      }
    } catch {}

    const all = [...MEMORY_MAP, ...extras];
    const alive = isHarnessAlive(project);
    const files = all.map((m) => {
      const r = resolveMemoryPath(project, m.path);
      let size = 0;
      let mtimeMs = 0;
      let exists = false;
      if (r) {
        try {
          const s = statSync(r.abs);
          exists = true;
          size = s.size;
          mtimeMs = s.mtimeMs;
        } catch {}
      }
      return {
        ...m,
        exists,
        size,
        mtimeMs,
        editable: m.tier === 'green' || m.tier === 'yellow' || (m.tier === 'red' && !alive),
        locked: m.tier === 'red' && alive,
      };
    });

    return Response.json({ alive, files });
  },
});

const getMemoryFile = defineTool({
  method: 'GET',
  path: '/harness/:slug/memory-file',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const path = new URL(req.url).searchParams.get('path');
    if (!path) return Response.json({ error: 'path required' }, { status: 400 });
    const r = resolveMemoryPath(project, path);
    if (!r) return Response.json({ error: 'invalid path' }, { status: 400 });
    const { tier, meta } = detectTier(path);

    // PG canonical (Migration 035) with FS fallback for harnesses pre-035.
    const { loadTextArtifact } = await import('../../../text-artifacts');
    let content: string | null = await loadTextArtifact(slug, path);
    let mtimeMs: number | null = null;
    let size = 0;
    if (content === null) {
      try {
        content = readFileSync(r.abs, 'utf8');
        const s = statSync(r.abs);
        mtimeMs = s.mtimeMs;
        size = s.size;
      } catch {}
    } else {
      size = Buffer.byteLength(content, 'utf8');
    }
    return Response.json({
      path,
      content,
      exists: content !== null,
      size,
      mtimeMs,
      tier,
      language: meta?.language ?? 'text',
    });
  },
});

const putMemoryFile = defineTool({
  method: 'PUT',
  path: '/harness/:slug/memory-file',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { path?: string; content?: string };
    if (typeof body.path !== 'string') return Response.json({ error: 'path required' }, { status: 400 });
    if (typeof body.content !== 'string') return Response.json({ error: 'content required' }, { status: 400 });
    const r = resolveMemoryPath(project, body.path);
    if (!r) return Response.json({ error: 'invalid path' }, { status: 400 });

    const { tier } = detectTier(body.path);
    if (tier === 'red' && isHarnessAlive(project)) {
      return Response.json(
        { error: 'harness is running; stop it before editing this file', tier, path: body.path },
        { status: 423 }, // Locked
      );
    }

    if (body.path.endsWith('.json')) {
      try { JSON.parse(body.content); }
      catch (e: any) { return Response.json({ error: `invalid JSON: ${e.message}` }, { status: 400 }); }
    }

    // PG canonical (Migration 035).
    const { saveTextArtifact } = await import('../../../text-artifacts');
    await saveTextArtifact(slug, body.path, body.content);

    // FS mirror — best-effort.
    try {
      const dir = r.abs.split('/').slice(0, -1).join('/');
      await mkdir(dir, { recursive: true });
      const tmp = `${r.abs}.tmp.${Date.now()}`;
      await writeFile(tmp, body.content, 'utf8');
      await rename(tmp, r.abs);
    } catch { /* mirror is best-effort */ }

    return Response.json({ ok: true, path: body.path, tier, wroteBytes: body.content.length });
  },
});

export default [getMemory, getMemoryFile, putMemoryFile];
