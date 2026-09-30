/**
 * POST /api/auth/login — authenticate username + optional password and
 * issue a session cookie. Soft per-IP + hard per-(IP,user) rate gates.
 *
 * Ported from app/api/auth/login/route.ts. `auth: 'public'` — this is
 * the pre-auth endpoint; it establishes the session everything else
 * gates on. Cookie writes are `Set-Cookie` headers (no Next `cookies()`
 * jar); request headers come from `req.headers` (no `next/headers`).
 */
import { login, SESSION_COOKIE, DEFAULT_SESSION_TTL_MS } from '../../../auth';
import {
  checkSoftGlobal,
  refundSoftGlobal,
  checkSoftPerIp,
  refundSoftPerIp,
  checkHardPerAccount,
  burnHardPerAccount,
  resetHardPerAccount,
  checkHardPerUser,
  burnHardPerUser,
  resetHardPerUser,
} from '../../../auth-rate-limit';
import { recordAuthEvent } from '../../../auth-audit';
import { defineTool } from '@papercusp/agent-mcp';
import { serializeSetCookie } from '../../cookies';
import {
  isRemoteRequest,
  REMOTE_OPERATOR_CAPABILITY,
  requestNeedsSecureCookie,
  requestWorkspaceId,
} from '../../../remote-auth-policy';

