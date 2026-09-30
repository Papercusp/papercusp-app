/**
 * GET /api/installed
 *
 * Registered projects (annotated with on-disk existence) + installed
 * harnesses. 2s globalThis TTL cache + single-flight — paperclip
 * concurrently rewriting the harnesses dir made the uncached path
 * 2.3-4.4s in diagnostics.
 *
 * Ported from app/api/installed/route.ts. `auth: 'public'`.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '../../../papercusp-root';
import { loadHarnessRegistry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

interface RegistryShape {
  projects: Array<{ slug: string; path: string; harnessKind?: string; addedAt?: string }>;
}
interface AnnotatedProject {
  slug: string;
  path: string;
  harnessKind?: string;
  addedAt?: string;
  exists: boolean;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function listInstalledHarnesses(): Promise<
  Array<{ slug: string; version: string | null; description: string | null }>
> {
  const harnessesDir = papercuspPath('harnesses');
  try {
    const dirs = await fs.readdir(harnessesDir, { withFileTypes: true });
    const out: Array<{ slug: string; version: string | null; description: string | null }> = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const manifest = await readJson<{ name: string; version: string; description?: string }>(
        join(harnessesDir, d.name, 'papercusp.json'),
      );
      out.push({
        slug: d.name,
        version: manifest?.version ?? null,
        description: manifest?.description ?? null,
      });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  } catch {
    return [];
  }
}

function annotateProjectExistence(projects: RegistryShape['projects']): {
  annotated: AnnotatedProject[];
  staleCount: number;
} {
  let staleCount = 0;
  const annotated = projects.map((p) => {
    const exists = existsSync(p.path);
    if (!exists) staleCount++;
    return { ...p, exists };
  });
  return { annotated, staleCount };
}

type Payload = {
  projects: AnnotatedProject[];
  staleCount: number;
  harnesses: Awaited<ReturnType<typeof listInstalledHarnesses>>;
};
const CACHE_TTL_MS = 2000;
type _G = {
  __installedCache?: { ts: number; payload: Payload };
  __installedInflight?: Promise<Payload>;
};
const _g = globalThis as unknown as _G;

async function compute(): Promise<Payload> {
  const reg = await loadHarnessRegistry();
  const { annotated, staleCount } = annotateProjectExistence(reg.projects);
  const harnesses = await listInstalledHarnesses();
  return { projects: annotated, staleCount, harnesses };
}

export default defineTool({
  method: 'GET',
  path: '/installed',
  auth: 'public',
  async handler() {
    const now = Date.now();
    const hit = _g.__installedCache;
    if (hit && now - hit.ts < CACHE_TTL_MS) {
      return Response.json(hit.payload, {
        headers: { 'X-Cache': 'HIT', 'X-Cache-Age': String(now - hit.ts) },
      });
    }
    if (_g.__installedInflight) {
      const payload = await _g.__installedInflight;
      return Response.json(payload, { headers: { 'X-Cache': 'COALESCED' } });
    }
    _g.__installedInflight = compute();
    try {
      const payload = await _g.__installedInflight;
      _g.__installedCache = { ts: Date.now(), payload };
      return Response.json(payload, { headers: { 'X-Cache': 'MISS' } });
    } finally {
      _g.__installedInflight = undefined;
    }
  },
});
