/**
 * Provider-neutral hosted browser authentication routes.
 *
 * These routes are dependency-injected and are intentionally not added to the
 * local ALL_ROUTES barrel here. The hosted host/profile integration owns that
 * explicit registration. Local sessions and wildcard authority never cross
 * this module: the browser cookie contains only an HMAC-signed opaque hosted
 * session id, and current permissions are derived by later authorization code.
 */
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { defineTool, type RouteDefinition } from '@papercusp/tooldef/define-tool';
import {
  HostedSessionCookieCodec,
  type CreateHostedSessionInput,
  type HostedSession,
  type HostedSessionStore,
} from '../../../auth/hosted-session';
import {
  type HostedIdentityProvider,
  type HostedIdentityProviderError,
  type HostedVerifiedIdentity,
  type HostedVerifiedIdentitySession,
} from '../../../auth/hosted/provider';
import { readCookie, serializeDeleteCookie, serializeSetCookie } from '../../cookies';
import { OAuthHostedAuthFlowStore, type HostedAuthFlow, type HostedAuthFlowStore } from './flow';
import type {
  HostedSelfSignupAdmission,
  HostedSelfSignupInput,
} from '../../../auth/hosted/self-signup';
import {
  HOSTED_SELF_SIGNUP_PRIVACY_VERSION,
  HOSTED_SELF_SIGNUP_TERMS_VERSION,
} from '../../../auth/hosted/self-signup';

/**
 * How long a hosted session lasts from sign-in.
 *
 * Deliberately NOT the identity provider's access-token expiry, which it used to be:
 * WorkOS access tokens live about five minutes, so every hosted sign-in ended five
 * minutes later (measured on the owner's account 2026-09-23). The provider stays the
 * authority on whether the person is still signed in — its revocation webhook ends our
 * session, and the session route renews the token with the refresh token and ends ours
 * when WorkOS refuses — so this is only the ceiling on a session nobody revoked.
 */
export const HOSTED_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

export const HOSTED_AUTH_FLOW_COOKIE = '__Secure-papercusp_hosted_auth_flow';
export const HOSTED_AUTH_CALLBACK_ROUTE = '/hosted/auth/callback';
export const HOSTED_AUTH_CALLBACK_PATH = `/api${HOSTED_AUTH_CALLBACK_ROUTE}`;

/** Stable manifest consumed by the later hosted-profile integration item. */
export const HOSTED_AUTH_ROUTES = [
  { method: 'GET', path: '/hosted/auth/sign-in', access: 'public' },
  { method: 'GET', path: HOSTED_AUTH_CALLBACK_ROUTE, access: 'public' },
  { method: 'POST', path: '/hosted/auth/logout', access: 'authenticated' },
  { method: 'GET', path: '/hosted/auth/session', access: 'authenticated' },
] as const;

export interface HostedIdentityBinding {
  readonly userId: string;
  readonly organizationId: string;
  readonly workspaceId?: string | null;
  /** Snapshot only. The session never stores the permission set itself. */
  readonly permissionVersion: number;
}

export interface BindHostedIdentityInput {
  readonly providerId: string;
  readonly externalOrganizationId?: string;
  readonly identity: HostedVerifiedIdentity;
}

export type BindHostedIdentity = (input: BindHostedIdentityInput) => Promise<HostedIdentityBinding | null>;

export type HostedAuthSessionStore = Pick<HostedSessionStore, 'create' | 'resolve' | 'revoke'>;

export interface HostedAuthRouteDependencies {
  readonly provider: HostedIdentityProvider;
  readonly bindIdentity: BindHostedIdentity;
  readonly sessionStore: HostedAuthSessionStore;
  readonly sessionCookieCodec: HostedSessionCookieCodec;
  /** Exact externally reachable HTTPS origin, for example https://app.papercusp.com. */
  readonly publicOrigin: string;
  readonly flowStore?: HostedAuthFlowStore;
  /** Explicit public-account admission; never used by ordinary sign-in. */
  readonly selfSignup?: HostedSelfSignupAdmission;
  readonly clock?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
}

type AnyRoute = RouteDefinition<any>;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function publicHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('hosted_auth_public_origin_must_be_an_exact_https_origin');
  }
  return url.origin;
}

