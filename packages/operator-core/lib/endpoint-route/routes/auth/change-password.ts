/**
 * POST /api/auth/change-password — change the current user's password
 * and re-issue a session (changePassword invalidates all sessions).
 *
 * Ported from app/api/auth/change-password/route.ts. `auth: 'loopback'` —
 * resolves the user with the seeded-`default`-user fallback: the desktop
 * webview is cookie-less (EI-338), so a strict session check left the
 * change-password form permanently 401 on desktop installs. Safe because
 * `changePassword` independently verifies the CURRENT password before
 * changing it (bad_password path) — a caller without the old password
 * still can't take over the account.
 *
 * EI-347: that "safe because current-password is verified" claim is FALSE for
 * the freshly-seeded `default` user specifically — its `password_hash` is NULL,
 * and `changePassword` skips the current-password check entirely in that state
 * (there is no current password to check). Loopback binding narrows the caller
 * to local processes, but "local process" is not "the app's own operator" — any
 * local caller could otherwise permanently claim the unconfigured account. When
 * the target has no password yet, this now ALSO requires `setupToken` (see
 * `auth-setup-token.ts`) — a random value printed to the operator's own console
 * at boot, which a caller with mere network reachability to the loopback port
 * cannot read. Once a password is set this extra gate no longer applies (the
 * normal current-password check is back in force for that account).
 */
import { getSessionUserOrDefault, changePassword, login, SESSION_COOKIE } from '../../../auth';
import { verifySetupToken } from '../../../auth-setup-token';
import { recordAuthEvent } from '../../../auth-audit';
import { defineTool } from '@papercusp/agent-mcp';
import { serializeSetCookie } from '../../cookies';
import { requireAllowedOriginOr403 } from '../../cors';
import { requestNeedsSecureCookie } from '../../../remote-auth-policy';

export default defineTool({
  method: 'POST',
  path: '/auth/change-password',
  // loopback (not public): the cookie-less desktop webview (EI-338) presents a
  // loopback Host, so this tier admits it while blocking off-box callers. The
  // current password is still verified by changePassword, and the cross-origin
  // CSRF guard below blocks a foreign browser page on the loopback port.
  auth: 'loopback',
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const userAgent = req.headers.get('user-agent') ?? undefined;
    const ip = req.headers.get('x-forwarded-for') ?? '127.0.0.1';

    const user = await getSessionUserOrDefault(req.headers);
    const body = await req.json().catch(() => null);
    const current = typeof body?.current === 'string' ? body.current : null;
    const next = typeof body?.next === 'string' ? body.next : null;
    const setupToken = typeof body?.setupToken === 'string' ? body.setupToken : null;

    // EI-347: the account has no password yet (current_hash is null), so
    // changePassword's own current-password check is a no-op — require the
    // boot-printed setup token as the ONLY gate standing between a bare
    // loopback-reachable caller and permanently claiming this account.
    if (!user.has_password && !verifySetupToken(setupToken)) {
      void recordAuthEvent({
        kind: 'change_password_failed',
        username: user.username, ip, userAgent, ok: false,
        errorCode: 'setup_token_required',
      });
      return Response.json({ error: 'setup_token_required' }, { status: 403 });
    }

    try {
      await changePassword(user.id, current, next);
      // changePassword invalidates all sessions for the user (including
      // the current cookie). Re-issue a session with the new password so
      // the user stays signed in — without this they'd silently fall to
      // an unauthenticated state on the next /api/auth/me poll.
      const session = await login(user.username, next, {
        user_agent: userAgent,
        remote_addr: ip,
      });
      void recordAuthEvent({
        kind: 'change_password_ok',
        username: user.username, ip, userAgent, ok: true,
        sessionToken: session.token,
      });
      return Response.json(
        { ok: true },
        {
          headers: {
            'set-cookie': serializeSetCookie(SESSION_COOKIE, session.token, {
              httpOnly: true,
              sameSite: 'Strict',
              path: '/',
              expires: session.expires_at,
              secure: requestNeedsSecureCookie(req),
            }),
          },
        },
      );
    } catch (e: unknown) {
      const code = (e as { code?: string }).code ?? 'failed';
      void recordAuthEvent({
        // bad_password is the "wrong current pw" case; everything else
        // (invalid next, password too short, etc.) is a generic failure.
        kind: code === 'bad_password' ? 'change_password_bad_old' : 'change_password_failed',
        username: user.username, ip, userAgent, ok: false,
        errorCode: code,
      });
      return Response.json({ error: code }, { status: 400 });
    }
  },
});
