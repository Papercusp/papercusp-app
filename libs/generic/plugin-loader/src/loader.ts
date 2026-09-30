/**
 * Generic plugin-loader kernel — the filesystem → typed-plugin pipeline,
 * with every host-specific decision injected through a ports object.
 *
 * The control flow it owns (per candidate directory):
 *
 *   1. read + validate the manifest        (ports.readManifest)
 *   2. if there's no identity-bearing manifest:
 *        - has an entry file?  → "missing/invalid manifest" error
 *        - otherwise           → silently skip (not-a-plugin dir)
 *   3. optional alternate-runtime dispatch  (ports.runtimeDispatch)
 *        e.g. wasm/daemon manifests that need no JS entry — return a
 *        ready result (or an error), or null to fall through to step 4.
 *   4. locate the entry module              (ports.locateEntry)
 *   5. import it → a plugin object          (ports.importEntry | default)
 *   6. validate the plugin vs its manifest  (ports.validatePlugin)
 *
 * Plus discovery: walk a set of search roots (with optional npm-style
 * `@scope/` recursion), load every candidate, and dedupe by plugin name
 * with first-seen-wins precedence (the host orders the roots so the
 * higher-precedence source comes first).
 *
 * Domain-free: the lib names no manifest fields, no runtime kinds, no
 * search-path convention — those all live in the ports the host supplies.
 * Depends only on `node:fs` / `node:path` / `node:module`.
 */
import { promises as fs, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

/** A successfully loaded plugin: the imported object plus its manifest + provenance. */
export interface LoadedPlugin<TPlugin, TManifest> {
  plugin: TPlugin;
  manifest: TManifest;
  /** Absolute dir of the plugin. */
  path: string;
  /** Provenance label the host attached to the search root (e.g. 'project'). */
  source: string;
}

export type LoadFromDirResult<TPlugin, TManifest> =
  | LoadedPlugin<TPlugin, TManifest>
  | { error: string; path: string }
  | { skipped: 'not-a-plugin'; path: string };

/** Marker a `readManifest` port returns when a manifest exists but is invalid. */
export interface ManifestError {
  __error: string;
}

export interface PluginLoaderPorts<TPlugin, TManifest> {
  /**
   * Read + parse + validate the manifest in `dir`. Return:
   *   - the parsed manifest             → proceed,
   *   - `{ __error }`                   → present-but-invalid (hard error),
   *   - `null`                          → no identity-bearing manifest here.
   */
  readManifest(dir: string): Promise<TManifest | ManifestError | null>;
  /** Locate the entry module in `dir`, or null if none exists. */
  locateEntry(dir: string): Promise<string | null>;
  /**
   * Import the entry module → plugin object. Returns the plugin, an
   * `{ error }` (import threw), or `null` (resolved to a non-object).
   * Defaults to {@link defaultImportEntry} (Node `createRequire`).
   */
  importEntry?(entryPath: string): Promise<TPlugin | { error: string } | null>;
  /**
   * Optional pre-entry dispatch for manifests that opt into an alternate
   * runtime (no JS entry needed). Return a ready {@link LoadedPlugin}, an
   * `{ error }`, or `null` to fall through to the JS entry path.
   */
  runtimeDispatch?(
    manifest: TManifest,
    path: string,
    source: string,
  ): Promise<LoadedPlugin<TPlugin, TManifest> | { error: string; path: string } | null>;
  /** Validate the imported plugin against its manifest; return an error string or null. */
  validatePlugin?(plugin: TPlugin, manifest: TManifest): Promise<string | null> | string | null;
  /** Extract the dedupe key (the plugin's unique name). */
  pluginName(plugin: TPlugin): string;
  /** Error message when a manifest is missing/invalid but the dir has an entry. */
  invalidManifestError?: string;
  /** Error message when no entry module is found in a manifest-bearing dir. */
  noEntryError?: string;
}

/** One discovery root: a directory whose immediate subdirs are plugin candidates. */
export interface DiscoverRoot {
  /** Directory to list (each subdir is a candidate plugin). */
  pluginsDir: string;
  /** Provenance label propagated onto every plugin found here. */
  source: string;
  /**
   * When true, a subdir whose name starts with `@` is treated as an
   * npm-style scope dir: its children become candidates instead of the
   * scope dir itself (which carries no manifest).
   */
  scopeRecurse?: boolean;
}

/**
 * Bundler-opaque dynamic import via Node's `createRequire`. Webpack /
 * Turbopack refuse to compile a bare `import(varURL)` because they
 * statically scan all `import(...)` calls; `createRequire` delegates to
 * Node's native resolver, which bundlers don't follow into.
 *
 * Caveat: handles CommonJS. ESM plugins must compile to CJS (or ship a
 * `.cjs` alongside an `.mjs`).
 */
export async function defaultImportEntry<TPlugin>(
  entryPath: string,
): Promise<TPlugin | { error: string } | null> {
  try {
    const req = createRequire(entryPath);
    const mod = req(entryPath);
    const candidate = mod?.default ?? mod;
    if (!candidate || typeof candidate !== 'object') return null;
    return candidate as TPlugin;
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * List the immediate subdirectories of `parent`, following symlinks
 * (dev-mode pattern: symlinking a plugin repo into a plugins dir) and
 * skipping dotfiles. Returns [] when `parent` doesn't exist.
 */
export async function listSubdirs(parent: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try {
          const st = await fs.stat(join(parent, e.name));
          isDir = st.isDirectory();
        } catch {
          /* dangling symlink — skip */
        }
      }
      if (isDir) out.push(join(parent, e.name));
    }
    return out;
  } catch {
    return [];
  }
}

