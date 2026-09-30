/**
 * Shared helpers for the device-facing `/api/device/*` routes.
 *
 * Ported off the legacy `_hono/mobile.ts` Hono router (Phase E4,
 * endpoint-unification-2026-05-21). The route-stack's auth step resolves
 * the device `Principal` via `requirePrincipal`; the handler reads it off
 * `ctx.principal`.
 *
 * Claim → Principal field map:
 *   claims.sub          → principal.slug        (the device id)
 *   claims.workspace_id → principal.workspaceId
 *   claims.user_email   → principal.label
 */

import type { Principal } from '@papercusp/agent-mcp';
import type { PrincipalRequirements } from '../../../auth/require-principal';
import type { RouteContext } from '../../define-route';
import { currentLoopbackPeerIsForeign } from '../../../auth/loopback-peer-trust';
import { requestIsExternal } from '../../../auth/forwarded-request-trust';

/**
 * Auth gate for a device-JWT route. The route-stack's auth step rejects
 * anything that doesn't resolve to `kind: 'device'`, so the handler can
 * treat `ctx.principal` as a present device principal.
 */
export const DEVICE_AUTH: PrincipalRequirements = { kind: ['device'] };

/**
 * Narrow a device-gated route's principal to non-null. Safe because
 * `DEVICE_AUTH` makes the route-stack throw a 403 before the handler runs
 * if the principal isn't a device — this is just the type-level
 * assertion of that runtime guarantee.
 */
export function devicePrincipal(ctx: RouteContext<unknown>): Principal {
  if (!ctx.principal) {
    throw new Error('device route handler reached without a resolved principal');
  }
  return ctx.principal;
}

/** Loopback host names — for the desktop-only mint-pair-token gate. */
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * True when the request's Host header resolves to a loopback name AND the loopback
 * peer is trusted. WI-10003621: on a hosted workspace host the customer account shares
 * the loopback interface and controls its own Host header, so a foreign loopback peer
 * (socket not owned by the service uid) must not mint desktop pair tokens or list and
 * revoke devices. Off a hosted host the peer verdict is never foreign, so this is the
 * plain Host check it always was.
 */
export function isLoopbackHost(req: Request): boolean {
  if (currentLoopbackPeerIsForeign()) return false;
  // external-app-access P-004 / R-7: a tunnel/relay request never mints desktop
  // pair tokens, whatever Host it presents.
  if (requestIsExternal(req.headers)) return false;
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}
