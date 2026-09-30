/**
 * GET/POST /api/agent-mcp/operator-standing-approvals — standing-approval candidates.
 * Ported from app/api/agent-mcp/operator-standing-approvals/route.ts. `auth: 'public'`.
 */
import { appendPreferenceEntry } from '../../../operator-preferences';
import {
  readCandidates,
  refreshCandidates,
} from '../../../operator-standing-candidates';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-standing-approvals',
  auth: 'public',
  async handler() {
    const candidates = await refreshCandidates().catch(async () => await readCandidates());
    return Response.json({ candidates });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-standing-approvals',
  auth: 'loopback',
  async handler(req) {
    let body: { capability?: unknown; targetHarness?: unknown; decision?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    const capability = typeof body.capability === 'string' ? body.capability : '';
    const target = typeof body.targetHarness === 'string' ? body.targetHarness : '';
    const decision = body.decision;
    if (!capability || !target || (decision !== 'approve' && decision !== 'dismiss')) {
      return new Response('capability + targetHarness + decision required', { status: 400 });
    }
    if (decision === 'approve') {
      const today = new Date().toISOString().slice(0, 10);
      const entry = `- [OPERATOR-PROPOSED-USER-CONFIRMED-${today}] [STANDING-APPROVE]\n  capability=${capability}, target=${target}\n  pattern: ≥3 silent dispatches in 24h\n  user confirmed: ${new Date().toISOString()}`;
      await appendPreferenceEntry(entry);
    }
    await refreshCandidates().catch(() => {});
    return Response.json({ ok: true });
  },
});

export default [get, post];
