/**
 * GET/POST/DELETE /api/agent-mcp/operator-preferences — preferences entries.
 * Ported from app/api/agent-mcp/operator-preferences/route.ts. `auth: 'public'`.
 */
import {
  appendPreferenceEntry,
  listPreferenceEntries,
  removePreferenceEntry,
} from '../../../operator-preferences';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-preferences',
  auth: 'public',
  async handler() {
    return Response.json({ entries: await listPreferenceEntries() });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-preferences',
  auth: 'loopback',
  async handler(req) {
    let body: { entry?: unknown } = {};
    try {
      body = (await req.json()) as { entry?: unknown };
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    const entry = typeof body.entry === 'string' ? body.entry.trim() : '';
    if (!entry) return new Response('entry required', { status: 400 });
    await appendPreferenceEntry(entry);
    return Response.json({ ok: true });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/agent-mcp/operator-preferences',
  auth: 'loopback',
  async handler(req) {
    const key = new URL(req.url).searchParams.get('key');
    if (!key) return new Response('key required', { status: 400 });
    const removed = await removePreferenceEntry(key);
    if (!removed) return new Response('not found', { status: 404 });
    return Response.json({ ok: true });
  },
});

export default [get, post, del];
