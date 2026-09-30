/**
 * Composite Principal resolver — replaces the 30+ ad-hoc isLoopback()
 * patterns scattered across `apps/operator/app/api/**` with one typed gate.
 *
 * Resolution order (first non-null wins):
 *   1. cookie session   — `kind: 'user'`,    `trust: 'verified'`
 *   2. app key          — `kind: 'service'`, `trust: 'verified'` (`pcapp_…` bearer)
 *   3. device JWT       — `kind: 'device'`,  `trust: 'verified'`
 *   4. superuser bearer — `kind: 'system'`,  `trust: 'trusted'`
 *   5. agent bearer     — `kind: 'system'|'pi'`, `trust: 'trusted'` (token_index)
 *   6. loopback         — `kind: 'loopback'`,`trust: 'unverified-loopback'`
 *
 * Order matters: a request with both a session cookie AND a superuser
 * bearer presents as a user session (cookies are first-class; the
 * superuser bearer is the escape hatch when cookies are absent).
 *
 * An app key is TERMINAL when presented: a `pcapp_…` bearer that does not
 * verify (unknown, wrong secret, revoked, paused, expired) is a 401, never a
 * fall-through to the resolvers below it. Falling through would let a bad key
 * relayed to a local listener pick up loopback trust (plan D-015).
 *
 * Requirements (`reqs`) gate the resolved principal further. Any failed
 * requirement throws `PrincipalCheckError` with an HTTP status the route
 * shim can lift into a Response:
 *   - no principal at all       → 401 unauthorized
 *   - `trust` not in allowed    → 403 forbidden
 *   - `kind` not in allowed     → 403 forbidden
 *   - missing capability        → 403 forbidden
 *
 * Phase 3b step 2 (principal-rfc-2026-05-20.md §5f).
 */

import type { Principal, PrincipalKind, PrincipalTrust, PrincipalRequirements } from '@papercusp/agent-mcp';
import { principalFromCookie } from './principal/from-cookie';
import { principalFromDeviceJwt } from './principal/from-device-jwt';
import { principalFromSuperuserToken } from './principal/from-superuser-token';
import { principalFromBearerToken } from './principal/from-bearer-token';
import { principalFromLoopback } from './principal/from-loopback';
import { resolveAppKeyPrincipal } from '../connected-apps/principal';

// Re-export so existing app-side imports (`import { PrincipalRequirements } from './require-principal'`)
// keep working. Canonical home is `@papercusp/agent-mcp` so the endpoint primitive
// can reference it without the app→package inversion. Phase E1
// (endpoint-unification-2026-05-21).
export type { PrincipalRequirements };

export class PrincipalCheckError extends Error {
  override readonly name = 'PrincipalCheckError';
  constructor(
    readonly status: 401 | 403,
    readonly reason: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(reason);
  }
}

/**
 * Resolve the principal from a request. Throws `PrincipalCheckError` when
 * the request fails auth or the resolved principal fails the requirements
 * — never returns null. The route's `catch` (or the route-stack `auth`
 * step) lifts the error into a typed 401/403 response.
 *
 * The cookie resolver reads the session cookie from the passed `headers`
 * (no `next/headers` dependency). Pass any `Headers`: a `Request`'s, the
 * Hono Context's `.req.raw.headers`, or `new Headers({...})` in tests.
 */
export async function requirePrincipal(
  headers: Headers,
  reqs: PrincipalRequirements = {},
): Promise<Principal> {
  const cookiePrincipal = await principalFromCookie(headers);
  const appKey = cookiePrincipal ? null : await resolveAppKeyPrincipal(headers);
  if (appKey && !appKey.ok) {
    throw new PrincipalCheckError(401, `app key refused: ${appKey.reason}`, {
      headers: headerSnapshot(headers),
    });
  }
  const principal =
    cookiePrincipal ??
    appKey?.principal ??
    (await principalFromDeviceJwt(headers)) ??
    principalFromSuperuserToken(headers) ??
    (await principalFromBearerToken(headers)) ??
    principalFromLoopback(headers);

  if (!principal) {
    throw new PrincipalCheckError(401, 'no principal resolved', { headers: headerSnapshot(headers) });
  }

  if (reqs.trust && reqs.trust.length > 0 && !reqs.trust.includes(principal.trust)) {
    throw new PrincipalCheckError(403, `trust ${principal.trust} not in allowlist`, {
      allowed: [...reqs.trust],
      actual: principal.trust,
    });
  }

  if (reqs.kind && reqs.kind.length > 0 && !reqs.kind.includes(principal.kind)) {
    throw new PrincipalCheckError(403, `kind ${principal.kind} not in allowlist`, {
      allowed: [...reqs.kind],
      actual: principal.kind,
    });
  }

  if (reqs.capabilities) {
    for (const cap of reqs.capabilities) {
      if (!principal.capabilities.has(cap) && !principal.capabilities.has('*')) {
        throw new PrincipalCheckError(403, `missing capability: ${cap}`, {
          required: [...reqs.capabilities],
          have: [...principal.capabilities],
        });
      }
    }
  }

  return principal;
}

/**
 * Test-only convenience: resolve a principal with no requirements, return
 * null instead of throwing on missing auth. Lets test harnesses probe
 * which resolver fires without setting up the error boundary.
 */
export async function tryResolvePrincipal(headers: Headers): Promise<Principal | null> {
  const cookiePrincipal = await principalFromCookie(headers);
  if (cookiePrincipal) return cookiePrincipal;
  // A presented app key decides the outcome on its own — see requirePrincipal.
  const appKey = await resolveAppKeyPrincipal(headers);
  if (appKey) return appKey.ok ? appKey.principal : null;
  return (
    (await principalFromDeviceJwt(headers)) ??
    principalFromSuperuserToken(headers) ??
    (await principalFromBearerToken(headers)) ??
    principalFromLoopback(headers)
  );
}

function headerSnapshot(headers: Headers): Record<string, string> {
  // Capture only the headers an auth audit needs; never the full set.
  const out: Record<string, string> = {};
  const host = headers.get('host');
  if (host) out.host = host;
  const auth = headers.get('authorization');
  if (auth) out.authPrefix = auth.slice(0, 12) + '…';
  return out;
}
