/**
 * GET /api/plugins/configs?harness=<h>&plugins=<a>,<b>,<c> — batched config read.
 * Ported from app/api/plugins/configs/route.ts. `auth: 'public'`.
 */
import { promises as fs } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { papercuspRoot } from '../../../papercusp-root';
import { listPluginsIn } from '../../../plugin-catalog';
import { defineTool } from '@papercusp/agent-mcp';

const HARNESS_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PLUGIN_DIR_SLUG = /^@?[a-z0-9][a-z0-9@._/-]{0,127}$/i;
const MAX_PLUGINS = 64;

function HARNESSES_DIR() { return join(papercuspRoot(), 'harnesses'); }
function GLOBAL_PLUGINS_DIR() { return join(papercuspRoot(), 'global-plugins'); }

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function resolveCanonicalSlugs(
  harness: string,
  inputSlugs: string[],
): Promise<Map<string, string>> {
  const sources: Array<[string, 'harness' | 'global']> = [
    [join(HARNESSES_DIR(), harness, 'plugins'), 'harness'],
    [GLOBAL_PLUGINS_DIR(), 'global'],
  ];
  const out = new Map<string, string>();
  for (const [src, kind] of sources) {
    let entries: Awaited<ReturnType<typeof listPluginsIn>> = [];
    try {
      entries = await listPluginsIn(src, kind);
    } catch { continue; }
    for (const entry of entries) {
      const dir = entry.path;
      const candidates = new Set<string>([entry.name, basename(dir)]);
      const parent = basename(dirname(dir));
      if (parent.startsWith('@')) {
        candidates.add(`${parent}/${basename(dir)}`);
      }
      for (const slug of inputSlugs) {
        if (out.has(slug)) continue;
        if (candidates.has(slug)) {
          out.set(slug, entry.name);
        }
      }
    }
  }
  return out;
}

export default defineTool({
  method: 'GET',
  path: '/plugins/configs',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const harness = url.searchParams.get('harness') ?? '';
    const pluginsParam = url.searchParams.get('plugins') ?? '';
    if (!HARNESS_SLUG.test(harness)) {
      return Response.json({ error: 'invalid harness' }, { status: 400 });
    }
    const slugs = pluginsParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (slugs.length === 0) {
      return Response.json({ configs: {} });
    }
    if (slugs.length > MAX_PLUGINS) {
      return Response.json(
        { error: `too many plugins (max ${MAX_PLUGINS})` },
        { status: 400 },
      );
    }
    for (const s of slugs) {
      if (!PLUGIN_DIR_SLUG.test(s)) {
        return Response.json({ error: `invalid plugin slug: ${s}` }, { status: 400 });
      }
    }

    const canonical = await resolveCanonicalSlugs(harness, slugs);

    const entries = await Promise.all(
      slugs.map(async (slug) => {
        const canonicalSlug = canonical.get(slug) ?? slug;
        const canonicalPath = join(
          HARNESSES_DIR(), harness, 'plugin-configs', `${canonicalSlug}.json`,
        );
        const fallbackPath = join(
          HARNESSES_DIR(), harness, 'plugin-configs', `${slug}.json`,
        );
        const config =
          (await readJson<Record<string, unknown>>(canonicalPath))
          ?? (await readJson<Record<string, unknown>>(fallbackPath))
          ?? {};
        return [slug, config] as const;
      }),
    );

    return Response.json({ configs: Object.fromEntries(entries) });
  },
});
