/**
 * Product-proposal action route (reject).
 *
 *   POST /api/harness/:slug/proposals/:id/reject   — stamp proposal as rejected
 *
 * The matching `/accept` handler was removed when SPEC.md was deprecated
 * (D-004): it appended acceptance bullets to SPEC.md (now gone) and had
 * no UI caller. The product-proposals file flow is otherwise UI-orphaned
 * (its harness panel was removed) and is a candidate for full removal in
 * a follow-up.
 *
 * File is source-of-truth: the harness FS watcher mirrors stamps into
 * `harness_proposals_shared` automatically; no explicit PG write here.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 29).
 */
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProject, harnessDir } from '../../../harness-core';
import { defineTool } from '@papercusp/agent-mcp';

const rejectProposal = defineTool({
  method: 'POST',
  path: '/harness/:slug/proposals/:id/reject',
  auth: 'loopback',
  async handler(_req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = (ctx.params.id as string).replace(/[^A-Za-z0-9_.-]/g, '');
    if (!id || !id.endsWith('.md')) return Response.json({ error: 'invalid id' }, { status: 400 });
    const proposalPath = join(harnessDir(project), 'proposals', id);
    if (!existsSync(proposalPath)) return Response.json({ error: 'not found' }, { status: 404 });
    await appendFile(proposalPath, `\n---\nrejected: true\nrejectedAt: ${new Date().toISOString()}\n`, 'utf8');
    return Response.json({ ok: true });
  },
});

export default [rejectProposal];
