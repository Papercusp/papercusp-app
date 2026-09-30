/**
 * GET /api/plugins/updates — installed-vs-catalog version diff.
 * Ported from app/api/plugins/updates/route.ts. `auth: 'public'`.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspRoot } from '../../../papercusp-root';
import { defineTool } from '@papercusp/agent-mcp';

interface InstalledManifest {
  name: string;
  version: string;
  capabilities?: string[];
  source?: string;
  path?: string;
}

interface CatalogEntry {
  kind?: string;
  name?: string;
  version?: string;
  capabilities?: string[];
  retracted?: string | boolean;
}

interface CapChange {
  added: string[];
  removed: string[];
  unchanged: string[];
}

interface UpdateRow {
  slug: string;
  name: string;
  installed: string;
  available: string;
  capChange: CapChange;
}

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch { return null; }
}

async function listInstalled(): Promise<InstalledManifest[]> {
  const root = join(papercuspRoot(), 'global-plugins');
  if (!existsSync(root)) return [];
  const out: InstalledManifest[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const dir = join(root, e.name);
    const m = await readJson<InstalledManifest>(join(dir, 'papercusp.json'));
    if (m?.name && m?.version) {
      out.push({ ...m, path: dir });
      continue;
    }
    if (!e.name.startsWith('@')) continue;
    const inner = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const sub of inner) {
      if (sub.name.startsWith('.')) continue;
      const subDir = join(dir, sub.name);
      const sm = await readJson<InstalledManifest>(join(subDir, 'papercusp.json'));
      if (sm?.name && sm?.version) out.push({ ...sm, path: subDir });
    }
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}

export function isNewerVersion(available: string, installed: string): boolean {
  if (available === installed) return false;
  const norm = (v: string) => v.replace(/^v/, '');
  const a = norm(available).split(/[.+-]/);
  const b = norm(installed).split(/[.+-]/);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? '0';
    const bi = b[i] ?? '0';
    const an = Number(ai);
    const bn = Number(bi);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an > bn;
    if (ai !== bi) return ai > bi;
  }
  return false;
}

export function computeCapChange(from: string[] = [], to: string[] = []): CapChange {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const c of toSet) {
    if (fromSet.has(c)) unchanged.push(c);
    else added.push(c);
  }
  for (const c of fromSet) {
    if (!toSet.has(c)) removed.push(c);
  }
  return { added: added.sort(), removed: removed.sort(), unchanged: unchanged.sort() };
}

export default defineTool({
  method: 'GET',
  path: '/plugins/updates',
  auth: 'public',
  async handler() {
    // The legacy marketplace catalog (`:3057` `/v1/catalog`) is RETIRED (D-005);
    // there is no remote catalog to diff installed plugins against. Cupboard-
    // sourced update-checking (kind=plugin) is a tracked follow-up. With no
    // catalog, the diff below yields no updates.
    const catalog: CatalogEntry[] = [];

    const installed = await listInstalled();
    const catBySlug = new Map<string, CatalogEntry>();
    for (const c of catalog) {
      if (c.kind && c.kind !== 'plugin') continue;
      if (typeof c.retracted === 'string' && c.retracted !== 'active') continue;
      if (c.retracted === true) continue;
      if (c.name && c.version) {
        const existing = catBySlug.get(c.name);
        if (!existing || isNewerVersion(c.version, existing.version!)) {
          catBySlug.set(c.name, c);
        }
      }
    }

    const updates: UpdateRow[] = [];
    for (const i of installed) {
      const c = catBySlug.get(i.name);
      if (!c?.version) continue;
      if (!isNewerVersion(c.version, i.version)) continue;
      updates.push({
        slug: i.name,
        name: i.name,
        installed: i.version,
        available: c.version,
        capChange: computeCapChange(i.capabilities, c.capabilities),
      });
    }
    return Response.json({ updates });
  },
});
