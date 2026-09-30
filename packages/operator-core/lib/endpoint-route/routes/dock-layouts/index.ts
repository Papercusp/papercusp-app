/**
 * /api/dock-layouts/* + /api/harness-phase-last-used/* — per-user named
 * dock layouts. Phase A1 (endpoint-hono-elimination-2026-05-21). Ported
 * off `_hono/dock-layouts.ts` (mounted via `registerDockLayouts`).
 *
 *   GET    /api/dock-layouts/_list
 *   GET    /api/dock-layouts/:name           (seeds on miss)
 *   PUT    /api/dock-layouts/:name           If-Match: <updated_ts> → 200 | 409
 *   DELETE /api/dock-layouts/:name           → 204
 *   GET    /api/harness-phase-last-used/:slug
 *   PUT    /api/harness-phase-last-used/:slug → 204
 *
 * `auth: 'public'` — the legacy router gated none of these; the handler
 * resolves a per-user scoping id via `getUserIdForLayouts(req)`.
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  getLayout,
  saveLayout,
  deleteLayout,
  listLayouts,
  getUserIdForLayouts,
  validateLayoutDoc,
  getLastUsedPhase,
  setLastUsedPhase,
  LayoutConflictError,
  LayoutValidationError,
  type LayoutDoc,
} from '../../../dock-layouts';

const list = defineTool({
  method: 'GET',
  path: '/dock-layouts/_list',
  auth: 'public',
  async handler(req) {
    const principal = await getUserIdForLayouts(req);
    return Response.json({ layouts: await listLayouts(principal) });
  },
});

const get = defineTool({
  method: 'GET',
  path: '/dock-layouts/:name',
  auth: 'public',
  async handler(req, ctx) {
    const principal = await getUserIdForLayouts(req);
    try {
      return Response.json(await getLayout(principal, ctx.params.name));
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/dock-layouts/:name',
  auth: 'loopback',
  async handler(req, ctx) {
    const principal = await getUserIdForLayouts(req);
    const name = ctx.params.name;
    let body: { layout: LayoutDoc };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    if (!body?.layout) {
      return Response.json({ error: 'missing { layout }' }, { status: 400 });
    }
    try {
      validateLayoutDoc(body.layout);
    } catch (err) {
      if (err instanceof LayoutValidationError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
    const ifMatchHeader = req.headers.get('if-match');
    const expectedTs = ifMatchHeader ? Number(ifMatchHeader) : undefined;
    if (ifMatchHeader && Number.isNaN(expectedTs)) {
      return Response.json({ error: 'If-Match must be numeric updated_ts' }, { status: 400 });
    }
    try {
      const row = await saveLayout(principal, name, body.layout, expectedTs);
      return Response.json(row);
    } catch (err) {
      if (err instanceof LayoutConflictError) {
        return Response.json({ error: err.message }, { status: 409 });
      }
      if (err instanceof LayoutValidationError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/dock-layouts/:name',
  auth: 'loopback',
  async handler(req, ctx) {
    const principal = await getUserIdForLayouts(req);
    await deleteLayout(principal, ctx.params.name);
    return new Response(null, { status: 204 });
  },
});

const phaseGet = defineTool({
  method: 'GET',
  path: '/harness-phase-last-used/:slug',
  auth: 'public',
  async handler(req, ctx) {
    const principal = await getUserIdForLayouts(req);
    const phase = await getLastUsedPhase(principal, ctx.params.slug);
    return Response.json({ phase });
  },
});

const phasePut = defineTool({
  method: 'PUT',
  path: '/harness-phase-last-used/:slug',
  auth: 'loopback',
  async handler(req, ctx) {
    const principal = await getUserIdForLayouts(req);
    let body: { phase?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    if (!body?.phase || typeof body.phase !== 'string') {
      return Response.json({ error: 'missing { phase: string }' }, { status: 400 });
    }
    await setLastUsedPhase(principal, ctx.params.slug, body.phase);
    return new Response(null, { status: 204 });
  },
});

export default [list, get, put, del, phaseGet, phasePut];
