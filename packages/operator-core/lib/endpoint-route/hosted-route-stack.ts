/**
 * The hosted control plane's route stack.
 *
 * `route-stack.ts`'s `authStep` hardcodes the LOCAL principal chain —
 * `requirePrincipal` (cookie session → device JWT → superuser bearer → agent
 * bearer → loopback) plus `principalFromCookie` for the remote-operator gate.
 * Every one of those can carry local or wildcard authority, and
 * `requirePrincipal` explicitly honours a `'*'` capability. None of that may be
 * reachable from app.papercusp.com.
 *
 * So the hosted profile does not broaden the local auth step; it REPLACES it.
 * This module swaps exactly one step and inherits `input` and `invoke`
 * unchanged from the default stack, so future changes to body parsing,
 * timeouts, telemetry and census attribution apply to hosted routes
 * automatically and cannot drift apart.
 *
 * The replacement step admits a request on exactly one path: a valid hosted
 * session cookie resolving to a live session and a currently-active
 * organization membership whose derived permissions include every capability
 * the route declares.
 */
import type { ZodTypeAny } from 'zod';
import type {
  HostedPrincipalDenialReason,
  HostedPrincipalResolver,
} from '../auth/hosted-principal-resolver';
import { isHostedPermission } from '../auth/hosted-principal';
import type { RouteDefinition } from './define-route';
import { DEFAULT_ROUTE_STACK, type RouteExecution, type RouteStep } from './route-stack';

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * HTTP status per denial reason.
 *
 * 401 means "authenticate again" — the browser should restart the hosted
 * sign-in flow. 403 means "authenticated, but not permitted" — re-authenticating
 * would change nothing, and telling the caller otherwise sends them into a
 * sign-in loop. `authority_unavailable` is 503 because it is our fault, not the
 * caller's, and must never be cached or retried as a permission failure.
 */
const DENIAL_STATUS: Readonly<Record<HostedPrincipalDenialReason, 401 | 403 | 503>> = Object.freeze({
  session_cookie_missing: 401,
  session_not_found: 401,
  session_permission_version_stale: 401,
  membership_not_active: 403,
  session_organization_mismatch: 403,
  workspace_not_in_organization: 403,
  authority_unavailable: 503,
});

function statusLabel(status: number): RouteExecution['status'] {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  return 'error';
}

/**
 * Capabilities a hosted route may require.
 *
 * Enforced at dispatch as well as at mount: `hosted-profile.ts` already refuses
 * to allowlist a route requiring `'*'` or no concrete capability, and this is
 * the second lock on the same door — a route reaching this stack by any other
 * mounting path still cannot be satisfied by a wildcard.
 */
function requiredCapabilities(def: RouteDefinition<ZodTypeAny | undefined>): {
  ok: true;
  capabilities: readonly string[];
} | { ok: false; message: string } {
  const auth = def.auth;
  if (typeof auth !== 'object' || auth === null) {
    return { ok: false, message: 'hosted route must declare capability requirements' };
  }
  const capabilities = auth.capabilities ?? [];
  if (capabilities.length === 0) {
    return { ok: false, message: 'hosted route must require at least one concrete capability' };
  }
  for (const capability of capabilities) {
    if (capability === '*') {
      return { ok: false, message: 'wildcard capability is not grantable in the hosted profile' };
    }
    if (!isHostedPermission(capability)) {
      return { ok: false, message: `unknown hosted permission: ${capability}` };
    }
  }
  return { ok: true, capabilities };
}

/**
 * Build the hosted `auth` step around a principal resolver.
 *
 * Exported for focused tests; production callers use `createHostedRouteStack`.
 */
export function createHostedAuthStep(resolve: HostedPrincipalResolver): RouteStep {
  return {
    name: 'auth',
    async run(exec) {
      const auth = exec.def.auth;

      if (auth === 'public') {
        exec.principal = null;
        return null;
      }

      // A loopback declaration is meaningless on an internet-facing control
      // plane: there is no trustworthy loopback. The profile allowlist cannot
      // admit one, and if a route arrives here declaring it, deny rather than
      // silently treat it as public.
      if (auth === 'loopback') {
        exec.status = 'forbidden';
        return errorResponse(403, 'forbidden', 'loopback routes are not mounted in the hosted profile');
      }

      const required = requiredCapabilities(exec.def);
      if (!required.ok) {
        exec.status = 'forbidden';
        return errorResponse(403, 'forbidden', required.message);
      }

      const resolution = await resolve(exec.req.headers);
      if (!resolution.ok) {
        const status = DENIAL_STATUS[resolution.reason];
        exec.status = statusLabel(status);
        return errorResponse(
          status,
          status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'authority_unavailable',
          resolution.reason,
        );
      }

      const principal = resolution.principal;
      for (const capability of required.capabilities) {
        // Deliberately no `capabilities.has('*')` escape — that check is what
        // makes the local gate wildcard-satisfiable, and it is the single line
        // this stack exists to omit.
        if (!principal.capabilities.has(capability as never)) {
          exec.status = 'forbidden';
          return errorResponse(403, 'forbidden', `missing permission: ${capability}`);
        }
      }

      if (auth.trust && auth.trust.length > 0 && !auth.trust.includes(principal.trust)) {
        exec.status = 'forbidden';
        return errorResponse(403, 'forbidden', `trust ${principal.trust} not in allowlist`);
      }
      if (auth.kind && auth.kind.length > 0 && !auth.kind.includes(principal.kind)) {
        exec.status = 'forbidden';
        return errorResponse(403, 'forbidden', `kind ${principal.kind} not in allowlist`);
      }

      exec.principal = principal;
      return null;
    },
  };
}

/**
 * The hosted stack: the hosted `auth` step, then `input` and `invoke` exactly
 * as the default stack defines them.
 *
 * Derived from `DEFAULT_ROUTE_STACK` rather than re-listing the steps so the
 * two cannot diverge; the filter is asserted in tests to have removed exactly
 * the local auth step.
 */
export function createHostedRouteStack(
  resolve: HostedPrincipalResolver,
): ReadonlyArray<RouteStep> {
  return Object.freeze([
    createHostedAuthStep(resolve),
    ...DEFAULT_ROUTE_STACK.filter((step) => step.name !== 'auth'),
  ]);
}
