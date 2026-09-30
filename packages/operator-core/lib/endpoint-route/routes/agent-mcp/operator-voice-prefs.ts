/**
 * GET/PUT /api/agent-mcp/operator-voice-prefs — voice prefs read/partial-save.
 * Ported from app/api/agent-mcp/operator-voice-prefs/route.ts. `auth: 'public'`.
 */
import { loadVoicePrefs, loadWorkspaceVoicePrefs, saveVoicePrefs } from '../../../voice-prefs';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-voice-prefs',
  auth: 'public',
  async handler(req) {
    const layer = new URL(req.url).searchParams.get('layer');
    if (layer === 'workspace') {
      return Response.json(await loadWorkspaceVoicePrefs());
    }
    return Response.json(await loadVoicePrefs());
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/agent-mcp/operator-voice-prefs',
  auth: 'loopback',
  async handler(req) {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return new Response('expected JSON object', { status: 400 });
    }
    const next = await saveVoicePrefs(body as any);
    return Response.json(next);
  },
});

export default [get, put];
