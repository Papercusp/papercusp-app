/**
 * GET /api/plugins/global — list every installed global plugin.
 * Ported from app/api/plugins/global/route.ts. `auth: 'public'`.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspRoot } from '../../../papercusp-root';
import { defineTool } from '@papercusp/agent-mcp';

const HIDDEN_PLUGIN_BASENAMES = new Set([
  'notion-export', 'slack-notifier',
]);

// Reserved by the CLI's lock-resolve node:test fixtures. Those tests used to
// write into the real global-plugins directory and a killed process could
// leave production-visible manifests behind. Keep the API safe during mixed
// version rollouts while old debris is removed and new tests become hermetic.
const LOCK_RESOLVE_FIXTURE_RE = /^lockresolve-\d+-/;

export function isLockResolveFixtureName(value: string | undefined | null): boolean {
  return typeof value === 'string' && LOCK_RESOLVE_FIXTURE_RE.test(value);
}

function isHidden(slugOrName: string | undefined | null): boolean {
  if (!slugOrName) return false;
  const base = slugOrName.includes('/') ? slugOrName.split('/').pop()! : slugOrName;
  return HIDDEN_PLUGIN_BASENAMES.has(base);
}

function GLOBAL_PLUGINS_DIR() { return join(papercuspRoot(), 'global-plugins'); }

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  icon?: string;
  dashboardTabs?: Array<{ id?: string; label?: string; icon?: string }>;
  [k: string]: unknown;
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
}

export default defineTool({
  method: 'GET',
  path: '/plugins/global',
  auth: 'public',
  async handler() {
    if (!existsSync(GLOBAL_PLUGINS_DIR())) return Response.json({ plugins: [] });
    const entries = await fs.readdir(GLOBAL_PLUGINS_DIR(), { withFileTypes: true }).catch(() => []);
    const plugins: Array<PluginManifest & { source: string; path: string }> = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || isLockResolveFixtureName(e.name)) continue;
      let isDirOrLinkToDir = e.isDirectory();
      if (!isDirOrLinkToDir && e.isSymbolicLink()) {
        const stat = await fs.stat(join(GLOBAL_PLUGINS_DIR(), e.name)).catch(() => null);
        isDirOrLinkToDir = stat?.isDirectory() ?? false;
      }
      if (!isDirOrLinkToDir) continue;
      const dir = join(GLOBAL_PLUGINS_DIR(), e.name);
      const m = await readJson<PluginManifest>(join(dir, 'papercusp.json'));
      if (m?.name && m?.version) {
        if (isLockResolveFixtureName(m.name)) continue;
        plugins.push({ ...m, source: 'global', path: dir });
        continue;
      }
      if (!e.name.startsWith('@')) continue;
      const inner = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const sub of inner) {
        if (sub.name.startsWith('.') || isLockResolveFixtureName(sub.name)) continue;
        let subIsDir = sub.isDirectory();
        if (!subIsDir && sub.isSymbolicLink()) {
          const t = await fs.stat(join(dir, sub.name)).catch(() => null);
          subIsDir = t?.isDirectory() ?? false;
        }
        if (!subIsDir) continue;
        const subDir = join(dir, sub.name);
        const subM = await readJson<PluginManifest>(join(subDir, 'papercusp.json'));
        if (!subM?.name || !subM?.version) continue;
        if (isLockResolveFixtureName(subM.name)) continue;
        plugins.push({ ...subM, source: 'global', path: subDir });
      }
    }
    const seen = new Set<string>();
    const deduped = plugins.filter((p) => {
      if (isHidden(p.name)) return false;
      if (seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });
    return Response.json({ plugins: deduped });
  },
});
