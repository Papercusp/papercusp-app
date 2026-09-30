/**
 * Action manifest format + env resolution for per-branch actions.
 *
 * Sources of actions:
 *   1. Harness-shipped:  <staging>/.papercusp/actions/<branch>/<name>.sh
 *      Optional manifest at  <staging>/.papercusp/actions/<branch>/<name>.manifest.json
 *
 *   2. Plugin-contributed: each enabled plugin's papercusp.json may declare a
 *      `branchActions` object. Keys are action names; values are full
 *      manifests including `branches` (which branches to expose on) and
 *      `scriptPath` (relative to the plugin install dir).
 *
 * Env resolution strategies:
 *   - { from: 'plugin', plugin, field }   → plugin-configs/<plugin>.json[field]
 *   - { from: 'config', field }           → (plugin actions only) the contributing
 *                                            plugin's own plugin-configs[field]
 *   - { from: 'harness', field }          → .papercusp/env.json[field]
 *   - { from: 'literal', value }          → that string verbatim
 *
 * Resolution returns both the resolved env dict and a list of `missing`
 * required entries — the API layer uses these to colour the UI chip.
 *
 * The dependency tracking is intentionally one-way: actions never *write*
 * back into plugin-configs. If a value is missing, we surface a "configure"
 * link to the existing plugin-config editor.
 */

import { promises as fs } from 'node:fs';
import { workspacesRoot } from './workspace-registry';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type EnvSource =
  | { from: 'plugin'; plugin: string; field: string; required?: boolean; description?: string }
  | { from: 'config'; field: string; required?: boolean; description?: string }
  | { from: 'harness'; field: string; required?: boolean; description?: string }
  | { from: 'literal'; value: string };

export interface ActionManifest {
  /** Human-friendly name shown in the menu (defaults to `name`). */
  displayName?: string;
  description?: string;
  /** Map of env-var-name → resolution strategy. */
  env?: Record<string, EnvSource>;
  /** Default 1800 (30min). */
  timeoutSec?: number;
}

/**
 * Plugin-contributed action manifest (script-based). Same shape as
 * ActionManifest plus which branches it shows up on and where the
 * script lives. Used by `branchActions` field.
 */
export interface PluginActionManifest extends ActionManifest {
  /** Branches this action should appear on. Default = all three. */
  branches?: Array<'staging' | 'testing' | 'production'>;
  /** Script path relative to the plugin install dir. Required. */
  scriptPath: string;
}

/**
 * Plugin-contributed button (URL-based). Plugins declare:
 *
 *   "buttons": {
 *     "staging":    { "build": "/api/plugins/@scope/myplug/build-staging" },
 *     "production": { "build": "/api/plugins/@scope/myplug/build-prod" }
 *   }
 *
 * Or with extra metadata:
 *
 *   "buttons": {
 *     "staging": {
 *       "build": {
 *         "url": "/api/plugins/@scope/myplug/build-staging",
 *         "displayName": "Build & deploy (staging)",
 *         "method": "POST"
 *       }
 *     }
 *   }
 *
 * The substrate POSTs (default) to `url` with JSON body:
 *   { harness, branch, button }
 *
 * Plugin handler can:
 *   - return text/event-stream (SSE) → substrate forwards lines to the
 *     xterm runner modal verbatim;
 *   - return application/json → substrate shows it as a one-line summary;
 *   - return text/plain or anything else → substrate shows the body.
 *
 * URL is relative to the operator's origin. Plugin authors typically
 * point at their own apiRoutes (mounted under /api/plugins/<slug>/...).
 */
export type ButtonDecl =
  | string
  | {
      url: string;
      method?: 'POST' | 'GET';
      displayName?: string;
      description?: string;
    };

export type ButtonsManifest = Partial<
  Record<'staging' | 'testing' | 'production', Record<string, ButtonDecl>>
>;

export function normalizeButtonDecl(d: ButtonDecl): {
  url: string; method: 'POST' | 'GET'; displayName?: string; description?: string;
} {
  if (typeof d === 'string') return { url: d, method: 'POST' };
  return { url: d.url, method: d.method ?? 'POST', displayName: d.displayName, description: d.description };
}

export interface MissingEnvEntry {
  name: string;
  from: EnvSource['from'];
  plugin?: string;
  field?: string;
  description?: string;
}

export interface EnvResolution {
  /** Env vars whose source resolved cleanly. */
  env: Record<string, string>;
  /** Required vars whose source was empty/absent — UI surfaces these. */
  missing: MissingEnvEntry[];
}

