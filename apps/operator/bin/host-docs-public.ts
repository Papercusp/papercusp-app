/**
 * `/docs/*` — the public Papercusp docs (Starlight at `apps/papercusp-docs`),
 * served by the operator Hono host.
 *
 * Sibling to `host-docs.ts`. Same Starlight slug-resolution mechanism, with
 * two deliberate differences:
 *
 *   - **No loopback gate.** Public docs are public; the internal engineering
 *     docs are loopback-only because they expose internals.
 *   - **Different doc root.** Defaults to `apps/operator/public/docs/`
 *     (populated by `apps/papercusp-docs/scripts/postbuild-copy.sh`), or
 *     `PAPERCUSP_PUBLIC_DOCS_ROOT` if set (used by the packaged desktop
 *     build to point at the bundled docs location).
 *
 * Mounted after the internal docs router in `host-handler.ts` so the URL
 * spaces stay clearly separated and `/docs` never falls through to the SPA.
 */
import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const PUBLIC_DOCS_ROOT = process.env.PAPERCUSP_PUBLIC_DOCS_ROOT
  ? resolve(process.env.PAPERCUSP_PUBLIC_DOCS_ROOT)
  : resolve(__dirname, '..', 'public', 'docs');

const EXT_CONTENT_TYPE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

const TEXT_EXTS = new Set([
  '.html', '.md', '.txt', '.xml', '.css', '.js', '.mjs', '.json', '.svg',
]);

const STATIC_ASSET_RE = /\.(md|txt|html|xml|js|mjs|css|json|svg|png|jpe?g|webp|gif|woff2?|wasm|ico)$/i;
const EXT_RE = /\.[a-z0-9]+$/i;

function serveFile(absPath: string, status = 200): Response {
  const ext = extname(absPath).toLowerCase();
  const contentType = EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream';
  const body = TEXT_EXTS.has(ext)
    ? readFileSync(absPath, 'utf-8')
    : readFileSync(absPath);
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

export const publicDocsRoutes = new Hono();

publicDocsRoutes.get('/docs/*', async (c) => {
  const pathname = decodeURI(new URL(c.req.url).pathname);
  const rel = pathname.replace(/^\/docs\/?/, '');

  if (rel && STATIC_ASSET_RE.test(rel)) {
    const abs = join(PUBLIC_DOCS_ROOT, rel);
    if (existsSync(abs)) return serveFile(abs, 200);
  }

  const isExtless = !rel || !EXT_RE.test(rel);
  const accept = c.req.header('accept') ?? '';
  if (isExtless && accept.includes('text/markdown')) {
    const slug = rel === '' || rel === '/' ? 'index' : rel.replace(/\/$/, '');
    const abs = join(PUBLIC_DOCS_ROOT, `${slug}.md`);
    if (existsSync(abs)) return serveFile(abs, 200);
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  if (isExtless) {
    const slug = rel === '' || rel === '/' ? 'index' : rel.replace(/\/$/, '');
    const abs = join(PUBLIC_DOCS_ROOT, `${slug}.html`);
    if (existsSync(abs)) return serveFile(abs, 200);
  }

  const notFoundPath = join(PUBLIC_DOCS_ROOT, '404.html');
  if (existsSync(notFoundPath)) return serveFile(notFoundPath, 404);
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
});

// Bare `/docs` (no trailing slash) → serve the index. Browsers asking for
// `/docs` typed in the address bar should land on the site, not 404.
publicDocsRoutes.get('/docs', async () => {
  const abs = join(PUBLIC_DOCS_ROOT, 'index.html');
  if (existsSync(abs)) return serveFile(abs, 200);
  return new Response('Public docs not built. Run `npm --workspace @papercupai/papercusp-docs run build`.', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
});
