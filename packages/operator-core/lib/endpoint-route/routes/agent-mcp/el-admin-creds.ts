/**
 * GET /api/agent-mcp/el-admin-creds — raw EL key + agent id for local scripts.
 * Ported from app/api/agent-mcp/el-admin-creds/route.ts. `auth: 'public'` —
 * requirePrincipal() inline (any-principal, matches pre-migration loopback posture).
 */
import { readElevenLabsKey } from '../../../voice-credentials';
import { loadVoicePrefs } from '../../../voice-prefs';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/el-admin-creds',
  auth: 'public',
  async handler(req) {
    try {
      await requirePrincipal(req.headers);
    } catch (err) {
      if (err instanceof PrincipalCheckError) {
        return Response.json({ error: err.reason }, { status: err.status });
      }
      throw err;
    }
    const [apiKey, prefs] = await Promise.all([
      readElevenLabsKey(),
      loadVoicePrefs(),
    ]);
    return Response.json({
      apiKey: apiKey ?? null,
      agentId: prefs.elevenLabsAgentId || null,
    });
  },
});