function harnessConfigDir(harnessSlug: string): string {
  // Mirrors lib/papercusp-root resolution. Cheap path resolution here so
  // this module is dependency-light and unit-testable.
  const env = process.env.PAPERCUSP_HOME;
  if (env) return join(env, 'harnesses', harnessSlug);
  // Active workspace per registry.json
  try {
    const idx = join(workspacesRoot(), 'registry.json');
    if (existsSync(idx)) {
      // We don't parse registry.json here — keep dep-light. The caller
      // (route handler) already passes the harnesses dir down via the
      // env or by calling resolveEnv with explicit `harnessConfigsDir`.
    }
  } catch { /* ignore */ }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DEFAULT_WORKSPACE_ID } = require('./workspace-registry') as typeof import('./workspace-registry');
  return join(workspacesRoot(), DEFAULT_WORKSPACE_ID, '.papercusp', 'harnesses', harnessSlug);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T;
  } catch { return null; }
}

/**
 * Resolve a manifest's env requirements. Caller passes the harness's
 * config dir (where `plugin-configs/` and `env.json` live). For
 * plugin-contributed actions, pass `contributingPlugin` so `from: 'config'`
 * can resolve to that plugin's own config.
 */
export async function resolveEnv(
  manifest: ActionManifest | undefined,
  args: {
    harnessConfigsDir: string;
    contributingPlugin?: string;
    /** Per-request readJson cache. When the caller is resolving env
     *  across many actions in parallel (e.g. /branch/<x>/actions),
     *  pass a shared Map to dedupe reads of the same plugin-config
     *  and env.json files across all calls. See /docs/performance #A1. */
    readCache?: Map<string, Promise<unknown>>;
  },
): Promise<EnvResolution> {
  const out: EnvResolution = { env: {}, missing: [] };
  if (!manifest?.env) return out;

  // Local cache covers within-this-call dedup even when no shared cache
  // is passed. The same plugin-config file is often referenced by
  // multiple env entries on the same manifest.
  const cache = args.readCache ?? new Map<string, Promise<unknown>>();
  const cachedReadJson = <T>(path: string): Promise<T | null> => {
    let p = cache.get(path);
    if (!p) {
      p = readJson(path);
      cache.set(path, p);
    }
    return p as Promise<T | null>;
  };

  // Resolve every entry in parallel — independent reads.
  const resolved = await Promise.all(
    Object.entries(manifest.env).map(async ([name, src]) => {
      if (src.from === 'literal') {
        return { name, value: src.value, missing: false as const };
      }

      let value: string | undefined;

      if (src.from === 'plugin') {
        const cfg = await cachedReadJson<Record<string, unknown>>(
          join(args.harnessConfigsDir, 'plugin-configs', `${src.plugin}.json`),
        );
        const v = cfg?.[src.field];
        if (typeof v === 'string' && v.length > 0) value = v;
      } else if (src.from === 'config') {
        if (!args.contributingPlugin) {
          return src.required
            ? { name, missing: true as const, src }
            : { name, missing: false as const, value: undefined };
        }
        const cfg = await cachedReadJson<Record<string, unknown>>(
          join(args.harnessConfigsDir, 'plugin-configs', `${args.contributingPlugin}.json`),
        );
        const v = cfg?.[src.field];
        if (typeof v === 'string' && v.length > 0) value = v;
      } else if (src.from === 'harness') {
        const env = await cachedReadJson<Record<string, unknown>>(
          join(args.harnessConfigsDir, 'env.json'),
        );
        const v = env?.[src.field];
        if (typeof v === 'string' && v.length > 0) value = v;
      }

      return { name, value, src, missing: false as const };
    }),
  );

  for (const r of resolved) {
    if (r.value !== undefined) {
      out.env[r.name] = r.value;
    } else if (r.missing || ('src' in r && r.src && 'required' in r.src && r.src.required)) {
      const src = ('src' in r ? r.src : undefined) as { from?: string; plugin?: string; field?: string; description?: string } | undefined;
      if (src) {
        out.missing.push({
          name: r.name,
          from: src.from as 'plugin' | 'config' | 'harness',
          plugin: src.from === 'plugin' ? src.plugin : (src.from === 'config' ? args.contributingPlugin : undefined),
          field: src.field,
          description: src.description,
        });
      }
    }
  }
  return out;
}

/** Read an inline action manifest sibling to `<name>.sh`. */
export async function readInlineManifest(
  stagingPath: string, branch: string, name: string,
): Promise<ActionManifest | null> {
  return readJson<ActionManifest>(
    join(stagingPath, '.papercusp', 'actions', branch, `${name}.manifest.json`),
  );
}

// re-exported so the test file can stub.
export const __test = { harnessConfigDir };
