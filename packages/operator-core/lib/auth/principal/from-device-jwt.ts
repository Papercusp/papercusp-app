/**
 * Device JWT → Principal resolver.
 *
 * Reads a paired-device JWT from `Authorization: Bearer <token>` (a route
 * whose `auth.tokenIn` allows `'query'` gets the token synthesized into
 * that header upstream in the route-stack), validates the HS256 signature
 * via `verifyDeviceToken`, checks the device has not been revoked, and
 * produces a `Principal` with `kind: 'device'`, `authMethod: 'jwt'`,
 * `trust: 'verified'`.
 *
 * `kind: 'device'` surfaces the device dimension — "device-only" /
 * "desktop-only" gates are real and easier expressed kind-shaped. A
 * device is a phone today, equally a paired CLI / kiosk / second desktop;
 * the credential identifies a device, not a form-factor.
 *
 * Async + revocation-aware: a revoked device must not resolve to a valid
 * principal. The `.catch(() => false)` fail-open on a transient PG error
 * matches the legacy `deviceAuth()` middleware exactly — a DB hiccup must
 * not lock out every paired device.
 */

import type { Principal } from '@papercusp/agent-mcp';
import { verifyDeviceToken } from '../../device-jwt';
import { isRevoked } from '../../device-store';

export async function principalFromDeviceJwt(headers: Headers): Promise<Principal | null> {
  const auth = headers.get('authorization');
  if (!auth) return null;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!token) return null;
  const claims = verifyDeviceToken(token);
  if (!claims) return null;
  // Revocation check — parity with the legacy `deviceAuth()` middleware.
  if (await isRevoked(claims.sub).catch(() => false)) return null;
  return {
    kind: 'device',
    slug: claims.sub,
    workspaceId: claims.workspace_id,
    authMethod: 'jwt',
    trust: 'verified',
    // Paired devices carry a fixed capability set in v1 — a later pass
    // will mint per-device capabilities when the data model supports it.
    capabilities: new Set(['device:*', 'voice:*', 'harness:read']),
    ...(claims.user_email ? { label: claims.user_email } : {}),
  };
}
