/**
 * Feature-scoped operator notes — Phase A1 (endpoint-hono-elimination-2026-05-21).
 * Ported off the legacy `_hono/operator-notes.ts` (mounted via
 * `registerOperatorNotes`). URLs unchanged.
 *
 *   GET  /api/harness/:slug/features/:featureId/notes
 *   POST /api/harness/:slug/features/:featureId/notes   body: { content, author? }
 *
 * `auth: 'public'` — the legacy `harness` sub-app gated none of these.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { appendOperatorNote, readOperatorNotes } from '../../../operator-notes';

const getNotes = defineTool({
  method: 'GET',
  path: '/harness/:slug/features/:featureId/notes',
  auth: 'public',
  async handler(_req, ctx) {
    const result = await readOperatorNotes(ctx.params.slug, ctx.params.featureId);
    if ('error' in result) return Response.json({ error: result.error }, { status: 400 });
    return Response.json(result);
  },
});

const postNote = defineTool({
  method: 'POST',
  path: '/harness/:slug/features/:featureId/notes',
  auth: 'loopback',
  input: z.object({ content: z.string().optional(), author: z.string().optional() }),
  async handler(_req, ctx) {
    const result = await appendOperatorNote({
      slug: ctx.params.slug,
      featureId: ctx.params.featureId,
      content: ctx.input.content ?? '',
      author: ctx.input.author,
    });
    if ('error' in result) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ ok: true, ...result });
  },
});

export default [getNotes, postNote];
