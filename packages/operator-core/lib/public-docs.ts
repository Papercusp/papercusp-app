/**
 * Read-only public manual hosting, shared by operator and portal.
 * The caller supplies the bundled PUBLIC root, never an engineering-doc root.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  // Pagefind fetches compressed metadata, indexes and fragments at runtime.
  '.pf_meta': 'application/octet-stream', '.pf_index': 'application/octet-stream',
  '.pf_fragment': 'application/octet-stream',
  '.pagefind': 'application/octet-stream',
};

export function publicDocsRelativePath(pathname: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded !== '/docs' && !decoded.startsWith('/docs/')) return null;
  const rel = decoded.slice('/docs'.length).replace(/^\//, '');
  // Reject encoded separators/traversal as well as malformed/double-encoded paths.
  if (/[%\\\u0000-\u001f\u007f]/.test(rel) ||
      rel.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return rel;
}

export async function servePublicDocs(request: Request, root: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const head = request.method === 'HEAD';
  const reply = (text: string, status: number) =>
    new Response(head ? null : text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const rel = publicDocsRelativePath(new URL(request.url).pathname);
  if (rel === null) return reply('Invalid documentation path', 400);
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(root); } catch {
    return reply('Public documentation is temporarily unavailable.', 503);
  }
  const read = async (name: string, status = 200): Promise<Response | null> => {
    const type = TYPES[extname(name).toLowerCase()];
    if (!type) return null;
    const file = resolve(canonicalRoot, name);
    if (!file.startsWith(`${canonicalRoot}${sep}`)) return null;
    try {
      const canonical = await realpath(file);
      if (!canonical.startsWith(`${canonicalRoot}${sep}`) || !(await stat(canonical)).isFile()) return null;
      return new Response(head ? null : new Uint8Array(await readFile(canonical)), {
        status,
        headers: {
          'content-type': type,
          'x-content-type-options': 'nosniff',
          'cache-control': 'public, max-age=0, must-revalidate',
        },
      });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
  };
  try {
    const slug = rel.replace(/\/$/, '') || 'index';
    const file = extname(slug) ? slug :
      `${slug}.${request.headers.get('accept')?.includes('text/markdown') ? 'md' : 'html'}`;
    const page = await read(file);
    if (page) return page;
    if (file.endsWith('.md')) return reply('Not found', 404);
    return await read('404.html', 404) ?? reply('Not found', 404);
  } catch {
    return reply('Public documentation is temporarily unavailable.', 503);
  }
}
