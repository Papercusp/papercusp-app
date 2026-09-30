/**
 * GET /api/plugins — every plugin reachable from any source, deduped
 * by manifest name. Used by the marketplace + admin "what's installed"
 * views.
 *
 * Relocated from app/api/_hono/plugins.ts (endpoint-hono-elimination
 * -2026-05-21 A3).
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  listPluginsIn,
  HARNESSES_DIR,
  GLOBAL_PLUGINS_DIR,
  type PluginManifest,
} from '../../../plugin-catalog';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/plugins',
  auth: 'public',
  async handler() {
    const sources: Array<{ dir: string; source: 'project' | 'harness' | 'global' }> = [];
    if (existsSync(HARNESSES_DIR())) {
      const harnessDirs = await fs.readdir(HARNESSES_DIR(), { withFileTypes: true }).catch(() => []);
      for (const h of harnessDirs) {
        if (!h.isDirectory()) continue;
        sources.push({ dir: join(HARNESSES_DIR(), h.name, 'plugins'), source: 'harness' });
      }
    }
    sources.push({ dir: GLOBAL_PLUGINS_DIR(), source: 'global' });

    const seen = new Set<string>();
    const items: Array<PluginManifest & { source: string; path: string }> = [];
    for (const s of sources) {
      for (const p of await listPluginsIn(s.dir, s.source)) {
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        items.push(p);
      }
    }
    return Response.json({ plugins: items });
  },
});
