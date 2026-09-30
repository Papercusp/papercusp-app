/**
 * POST/GET/DELETE /api/agent-mcp/voice-debug — voice debug ring-buffer.
 * Ported from app/api/agent-mcp/voice-debug/route.ts. `auth: 'public'`.
 */
import {
  appendVoiceDebugEvent,
  clearVoiceDebugEvents,
  readVoiceDebugEvents,
} from '../../../voice-debug-ring';
import { defineTool } from '@papercusp/agent-mcp';

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/voice-debug',
  auth: 'loopback',
  async handler(req) {
    let body: { event?: string; detail?: unknown; ts?: number } = {};
    try { body = await req.json(); } catch { /* empty body OK */ }
    const count = appendVoiceDebugEvent(body);
    return Response.json({ ok: true, count });
  },
});

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/voice-debug',
  auth: 'public',
  handler(req) {
    const url = new URL(req.url);
    const since = Number(url.searchParams.get('since') ?? '0');
    const events = readVoiceDebugEvents(since || undefined);
    return Response.json({
      count: events.length,
      events,
    });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/agent-mcp/voice-debug',
  auth: 'loopback',
  handler() {
    clearVoiceDebugEvents();
    return Response.json({ ok: true, cleared: true });
  },
});

export default [post, get, del];
