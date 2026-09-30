/**
 * Phase 6b item 2 — apiRoutes mounting.
 *
 * Discovers loaded plugins on first call and registers each plugin's
 * `apiRoutes` (a Hono app or any object with a `fetch(req)` method)
 * into an in-memory registry keyed by safe-name.
 *
 * `dispatchPluginApiRoute(req)` resolves the requested plugin by the
 * first `/api/plugins/<name>/…` path segment and forwards the request to
 * that plugin's `apiRoutes` handler. It returns `null` when the segment
 * is not a registered plugin, so the `/plugins/*` `defineTool` catch-all
 * (`routes/plugins/catchall.ts`) can fall through to projected-tool
 * dispatch. We use runtime dispatch instead of `Hono.mount(...)` because
 * Hono's `app.route(prefix, sub)` snapshots the sub-app's routes at
 * registration time — late mounts (after server boot or after a
 * hot-reload reset) silently no-op.
 *
 * Plugin authors expose `apiRoutes` in their manifest as a Hono app. The
 * SDK types this as `unknown` (to keep the SDK Hono-version-agnostic);
 * we duck-type at registration time and skip plugins that don't expose
 * a Hono-shaped `fetch` handler.
 */
import { loadPlugins, type LoadedPlugin } from '@papercusp/plugin-loader';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';

import { papercuspPath } from './papercusp-root';
interface ApiRouteHandle {
  fetch: (req: Request, ...rest: any[]) => Promise<Response> | Response;
}

function looksLikeHonoApp(x: unknown): x is ApiRouteHandle {
  return typeof x === 'object' && x !== null && typeof (x as any).fetch === 'function';
}

function discoverHarnessSlugs(): string[] {
  const harnessRoot = papercuspPath('harnesses');
  if (!existsSync(harnessRoot)) return [];
  try {
    return readdirSync(harnessRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Realm-pinned so HMR module reloads don't lose mounts. Pinned through
// @papercusp/module-singleton rather than a hand-rolled `globalThis[key]` pair:
// hand-rolling shares correctly but is invisible to listModuleDuplications(),
// which then answers a confident `[]` while this module is split
// (EI-19479108855357092).
type Result = { mounted: number; skipped: number; errors: string[] };
type Registry = Map<string, ApiRouteHandle>;
type CacheShape = { promise: Promise<Result> | null; counts: Result | null; registry: Registry };
const __cache = pinModuleState<CacheShape>(
  '@papercusp/operator-core.pluginApiMount',
  () => ({ promise: null, counts: null, registry: new Map() }),
);

export interface MountPluginApiRoutesOptions {
  /** Override the global-plugins discovery directory (tests). */
  globalPluginsDir?: string;
  /** Override the harness-slug list (tests). Defaults to scanning ~/.papercusp/harnesses. */
  harnessSlugs?: string[];
}

/**
 * Build / refresh the in-memory plugin-apiRoutes registry. Idempotent
 * after first call until `_resetPluginApiRoutesForTests()` is invoked.
 * Dispatch into the registry happens via `dispatchPluginApiRoute`.
 */
export function mountPluginApiRoutes(opts: MountPluginApiRoutesOptions = {}): Promise<{ mounted: number; skipped: number; errors: string[] }> {
  if (__cache.promise) return __cache.promise;

  __cache.promise = (async () => {
    const errors: string[] = [];
    let mounted = 0;
    let skipped = 0;
    __cache.registry.clear();

    let discovered: { loaded: LoadedPlugin[]; errors: Array<{ error: string; path: string }> };
    try {
      discovered = await loadPlugins({
        globalPluginsDir: opts.globalPluginsDir,
        harnessSlugs: opts.harnessSlugs ?? discoverHarnessSlugs(),
      });
    } catch (e: any) {
      errors.push(`plugin discovery failed: ${e?.message ?? String(e)}`);
      const result = { mounted: 0, skipped: 0, errors };
      __cache.counts = result;
      return result;
    }

    for (const lp of discovered.loaded) {
      const apiRoutes = lp.plugin.apiRoutes;
      if (apiRoutes === undefined || apiRoutes === null) {
        skipped++;
        continue;
      }
      if (!looksLikeHonoApp(apiRoutes)) {
        errors.push(`plugin "${lp.plugin.name}" apiRoutes is not Hono-shaped (no .fetch); skipping`);
        skipped++;
        continue;
      }
      const safeName = lp.plugin.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      __cache.registry.set(safeName, apiRoutes);
      mounted++;
    }

    for (const err of discovered.errors) {
      // "no entry point found" is the loader's signal that this plugin has
      // no JS surface — i.e. it's a provision-only plugin (declarative
      // resources + scripts, capabilities like compute:exec:wrangler).
      // Those are valid; the loader should treat absence-of-entry-point as
      // "skip silently" rather than "error". Demote to info-level so it
      // doesn't show up in the boot-time `errors=N` count and stop the
      // log spam from every cold render walking global-plugins/.
      // Real errors (corrupt manifest, missing dependency at a present
      // entry point) keep the original error path.
      if (/no entry point found/i.test(err.error)) {
         
        console.info(`[plugin-mount] skipping provision-only plugin at ${err.path}`);
        skipped++;
        continue;
      }
      errors.push(`plugin discovery error at ${err.path}: ${err.error}`);
    }

    const result = { mounted, skipped, errors };
    __cache.counts = result;
    return result;
  })();

  return __cache.promise;
}

async function ensureRegistryBuilt(): Promise<void> {
  if (__cache.promise) {
    await __cache.promise;
    return;
  }
  // Lazy rebuild: install/uninstall reset paths clear the cache and don't
  // re-call mountPluginApiRoutes themselves. We rehydrate on first dispatch.
  await mountPluginApiRoutes();
}

/**
 * Resolve a `/api/plugins/<name>/…` request to a registered plugin's
 * `apiRoutes` handler and forward to it. Returns the plugin's `Response`,
 * or `null` when the first path segment is not a registered plugin — the
 * `/plugins/*` `defineTool` catch-all then falls through to projected-
 * tool dispatch.
 *
 * Relocated from the Hono-sub-app `installPluginApiDispatcher` mutation
 * (endpoint-hono-elimination-2026-05-21 A3). The old dispatcher yielded
 * via Hono `next()`; a `defineTool` handler cannot yield, so the
 * fall-through is expressed as a `null` return the catch-all checks.
 */
export async function dispatchPluginApiRoute(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  // pathname is `/api/plugins/<name>` or `/api/plugins/<name>/<rest>`.
  const m = url.pathname.match(/\/plugins\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  const name = decodeURIComponent(m[1]);
  await ensureRegistryBuilt();
  const handle = __cache.registry.get(name);
  // Registry miss → not a plugin-contributed apiRoute. Return null so the
  // caller falls through to literal routes / projected-tool dispatch.
  if (!handle) return null;
  // Hand the inner handler a Request stripped of the `/api/plugins/<name>`
  // prefix so its own internal routing matches the way it does in
  // standalone tests.
  const rest = m[2] ?? '/';
  const innerReq = new Request(url.origin + rest + url.search, req);
  return handle.fetch(innerReq);
}

/** Inspector for tests / health endpoints — null until first mount completes. */
export function pluginApiRoutesStatus() {
  return __cache.counts;
}

/** Read-only view of the registry — used by diagnostics. */
export function pluginApiRegistryNames(): string[] {
  return Array.from(__cache.registry.keys()).sort();
}

/** Resets the cache. Tests use this to re-mount with different fixtures. */
export function _resetPluginApiRoutesForTests() {
  __cache.promise = null;
  __cache.counts = null;
  __cache.registry.clear();
}
