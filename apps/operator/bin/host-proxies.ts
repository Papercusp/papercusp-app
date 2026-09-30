/**
 * Upstream proxies replacing `next.config.js` `rewrites()`.
 *
 *   afterFiles  →  cross-app routes (Papercup demo on :3061, Restart admin
 *                   on :3001). Always on.
 *   beforeFiles →  Rust opt-in rewrites — every path declared in
 *                   `papercup-rust-server/openapi.yaml` proxies to
 *                   `${RUST_UPSTREAM}` *only* when the request carries
 *                   `?backend=rust` AND `PAPERCUSP_ENABLE_RUST_REWRITES=1`.
 *                   Default off.
 *
 * The `/drizzle-studio/*` rewrite from next.config.js is handled in
 * `page-routes.ts` instead — it's a same-process handler, not an upstream
 * proxy, so it lives with the other page-namespace routes.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAPERCUP_UPSTREAM =
  process.env.PAPERCUSP_PAPERCUP_UPSTREAM ?? 'http://localhost:3061';
const WEB_UPSTREAM =
  process.env.PAPERCUSP_WEB_UPSTREAM ?? 'http://localhost:3001';
const RUST_UPSTREAM =
  process.env.PAPERCUSP_RUST_UPSTREAM ?? 'http://127.0.0.1:3060';

/** Re-issue the incoming request against `upstream`, streaming the body. */
async function proxyTo(upstream: string, c: Context): Promise<Response> {
  const inUrl = new URL(c.req.url);
  const target = `${upstream}${inUrl.pathname}${inUrl.search}`;
  const headers = new Headers(c.req.raw.headers);
  headers.delete('host');
  const init: RequestInit & { duplex?: 'half' } = {
    method: c.req.method,
    headers,
  };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = c.req.raw.body;
    init.duplex = 'half';
  }
  let res: Response;
  try {
    res = await fetch(target, init as RequestInit);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Upstream unreachable: ${msg}`, {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(res.body, { status: res.status, headers: res.headers });
}

// ---- afterFiles: cross-app routes -----------------------------------------

export const crossAppRewrites = new Hono();

crossAppRewrites.all('/api/org/*',           (c) => proxyTo(PAPERCUP_UPSTREAM, c));
crossAppRewrites.all('/api/briefings/*',     (c) => proxyTo(PAPERCUP_UPSTREAM, c));
crossAppRewrites.all('/api/public/*',        (c) => proxyTo(PAPERCUP_UPSTREAM, c));
crossAppRewrites.all('/api/admin-sidebar/*', (c) => proxyTo(WEB_UPSTREAM, c));
crossAppRewrites.all('/api/repo-git/*',      (c) => proxyTo(WEB_UPSTREAM, c));
crossAppRewrites.all('/api/build-info',      (c) => proxyTo(WEB_UPSTREAM, c));

// ---- beforeFiles: Rust opt-in (default OFF) -------------------------------

/** Parse the `paths:` block of openapi.yaml without pulling in a YAML dep. */
function loadRustPaths(): string[] {
  if (process.env.PAPERCUSP_ENABLE_RUST_REWRITES !== '1') return [];
  const openapiPath = process.env.PAPERCUSP_RUST_OPENAPI
    ?? resolve(__dirname, '..', '..', '..', 'papercup-rust-server', 'openapi.yaml');
  if (!existsSync(openapiPath)) {
    console.warn(`[hono-host] rust openapi missing at ${openapiPath} — opt-in inert`);
    return [];
  }
  const text = readFileSync(openapiPath, 'utf-8');
  const paths: string[] = [];
  let inPaths = false;
  for (const line of text.split('\n')) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (!inPaths) continue;
    if (/^[A-Za-z]/.test(line)) break;
    const m = line.match(/^  (\/[^\s:]+):\s*$/);
    if (m) paths.push(m[1].replace(/\{([^}]+)\}/g, ':$1'));
  }
  return paths;
}

/** Compile `/foo/:id/bar` → regex matching that exact path shape. */
function compileTemplate(tmpl: string): RegExp {
  const escaped = tmpl
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[^/]+/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

const RUST_TEMPLATES = loadRustPaths().map(compileTemplate);
if (RUST_TEMPLATES.length > 0) {
  console.log(
    `[hono-host] rust opt-in: ${RUST_TEMPLATES.length} paths gated on ?backend=rust → ${RUST_UPSTREAM}`,
  );
}

/** Middleware — apply on `/api/*` ahead of the local API + cross-app routes. */
export const rustOptIn: MiddlewareHandler = async (c, next) => {
  if (RUST_TEMPLATES.length === 0) return next();
  if (c.req.query('backend') !== 'rust') return next();
  const pathname = new URL(c.req.url).pathname;
  for (const re of RUST_TEMPLATES) {
    if (re.test(pathname)) return proxyTo(RUST_UPSTREAM, c);
  }
  return next();
};
