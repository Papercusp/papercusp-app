/**
 * Superuser-mode bearer token validation.
 *
 * Loopback alone can't distinguish a user-shell `omp` invocation from a
 * Papercusp-orchestrator-spawned child agent — both run on the same
 * machine, same user, same loopback. So `?superuser=1` requires an
 * additional `Authorization: Bearer <token>` whose value matches the
 * file at `$PAPERCUSP_HOME/superuser-token`, or
 * `~/.papercusp/superuser-token` when no scoped home is set (mode 0600).
 *
 * The CLI installer (`apps/operator/scripts/install-standalone-mcp.sh`)
 * generates the token and writes it to the file; orchestrator-spawned
 * agents never receive the token in their MCP URLs.
 *
 * This is friction, not enforcement: any process running as the same
 * user can read the token file. See plan §"Honest enforcement" — if you
 * want true isolation, run shell-omp under a different OS user.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { currentLoopbackPeerIsForeign } from './auth/loopback-peer-trust';
import { externalIngressReason, forwardedRequestVerdict } from './auth/forwarded-request-trust';

function tokenPath(): string {
  return join(process.env.PAPERCUSP_HOME || join(homedir(), '.papercusp'), 'superuser-token');
}

function loadToken(): string | null {
  try {
    const path = tokenPath();
    // This is an authentication boundary. Do not cache by mtime: a token can
    // be replaced at the same path without a distinguishable mtime update,
    // leaving a long-lived operator process accepting only the old bearer.
    const tok = readFileSync(path, 'utf8').trim();
    if (tok.length < 16) return null; // sanity: refuse short tokens
    return tok;
  } catch {
    return null;
  }
}

/**
 * Read the on-disk superuser bearer token, or null if not yet installed.
 * The single shared reader — `console-launcher` and `buildLaunchSpec`'s
 * `su` branch both use this so the "where's the token" logic (path and
 * short-token sanity) lives in exactly one place.
 */
export function readSuperuserToken(): string | null {
  return loadToken();
}

/** Returns true if the bearer matches the on-disk superuser token. */
export function isValidSuperuserBearer(bearer: string | null | undefined): boolean {
  if (!bearer) return false;
  const expected = loadToken();
  if (!expected) return false;
  const a = Buffer.from(bearer);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Extract the hostname from a `Host` header value, dropping the port.
 * Handles bracketed IPv6 (`[::1]:3070` → `[::1]`), bare IPv6 (`::1`, kept
 * whole — it has no port), and the IPv4/hostname `name:port` form. A naive
 * `split(':')[0]` mangles both IPv6 shapes, which is why the `[::1]`/`::1`
 * loopback branches used to be unreachable.
 */
function hostnameOf(rawHost: string): string {
  const host = rawHost.toLowerCase().trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const colonCount = (host.match(/:/g) ?? []).length;
  return colonCount === 1 ? host.slice(0, host.indexOf(':')) : host;
}

/** Loopback check — refuses superuser unless origin is 127.0.0.1 / ::1 / localhost. */
export function isLoopbackRequest(headers: Headers): boolean {
  // WI-10003619: on a hosted workspace host the loopback interface is shared with
  // the customer account, so an address is not proof of locality. A loopback peer
  // whose socket is not owned by the service uid gets NO loopback trust here — this
  // withdraws the `'*'` principalFromLoopback fallback and every ad-hoc caller at once.
  if (currentLoopbackPeerIsForeign()) return false;
  // external-app-access P-004 / R-7 (D-010): outside traffic — the external-ingress
  // listener, the relay's deny-only marker, an edge header, or forwarding headers
  // that name a non-loopback client — is never loopback, whatever its Host says.
  // This check used to run AFTER the Host check, so a tunnel that rewrote Host to
  // localhost got the full '*' loopback principal.
  if (externalIngressReason(headers) !== null) return false;
  // A local proxy (every forwarded client is loopback) keeps local trust; the Host it
  // presents is the proxy's upstream name, not evidence either way.
  if (forwardedRequestVerdict(headers).kind === 'local-proxy') return true;
  // Direct connection (no forwarding headers): the Host header decides. Fail closed on
  // a non-loopback or missing Host — the desktop's local superuser path always carries
  // a loopback Host (127.0.0.1/localhost) or rides the separate IPC server. (Bearer
  // validation is a second gate either way.)
  return LOOPBACK_HOSTS.has(hostnameOf(headers.get('host') ?? ''));
}

export const SUPERUSER_TOKEN_PATH = tokenPath();
