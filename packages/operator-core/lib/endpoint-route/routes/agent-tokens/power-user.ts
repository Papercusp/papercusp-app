/**
 * POST /api/agent-tokens/power-user
 *
 * Issues an OAuth-style two-token pair for the `workspace-power-user`
 * auth tier. Ported from app/api/agent-tokens/power-user/route.ts.
 *
 * `auth: {}` = any resolved principal (the route's prior
 * `requirePrincipal(req.headers)` with no requirements — loopback/
 * cookie/bearer all pass; it is the gate, the body is the work).
 */
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import { createPowerUserSession } from '../../../power-user-sessions';
import { mintAccessToken, mintRefreshToken } from '../../../power-user-token';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-tokens/power-user',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as { workspace?: string };
    try {
      const user = await getSessionUserOrDefault(req.headers);
      const workspaceId = (body.workspace ?? '').trim() || activeWorkspaceId();
      const { authSessionId } = await createPowerUserSession({ workspaceId, userId: user.id });
      const access = await mintAccessToken({ workspaceId, userId: user.id, authSessionId });
      const refresh = await mintRefreshToken({ authSessionId });
      return Response.json({
        access_token: access.token,
        access_expires_at: new Date(access.exp * 1000).toISOString(),
        refresh_token: refresh.token,
        refresh_expires_at: new Date(refresh.exp * 1000).toISOString(),
        workspace_id: workspaceId,
        user_id: user.id,
        auth_session_id: authSessionId,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'power-user token issue failed';
      return Response.json({ error: msg }, { status: 400 });
    }
  },
});