export interface PluginLoader<TPlugin, TManifest> {
  /** Load a single plugin from a known directory. */
  loadFromDir(dir: string, source: string): Promise<LoadFromDirResult<TPlugin, TManifest>>;
  /**
   * Discover and load every plugin reachable from the given roots,
   * deduped by plugin name (first-seen wins — order roots by precedence).
   */
  loadAll(roots: DiscoverRoot[]): Promise<{
    loaded: Array<LoadedPlugin<TPlugin, TManifest>>;
    errors: Array<{ error: string; path: string }>;
  }>;
}

/** Build a plugin loader bound to one set of host ports. */
export function createPluginLoader<TPlugin, TManifest>(
  ports: PluginLoaderPorts<TPlugin, TManifest>,
): PluginLoader<TPlugin, TManifest> {
  const importEntry = ports.importEntry ?? ((p: string) => defaultImportEntry<TPlugin>(p));

  async function loadFromDir(
    dir: string,
    source: string,
  ): Promise<LoadFromDirResult<TPlugin, TManifest>> {
    const path = resolve(dir);
    const manifest = await ports.readManifest(path);
    // A directory with neither manifest nor entry point isn't a
    // misconfigured plugin — it's not a plugin dir at all. Skip silently
    // instead of polluting the error log.
    if (!manifest) {
      const entry = await ports.locateEntry(path);
      if (!entry) return { skipped: 'not-a-plugin', path };
      return { error: ports.invalidManifestError ?? 'missing or invalid manifest', path };
    }
    if (typeof manifest === 'object' && '__error' in manifest) {
      return { error: (manifest as ManifestError).__error, path };
    }

    // Alternate-runtime manifests (e.g. wasm/daemon) can short-circuit the
    // JS entry/import/validate path entirely.
    if (ports.runtimeDispatch) {
      const dispatched = await ports.runtimeDispatch(manifest as TManifest, path, source);
      if (dispatched) return dispatched;
      // null → fall through to the JS path.
    }

    const entry = await ports.locateEntry(path);
    if (!entry) return { error: ports.noEntryError ?? 'no entry point found', path };
    const imported = await importEntry(entry);
    if (!imported) return { error: `import returned null/non-object from ${entry}`, path };
    if (typeof imported === 'object' && 'error' in imported) {
      return { error: `import threw at ${entry}: ${(imported as { error: string }).error}`, path };
    }
    const plugin = imported as TPlugin;
    if (ports.validatePlugin) {
      const validationError = await ports.validatePlugin(plugin, manifest as TManifest);
      if (validationError) return { error: validationError, path };
    }
    return { plugin, manifest: manifest as TManifest, path, source };
  }

  async function loadAll(roots: DiscoverRoot[]): Promise<{
    loaded: Array<LoadedPlugin<TPlugin, TManifest>>;
    errors: Array<{ error: string; path: string }>;
  }> {
    const loaded: Array<LoadedPlugin<TPlugin, TManifest>> = [];
    const errors: Array<{ error: string; path: string }> = [];

    // Collect candidate directories in root order, then subdir order.
    const candidates: Array<{ dir: string; source: string }> = [];
    for (const root of roots) {
      for (const d of await listSubdirs(root.pluginsDir)) {
        if (root.scopeRecurse && basename(d).startsWith('@')) {
          // npm-style scope dir holds one or more plugins; each child is a
          // candidate, not the scope dir itself.
          for (const child of await listSubdirs(d)) {
            candidates.push({ dir: child, source: root.source });
          }
          continue;
        }
        candidates.push({ dir: d, source: root.source });
      }
    }

    // Load each; dedupe by plugin name (first-seen wins).
    const seen = new Set<string>();
    for (const c of candidates) {
      const result = await loadFromDir(c.dir, c.source);
      if ('skipped' in result) continue;
      if ('error' in result) {
        errors.push(result);
        continue;
      }
      const name = ports.pluginName(result.plugin);
      if (seen.has(name)) continue;
      seen.add(name);
      loaded.push(result);
    }

    return { loaded, errors };
  }

  return { loadFromDir, loadAll };
}
