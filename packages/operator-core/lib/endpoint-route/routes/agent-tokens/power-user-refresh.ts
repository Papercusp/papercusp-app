/**
 * POST /api/agent-tokens/power-user/refresh
 *
 * Mints a fresh access token from a still-valid refresh token. The
 * refresh token (Authorization: Bearer) is the credential; the route
 * also resolves a principal (`auth: {}`) as the transport gate.
 *
 * Ported from app/api/agent-tokens/power-user/refresh/route.ts.
 */
import { verifyRefreshToken, mintAccessToken } from '../../../power-user-token';
import { getActivePowerUserSession } from '../../../power-user-sessions';
import { defineTool } from '@papercusp/agent-mcp';

function bearerFrom(req: Request): string | null {
  const raw = req.headers.get('authorization') ?? '';
  if (!raw) return null;
  return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
}

export default defineTool({
  method: 'POST',
  path: '/agent-tokens/power-user/refresh',
  // The refresh token (Authorization: Bearer) IS the credential, read in the
  // handler. During a refresh the access token has expired by definition, so
  // there's no verified/trusted principal to gate on — `auth: {}` (any resolved
  // principal, incl. loopback) is the transport gate, exactly as the header
  // doc-comment states. (The previous `trust: ['verified','trusted']` was
  // copy-pasted from the issue endpoint and 403'd every legitimate refresh,
  // since the same Authorization header can't be both a trusted-principal
  // bearer and the refresh token.)
  auth: {},
  async handler(req) {
    const refreshToken = bearerFrom(req);
    const claims = await verifyRefreshToken(refreshToken);
    if (!claims) {
      return Response.json({ error: 'invalid or expired refresh token' }, { status: 401 });
    }
    const session = await getActivePowerUserSession(claims.authSessionId);
    if (!session) {
      return Response.json({ error: 'session revoked or unknown' }, { status: 401 });
    }
    try {
      const access = await mintAccessToken({
        workspaceId: session.workspaceId,
        userId: session.userId,
        authSessionId: session.authSessionId,
      });
      return Response.json({
        access_token: access.token,
        access_expires_at: new Date(access.exp * 1000).toISOString(),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'refresh failed';
      return Response.json({ error: msg }, { status: 400 });
    }
  },
});
