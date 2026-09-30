/**
 * POST /api/auth/signup — create a local account, optionally auto-login.
 *
 * Ported from app/api/auth/signup/route.ts. `auth: 'public'` — account
 * creation is pre-auth.
 */
import { signup, login, listUsers, SESSION_COOKIE } from '../../../auth';
import { defineTool } from '@papercusp/agent-mcp';
import { serializeSetCookie } from '../../cookies';
import { requestNeedsSecureCookie } from '../../../remote-auth-policy';

export default defineTool({
  method: 'POST',
  path: '/auth/signup',
  auth: 'public',
  async handler(req) {
    const body = await req.json().catch(() => null);
    const username = typeof body?.username === 'string' ? body.username : '';
    const display_name = typeof body?.display_name === 'string' ? body.display_name : '';
    const password = typeof body?.password === 'string' ? body.password : null;
    const autoLogin = body?.auto_login !== false;
    if (!username || !display_name) {
      return Response.json({ error: 'username + display_name required' }, { status: 400 });
    }

    // Single-owner posture (auth-tier rollout 2026-06-10, OWNER rows): the
    // route stays `public` so a fresh install can create its first account,
    // but once any active user exists further signups need the explicit
    // OPEN_SIGNUP flag — this endpoint is internet-reachable through the
    // cloudflared tunnel.
    const existing = await listUsers();
    if (existing.length > 0) {
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      if (!(await getFlag(FLAGS.OPEN_SIGNUP, 'system'))) {
        return Response.json({ error: 'signup_disabled' }, { status: 403 });
      }
    }

    try {
      const user = await signup(username, display_name, password);
      const headers: Record<string, string> = {};
      if (autoLogin) {
        const session = await login(user.username, password, {
          user_agent: req.headers.get('user-agent') ?? undefined,
          remote_addr: req.headers.get('x-forwarded-for') ?? undefined,
        });
        headers['set-cookie'] = serializeSetCookie(SESSION_COOKIE, session.token, {
          httpOnly: true,
          sameSite: 'Strict',
          path: '/',
          expires: session.expires_at,
          secure: requestNeedsSecureCookie(req),
        });
      }
      return Response.json({ ok: true, user }, { headers });
    } catch (e: unknown) {
      const msg = (e as Error).message;
      const code = (e as { code?: string }).code;
      if (/duplicate|unique/i.test(msg)) {
        return Response.json({ error: 'username_taken' }, { status: 409 });
      }
      return Response.json({ error: code ?? 'signup_failed' }, { status: 400 });
    }
  },
});