/** Accept only an origin-relative browser target; never a scheme-relative URL. */
export function safeHostedReturnTarget(value: unknown, origin: string): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\r\n\0]/.test(value)
  ) {
    return null;
  }
  try {
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function randomToken(random: (size: number) => Uint8Array, size = 32): string {
  const bytes = Buffer.from(random(size));
  if (bytes.byteLength < size) throw new Error('hosted_auth_entropy_source_returned_too_few_bytes');
  return bytes.toString('base64url');
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function equalDigest(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function flowCookie(value: string): string {
  return serializeSetCookie(HOSTED_AUTH_FLOW_COOKIE, value, {
    httpOnly: true,
    sameSite: 'Lax',
    path: HOSTED_AUTH_CALLBACK_PATH,
    secure: true,
  });
}

function deleteFlowCookie(): string {
  return serializeDeleteCookie(HOSTED_AUTH_FLOW_COOKIE, HOSTED_AUTH_CALLBACK_PATH, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
  });
}

function jsonError(code: string, safeMessage: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ ok: false, error: { code, safeMessage } }, { status, headers });
}

function providerErrorStatus(error: HostedIdentityProviderError): number {
  if (error.code === 'rate_limited') return 429;
  if (error.code === 'provider_unavailable' || error.code === 'provider_error' || error.code === 'configuration_error')
    return 503;
  if (error.code === 'invalid_session' || error.code === 'session_expired' || error.code === 'session_revoked')
    return 401;
  return 400;
}

