/**
 * Native remote-operator exposure policy.
 *
 * Loopback remains the zero-config default (including an SSH local forward).
 * An off-loopback listener is accepted only when the existing remote-admin
 * opt-in is accompanied by an exact HTTPS browser-origin allowlist.  This
 * turns PAPERCUSP_ALLOW_REMOTE_ADMIN from a request-time bypass into one part
 * of a complete, fail-fast listener contract.
 */
import { isLoopbackHost } from './endpoint-route/loopback-guard';
import { resolveBindHost } from './resolve-bind-host';

export const REMOTE_ORIGINS_ENV = 'PAPERCUSP_REMOTE_ORIGINS';
export const REMOTE_OPERATOR_CAPABILITY = 'operator:remote';

export interface RemoteAuthPolicy {
  remote: boolean;
  origins: readonly string[];
}

function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Exact, canonical HTTPS origins configured for direct remote browsers. */
export function configuredRemoteOrigins(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const values = (env[REMOTE_ORIGINS_ENV] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const origins: string[] = [];
  for (const value of values) {
    const origin = canonicalOrigin(value);
    if (!origin) {
      throw new Error(
        `${REMOTE_ORIGINS_ENV} entries must be exact HTTPS origins without paths, credentials, query strings, or fragments (invalid: ${value})`,
      );
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/** Fail before listen when an off-loopback bind lacks a complete auth policy. */
export function assertRemoteAuthReady(
  bindHost: string,
  env: NodeJS.ProcessEnv = process.env,
): RemoteAuthPolicy {
  if (isLoopbackHost(bindHost)) return { remote: false, origins: [] };
  if (env.PAPERCUSP_ALLOW_REMOTE_ADMIN !== '1') {
    throw new Error(
      `Refusing off-loopback bind ${bindHost}: set PAPERCUSP_ALLOW_REMOTE_ADMIN=1 only together with ${REMOTE_ORIGINS_ENV}.`,
    );
  }
  const origins = configuredRemoteOrigins(env);
  if (origins.length === 0) {
    throw new Error(
      `Refusing off-loopback bind ${bindHost}: ${REMOTE_ORIGINS_ENV} must contain at least one exact HTTPS origin.`,
    );
  }
  return { remote: true, origins };
}

/** Resolve and validate the policy for the listener this process will use. */
export function currentRemoteAuthPolicy(
  env: NodeJS.ProcessEnv = process.env,
): RemoteAuthPolicy {
  return assertRemoteAuthReady(resolveBindHost(env), env);
}

/** Whether an Origin is one of the configured direct-remote browser origins. */
export function isConfiguredRemoteOrigin(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    return configuredRemoteOrigins(env).includes(new URL(origin).origin) && new URL(origin).origin === origin;
  } catch {
    return false;
  }
}

/** Explicit request workspace; header wins over the stream-compatible query. */
export function requestWorkspaceId(req: Request): string | null {
  const header = req.headers.get('x-papercusp-workspace')?.trim();
  if (header) return header;
  try {
    return new URL(req.url).searchParams.get('ws')?.trim() || null;
  } catch {
    return null;
  }
}

/** Canonical external HTTPS origin/authority seen by a direct remote browser. */
export function requestExternalOrigin(req: Request): string | null {
  try {
    const url = new URL(req.url);
    const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    const protocol = forwardedProto ?? url.protocol.slice(0, -1).toLowerCase();
    const host = forwardedHost || url.host;
    if (protocol !== 'https' || !host) return null;
    return new URL(`https://${host}`).origin;
  } catch {
    return null;
  }
}

/** Socket-address loopback check, including IPv4-mapped IPv6 addresses. */
export function isLoopbackRemoteAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase().replace(/^::ffff:/, '');
  return isLoopbackHost(normalized);
}

/** True for requests arriving through the direct remote surface. */
export function isRemoteRequest(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!currentRemoteAuthPolicy(env).remote) return false;
  try {
    return !isLoopbackHost(new URL(req.url).host);
  } catch {
    return !isLoopbackHost(req.headers.get('host'));
  }
}

/**
 * A remote listener plus either a non-loopback socket peer or an external
 * request authority is the direct-remote surface. The authority fallback is
 * what keeps reverse-proxy unit contexts testable and catches proxy ingress;
 * an SSH local forward keeps both peer and request authority loopback.
 */
export function isDirectRemoteRequest(
  req: Request,
  remoteAddress?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!currentRemoteAuthPolicy(env).remote) return false;
  if (remoteAddress && !isLoopbackRemoteAddress(remoteAddress)) return true;
  return isRemoteRequest(req, env);
}

/** Remote cookies are always Secure; forwarded HTTPS also opts in explicitly. */
export function requestNeedsSecureCookie(req: Request): boolean {
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwardedProto === 'https') return true;
  try {
    const url = new URL(req.url);
    return url.protocol === 'https:' || !isLoopbackHost(url.host);
  } catch {
    return true;
  }
}