export default defineTool({
  method: 'POST',
  path: '/auth/login',
  auth: 'public',
  async handler(req, ctx) {
    const body = await req.json().catch(() => null);
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : null;
    const ttl_ms = typeof body?.ttl_ms === 'number' ? body.ttl_ms : DEFAULT_SESSION_TTL_MS;
    const userAgent = req.headers.get('user-agent') ?? undefined;
    const remote = isRemoteRequest(req);
    // RouteContext.peerAddress is captured from the accepted socket by the
    // host adapter. Never use X-Forwarded-For here: direct callers can forge
    // or rotate it, while the socket peer remains transport-derived. The
    // in-process Hono test adapter has no socket, so preserve its local
    // compatibility fallback; an unknown remote peer gets one shared bucket.
    const peerAddress = ctx.peerAddress?.trim() || null;
    const ip = peerAddress ?? (remote ? 'unknown' : '127.0.0.1');
    const workspaceId = requestWorkspaceId(req);

    if (remote && !workspaceId) {
      return Response.json({ error: 'workspace_required' }, { status: 400 });
    }
    if (remote && !password) {
      return Response.json({ error: 'password_required' }, { status: 403 });
    }

    if (!username) {
      // Audit malformed attempts too — missing-username probes shouldn't
      // be invisible just because they error early.
      void recordAuthEvent({
        kind: 'login_failed',
        username: undefined,
        ip, userAgent, ok: false,
        errorCode: 'username_required',
      });
      return Response.json({ error: 'username required' }, { status: 400 });
    }

    // (1) Global abuse budget. Unlike the per-IP bucket, this is not
    //     loopback-exempt: it bounds distributed attempts that rotate source
    //     addresses.
    const globalResult = await checkSoftGlobal().catch(() => ({ ok: true, retryAfterS: undefined as number | undefined }));
    if (!globalResult.ok) {
      void recordAuthEvent({
        kind: 'login_rate_limited',
        username, ip, userAgent, ok: false,
        errorCode: 'global_rate_limited',
        metadata: { retry_after_s: globalResult.retryAfterS },
      });
      return Response.json(
        { error: 'rate_limited', retry_after_s: globalResult.retryAfterS ?? 60 },
        { status: 429 },
      );
    }

    // (2) Soft per-IP gate. Loopback-exempt so single-user desktop installs
    //     never lock themselves out via typos on their own machine.
    const softResult = await checkSoftPerIp(ip).catch(() => ({ ok: true, retryAfterS: undefined as number | undefined }));
    if (!softResult.ok) {
      void recordAuthEvent({
        kind: 'login_rate_limited',
        username, ip, userAgent, ok: false,
        errorCode: 'soft_rate_limited',
        metadata: { retry_after_s: softResult.retryAfterS },
      });
      return Response.json(
        { error: 'rate_limited', retry_after_s: softResult.retryAfterS ?? 60 },
        { status: 429 },
      );
    }

    // (3) Hard per-account gate. Applies across source addresses so rotating
    //     a forged/forwarded address cannot evade the lockout.
    const accountResult = await checkHardPerAccount(username).catch(() => ({ ok: true, retryAfterS: undefined as number | undefined }));
    if (!accountResult.ok) {
      void recordAuthEvent({
        kind: 'login_rate_limited',
        username, ip, userAgent, ok: false,
        errorCode: 'account_locked_out',
        metadata: { retry_after_s: accountResult.retryAfterS },
      });
      return Response.json(
        { error: 'rate_limited', retry_after_s: accountResult.retryAfterS ?? 300 },
        { status: 429 },
      );
    }

    // (4) Hard per-(IP, username) gate. Applies even on loopback —
    //     username-scoped so one bad-actor account can't block the whole
    //     install.
    const hardResult = await checkHardPerUser(ip, username).catch(() => ({ ok: true, retryAfterS: undefined as number | undefined }));
    if (!hardResult.ok) {
      void recordAuthEvent({
        kind: 'login_rate_limited',
        username, ip, userAgent, ok: false,
        errorCode: 'hard_locked_out',
        metadata: { retry_after_s: hardResult.retryAfterS },
      });
      return Response.json(
        { error: 'rate_limited', retry_after_s: hardResult.retryAfterS ?? 300 },
        { status: 429 },
      );
    }

    try {
      const result = await login(username, password, {
        user_agent: userAgent,
        remote_addr: ip,
        ttl_ms,
        workspace_id: workspaceId ?? undefined,
        capabilities: remote ? ['*', REMOTE_OPERATOR_CAPABILITY] : ['*'],
        remote,
      });
      // Refund the soft bucket so an earlier-failed typo isn't held
      // against the legitimate user. Reset the hard bucket so the
      // 5-strike counter clears on success.
      await refundSoftGlobal().catch(() => { /* best-effort */ });
      await refundSoftPerIp(ip).catch(() => { /* best-effort */ });
      await resetHardPerAccount(username).catch(() => { /* best-effort */ });
      await resetHardPerUser(ip, username).catch(() => { /* best-effort */ });
      void recordAuthEvent({
        kind: 'login_ok',
        username, ip, userAgent, ok: true,
        sessionToken: result.token,
      });
      return Response.json(
        { ok: true, user: result.user },
        {
          headers: {
            'set-cookie': serializeSetCookie(SESSION_COOKIE, result.token, {
              httpOnly: true,
              sameSite: 'Strict',
              path: '/',
              expires: result.expires_at,
              secure: requestNeedsSecureCookie(req),
            }),
          },
        },
      );
    } catch (e: unknown) {
      const code = (e as { code?: string }).code ?? 'login_failed';
      const status = code === 'unknown_user' || code === 'bad_password'
        ? 401
        // WI-10003621: a foreign loopback peer on a hosted host may not log in at all.
        : code === 'foreign_loopback_peer' ? 403 : 400;
      if (status >= 500) console.error('[auth/login]', code, (e as Error).stack);
      // Failure burns both hard counters. (Soft buckets are already burned
      // by checkSoftGlobal/checkSoftPerIp.)
      await burnHardPerAccount(username).catch(() => { /* best-effort */ });
      await burnHardPerUser(ip, username).catch(() => { /* best-effort */ });
      void recordAuthEvent({
        kind: code === 'bad_password' ? 'login_bad_password' :
              code === 'unknown_user' ? 'login_unknown_user' :
              'login_failed',
        username, ip, userAgent, ok: false,
        errorCode: code,
      });
      return Response.json({ error: code }, { status });
    }
  },
});
