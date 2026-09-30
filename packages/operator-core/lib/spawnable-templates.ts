/**
 * Spawnable-template catalog — the merged list of marketplace + locally-
 * installed templates that declare a `spawnable` manifest field.
 *
 * Extracted from `app/api/_hono/cross-harness.ts` in Phase A1
 * (endpoint-hono-elimination-2026-05-21) so the helper survives that
 * router's migration to `defineTool`. Consumed by
 * `routes/marketplace/spawnable.ts` (the `/api/marketplace/spawnable`
 * route) and the `scaffold_harness` prompt-builder validation.
 *
 * 10s TTL cache with in-flight-promise collapse: the list is read on
 * every dashboard mount and every `scaffold_harness` verb validation;
 * under contention each call did a cross-port self-fetch + a per-harness
 * fs walk (96ms p50 / 644ms p99). Snapshots/templates change rarely.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import { papercuspPath } from './papercusp-root';
import { operatorApiBase } from './operator-api-base';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SpawnableCacheEntry {
  expires: number;
  inflight: Promise<{ spawnable: any[] }> | null;
  value: { spawnable: any[] } | null;
}
// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair: hand-rolling still fixes correctness, but
// the key is invisible to listModuleDuplications(), which then reports a
// confident `[]` while this module is split (EI-19479108855357092).
const __spawnableCache = pinModuleState<SpawnableCacheEntry>(
  '@papercusp/operator-core.spawnableCache',
  () => ({ expires: 0, inflight: null, value: null }),
);

/**
 * Reset the cache between tests THROUGH the module's own seam.
 *
 * Do not reach for `globalThis[Symbol.for(...)]` in a test: that targets the
 * storage LOCATION rather than this module's state, so it keeps compiling and
 * silently resets NOTHING the moment the state moves (which is exactly what
 * happened when this module was migrated to pinModuleState —
 * EI-19479108855357092).
 */
export function resetSpawnableCacheForTest(): void {
  __spawnableCache.value = null;
  __spawnableCache.expires = 0;
  __spawnableCache.inflight = null;
}

async function computeSpawnableTemplates(): Promise<{ spawnable: any[] }> {
  const operatorBase = operatorApiBase();
  let catalog: any[] = [];
  try {
    const r = await fetch(`${operatorBase}/api/marketplace/catalog`);
    if (r.ok) {
      const d: any = await r.json();
      catalog = Array.isArray(d?.templates) ? d.templates : Array.isArray(d) ? d : [];
    }
  } catch { /* fall through */ }

  // Scan locally-installed templates for spawnable fields. Parallelized:
  // serial fs.readFile cost ~150ms per call under HMR file-tracking.
  const harnessesDir = process.env.PAPERCUSP_HARNESSES_DIR ?? papercuspPath('harnesses');
  const localSpawnable: any[] = [];
  if (existsSync(harnessesDir)) {
    try {
      const entries = await fs.readdir(harnessesDir);
      const results = await Promise.all(entries.map(async (name) => {
        const manifestPath = join(harnessesDir, name, 'papercusp.json');
        if (!existsSync(manifestPath)) return null;
        try {
          const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
          if (m.spawnable && typeof m.spawnable === 'object') {
            return {
              name: m.name ?? name,
              version: m.version ?? '0.0.0',
              description: m.description,
              spawnable: m.spawnable,
              source: 'local' as const,
            };
          }
        } catch { /* skip */ }
        return null;
      }));
      for (const r of results) if (r) localSpawnable.push(r);
    } catch { /* skip */ }
  }

  // Merge: local-installed overrides catalog entries with the same name.
  const catalogSpawnable = catalog
    .filter((t) => t && typeof t === 'object' && t.spawnable && typeof t.spawnable === 'object')
    .map((t) => ({ ...t, source: 'catalog' }));
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const t of localSpawnable) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    merged.push(t);
  }
  for (const t of catalogSpawnable) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    merged.push(t);
  }
  return { spawnable: merged };
}

export async function getSpawnableTemplates(): Promise<{ spawnable: any[] }> {
  const now = Date.now();
  const TTL_MS = 10_000;
  if (__spawnableCache.value && __spawnableCache.expires > now) return __spawnableCache.value;
  if (!__spawnableCache.inflight) {
    __spawnableCache.inflight = (async () => {
      const result = await computeSpawnableTemplates();
      __spawnableCache.value = result;
      __spawnableCache.expires = Date.now() + TTL_MS;
      __spawnableCache.inflight = null;
      return result;
    })();
  }
  return __spawnableCache.inflight;
}
