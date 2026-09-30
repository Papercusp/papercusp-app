/**
 * GET /api/plugins/:slug/installed — list every plugin reachable by the
 * named harness (project-scoped + all harness-bundled + global), deduped
 * by manifest name.
 *
 * Relocated from app/api/_hono/plugins.ts (endpoint-hono-elimination
 * -2026-05-21 A3).
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  listPluginsIn,
  resolveProjectPath,
  HARNESSES_DIR,
  GLOBAL_PLUGINS_DIR,
  type PluginManifest,
} from '../../../plugin-catalog';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/plugins/:slug/installed',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
      return Response.json({ error: 'invalid slug' }, { status: 400 });
    }
    const projectPath = await resolveProjectPath(slug);
    const sources: Array<{ name: string; dir: string; source: 'project' | 'harness' | 'global' }> = [];
    if (projectPath) {
      sources.push({ name: slug, dir: join(projectPath, 'plugins'), source: 'project' });
    }

    // Walk every installed harness — each may carry its own bundled
    // plugins in <harness>/plugins/.
    if (existsSync(HARNESSES_DIR())) {
      const harnessDirs = await fs.readdir(HARNESSES_DIR(), { withFileTypes: true }).catch(() => []);
      for (const h of harnessDirs) {
        if (!h.isDirectory()) continue;
        sources.push({ name: h.name, dir: join(HARNESSES_DIR(), h.name, 'plugins'), source: 'harness' });
      }
    }
    sources.push({ name: 'global', dir: GLOBAL_PLUGINS_DIR(), source: 'global' });

    const seen = new Set<string>();
    const items: Array<PluginManifest & { source: string; path: string }> = [];
    for (const s of sources) {
      for (const p of await listPluginsIn(s.dir, s.source)) {
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        items.push(p);
      }
    }

    return Response.json({
      project: { slug, path: projectPath },
      plugins: items,
    });
  },
});
