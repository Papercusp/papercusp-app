/**
 * GET/POST /api/user/jev-settings — the Jev card on Settings › Memory
 * (plan jev-decision-model-integration-2026-09-29, P-013 / D-008).
 *
 * GET  → { mode, keyPresent, maskedKey, effective, model }. Never the raw key.
 * POST { mode?: 'off'|'shadow'|'on', apiKey?: string | null }
 *        apiKey string → save it (encrypted integration credential TYPESAFE_API_KEY)
 *        apiKey null   → clear it (withdraws egress consent; effective mode drops to off)
 *      → the same view as GET.
 *
 * POST is loopback-only like the memory-pause switch: a user setting on the
 * user's own machine, and saving a credential must never be reachable remotely.
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  getJevSettingsView,
  isJevMode,
  jevApiKeyProblem,
  setJevApiKey,
  setJevMode,
  JEV_MODES,
} from '../../../memory/jev-settings';

const get = defineTool({
  method: 'GET',
  path: '/user/jev-settings',
  auth: 'public',
  async handler() {
    try {
      return Response.json(await getJevSettingsView());
    } catch (e) {
      return Response.json({ error: 'jev_settings_unavailable', detail: e instanceof Error ? e.message : String(e) }, { status: 503 });
    }
  },
});

const set = defineTool({
  method: 'POST',
  path: '/user/jev-settings',
  auth: 'loopback',
  async handler(req) {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return Response.json({ error: 'body must be an object' }, { status: 400 });
    }
    const { mode, apiKey } = body as { mode?: unknown; apiKey?: unknown };
    if (mode === undefined && apiKey === undefined) {
      return Response.json({ error: 'nothing to change: pass mode and/or apiKey' }, { status: 400 });
    }
    if (mode !== undefined && !isJevMode(mode)) {
      return Response.json({ error: `mode must be one of: ${JEV_MODES.join(', ')}` }, { status: 400 });
    }
    if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') {
      return Response.json({ error: 'apiKey must be a string, or null to clear it' }, { status: 400 });
    }
    if (typeof apiKey === 'string') {
      const problem = jevApiKeyProblem(apiKey);
      if (problem) return Response.json({ error: problem }, { status: 400 });
    }

    // Key first: a request that saves a key AND turns Jev on must not leave the
    // mode on with the old (or no) key if the credential write fails.
    if (apiKey !== undefined) await setJevApiKey(apiKey as string | null);
    if (mode !== undefined) await setJevMode(mode as Parameters<typeof setJevMode>[0]);
    return Response.json({ ok: true, ...(await getJevSettingsView()) });
  },
});

export default [get, set];
