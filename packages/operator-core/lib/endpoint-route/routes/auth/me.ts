/**
 * GET  /api/auth/me — current session user + available users list.
 * PATCH /api/auth/me — update display name.
 *
 * Ported from app/api/auth/me/route.ts. `auth: 'public'` — GET falls
 * through to the seeded `default` user when no session is present (the
 * `getSessionUserOrDefault` semantics every memory tool relies on), and
 * PATCH does its own session check so it can return a clean 401.
 */
import {
  getSessionUser,
  getSessionUserOrDefault,
  listUsers,
  login,
  updateDisplayName,
  SESSION_COOKIE,
  DEFAULT_SESSION_TTL_MS,
} from '../../../auth';
import { defineTool } from '@papercusp/agent-mcp';
import { serializeSetCookie } from '../../cookies';
import { requireAllowedOriginOr403 } from '../../cors';
import { isRemoteRequest, requestNeedsSecureCookie } from '../../../remote-auth-policy';
import { currentLoopbackPeerIsForeign } from '../../../auth/loopback-peer-trust';

const get = defineTool({
  method: 'GET',
  path: '/auth/me',
  auth: 'public',
  async handler(req) {
    // Each PG-touching call is wrapped so a failure here doesn't 500 the
    // whole chrome UI. Errors are LOGGED (not swallowed) so a real
    // misconfiguration surfaces instead of masquerading as "pgUnavailable".
    let sessionUser: Awaited<ReturnType<typeof getSessionUser>> = null;
    try {
      sessionUser = await getSessionUser(req.headers);
    } catch (err) {
      console.error('[auth/me] getSessionUser threw — will fall through to default user:', err);
    }

    if (sessionUser) {
      let available: Awaited<ReturnType<typeof listUsers>> = [];
      try {
        available = await listUsers();
      } catch (err) {
        console.error('[auth/me] listUsers threw (non-fatal):', err);
      }
      return Response.json({ user: sessionUser, autoLogin: false, available });
    }

    // Never expose the passwordless local default-user fallback or account
    // enumeration to an unauthenticated off-loopback browser. The login form
    // remains usable with an empty username field.
    // WI-10003621: a foreign loopback peer on a hosted workspace host (the customer
    // uid) is treated exactly like a remote caller — no default-user fallback, no
    // account list, no auto-established session. login() refuses it regardless; this
    // keeps the response honest instead of reporting a failed auto-login.
    if (isRemoteRequest(req) || currentLoopbackPeerIsForeign()) {
      return Response.json({ user: null, autoLogin: false, available: [] });
    }

    try {
      const user = await getSessionUserOrDefault(req.headers);
      let available: Awaited<ReturnType<typeof listUsers>> = [];
      try {
        available = await listUsers();
      } catch (err) {
        console.error('[auth/me] listUsers threw (non-fatal):', err);
      }
      // Auto-establish a real session for passwordless users so endpoints
      // that strictly require a session cookie don't 401 on first paint —
      // but only for cookie-capable callers. A caller presenting an
      // Authorization header (the desktop webview's sys:http bridge injects
      // the loopback superuser bearer; agent/CLI tools present their own)
      // has no cookie jar, so the Set-Cookie can never come back and every
      // mint is an orphan user_sessions row (EI-338: 6.5k single-use rows
      // from webview boots).
      const headers: Record<string, string> = {};
      if (!user.has_password && !req.headers.get('authorization')) {
        try {
          const result = await login(user.username, null, {
            user_agent: req.headers.get('user-agent') ?? undefined,
            remote_addr: req.headers.get('x-forwarded-for') ?? '127.0.0.1',
          });
          headers['set-cookie'] = serializeSetCookie(SESSION_COOKIE, result.token, {
            httpOnly: true,
            sameSite: 'Lax',
            path: '/',
            maxAge: Math.floor(DEFAULT_SESSION_TTL_MS / 1000),
            secure: requestNeedsSecureCookie(req),
          });
        } catch (err) {
          console.error('[auth/me] auto-session establish failed (non-fatal):', err);
        }
      }
      return Response.json({ user, autoLogin: true, available }, { headers });
    } catch (err) {
      // Fall back to a synthetic default user so the chrome UI still
      // renders. Surface what actually broke in the operator log.
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[auth/me] getSessionUserOrDefault failed — returning synthetic default with reason:', reason, err);
      return Response.json({
        user: {
          id: '00000000-0000-0000-0000-000000000001',
          username: 'default',
          display_name: 'User',
          has_password: false,
        },
        autoLogin: true,
        available: [],
        degraded: true,
        degradedReason: reason,
        // Deprecated alias kept for one cycle so any existing client
        // checks against `pgUnavailable` keep working.
        pgUnavailable: true,
      });
    }
  },
});

const patch = defineTool({
  method: 'PATCH',
  path: '/auth/me',
  // loopback (not public): the cookie-less desktop webview (EI-338) presents a
  // loopback Host, so this tier admits it while blocking off-box callers — and
  // the default-user fallback below is then only reachable from the local box.
  auth: 'loopback',
  async handler(req) {
    // Belt-and-suspenders against a cross-origin browser page POSTing to the
    // loopback port (the Host check alone can't see Origin).
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    // Default-user fallback, matching GET above: the desktop webview is
    // cookie-less (EI-338), so a strict session check left display-name
    // editing permanently broken on desktop installs.
    const user = await getSessionUserOrDefault(req.headers);
    const body = await req.json().catch(() => null);
    const display_name = typeof body?.display_name === 'string' ? body.display_name.trim() : '';
    if (!display_name) {
      return Response.json({ error: 'display_name_required' }, { status: 400 });
    }
    if (display_name.length > 80) {
      return Response.json({ error: 'display_name_too_long' }, { status: 400 });
    }
    await updateDisplayName(user.id, display_name);
    return Response.json({ ok: true });
  },
});

export default [get, patch];
