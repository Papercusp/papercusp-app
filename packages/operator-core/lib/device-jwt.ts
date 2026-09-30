/**
 * Mobile device JWTs. Signed HS256 with MOBILE_JWT_SECRET.
 *
 * Claims shape:
 *   sub:           device_id (uuid)
 *   workspace_id:  bound workspace (matches PG-RLS app.workspace_id GUC)
 *   device_kind:   'mobile' (drives row visibility in libs/zero-harness/queries.ts)
 *   user_email:    optional; set when device is paired with an authenticated session
 *   iat / exp:     standard
 *
 * Secret rotation: change MOBILE_JWT_SECRET, all current device tokens become invalid.
 * Acceptable: phones re-pair via QR. No graceful key rotation in v1.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Resolve the JWT secret lazily, on first use.
 *
 * Module-load throw was breaking `next build`: Next 16's "Collecting page
 * data" phase imports every route's module under `NODE_ENV=production`,
 * including this one — even though the build host doesn't need to *sign*
 * tokens. The throw aborted page-data collection and the build skipped
 * standalone bundle generation. Deferring the check until a token is
 * actually signed/verified keeps the module side-effect-free at import
 * time so build hosts (and any route that imports this transitively but
 * doesn't actually use it) don't need MOBILE_JWT_SECRET.
 */
/**
 * Durability status of the device-JWT signing secret (mobile-apps-revival-v2
 * P-001). Pure — reads env, never memoizes — so a boot hook and the phone
 * connection-health route (P-010) can both call it freely.
 *
 *  - durable:true  source:'env'             — a >=32-char MOBILE_JWT_SECRET is
 *                                             set; device tokens survive
 *                                             restarts/deploys (the ship state).
 *  - durable:false source:'unset-production' — production with no usable secret;
 *                                             signing WILL throw.
 *  - durable:false source:'ephemeral'        — dev with no secret; a random
 *                                             per-process secret is used and
 *                                             every restart silently invalidates
 *                                             all paired devices (phones must
 *                                             re-pair). The silent-invalidation
 *                                             trap this warning exists to expose.
 */
export type MobileJwtSecretStatus =
  | { durable: true; source: 'env' }
  | { durable: false; source: 'unset-production'; reason: string }
  | { durable: false; source: 'ephemeral'; reason: string };

export function mobileJwtSecretStatus(): MobileJwtSecretStatus {
  const s = process.env.MOBILE_JWT_SECRET;
  if (s && s.length >= 32) return { durable: true, source: 'env' };
  if (process.env.NODE_ENV === 'production') {
    return {
      durable: false,
      source: 'unset-production',
      reason:
        'MOBILE_JWT_SECRET is unset or <32 chars in production; device-token signing will throw and mobile pairing is broken.',
    };
  }
  return {
    durable: false,
    source: 'ephemeral',
    reason:
      'MOBILE_JWT_SECRET is unset; using a per-process secret — device tokens will NOT survive an operator restart (paired phones silently stop working until they re-pair). Set MOBILE_JWT_SECRET (>=32 chars) in apps/operator/.env.local to make them durable.',
  };
}

/**
 * Refuse a clustered request host whose workers would each mint a different
 * fallback secret. A per-process fallback is tolerable for a one-process dev
 * server, but in a reuse-port cluster it makes a token valid only on the worker
 * that signed it and turns normal load-balancing into intermittent auth.
 */
export function assertMobileJwtSecretDurableForCluster(workerCount: number): void {
  if (workerCount <= 1) return;
  const status = mobileJwtSecretStatus();
  if (status.durable) return;
  throw new Error(
    `[device-jwt] Refusing to start ${workerCount}-worker host without a durable ` +
      `MOBILE_JWT_SECRET (>=32 chars): per-process fallback secrets make device JWTs ` +
      `intermittently invalid across workers. ${status.reason}`,
  );
}

let _warnedEphemeral = false;

/**
 * Emit the device-JWT durability warning at most once per process. Safe to call
 * eagerly at boot (below) AND lazily on first token use — whichever happens
 * first wins; the guard makes the second call a no-op.
 */
export function warnIfMobileJwtSecretNotDurable(): MobileJwtSecretStatus {
  const status = mobileJwtSecretStatus();
  if (!status.durable && !_warnedEphemeral) {
    _warnedEphemeral = true;
    console.warn(`[device-jwt] ${status.reason}`);
  }
  return status;
}

/** Test-only: reset the memoized secret + the warn-once latch. */
export function __resetDeviceJwtForTest(): void {
  _secret = null;
  _warnedEphemeral = false;
}

let _secret: string | null = null;
function getSecret(): string {
  if (_secret) return _secret;
  const s = process.env.MOBILE_JWT_SECRET;
  if (s && s.length >= 32) {
    _secret = s;
    return _secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('MOBILE_JWT_SECRET must be set (>=32 chars) in production');
  }
  // Dev: derive a stable per-process secret. Rotates on restart — warn once so
  // "my phone silently stopped working after a restart" is diagnosable rather
  // than mysterious.
  warnIfMobileJwtSecretNotDurable();
  _secret = randomBytes(32).toString('base64url');
  return _secret;
}

export interface DeviceClaims {
  sub: string;
  workspace_id: string;
  device_kind: 'mobile';
  user_email?: string;
  iat: number;
  exp: number;
}

const TTL_DAYS = 365;
const TTL_MS = TTL_DAYS * 24 * 3600 * 1000;

const b64 = (b: Buffer | string) =>
  Buffer.from(b).toString('base64url');

export function signDeviceToken(
  partial: Omit<DeviceClaims, 'iat' | 'exp'>,
): string {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claims: DeviceClaims = {
    ...partial,
    iat: now,
    exp: now + Math.floor(TTL_MS / 1000),
  };
  const payload = b64(JSON.stringify(claims));
  const sig = b64(
    createHmac('sha256', getSecret()).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

export function verifyDeviceToken(token: string): DeviceClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  // Fail CLOSED when no signing secret is available (production without
  // MOBILE_JWT_SECRET): getSecret() throws there, and a throw from a verifier
  // turns an attacker-supplied token into an uncaught error in the caller (the
  // mobile voice WS `connection` handler) instead of a refusal (WI-10003621).
  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return null;
  }
  const expected = b64(
    createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: DeviceClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (claims.exp < Math.floor(Date.now() / 1000)) return null;
  if (claims.device_kind !== 'mobile') return null;
  return claims;
}

// The `deviceAuth()` Hono middleware was deleted in Phase E5
// (endpoint-unification-2026-05-21) along with `_hono/mobile.ts`. The
// device JWT is now resolved by `requirePrincipal` via the
// `principalFromDeviceJwt` resolver, which carries the same
// signature-verify + `isRevoked` check the middleware did.
// `signDeviceToken` / `verifyDeviceToken` above remain — the resolver
// and the `/device/*` `defineTool`s use them.
