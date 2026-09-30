/**
 * Host-level credentialed CORS for `/api/*` — faithful port of the
 * `proxy.ts` middleware that the Hono host replaces.
 *
 * Differs from the narrower `tauriApiCors` inside `_hono/app.ts` (mounted on
 * 5 sub-paths with a 3-origin allowlist) by covering *every* `/api/*` path
 * with the broader proxy.ts origin set (any-port localhost/127.0.0.1 +
 * tauri:/capacitor:/ionic: schemes). Both run in production: the host CORS
 * is outermost and overwrites the inner `Access-Control-Allow-Origin` for
 * the 5-path overlap. That preserves the behavior the Next stack had today
 * (`proxy.ts` outer + `_hono` inner) without mutating `_hono/app.ts`.
 *
 * Ported 1:1 from `apps/operator/proxy.ts` — see plan Phase E2.
 */
import type { MiddlewareHandler } from 'hono';

const LOCAL_API_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    // x-papercusp-workspace: per-window workspace context — stamped on every
    // operator API fetch, incl. crossOriginUrl()'s sibling-loopback shards;
    // a preflight that disallows it blocks the whole call (2026-06-10).
    'authorization, content-type, if-match, last-event-id, x-requested-with, x-papercusp-workspace',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin, Access-Control-Request-Headers',
} as const;

const LOCAL_API_ORIGIN_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '10.0.2.2',
  'tauri.localhost',
]);
const LOCAL_API_ORIGIN_PROTOCOLS = new Set([
  'http:',
  'https:',
  'tauri:',
  'capacitor:',
  'ionic:',
]);

/** True iff the request's Origin header is in the allowed local-API set. */
export function allowedLocalApiOrigin(origin: string | null): string | null {
  if (!origin) return null;
  // `null` is the serialized origin of sandboxed/file/data documents. It is
  // deliberately never a trusted browser origin: reflecting it together with
  // credentials turns an opaque page into a readable local-API client.
  if (origin === 'null') return null;
  try {
    const url = new URL(origin);
    if (!LOCAL_API_ORIGIN_PROTOCOLS.has(url.protocol)) return null;
    // An Origin header is an origin, not an arbitrary URL. Reject credentials,
    // paths, queries, and fragments instead of reflecting a caller-controlled
    // string that merely happens to parse as a URL.
    if (
      url.username ||
      url.password ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.hash ||
      ((url.protocol === 'http:' || url.protocol === 'https:') && origin !== url.origin)
    ) {
      return null;
    }
    if (LOCAL_API_ORIGIN_HOSTS.has(url.hostname)) return origin;
  } catch {
    return null;
  }
  return null;
}

/**
 * Hono middleware — apply to `/api/*`. Reflects the origin when allowed,
 * answers OPTIONS preflight with 204 immediately, and decorates the
 * downstream response with the standard CORS headers.
 */
export const apiCors: MiddlewareHandler = async (c, next) => {
  const corsOrigin = allowedLocalApiOrigin(c.req.header('origin') ?? null);
  if (!corsOrigin) {
    // No allowed origin → behave as if CORS middleware wasn't there. The
    // request still reaches the API; only the headers are missing.
    return next();
  }

  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        ...LOCAL_API_CORS_HEADERS,
      },
    });
  }

  await next();
  // Mutate the downstream response's headers. If `_hono/app.ts`'s narrower
  // `tauriApiCors` already wrote ACAO, we overwrite with the broader value
  // — that mirrors the Next setup where proxy.ts was the outer layer.
  c.res.headers.set('Access-Control-Allow-Origin', corsOrigin);
  for (const [k, v] of Object.entries(LOCAL_API_CORS_HEADERS)) {
    c.res.headers.set(k, v);
  }
};
