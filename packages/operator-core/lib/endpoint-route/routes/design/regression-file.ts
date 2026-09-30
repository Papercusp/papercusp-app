/**
 * GET /api/design/regressions/:bucket/:file
 *
 * Streams a Lost Pixel PNG from one of the three apps/operator/lostpixel-*
 * directories. Strict allowlist + traversal containment.
 *
 * Ported from app/api/design/regressions/[bucket]/[file]/route.ts.
 * Next `[bucket]/[file]` → Hono `:bucket/:file`. `auth: 'public'`.
 */
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import { defineTool } from '@papercusp/agent-mcp';

const ROOTS: Record<string, string> = {
  baseline: 'lostpixel-baseline',
  current: 'lostpixel-current',
  diff: 'lostpixel-diff',
};
const FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.png$/i;

export default defineTool({
  method: 'GET',
  path: '/design/regressions/:bucket/:file',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.DESIGN);
    if (blocked) return blocked;
    const { bucket, file } = ctx.params;
    const rel = ROOTS[bucket];
    if (!rel) return Response.json({ error: 'unknown bucket' }, { status: 400 });
    if (!FILENAME_RE.test(file)) {
      return Response.json({ error: 'invalid filename' }, { status: 400 });
    }
    const root = resolve(process.cwd(), rel);
    const abs = resolve(root, file);
    if (!abs.startsWith(root + '/')) {
      return Response.json({ error: 'traversal blocked' }, { status: 400 });
    }
    try {
      const bytes = await fs.readFile(abs);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      return Response.json({ error: 'io_error' }, { status: 500 });
    }
  },
});