function providerErrorResponse(error: HostedIdentityProviderError, headers?: Headers): Response {
  const responseHeaders = new Headers(headers);
  if (error.retryAfterMs !== undefined) {
    responseHeaders.set('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))));
  }
  return Response.json(
    {
      ok: false,
      error: {
        code: error.code,
        safeMessage: error.safeMessage,
        retryable: error.retryable,
        ...(error.providerCode ? { providerCode: error.providerCode } : {}),
        ...(error.requestId ? { requestId: error.requestId } : {}),
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      },
    },
    { status: providerErrorStatus(error), headers: responseHeaders },
  );
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function callbackErrorRedirect(origin: string, returnTo: string, code: string): Response {
  const target = new URL(returnTo, origin);
  target.searchParams.set('hosted_auth_error', code);
  return redirect(target.toString(), [deleteFlowCookie()]);
}

/**
 * Recover to the public portal when the provider callback omitted state.
 *
 * We cannot safely recover the original return target without a valid flow
 * state, so this deliberately falls back to `/`. The callback remains
 * fail-closed (no code exchange and no session creation), while the portal
 * gets a navigable error signal from which it can offer the unified
 * sign-in/sign-up entry point instead of exposing a dead-end JSON response.
 */
function callbackRecoveryRedirect(origin: string, code: string): Response {
  const target = new URL('/', origin);
  target.searchParams.set('hosted_auth_error', code);
  target.searchParams.set('hosted_auth_recovery', '1');
  // Every hosted-auth callback failure exits through here as a 303 back to '/',
  // which is indistinguishable IN THE BROWSER from an ordinary bounce to the
  // sign-in page. Until this line existed the route emitted NO server-side
  // output at all (measured 2026-09-22: zero logging call sites in this file),
  // so a real user-reported signup failure left no trace in any log or table —
  // the refusal code was only ever visible in the user's own address bar.
  // Keep this: it is the sole observability seam for state_required,
  // signup_unavailable, signup_<code> and membership_required.
  console.warn(
    `[hosted-auth] callback recovery redirect code=${code} origin=${origin}`,
  );
  return redirect(target.toString(), [deleteFlowCookie()]);
}

/**
 * The callback's 503 exits swallow their cause so nothing internal reaches the
 * browser — which left the server blind too: the owner's `session_create_failed`
 * on 2026-09-23 was diagnosable only from the Postgres server log. Log the code
 * and the cause's message (a driver/constraint message, never a token).
 */
function logCallbackFailure(code: string, cause: unknown): void {
  console.warn(
    `[hosted-auth] callback failed code=${code} cause=${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

function validProviderRedirect(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function validIdentitySession(value: HostedVerifiedIdentitySession, nowMs: number): boolean {
  return (
    nonEmpty(value.externalSessionId) &&
    nonEmpty(value.identity?.externalUserId) &&
    nonEmpty(value.identity?.primaryEmail) &&
    value.identity.emailVerified === true &&
    Number.isFinite(value.expiresAtMs) &&
    value.expiresAtMs > nowMs
  );
}

function validBinding(value: HostedIdentityBinding): boolean {
  return (
    nonEmpty(value.userId) &&
    nonEmpty(value.organizationId) &&
    (value.workspaceId == null || nonEmpty(value.workspaceId)) &&
    Number.isSafeInteger(value.permissionVersion) &&
    value.permissionVersion >= 0
  );
}

function validAdmittedSession(
  session: HostedSession,
  binding: HostedIdentityBinding,
  upstream: HostedVerifiedIdentitySession,
  providerId: string,
  expiresAt: Date,
): boolean {
  return (
    session.id.length > 0 &&
    session.userId === binding.userId &&
    session.organizationId === binding.organizationId &&
    (session.workspaceId ?? null) === (binding.workspaceId ?? null) &&
    session.permissionVersion === binding.permissionVersion &&
    session.upstreamProvider === providerId &&
    session.upstreamSessionId === upstream.externalSessionId &&
    session.expiresAt.getTime() === expiresAt.getTime() &&
    session.revokedAt === null
  );
}

async function revokeUpstreamBestEffort(provider: HostedIdentityProvider, externalSessionId: string): Promise<void> {
  try {
    await provider.revokeSession({ externalSessionId, reason: 'security_event' });
  } catch {
    // The caller is already failing closed; never expose or retain provider secrets.
  }
}

/** Create the four route definitions without mutating the shared route registry. */
export function createHostedAuthRoutes(deps: HostedAuthRouteDependencies): ReadonlyArray<AnyRoute> {
  const origin = publicHttpsOrigin(deps.publicOrigin);
  const callbackUri = `${origin}${HOSTED_AUTH_CALLBACK_PATH}`;
  const clock = deps.clock ?? (() => new Date());
  const random = deps.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  const flowStore = deps.flowStore ?? new OAuthHostedAuthFlowStore(deps.provider.providerId, new URL(origin).host);

  const signIn = defineTool({
    method: 'GET',
    path: '/hosted/auth/sign-in',
    auth: 'public',
    async handler(req) {
      const url = new URL(req.url);
      const requestedReturnTo = url.searchParams.get('returnTo') ?? '/';
      const returnTo = safeHostedReturnTarget(requestedReturnTo, origin);
      if (!returnTo) return jsonError('invalid_return_target', 'The return target is not valid.', 400);

      const intentRaw = url.searchParams.get('intent');
      const intent = intentRaw == null ? 'sign-in' : intentRaw;
      if (intent !== 'sign-in' && intent !== 'sign-up') {
        return jsonError('invalid_sign_in_intent', 'The sign-in intent is not valid.', 400);
      }

      const verifier = randomToken(random);
      const nonce = randomToken(random);
      const browserBinding = randomToken(random);
      const flow: HostedAuthFlow = {
        providerId: deps.provider.providerId,
        intent,
        redirectUri: callbackUri,
        returnTo,
        nonce,
        pkceCodeVerifier: verifier,
        browserBindingDigest: digest(browserBinding),
      };

      let state: string;
      try {
        state = await flowStore.create(flow);
      } catch {
        return jsonError('flow_state_unavailable', 'Sign-in could not be started.', 503);
      }

      let initiated;
      try {
        initiated = await deps.provider.beginSignIn({
          redirectUri: callbackUri,
          state,
          nonce,
          pkce: {
            challenge: digest(verifier),
            method: 'S256',
          },
          intent,
        });
      } catch {
        return jsonError('provider_unavailable', 'The identity provider is unavailable.', 503);
      }
      if (!initiated.ok) return providerErrorResponse(initiated.error);
      const authorizationUrl = validProviderRedirect(initiated.value.authorizationUrl);
      if (!authorizationUrl) {
        return jsonError('invalid_authorization_url', 'The identity provider returned an invalid redirect.', 502);
      }

      const headers = new Headers({ location: authorizationUrl });
      headers.append('set-cookie', flowCookie(browserBinding));
      return new Response(null, { status: 302, headers });
    },
  });

  const callback = defineTool({
    method: 'GET',
    path: HOSTED_AUTH_CALLBACK_ROUTE,
    auth: 'public',
    async handler(req) {
      const url = new URL(req.url);
      const state = url.searchParams.get('state') ?? '';
      if (!state) {
        return callbackRecoveryRedirect(origin, 'state_required');
      }

      let consumed;
      try {
        consumed = await flowStore.consume(state);
      } catch {
        return jsonError('flow_state_unavailable', 'The sign-in state could not be verified.', 503, {
          'set-cookie': deleteFlowCookie(),
        });
      }
      if (!consumed.ok) {
        return jsonError(`invalid_state_${consumed.error}`, 'The sign-in state is not valid.', 400, {
          'set-cookie': deleteFlowCookie(),
        });
      }
      const flow = consumed.flow;
      const browserBinding = readCookie(req, HOSTED_AUTH_FLOW_COOKIE) ?? '';
      if (
        flow.providerId !== deps.provider.providerId ||
        flow.redirectUri !== callbackUri ||
        !equalDigest(flow.browserBindingDigest, digest(browserBinding))
      ) {
        return jsonError('browser_flow_mismatch', 'The sign-in flow does not match this browser.', 400, {
          'set-cookie': deleteFlowCookie(),
        });
      }
      const returnTo = safeHostedReturnTarget(flow.returnTo, origin);
      if (!returnTo) {
        return jsonError('invalid_return_target', 'The return target is not valid.', 400, {
          'set-cookie': deleteFlowCookie(),
        });
      }

      const providerCallbackError = url.searchParams.get('error');
      if (providerCallbackError) {
        const safeCode = /^[A-Za-z0-9_.-]{1,80}$/.test(providerCallbackError)
          ? providerCallbackError
          : 'provider_rejected';
        return callbackErrorRedirect(origin, returnTo, safeCode);
      }
      const code = url.searchParams.get('code') ?? '';
      if (!code || code.length > 8_192) {
        return jsonError('code_required', 'The authorization code is required.', 400, {
          'set-cookie': deleteFlowCookie(),
        });
      }

      let exchanged;
      try {
        exchanged = await deps.provider.exchangeCallback({
          code,
          redirectUri: callbackUri,
          pkceCodeVerifier: flow.pkceCodeVerifier,
          expectedNonce: flow.nonce,
        });
      } catch {
        return jsonError('provider_unavailable', 'The identity provider is unavailable.', 503, {
          'set-cookie': deleteFlowCookie(),
        });
      }
      if (!exchanged.ok) {
        return providerErrorResponse(
          exchanged.error,
          new Headers({
            'set-cookie': deleteFlowCookie(),
          }),
        );
      }
      const upstream = exchanged.value;
      const now = clock();
      const sessionExpiresAt = new Date(now.getTime() + HOSTED_SESSION_LIFETIME_MS);
      if (!validIdentitySession(upstream, now.getTime())) {
        await revokeUpstreamBestEffort(deps.provider, upstream.externalSessionId);
        return jsonError('invalid_verified_identity', 'The verified identity is not valid.', 502, {
          'set-cookie': deleteFlowCookie(),
        });
      }

      let binding: HostedIdentityBinding | null = null;
      let admittedSession: HostedSession | null = null;
      // Bind an identity the provider already knows. Shared by the `sign-in`
      // intent and by the duplicate-identity sign-up fall-through below, so
      // both reach membership admission through exactly one code path.
      const bindExistingIdentity = async (): Promise<
        { ok: true; binding: HostedIdentityBinding | null } | { ok: false; response: Response }
      > => {
        try {
          return {
            ok: true,
            binding: await deps.bindIdentity({
              providerId: deps.provider.providerId,
              identity: upstream.identity,
              ...(upstream.externalOrganizationId ? { externalOrganizationId: upstream.externalOrganizationId } : {}),
            }),
          };
        } catch (cause) {
          logCallbackFailure('identity_binding_unavailable', cause);
          await revokeUpstreamBestEffort(deps.provider, upstream.externalSessionId);
          return {
            ok: false,
            response: jsonError('identity_binding_unavailable', 'The local identity could not be resolved.', 503, {
              'set-cookie': deleteFlowCookie(),
            }),
          };
        }
      };
      if (flow.intent === 'sign-up') {
        if (!deps.selfSignup) {
          await revokeUpstreamBestEffort(deps.provider, upstream.externalSessionId);
          return callbackRecoveryRedirect(origin, 'signup_unavailable');
        }
        let admitted: Awaited<ReturnType<HostedSelfSignupAdmission['complete']>>;
        try {
          const input: HostedSelfSignupInput = {
            attemptId: state,
            providerId: deps.provider.providerId,
            identity: upstream.identity,
            upstreamSessionId: upstream.externalSessionId,
            sessionExpiresAt,
            // Versions are intentionally fixed at the route seam until the
            // Portal supplies a reviewed terms-version selector.
            termsVersion: HOSTED_SELF_SIGNUP_TERMS_VERSION,
            privacyVersion: HOSTED_SELF_SIGNUP_PRIVACY_VERSION,
            acceptedAt: now,
          };
          admitted = await deps.selfSignup.complete(input);
        } catch (cause) {
          logCallbackFailure('signup_unavailable', cause);
          await revokeUpstreamBestEffort(deps.provider, upstream.externalSessionId);
          return jsonError('signup_unavailable', 'Account creation is temporarily unavailable.', 503, {
            'set-cookie': deleteFlowCookie(),
          });
        }
        if (!admitted.ok) {
          // `duplicate_identity` means the verified identity ALREADY exists —
          // a returning user who clicked "Create account" instead of "Sign in".
          // Refusing it stranded them in a loop: the callback bounced to `/`,
          // the portal's generic recovery copy invited them to create an
          // account again, and the next attempt failed identically. The owner
          // hit this twice (WI-10002367). Treat it as the sign-in it actually
          // is. Admission stays fail-closed: binding an identity never creates
          // membership, so an account without one still reaches
          // `membership_required` below instead of receiving a session.
          if (admitted.code !== 'duplicate_identity') {
            await revokeUpstreamBestEffort(deps.provider, upstream.externalSessionId);
            return callbackRecoveryRedirect(origin, `signup_${admitted.code}`);
          }
          const bound = await bindExistingIdentity();
          if (!bound.ok) return bound.response;
          binding = bound.binding;
        } else {
          binding = admitted.binding;
          admittedSession = admitted.session;
        }
      } else {
        const bound = await bindExistingIdentity();
        if (!bound.ok) return bound.response;
        binding = bound.binding;
      }
      if (!binding || !validBinding(binding)) {
        await revokeUpstreamBestEffort(deps.provider, upstream.externalSessionId);
        // Admission is intentionally still fail-closed: an identity provider
        // sign-up never creates Papercusp membership. Recover in the Portal,
        // though, so a new user gets the enrollment/invitation next step
        // instead of a raw JSON 403 dead end.
        return callbackRecoveryRedirect(origin, 'membership_required');
      }
      if (
        admittedSession &&
        !validAdmittedSession(admittedSession, binding, upstream, deps.provider.providerId, sessionExpiresAt)
      ) {
        await revokeUpstreamBestEffort(deps.provider, upstream.externalSessionId);
        return jsonError('session_create_failed', 'The hosted session could not be created.', 503, {
          'set-cookie': deleteFlowCookie(),
        });
      }

      let session = admittedSession;
      if (!session) {
        try {
          const createInput: CreateHostedSessionInput = {
            userId: binding.userId,
            organizationId: binding.organizationId,
            workspaceId: binding.workspaceId ?? null,
            permissionVersion: binding.permissionVersion,
            upstreamProvider: deps.provider.providerId,
            upstreamSessionId: upstream.externalSessionId,
            expiresAt: sessionExpiresAt,
          };
          session = await deps.sessionStore.create(createInput);
        } catch (cause) {
          logCallbackFailure('session_create_failed', cause);
          await revokeUpstreamBestEffort(deps.provider, upstream.externalSessionId);
          return jsonError('session_create_failed', 'The hosted session could not be created.', 503, {
            'set-cookie': deleteFlowCookie(),
          });
        }
      }

      return redirect(new URL(returnTo, origin).toString(), [
        deps.sessionCookieCodec.serialize(session.id, session.expiresAt, now),
        deleteFlowCookie(),
      ]);
    },
  });

  const logout = defineTool({
    method: 'POST',
    path: '/hosted/auth/logout',
    auth: { capabilities: ['workspace:view'] },
    async handler(req) {
      if (req.headers.get('origin') !== origin) {
        return jsonError('cross_origin_blocked', 'The request origin is not allowed.', 403);
      }
      const body = await req.json().catch(() => null);
      if (body !== null && (typeof body !== 'object' || Array.isArray(body))) {
        return jsonError('invalid_body', 'The request body is not valid.', 400);
      }
      const requestedReturnTo = (body as Record<string, unknown> | null)?.returnTo ?? '/';
      const returnTo = safeHostedReturnTarget(requestedReturnTo, origin);
      if (!returnTo) return jsonError('invalid_return_target', 'The return target is not valid.', 400);

      const headers = new Headers({ 'set-cookie': deps.sessionCookieCodec.delete() });
      const sessionId = deps.sessionCookieCodec.read(req.headers);
      if (!sessionId) {
        return Response.json({ ok: true, returnTo, redirectTo: returnTo, upstreamRevoked: false }, { headers });
      }

      let session: HostedSession | null = null;
      try {
        session = await deps.sessionStore.resolve(sessionId);
        await deps.sessionStore.revoke(sessionId, 'user_logout', clock());
      } catch {
        return jsonError('session_revoke_failed', 'The local session could not be revoked.', 503, headers);
      }
      if (!session) {
        return Response.json({ ok: true, returnTo, redirectTo: returnTo, upstreamRevoked: false }, { headers });
      }

      const postLogoutRedirectUri = new URL(returnTo, origin).toString();
      const [logoutResult, revokeResult] = await Promise.all([
        deps.provider
          .beginLogout({
            externalSessionId: session.upstreamSessionId,
            postLogoutRedirectUri,
          })
          .catch(() => null),
        deps.provider
          .revokeSession({
            externalSessionId: session.upstreamSessionId,
            reason: 'user_logout',
          })
          .catch(() => null),
      ]);
      const logoutUrl = logoutResult?.ok ? validProviderRedirect(logoutResult.value.logoutUrl) : null;
      return Response.json(
        {
          ok: true,
          returnTo,
          redirectTo: logoutUrl ?? returnTo,
          upstreamRevoked: revokeResult?.ok === true,
        },
        { headers },
      );
    },
  });

  const session = defineTool({
    method: 'GET',
    path: '/hosted/auth/session',
    auth: { capabilities: ['workspace:view'] },
    async handler(req) {
      const sessionId = deps.sessionCookieCodec.read(req.headers);
      const clearHeaders = new Headers({ 'set-cookie': deps.sessionCookieCodec.delete() });
      if (!sessionId) {
        return jsonError('session_required', 'A valid hosted session is required.', 401, clearHeaders);
      }

      let local: HostedSession | null;
      try {
        local = await deps.sessionStore.resolve(sessionId);
      } catch {
        return jsonError('session_store_unavailable', 'The hosted session could not be resolved.', 503);
      }
      if (!local || local.upstreamProvider !== deps.provider.providerId) {
        return jsonError('session_invalid', 'The hosted session is not valid.', 401, clearHeaders);
      }

      let validated;
      try {
        validated = await deps.provider.validateSession({
          externalSessionId: local.upstreamSessionId,
        });
      } catch {
        return jsonError('provider_unavailable', 'The identity provider is unavailable.', 503);
      }
      if (!validated.ok) {
        if (!validated.error.retryable) {
          await deps.sessionStore.revoke(sessionId, `upstream_${validated.error.code}`, clock()).catch(() => false);
          return providerErrorResponse(validated.error, clearHeaders);
        }
        return providerErrorResponse(validated.error);
      }

      const upstream = validated.value;
      const now = clock();
      if (upstream.externalSessionId !== local.upstreamSessionId || !validIdentitySession(upstream, now.getTime())) {
        await deps.sessionStore.revoke(sessionId, 'upstream_session_mismatch', now).catch(() => false);
        return jsonError('session_invalid', 'The hosted session is not valid.', 401, clearHeaders);
      }

      return Response.json({
        ok: true,
        identity: {
          externalUserId: upstream.identity.externalUserId,
          primaryEmail: upstream.identity.primaryEmail,
          emailVerified: true,
          ...(upstream.identity.displayName ? { displayName: upstream.identity.displayName } : {}),
          ...(upstream.identity.avatarUrl ? { avatarUrl: upstream.identity.avatarUrl } : {}),
        },
        session: {
          sessionId: local.id,
          userId: local.userId,
          organizationId: local.organizationId,
          workspaceId: local.workspaceId,
          permissionVersion: local.permissionVersion,
          upstreamProvider: local.upstreamProvider,
          issuedAtMs: upstream.issuedAtMs,
          authenticatedAtMs: upstream.authenticatedAtMs,
          // The session's own end. The access token behind it is renewed on each check,
          // so its five-minute expiry says nothing about how long this session lasts.
          expiresAtMs: local.expiresAt.getTime(),
          authenticationMethods: [...upstream.authenticationMethods],
          mfaVerified: upstream.mfaVerified,
        },
      });
    },
  });

  return [signIn, callback, logout, session];
}

/** Named integration seam; deliberately side-effect-free. */
export function configureHostedAuthRoutes(deps: HostedAuthRouteDependencies): ReadonlyArray<AnyRoute> {
  return createHostedAuthRoutes(deps);
}

export default createHostedAuthRoutes;
