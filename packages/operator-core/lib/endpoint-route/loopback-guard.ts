/**
 * loopback-guard — shared loopback-host detection + a 403 guard for routes
 * that must not be reachable off-box.
 *
 * Defense-in-depth (D-009 of production-readiness-test-coverage-2026-05-30):
 * the operator's Hono host binds 127.0.0.1 by default (`bin/hono-host.ts`), so
 * the *primary* perimeter for the destructive `auth: 'public'` routes (backup
 * restore/rollback/promote, flag set/preset, harness spawn launch/invoke) is
 * that bind. This guard is the secondary layer: if the host is ever bound to
 * 0.0.0.0 (`PAPERCUSP_BIND_HOST`/`HOSTNAME`), a request whose `Host` header is
 * not a loopback name is rejected — so an accidental non-loopback bind can't
 * silently expose backup-restore + flag mutation to the LAN.
 *
 * LIMITATION (intentional, mirrors the `/internal/docs` gate): this checks the
 * request's host (from `req.url`, which `@hono/node-server` derives from the
 * client-supplied `Host` header), which a crafted request can forge. It stops
 * casual / browser cross-host access, not a determined attacker who connects to
 * a non-loopback bind and forges `Host: localhost`. The real perimeter remains
 * the loopback bind; this raises the bar without replacing it.
 *
 * `isLoopbackHost` is the single canonical implementation — `bin/host-docs.ts`
 * imports it here rather than keeping its own copy, so the two gates can't drift.
 */

import { foreignLoopbackPeerResponse } from '../auth/loopback-peer-trust';
import { externalIngressResponse } from '../auth/forwarded-request-trust';

/** Host names that resolve to the local machine (incl. the QEMU + Tauri aliases). */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '10.0.2.2',
  'tauri.localhost',
]);

/** True iff the request's `Host` header points at a loopback address. */
export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const lower = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(lower)) return true;
  let hostname = lower;
  if (hostname.startsWith('[')) {
    // [::1]:3070 → ::1
    hostname = hostname.slice(1, hostname.indexOf(']'));
  } else if (hostname.includes(':')) {
    // 127.0.0.1:3070 → 127.0.0.1
    hostname = hostname.slice(0, hostname.indexOf(':'));
  }
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * Returns a 403 `Response` when `req` is NOT loopback-originated (by `Host`
 * header) and the explicit remote-admin opt-out is unset; otherwise `null`
 * (caller proceeds). Call at the top of a destructive `auth: 'public'` handler:
 *
 *   const gate = requireLoopbackOr403(req);
 *   if (gate) return gate;
 *
 * Opt into remote access with `PAPERCUSP_ALLOW_REMOTE_ADMIN=1` (off by default).
 */
export function requireLoopbackOr403(req: Request): Response | null {
  // WI-10003619: a loopback peer not owned by the service uid (a hosted host's
  // customer account) is refused before any opt-out — the remote-admin lever is for
  // off-box access, never for a co-resident account on a shared loopback interface.
  const foreignPeer = foreignLoopbackPeerResponse();
  if (foreignPeer) return foreignPeer;
  if (process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN === '1') return null;
  // external-app-access P-004 / R-7: tunnel and relay traffic is never local, even
  // when a tunnel rewrote its Host to localhost. (After the remote-admin opt-out,
  // which is the operator's explicit choice to serve these routes to off-box callers.)
  const external = externalIngressResponse(req.headers);
  if (external) return external;
  // Prefer the host from req.url (set by @hono/node-server from the Host header,
  // and always present on app.request() Requests in tests — unlike the raw
  // `host` header, which the Fetch spec forbids setting); fall back to the
  // header if the URL is somehow opaque.
  let host: string | null = null;
  try {
    host = new URL(req.url).host;
  } catch {
    host = null;
  }
  if (!host) host = req.headers.get('host');
  if (isLoopbackHost(host)) return null;
  return Response.json(
    {
      error: 'loopback_only',
      // Not "mutates durable state" any more: since 2026-07-26 the loopback
      // tier also covers pure READS whose exposure is the concern rather than
      // their effect (the whole sync surface, `GET /rest-query`). Describe the
      // tier, not a guess at what the route does.
      detail:
        'This route is loopback-only. Reach it on 127.0.0.1 / localhost, or set PAPERCUSP_ALLOW_REMOTE_ADMIN=1 to opt into remote access.',
    },
    { status: 403 },
  );
}
