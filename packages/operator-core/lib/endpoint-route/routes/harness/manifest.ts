/**
 * GET /api/harness/:slug/manifest — returns the harness instance's papercusp.json.
 *
 * Ported from app/api/harness/[slug]/manifest/route.ts. `auth: 'public'`.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '../../../papercusp-root';
import { loadHarnessRegistry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/manifest',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
      return Response.json({ error: 'invalid slug' }, { status: 400 });
    }
    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });

    const projectManifestPath = join(project.path, '.papercusp', 'papercusp.json');
    let manifest: Record<string, unknown> | null = null;
    if (existsSync(projectManifestPath)) {
      try { manifest = JSON.parse(await fs.readFile(projectManifestPath, 'utf8')); } catch { /* ignore */ }
    }
    if (!manifest) {
      const harnessesDir = papercuspPath('harnesses');
      if (existsSync(harnessesDir)) {
        const dirs = await fs.readdir(harnessesDir, { withFileTypes: true }).catch(() => []);
        const candidates = await Promise.all(dirs.map(async (d) => {
          if (!d.isDirectory()) return null;
          try {
            const m = JSON.parse(await fs.readFile(join(harnessesDir, d.name, 'papercusp.json'), 'utf8'));
            return m && Array.isArray(m.configFiles) ? m : null;
          } catch { return null; }
        }));
        const found = candidates.find((m) => m != null);
        if (found) manifest = found;
      }
    }

    return Response.json({
      slug,
      projectPath: project.path,
      manifest,
      configFiles: Array.isArray(manifest?.configFiles) ? manifest!.configFiles : null,
    });
  },
});
