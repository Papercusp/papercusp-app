/**
 * GET /api/design/regressions
 *
 * Lists Lost Pixel baseline / current / diff PNGs from the three
 * apps/operator/lostpixel-{baseline,current,diff}/ directories, grouped
 * by image name. The image bytes are served by ./regressions/:bucket/:file.
 *
 * Ported from app/api/design/regressions/route.ts. `auth: 'public'` —
 * gateApiRoute(FLAGS.DESIGN) is the actual gate.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import { defineTool } from '@papercusp/agent-mcp';

const ROOTS = {
  baseline: 'lostpixel-baseline',
  current: 'lostpixel-current',
  diff: 'lostpixel-diff',
} as const;
type Bucket = keyof typeof ROOTS;

async function listDir(absDir: string) {
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    const out = new Map<string, { mtime: number; size: number }>();
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.png')) continue;
      const stat = await fs.stat(join(absDir, e.name));
      out.set(e.name, { mtime: stat.mtimeMs, size: stat.size });
    }
    return out;
  } catch {
    return new Map<string, { mtime: number; size: number }>();
  }
}

export default defineTool({
  method: 'GET',
  path: '/design/regressions',
  auth: 'public',
  async handler(req) {
    const blocked = await gateApiRoute(req, FLAGS.DESIGN);
    if (blocked) return blocked;
    const cwd = process.cwd();
    const buckets: Record<Bucket, Awaited<ReturnType<typeof listDir>>> = {
      baseline: await listDir(join(cwd, ROOTS.baseline)),
      current: await listDir(join(cwd, ROOTS.current)),
      diff: await listDir(join(cwd, ROOTS.diff)),
    };
    const allNames = new Set<string>();
    for (const m of Object.values(buckets)) for (const n of m.keys()) allNames.add(n);
    const items = [...allNames].sort().map((name) => {
      const b = buckets.baseline.get(name);
      const c = buckets.current.get(name);
      const d = buckets.diff.get(name);
      return {
        name,
        hasBaseline: !!b,
        hasCurrent: !!c,
        hasDiff: !!d,
        baselineMtime: b?.mtime ?? null,
        currentMtime: c?.mtime ?? null,
        diffMtime: d?.mtime ?? null,
        baselineSize: b?.size ?? null,
        currentSize: c?.size ?? null,
        diffSize: d?.size ?? null,
        hasRegression: !!d && d.size > 200,
      };
    });
    return Response.json({
      ok: true,
      counts: {
        baseline: buckets.baseline.size,
        current: buckets.current.size,
        diff: buckets.diff.size,
        regressions: items.filter((i) => i.hasRegression).length,
      },
      items,
    });
  },
});
