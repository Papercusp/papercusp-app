/**
 * Per-harness skill files + supervisor notes:
 *
 *   GET    /api/harness/:slug/skills                  — list .claude/skills/*.md
 *   GET    /api/harness/:slug/skills/:name            — one skill file
 *   PUT    /api/harness/:slug/skills/:name            — write a skill file
 *   DELETE /api/harness/:slug/skills/:name            — remove a skill file
 *   PUT    /api/harness/:slug/supervisor-notes        — replace supervisor-notes.md
 *   POST   /api/harness/:slug/supervisor-notes/append — append a timestamped block
 *
 * supervisor-notes.md is PG-canonical (text-artifacts); skill files are
 * FS-only under the project's `.claude/skills/`.
 *
 * NOTE: `GET /harness/:slug/supervisor-notes` is intentionally NOT here —
 * `routes/cross-harness/index.ts` already owns that path (it reads the
 * cross-harness `supervisor_notes` PG table, a different endpoint that
 * collided on the same URL). The legacy `_hono/harness.ts` GET was
 * dead-shadowed by it (phase-1 literal out-ranks the harness sub-app)
 * and is dropped, not migrated — a pre-existing URL collision left as-is.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 16).
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import type { ProjectEntry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

const skillsDir = (p: ProjectEntry) => join(p.path, '.claude', 'skills');

/** Validate + normalize a skill filename — rejects traversal, forces `.md`. */
function safeName(name: string): string | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  if (name.includes('..') || name.startsWith('.')) return null;
  return name.replace(/\.md$/i, '') + '.md';
}

const getSkills = defineTool({
  method: 'GET',
  path: '/harness/:slug/skills',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const dir = skillsDir(project);
    let files: string[] = [];
    try {
      if (existsSync(dir)) {
        files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
      }
    } catch {}
    return Response.json({ skills: files });
  },
});

const getSkill = defineTool({
  method: 'GET',
  path: '/harness/:slug/skills/:name',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const name = safeName(ctx.params.name as string);
    if (!name) return Response.json({ error: 'bad name' }, { status: 400 });
    const content = safeRead(join(skillsDir(project), name)) ?? '';
    return Response.json({ name, content });
  },
});

const putSkill = defineTool({
  method: 'PUT',
  path: '/harness/:slug/skills/:name',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const name = safeName(ctx.params.name as string);
    if (!name) return Response.json({ error: 'bad name' }, { status: 400 });
    const body = await req.json().catch(() => ({} as any));
    if (typeof body.content !== 'string') return Response.json({ error: 'content required' }, { status: 400 });
    const dir = skillsDir(project);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), body.content, 'utf8');
    return Response.json({ ok: true, name });
  },
});

const deleteSkill = defineTool({
  method: 'DELETE',
  path: '/harness/:slug/skills/:name',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const name = safeName(ctx.params.name as string);
    if (!name) return Response.json({ error: 'bad name' }, { status: 400 });
    try { await unlink(join(skillsDir(project), name)); } catch {}
    return Response.json({ ok: true });
  },
});

const putSupervisorNotes = defineTool({
  method: 'PUT',
  path: '/harness/:slug/supervisor-notes',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = await req.json().catch(() => ({} as any));
    if (typeof body.content !== 'string') return Response.json({ error: 'content required' }, { status: 400 });
    const { saveTextArtifact } = await import('../../../text-artifacts');
    await saveTextArtifact(slug, 'supervisor-notes.md', body.content);
    return Response.json({ ok: true });
  },
});

const appendSupervisorNotes = defineTool({
  method: 'POST',
  path: '/harness/:slug/supervisor-notes/append',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = await req.json().catch(() => ({} as any));
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return Response.json({ error: 'text required' }, { status: 400 });
    const speaker = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'human';
    const block = `\n## ${speaker} ${new Date().toISOString()}\n\n${text}\n`;
    const { appendTextArtifact } = await import('../../../text-artifacts');
    await appendTextArtifact(slug, 'supervisor-notes.md', block);
    return Response.json({ ok: true });
  },
});

export default [
  getSkills, getSkill, putSkill, deleteSkill,
  putSupervisorNotes, appendSupervisorNotes,
];
