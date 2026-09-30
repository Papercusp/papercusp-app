/**
 * GET /api/plugins/manifest?slug=<name> — manifest read for permissions UI.
 * Ported from app/api/plugins/manifest/route.ts. `auth: 'public'`.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspRoot } from '../../../papercusp-root';
import { defineTool } from '@papercusp/agent-mcp';

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  icon?: string;
  capabilities?: string[];
  [k: string]: unknown;
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
}

async function findManifest(slug: string): Promise<{ manifest: PluginManifest; path: string } | null> {
  const root = join(papercuspRoot(), 'global-plugins');
  if (!existsSync(root)) return null;
  const direct = join(root, slug);
  const directManifest = await readJson<PluginManifest>(join(direct, 'papercusp.json'));
  if (directManifest?.name) return { manifest: directManifest, path: direct };

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.name.startsWith('@')) continue;
    const inner = join(root, e.name, slug);
    const m = await readJson<PluginManifest>(join(inner, 'papercusp.json'));
    if (m?.name) return { manifest: m, path: inner };
  }

  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const dir = join(root, e.name);
    const m = await readJson<PluginManifest>(join(dir, 'papercusp.json'));
    if (m?.name === slug) return { manifest: m, path: dir };
  }
  return null;
}

export default defineTool({
  method: 'GET',
  path: '/plugins/manifest',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const slug = url.searchParams.get('slug') ?? '';
    if (!slug) return Response.json({ error: 'slug required' }, { status: 400 });
    const found = await findManifest(slug);
    if (!found) return Response.json({ error: 'not found' }, { status: 404 });
    const { manifest } = found;
    return Response.json({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? null,
      icon: manifest.icon ?? null,
      capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
    });
  },
});
