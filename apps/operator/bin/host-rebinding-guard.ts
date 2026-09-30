/**
 * DNS-rebinding guard for the operator's `/api/*` surface
 * (open-source-release-2026-09-29 P-010).
 *
 * The operator binds loopback and several read routes are `auth: 'public'`
 * (e.g. GET /api/coord/presence, /api/coord/inbox) on the premise that only
 * local processes can reach them. A DNS-rebinding page defeats that premise:
 * `evil.example` re-resolves to 127.0.0.1, the browser treats the operator as
 * same-origin, and a same-origin GET carries NO `Origin` header — so the
 * existing Origin check (which does stop rebinding MUTATIONS) never sees it.
 * The one thing the attacker cannot forge from a browser is the `Host` header:
 * it stays `evil.example:<port>`. So a loopback-bound operator refuses every
 * request whose Host is not a loopback name.
 *
 * Exempt (their own access models apply, and they are not the local-desktop shape):
 *   - PAPERCUSP_ALLOW_REMOTE_ADMIN=1 — the explicit remote opt-in; an off-loopback
 *     bind additionally has to pass assertRemoteAuthReady before it can listen.
 *   - the hosted control-plane and VM-release distribution profiles.
 *   - requests on the external-ingress listener (WI-10004174). A user's own tunnel sends
 *     its PUBLIC Host there, so the guard would refuse every MCP request. The exemption is
 *     safe because that listener holds no local trust (D-015) and serves only the MCP
 *     resource and its OAuth sign-in (external-ingress-paths.ts); the rebinding threat is
 *     a browser page reaching LOCAL trust on the loopback listener, which this does not grant.
 * A request with no Host header at all is allowed: every browser sends one, so its
 * absence identifies a non-browser local client, which rebinding cannot produce.
 */
import type { MiddlewareHandler } from 'hono';
import { currentExternalIngressListener } from '@papercusp/operator-core/lib/auth/forwarded-request-trust';
import { isLoopbackHost } from '@papercusp/operator-core/lib/endpoint-route/loopback-guard';
import { isHostedControlPlaneDistributionProfile } from '@papercusp/operator-core/lib/endpoint-route/hosted-runtime';
import { isVmReleaseDistribution } from '@papercusp/operator-core/lib/vm-release-runtime-policy';

/** RFC 6761: every `*.localhost` name resolves to loopback and cannot be rebound. */
function isLocalhostSubdomain(host: string): boolean {
  const lower = host.trim().toLowerCase();
  const name = lower.startsWith('[') ? lower : lower.split(':')[0] ?? '';
  return name.endsWith('.localhost');
}

/** Whether a request carrying this `Host` header may reach the operator API. */
export function isHostHeaderAllowed(
  host: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.PAPERCUSP_ALLOW_REMOTE_ADMIN === '1') return true;
  if (isHostedControlPlaneDistributionProfile(env) || isVmReleaseDistribution(env)) return true;
  if (host === null || host === undefined || host.trim() === '') return true;
  return isLoopbackHost(host) || isLocalhostSubdomain(host);
}

export const hostRebindingGuard: MiddlewareHandler = async (c, next) => {
  if (currentExternalIngressListener() === null && !isHostHeaderAllowed(c.req.header('host'))) {
    return c.json(
      {
        error: {
          code: 'host_not_allowed',
          message:
            'This operator only answers requests addressed to a loopback host (127.0.0.1 / localhost). '
            + 'Set PAPERCUSP_ALLOW_REMOTE_ADMIN=1 (with PAPERCUSP_BIND_HOST and the remote-auth origins) to serve remote clients.',
        },
      },
      403,
    );
  }
  await next();
};
