/**
 * Centralized cross-origin CORS for the route layer.
 *
 * A route opts into cross-origin reachability with `cors: true` (default
 * allowlist) or `cors: { origins }` (explicit override); `registerRoute`
 * applies the matching middleware. Orthogonal to auth — see the `cors`
 * field on the route definition. Not device-specific: any cross-origin
 * client uses the same field.
 *
 * Default origin policy — the cross-origin clients (paired devices, the
 * desktop WebView, dev tabs):
 *   - `*://tauri.localhost`   — the desktop WebView
 *   - `http://localhost:*`    — browser-dev tabs
 *   - `http://127.0.0.1:*`    — same, IP form
 *   - `http://10.0.2.2:*`     — the Android emulator's host alias
 * Anything else is refused (empty `Access-Control-Allow-Origin`).
 *
 * `credentials: true` is required because device requests carry the JWT
 * in `Authorization`; with credentials enabled the origin MUST be echoed
 * exactly (never `*`) — the function form does that.
 */

import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

/** Default cross-origin allowlist test — returns the origin if allowed, else ''. */
export function defaultCorsOrigin(origin: string | undefined | null): string {
  if (!origin) return origin ?? '';
  if (origin.endsWith('://tauri.localhost')) return origin;
  if (origin.startsWith('http://localhost:')) return origin;
  if (origin.startsWith('http://127.0.0.1:')) return origin;
  if (origin.startsWith('http://10.0.2.2:')) return origin;
  return '';
}

/**
 * Build a CORS middleware. `origins` undefined → the default allowlist;
 * an explicit list → exact-match against it. Applied by `registerRoute`
 * for `cors`-enabled routes; handles the OPTIONS preflight itself (204 +
 * headers) so the route file never needs an OPTIONS handler.
 */
export function corsFor(origins?: readonly string[]): MiddlewareHandler {
  return cors({
    origin: origins
      ? (origin) => (origin && origins.includes(origin) ? origin : '')
      : (origin) => defaultCorsOrigin(origin),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'authorization',
      'content-type',
      'last-event-id',
      'x-papercusp-run-id',
      // Per-window workspace context — stamped on EVERY operator API fetch by
      // installWorkspaceHeaderFetch, including the deliberately cross-origin
      // sibling-loopback calls from crossOriginUrl() (saved-prompts, git/show).
      // Omitting it here makes those preflights strip the header and the
      // browser block the call outright (harness-settings e2e, 2026-06-10).
      'x-papercusp-workspace',
    ],
    credentials: true,
    maxAge: 600,
  });
}

/**
 * CSRF guard for state-mutating handlers that admit the cookie-less desktop
 * webview (EI-338) — i.e. routes whose auth tier accepts `unverified-loopback`
 * or the default-user fallback, so the tier no longer blocks a cross-origin
 * browser page from POSTing to 127.0.0.1.
 *
 * Why a guard is still needed despite CORS: CORS stops a foreign page from
 * READING a response, and the JSON preflight stops most writes — but a
 * cross-origin SIMPLE request (e.g. `POST` with `text/plain` to dodge the
 * preflight) still EXECUTES server-side. The `verified/trusted` tier used to
 * be the backstop for that; loosening it to admit the webview removed it. This
 * restores it on the `Origin` header, which a browser always stamps on a
 * cross-origin request and JS cannot forge:
 *   - no `Origin` (non-browser: curl, server-to-server, SU bearer, or a
 *     same-origin GET that omits it) → allow.
 *   - `Origin` present → must pass `defaultCorsOrigin` (the SAME allowlist the
 *     CORS layer already trusts for the desktop/device clients), so every
 *     legitimate webview/device call passes and a foreign page is refused.
 *
 * Returns a 403 `Response` to short-circuit the handler, or `null` to proceed.
 * Call at the top of a mutating handler:
 *
 *   const csrf = requireAllowedOriginOr403(req);
 *   if (csrf) return csrf;
 */
export function requireAllowedOriginOr403(req: Request): Response | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  if (defaultCorsOrigin(origin)) return null;
  return Response.json({ error: 'cross_origin_blocked' }, { status: 403 });
}
