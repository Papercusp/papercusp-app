/**
 * @papercusp/plugin-loader — discovers + loads plugins from disk.
 *
 * Plugins are directories that contain:
 *   - papercusp.json       manifest with name + version
 *   - index.{ts,js,mjs}    default-exports a Plugin
 *
 * The loader doesn't actually mount API routes or render dashboard tabs —
 * those happen in the harness API + UI hosts that consume this loader's
 * output. This module is just the file-system → typed-Plugin pipeline.
 *
 * Search paths (in order):
 *   1. <projectDir>/plugins/<name>/
 *   2. ~/.papercusp/harnesses/<harness-slug>/plugins/<name>/
 *   3. ~/.papercusp/global-plugins/<name>/
 */
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Resolve the active Papercusp root. The substrate moved to per-workspace
 * storage at ~/.papercusp-workspaces/<id>/.papercusp/. This mirrors the
 * resolver used in the operator and CLI so the loader picks up plugins
 * from the right location regardless of where it's invoked from.
 *
 * Cached per-call with mtime invalidation: if registry.json changes (the
 * Tauri shell rewrites it on workspace switch), the next call picks up
 * the new `current` workspace without a process restart. Mirrors the
 * mtime-aware caching in apps/operator/lib/papercusp-root.ts.
 */
import { statSync } from 'node:fs';
interface __RootCache { mtime: number; content: string | null; env: string | undefined; value: string }
let __rootCache: __RootCache | null = null;

/**
 * Resolve the workspaces root (`~/.papercusp-workspaces`), honoring
 * `PAPERCUSP_WORKSPACES_ROOT` before falling back to `homedir()`.
 *
 * Spawned CLI children can run with `HOME` remapped to a per-workspace dir
 * (P-051); a bare `homedir()` there resolves to a NESTED registry
 * (`~/.papercusp-workspaces/<current>/.papercusp-workspaces/registry.json`)
 * that disagrees with the real one — the documented "switch failed:
 * workspace dir ... missing" trap (agent-insights/workspaces-root-vs-remapped-home).
 * `homedir()` alone is correct only in dev, where HOME is not remapped.
 *
 * Mirrors `workspacesRoot()` in `@papercusp/operator-core`'s
 * `workspace-registry.ts`, kept local rather than imported to avoid pulling
 * operator-core's server-oriented module graph into the plugin loader.
 */
function workspacesRootDir(): string {
  const env = process.env.PAPERCUSP_WORKSPACES_ROOT;
  if (env && env.trim()) return env;
  return join(homedir(), '.papercusp-workspaces');
}

function papercuspRootResolved(): string {
  // Build the current cache key.
  const wsIndex = join(workspacesRootDir(), 'registry.json');
  let mtime = 0;
  let content: string | null = null;
  try {
    mtime = statSync(wsIndex).mtimeMs;
    content = readFileSync(wsIndex, 'utf8');
  } catch { /* missing — both stay zero/null */ }
  const env = process.env.PAPERCUSP_HOME;
  if (
    __rootCache
    && __rootCache.mtime === mtime
    && __rootCache.content === content
    && __rootCache.env === env
  ) {
    return __rootCache.value;
  }

  let value: string;
  if (env) {
    value = env;
  } else if (content) {
    try {
      const parsed = JSON.parse(content) as { current?: string };
      if (parsed.current) {
        const cand = join(workspacesRootDir(), parsed.current, '.papercusp');
        if (existsSync(cand)) {
          value = cand;
        } else {
          value = fallbackRoot();
        }
      } else {
        value = fallbackRoot();
      }
    } catch {
      value = fallbackRoot();
    }
  } else {
    value = fallbackRoot();
  }

  __rootCache = { mtime, content, env, value };
  return value;
}

function fallbackRoot(): string {
  const def = join(workspacesRootDir(), 'default', '.papercusp');
  if (existsSync(def)) return def;
  return join(homedir(), '.papercusp');
}
import type { Plugin } from '@papercusp/plugin-sdk';
import {
  createPluginLoader,
  satisfies,
  type LoadedPlugin as CoreLoadedPlugin,
  type DiscoverRoot,
} from '@papercusp/plugin-loader-core';

// Lazy + cached read of PAPERCUSP_RUNTIME_VERSION. Top-level destructure of
// the CJS-loaded plugin-sdk namespace yields undefined under Node 25 + tsx
// 4.21 (the named export is on `.default` and named-binding attachment
// happens after the importing module has already evaluated). Reading it
// inside an async function works because the namespace is fully populated
// by then.
let _runtimeVersion: string | undefined;
async function getRuntimeVersion(): Promise<string> {
  // Escape hatch (incident-response only — see /docs/spec/plugin-migration):
  // PAPERCUSP_RUNTIME_VERSION_OVERRIDE makes the loader treat that string as
  // the runtime version when validating plugin ranges. Read on every call so
  // operators can flip it via env without restarting the host.
  const override = process.env.PAPERCUSP_RUNTIME_VERSION_OVERRIDE;
  if (override && override.length > 0) return override;
  if (_runtimeVersion) return _runtimeVersion;
  const sdk = await import('@papercusp/plugin-sdk');
  const v = (sdk as { PAPERCUSP_RUNTIME_VERSION?: string }).PAPERCUSP_RUNTIME_VERSION
    ?? (sdk as { default?: { PAPERCUSP_RUNTIME_VERSION?: string } }).default?.PAPERCUSP_RUNTIME_VERSION;
  if (!v) throw new Error('plugin-loader: @papercusp/plugin-sdk did not export PAPERCUSP_RUNTIME_VERSION');
  _runtimeVersion = v;
  return v;
}

export interface LoadedPlugin {
  plugin: Plugin;
  path: string;             // absolute dir of the plugin
  source: 'project' | 'harness' | 'global';
  /** Tool declarations parsed from the plugin's papercusp.json manifest. */
  toolDefinitions?: import('@papercusp/plugin-sdk').ToolDefinition[];
  /**
   * Runtime descriptor parsed from manifest. WASM/daemon plugins carry
   * the absolute wasmPath / daemonCommand so the operator's host can
   * dispatch at enable time without re-reading the manifest. JS plugins
   * default to `{ kind: 'js' }`.
   */
  runtime?: import('@papercusp/plugin-sdk').PluginRuntime;
  /** Declarative reaction rules parsed from the manifest (merged with the entry plugin's `reactions` by `collectReactionRules`). */
  manifestReactions?: import('@papercusp/plugin-sdk').PluginReactionRule[];
  /** Pure-data external source → plan-template declaration (never armed by discovery). */
  triggerPack?: import('@papercusp/plugin-sdk').PluginTriggerPack;
}

export interface LoaderOptions {
  projectDir?: string;       // <project>/plugins/<name>/
  harnessSlugs?: string[];   // ~/.papercusp/harnesses/<slug>/plugins/
  globalPluginsDir?: string; // override ~/.papercusp/global-plugins/
}

// PAPERCUSP_ROOT is intentionally NOT cached at module-load — see
// papercuspRootResolved() above. Each loadPlugins() call resolves fresh
// (with mtime cache) so workspace switches don't need a server restart.

interface ManifestShape {
  name: string;
  version: string;
  description?: string;
  papercusp?: string;
  kind?: import('@papercusp/plugin-sdk').Plugin['kind'];
  capabilities?: string[];
  /** Install/consent-canonical action declarations. Runtime handlers bind by name. */
  actions?: import('@papercusp/plugin-sdk').ActionDefinition[];
  configSchema?: Record<string, unknown>;
  oauth?: import('@papercusp/plugin-sdk').PluginOAuthRequirement[];
  /** MCP tool declarations. Handlers live on the plugin's `tools` export. */
  tools?: import('@papercusp/plugin-sdk').ToolDefinition[];
  /**
   * Optional multi-runtime descriptor. Omitted = JS plugin (existing
   * behavior). 'wasm' / 'daemon' route through alternate loaders.
   * See @papercusp/plugin-sdk PluginRuntime.
   */
  runtime?: import('@papercusp/plugin-sdk').PluginRuntime;
  /**
   * UI contributions parsed from the manifest. The `type` field
   * distinguishes React (in-bundle) from iframe surfaces (Batch H).
   */
  ui?: import('@papercusp/plugin-sdk').UiSurfaceManifestEntry[];
  /** Manifest-driven dashboard contributions (runtime exports may add component functions). */
  dashboardTabs?: Array<Record<string, unknown> & { id: string }>;
  /** Manifest-driven sidebar contributions (runtime exports may add badge functions). */
  sidebarItems?: Array<Record<string, unknown> & { id: string }>;
  /**
   * Declarative event-reaction rules (plugin-system-hive-port D-003 / P-005).
   * The manifest carries the declarative subset only (data-match `when`,
   * static `args` — enforced by the JSON schema); function forms live on the
   * entry plugin's `reactions` export. Merged by `collectReactionRules`.
   */
  reactions?: import('@papercusp/plugin-sdk').PluginReactionRule[];
  /**
   * Event-key families this unit PROVIDES + the ones it DEPENDS ON — the
   * events-as-a-dependency axis (cupboard-public-release-2026-07-12 D-003 /
   * P-005). Pure data (a kind:'pack' may declare them); the installed-tier
   * events:catalog (P-006) + resolver (P-007) consume `provides.events`, and
   * install-time dep validation (P-007) consumes `dependencies.events`.
   */
  provides?: import('@papercusp/plugin-sdk').ManifestProvides;
  dependencies?: import('@papercusp/plugin-sdk').ManifestDependencies;
  /** Pure-data trigger-pack declaration (external-triggers P-012). */
  triggerPack?: import('@papercusp/plugin-sdk').PluginTriggerPack;
}

async function readManifest(dir: string): Promise<ManifestShape | { __error: string } | null> {
  try {
    const raw = await fs.readFile(join(dir, 'papercusp.json'), 'utf8');
    const parsed = JSON.parse(raw) as ManifestShape;
    if (!parsed?.name || !parsed?.version) return null;
    // Strict-validate against the JSON schema (Batch A1/A2 — manifest
    // hardening). Refusal here is a hard load failure: a typo'd field
    // name silently doing nothing is the bug we're fixing. Lazy-import
    // so the validator (and ajv) only loads on first manifest read.
    const { validateManifest } = await import('./manifest-validate');
    const r = validateManifest(parsed);
    if (!r.ok) {
      const summary = r.issues.map((i) => `${i.path} — ${i.message}`).join('; ');
      return { __error: `manifest invalid: ${summary}` };
    }
    // Semantic cross-field check the JSON schema can't express: provides.events
    // family uniqueness + keyTemplate↔params consistency, dependencies.events
    // family presence (events-as-a-dependency axis, D-003 / P-005). Runs for
    // every manifest — js / wasm / daemon — since they all funnel through here.
    const { validateManifestEventDeclarations, validateTriggerPackDeclaration } = await import('@papercusp/plugin-sdk');
    const evtIssues = validateManifestEventDeclarations(parsed);
    if (evtIssues.length > 0) {
      return { __error: `manifest invalid: ${evtIssues.join('; ')}` };
    }
    const triggerPackIssues = validateTriggerPackDeclaration(parsed);
    if (triggerPackIssues.length > 0) {
      return { __error: `manifest invalid: ${triggerPackIssues.join('; ')}` };
    }
    if (parsed.triggerPack) {
      for (const target of parsed.triggerPack.targets) {
        if (target.kind !== 'plan') continue;
        const planPath = resolve(dir, target.path);
        if (!planPath.startsWith(resolve(dir) + sep) || !existsSync(planPath)) {
          return {
            __error: `manifest invalid: triggerPack plan target "${target.id}" does not resolve to a bundled file (${target.path})`,
          };
        }
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

async function locateEntry(dir: string): Promise<string | null> {
  // Prefer compiled .js over source .ts. Reason: bundled runtimes (Next.js
  // Turbopack, webpack standalone) can dynamic-import .js but not .ts at
  // runtime. When both exist, .js is the runtime-canonical artifact and
  // .ts is just for editor tooling.
  const candidates = [
    // Prefer `.cjs` for plugins whose package.json declares `type: module`
    // — `.js` is interpreted as ESM there and our CJS createRequire path
    // would fail to bind `module.exports`. The runtime tries each in order;
    // first hit wins.
    'index.cjs',
    join('dist', 'index.cjs'),
    'index.js',
    'index.mjs',
    join('dist', 'index.js'),
    'index.ts',
    join('src', 'index.ts'),
  ];
  for (const c of candidates) {
    const p = join(dir, c);
    if (existsSync(p)) return p;
  }
  return null;
}

// Bundler-opaque dynamic import. Webpack/Turbopack refuse to compile a bare
// `import(varURL)` (or even `new Function('return import(...)')()`) because
// they statically scan all `import(...)` calls. We use Node's createRequire
// which delegates to Node's native module resolver — bundlers don't try to
// reach inside `module.createRequire(...)` to follow what gets required.
//
// Caveat: createRequire only handles CommonJS. ESM plugins must compile to
// CJS (or ship .cjs alongside .mjs). For the v1 plugin loader, plugins are
// expected to ship CJS-compatible artifacts.
import { createRequire } from 'node:module';

async function importPluginEntry(entryPath: string): Promise<Plugin | { error: string } | null> {
  try {
    const req = createRequire(entryPath);
    const mod = req(entryPath);
    const candidate = mod?.default ?? mod;
    if (!candidate || typeof candidate !== 'object') return null;
    if (typeof (candidate as any).name !== 'string') return null;
    return candidate as Plugin;
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}

/**
 * Wire-protocol version. Separate from the runtime release version so
 * lifecycle hooks + cap shapes can evolve without forcing every plugin
 * to bump its `papercusp` range. Plugins declare `protocol: '^1.0'` in
 * their manifest; the loader refuses loads outside the declared range.
 * Bump on backwards-incompatible changes to the wire protocol only.
 */
export const PROTOCOL_VERSION = '1.0.0';

async function validate(plugin: Plugin, manifest: ManifestShape): Promise<string | null> {
  if (plugin.name !== manifest.name) return `manifest.name "${manifest.name}" doesn't match plugin.name "${plugin.name}"`;
  if (plugin.version !== manifest.version) return `manifest.version "${manifest.version}" doesn't match plugin.version "${plugin.version}"`;
  // Runtime version constraint — plugins declare `papercusp: '<range>'` in
  // their manifest. Refuse to load if the host's runtime is outside the
  // declared range. Plugins that omit `papercusp` are considered legacy and
  // allowed (with a future-deprecation warning expected at the host).
  const range = (plugin as unknown as { papercusp?: string }).papercusp ?? manifest.papercusp;
  if (range) {
    const runtimeVersion = await getRuntimeVersion();
    if (!satisfies(runtimeVersion, range)) {
      return `plugin "${plugin.name}" requires papercusp runtime "${range}" but host is "${runtimeVersion}"`;
    }
  }
  // Wire-protocol version (Batch E1, Rust-port-feedback item 7). Separate
  // from the runtime version so hooks can evolve independently of release
  // cycles. Pinned to "1.0" today; future bumps will refuse loads from
  // plugins that don't declare a compatible range.
  const protocolRange = (plugin as unknown as { protocol?: string }).protocol ?? (manifest as { protocol?: string }).protocol;
  if (protocolRange) {
    if (!satisfies(PROTOCOL_VERSION, protocolRange)) {
      return `plugin "${plugin.name}" requires plugin-protocol "${protocolRange}" but host implements "${PROTOCOL_VERSION}"`;
    }
  }
  // papercusp.json is the install + consent boundary, so it is the canonical
  // source for declarative permissions. The entry export is a runtime carrier,
  // not a second permission manifest; reconcileManifestDeclarations() below
  // projects this exact list onto the loaded Plugin and drops export-only caps.
  const declaredCapabilities = manifest.capabilities ?? [];
  // Validate UI surfaces require the right cap, per entry type. react/iframe
  // panes are desktop surfaces gated by ui:harness-route; tui-pane panes are
  // pui surfaces gated by ui:tui-pane and must carry a non-empty `command`
  // (revive-plugin-system-2026-06-04 D-002). The exec-gate on command[0]
  // (compute:exec:<bin>) is enforced at the resolution endpoint.
  if (Array.isArray(manifest.ui) && manifest.ui.length > 0) {
    const entries = manifest.ui as Array<{ type?: string; slug?: string; command?: unknown }>;
    const hasDesktopSurface = entries.some((u) => (u.type ?? 'react') !== 'tui-pane');
    if (hasDesktopSurface && !declaredCapabilities.includes('ui:harness-route')) {
      return `plugin "${plugin.name}" declares a react/iframe ui contribution but lacks capability "ui:harness-route"`;
    }
    const tuiPanes = entries.filter((u) => u.type === 'tui-pane');
    if (tuiPanes.length > 0 && !declaredCapabilities.includes('ui:tui-pane')) {
      return `plugin "${plugin.name}" declares a tui-pane ui contribution but lacks capability "ui:tui-pane"`;
    }
    for (const u of tuiPanes) {
      if (!Array.isArray(u.command) || u.command.length === 0 || typeof u.command[0] !== 'string') {
        return `plugin "${plugin.name}" tui-pane "${u.slug ?? '?'}" must declare a non-empty string[] \`command\``;
      }
    }
    // React is the one UI form whose live component cannot exist in JSON.
    // Resolve that structural boundary by identity at load time: every
    // manifest-declared React surface must have a same-slug runtime component.
    const exportedUi = normalizeDeclarationRecords((plugin as unknown as { ui?: unknown }).ui);
    for (const u of entries.filter((entry) => (entry.type ?? 'react') === 'react')) {
      const live = exportedUi.find((entry) => entry.slug === u.slug);
      if (!live || typeof live.component !== 'function') {
        return `plugin "${plugin.name}" declares react manifest.ui slug "${u.slug ?? '?'}" but its export has no matching runtime component`;
      }
    }
  }
  if ((manifest.dashboardTabs?.length ?? 0) > 0 && !declaredCapabilities.includes('ui:dashboard-tab')) {
    return `plugin "${plugin.name}" declares dashboardTabs but lacks capability "ui:dashboard-tab"`;
  }
  if ((manifest.sidebarItems?.length ?? 0) > 0 && !declaredCapabilities.includes('ui:sidebar-item')) {
    return `plugin "${plugin.name}" declares sidebarItems but lacks capability "ui:sidebar-item"`;
  }
  for (const action of manifest.actions ?? []) {
    for (const capability of action.capabilities ?? []) {
      if (!declaredCapabilities.includes(capability)) {
        return `plugin "${plugin.name}" action "${action.name}" requires capability "${capability}" but papercusp.json doesn't declare it`;
      }
    }
  }
  // Tool validation:
  //   1. Every manifest tool must have a matching handler key on plugin.tools.
  //   2. No orphan handlers — every key in plugin.tools must be in manifest.tools[].
  //   3. Each tool's `capabilities` must subset the plugin's `capabilities`.
  //   4. Each tool's name must be unique within this plugin.
  //   5. Tool names must be dotted (e.g. "repomix.pack") to support
  //      MCP namespacing and prevent collision with built-in tools.
  //
  // MCP-proxy plugins skip 1+2: their tool list is only known at runtime
  // (e.g. GitNexus's tools/list, which depends on the upstream server's
  // version). They implement `getDynamicTools` instead. Capability
  // gating still applies — declare every potentially-required cap in
  // `plugin.capabilities` so dispatch-time cap checks have something to
  // match against.
  const hasDynamicTools = typeof (plugin as { getDynamicTools?: unknown }).getDynamicTools === 'function';
  const manifestTools = manifest.tools ?? [];
  const handlerMap = (plugin as { tools?: Record<string, unknown> }).tools ?? {};
  const handlerKeys = Object.keys(handlerMap);
  const manifestToolNames = new Set<string>();
  for (const t of manifestTools) {
    if (!t || typeof t.name !== 'string' || t.name.length === 0) {
      return `plugin "${plugin.name}" has an invalid tool entry (missing name)`;
    }
    if (manifestToolNames.has(t.name)) {
      return `plugin "${plugin.name}" declares duplicate tool name "${t.name}"`;
    }
    manifestToolNames.add(t.name);
    // Tool name is the function key — bare names like 'pack' are fine.
    // The plugin-loader → projected-tool wiring derives the dotted MCP
    // name (e.g. 'repomix.pack') and HTTP path from the plugin name +
    // tool name unless the manifest entry's `expose` overrides them.
    // Handler can be missing IF the plugin declares dynamic tools — the
    // host fetches handlers from getDynamicTools() at register time.
    if (typeof handlerMap[t.name] !== 'function' && !hasDynamicTools) {
      return `plugin "${plugin.name}" declares tool "${t.name}" in manifest but provides no handler in tools export`;
    }
    const caps = Array.isArray(t.capabilities) ? t.capabilities : [];
    for (const c of caps) {
      if (!declaredCapabilities.includes(c)) {
        return `plugin "${plugin.name}" tool "${t.name}" requires capability "${c}" but plugin manifest doesn't declare it`;
      }
    }
  }
  // Skip orphan-handler check for dynamic-tools plugins; they may export
  // a stub `tools` map (or none) and rely entirely on getDynamicTools.
  if (!hasDynamicTools) {
    for (const k of handlerKeys) {
      if (!manifestToolNames.has(k)) {
        return `plugin "${plugin.name}" exports handler for "${k}" but manifest has no matching tools[] entry`;
      }
    }
  }
  // Reaction-rule validation (plugin-system-hive-port D-003 / P-005):
  //   1. Rule ids unique within the plugin (across manifest + code rules).
  //   2. Each trigger in `on` requires an `events:listen:<trigger>` capability
  //      — the consent surface for what the plugin watches.
  //   3. An explicit `capability` must be one the plugin declares.
  // Fire-target resolution (must be THIS plugin's projected tool) happens at
  // host registration time, when the projection registry exists.
  {
    const manifestRules = manifest.reactions ?? [];
    const codeRules = (plugin as { reactions?: import('@papercusp/plugin-sdk').PluginReactionRule[] }).reactions ?? [];
    const seenIds = new Set<string>();
    for (const [label, rules] of [['manifest', manifestRules], ['export', codeRules]] as const) {
      for (const r of rules) {
        if (!r || typeof r.id !== 'string' || r.id.length === 0) {
          return `plugin "${plugin.name}" has an invalid ${label} reaction (missing id)`;
        }
        // A code rule deliberately re-declaring a manifest rule's id (override) is
        // allowed; a duplicate WITHIN one source is an authoring error.
        const scopedId = `${label}:${r.id}`;
        if (seenIds.has(scopedId)) {
          return `plugin "${plugin.name}" declares duplicate reaction id "${r.id}"`;
        }
        seenIds.add(scopedId);
        if (typeof r.fire !== 'string' || r.fire.length === 0) {
          return `plugin "${plugin.name}" reaction "${r.id}" has no fire target`;
        }
        const triggers = Array.isArray(r.on) ? r.on : [r.on];
        if (triggers.length === 0 || triggers.some((t) => typeof t !== 'string' || t.length === 0)) {
          return `plugin "${plugin.name}" reaction "${r.id}" has an invalid \`on\` trigger`;
        }
        for (const t of triggers) {
          if (!declaredCapabilities.includes(`events:listen:${t}`)) {
            return `plugin "${plugin.name}" reaction "${r.id}" listens on "${t}" but lacks capability "events:listen:${t}"`;
          }
        }
        if (r.capability !== undefined && !declaredCapabilities.includes(r.capability)) {
          return `plugin "${plugin.name}" reaction "${r.id}" scopes to capability "${r.capability}" the plugin doesn't declare`;
        }
      }
    }
  }
  // kind='pack' — a runtime-less code-tool pack (tool-distribution-granularity
  // 2026-06-05 D-001/D-004): statically-declared tools are its ONLY
  // contribution, so a pack stays installable in isolation by construction.
  // A plugin = a pack WITH a runtime; anything runtime-bearing here means the
  // author wanted kind='plugin'.
  const kind =
    (manifest as { kind?: string }).kind ?? (plugin as { kind?: string }).kind ?? 'plugin';
  if (kind === 'pack') {
    const runtimeKind = manifest.runtime?.kind ?? 'js';
    if (runtimeKind !== 'js') {
      return `pack "${plugin.name}" declares runtime.kind "${runtimeKind}" — a pack is runtime-less (js-loaded tool handlers only); use kind "plugin"`;
    }
    if (hasDynamicTools) {
      return `pack "${plugin.name}" implements getDynamicTools — dynamic (MCP-proxy) tools ride a plugin runtime; use kind "plugin"`;
    }
    const offending: string[] = [];
    if ((manifest.ui?.length ?? 0) > 0 || normalizeDeclarationRecords((plugin as unknown as { ui?: unknown }).ui).length > 0) offending.push('ui');
    if ((manifest.dashboardTabs?.length ?? 0) > 0 || (plugin.dashboardTabs?.length ?? 0) > 0) offending.push('dashboardTabs');
    if ((manifest.sidebarItems?.length ?? 0) > 0 || (plugin.sidebarItems?.length ?? 0) > 0) offending.push('sidebarItems');
    // roles/routines are retired SDK axes (plugin-system-hive-port D-004) —
    // the typed Plugin no longer carries them, but an untyped JS export can
    // still smuggle them in, so the pack purity check stays defensive.
    const legacy = plugin as { roles?: Record<string, unknown>; routines?: unknown[] };
    if (Object.keys(legacy.roles ?? {}).length > 0) offending.push('roles');
    if ((legacy.routines?.length ?? 0) > 0) offending.push('routines');
    if ((manifest.actions?.length ?? 0) > 0 || (plugin.actions?.length ?? 0) > 0) offending.push('actions');
    if (plugin.hooks && Object.keys(plugin.hooks).length > 0) offending.push('hooks');
    if ((plugin.reactions?.length ?? 0) > 0 || (manifest.reactions?.length ?? 0) > 0) offending.push('reactions');
    // NB (events-as-a-dependency axis, D-003 / P-005): `provides.events` and
    // `dependencies.events` are pure DATA declarations, not runtime-bearing
    // surfaces, so they are intentionally ABSENT from this offending list — a
    // runtime-less pack may declare what event families it provides/requires.
    // Actually EMITTING/REACTING is runtime: `reactions` (above) stays
    // pack-forbidden; a pack's js tool handler may still emit its declared family.
    if (offending.length > 0) {
      return `pack "${plugin.name}" declares runtime-bearing surface(s) ${offending.join(', ')} — a pack contributes tools only; use kind "plugin"`;
    }
    if (manifestTools.length === 0) {
      return `pack "${plugin.name}" declares no tools — a pack is a distribution unit of n≥1 tools`;
    }
  }
  return null;
}

/** Normalize a singular legacy runtime declaration or an array to records. */
function normalizeDeclarationRecords(value: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  return values.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
}

/**
 * Reconcile a manifest-owned declaration axis with its runtime-only half.
 *
 * The manifest controls which identities exist and every serializable field.
 * A same-key export may contribute non-serializable behavior (React component,
 * action handler, badge callback). Export-only identities are deliberately
 * absent from the result, so code cannot bypass install/consent truth.
 */
function reconcileDeclarationAxis(manifestValue: unknown, exportValue: unknown, key: string): Array<Record<string, unknown>> {
  const exportedByKey = new Map<unknown, Record<string, unknown>>();
  for (const entry of normalizeDeclarationRecords(exportValue)) {
    if (entry[key] !== undefined) exportedByKey.set(entry[key], entry);
  }
  return normalizeDeclarationRecords(manifestValue).map((declared) => {
    const runtime = exportedByKey.get(declared[key]);
    return runtime ? { ...runtime, ...declared } : { ...declared };
  });
}

/**
 * Make papercusp.json the single declarative source while preserving the
 * entry module's runtime-only functions for identities the manifest admits.
 * This is the load-time package-boundary reconciliation required by the
 * derived-truth ladder: manifest→live projects; live→manifest cannot smuggle.
 */
function reconcileManifestDeclarations(plugin: Plugin, manifest: ManifestShape): Plugin {
  const reconciled: Record<string, unknown> = {
    ...(plugin as unknown as Record<string, unknown>),
    capabilities: [...(manifest.capabilities ?? [])],
  };
  const axes = [
    ['actions', manifest.actions, (plugin as unknown as { actions?: unknown }).actions, 'name'],
    ['ui', manifest.ui, (plugin as unknown as { ui?: unknown }).ui, 'slug'],
    ['dashboardTabs', manifest.dashboardTabs, (plugin as unknown as { dashboardTabs?: unknown }).dashboardTabs, 'id'],
    ['sidebarItems', manifest.sidebarItems, (plugin as unknown as { sidebarItems?: unknown }).sidebarItems, 'id'],
  ] as const;
  for (const [field, manifestValue, exportValue, key] of axes) {
    const declarations = reconcileDeclarationAxis(manifestValue, exportValue, key);
    if (declarations.length > 0) reconciled[field] = declarations;
    else delete reconciled[field];
  }
  return reconciled as unknown as Plugin;
}

/**
 * Papercusp runtime dispatch (the `@papercusp/plugin-loader-core`
 * `runtimeDispatch` port). G3 dispatch: when a manifest opts into a non-JS
 * runtime, route to the dedicated loader. WASM + daemon plugins don't need
 * a JS entry — they expose actions/ui through the runtime's own host
 * surface. Returns a ready core result, an error, or null to fall through
 * to the JS entry path.
 */
async function runtimeDispatch(
  manifest: ManifestShape,
  path: string,
  source: string,
): Promise<CoreLoadedPlugin<Plugin, ManifestShape> | { error: string; path: string } | null> {
  const runtime = manifest.runtime;
  // kind='pack' purity, runtime half (tool-distribution-granularity D-004):
  // wasm/daemon manifests short-circuit validate() below, so the runtime-less
  // rule for packs must gate HERE, before the dispatch.
  if ((manifest as { kind?: string }).kind === 'pack' && runtime && runtime.kind !== 'js') {
    return {
      error: `pack "${(manifest as { name?: string }).name ?? '?'}" declares runtime.kind "${runtime.kind}" — a pack is runtime-less (js-loaded tool handlers only); use kind "plugin"`,
      path,
    };
  }
  if (runtime?.kind === 'wasm') {
    if (!runtime.wasmPath) {
      return { error: 'manifest.runtime.kind = "wasm" but runtime.wasmPath missing', path };
    }
    const wasmAbs = resolve(path, runtime.wasmPath);
    try {
      // Stat-only — actual instantiation happens at enable time so a
      // browse over installed plugins doesn't pay the wasmtime startup
      // cost. The shim records intent; the operator's plugin-host-runtime
      // calls loadWasmPlugin() at enable.
      await fs.stat(wasmAbs);
    } catch {
      return { error: `wasm artifact not found at ${wasmAbs}`, path };
    }
    return { plugin: makeWasmPluginShim(manifest, wasmAbs), manifest, path, source };
  }
  if (runtime?.kind === 'daemon') {
    if (!runtime.daemonCommand || runtime.daemonCommand.length === 0) {
      return { error: 'manifest.runtime.kind = "daemon" but runtime.daemonCommand missing/empty', path };
    }
    return { plugin: makeDaemonPluginShim(manifest), manifest, path, source };
  }
  // Manifest-only plugins: a JS-runtime manifest with no tool declarations
  // and no entry module is a legitimate asset/declarative plugin —
  // provision scripts, manifest-declared roles, configSchema (e.g.
  // cloudflare-stack ships only provision/*.sh + roles/*.md). Excluded:
  // packs (a pack exists to provide js tool handlers) and manifests
  // declaring react UI surfaces (the component comes from the entry).
  if (
    (!runtime || runtime.kind === 'js') &&
    (manifest as { kind?: string }).kind !== 'pack' &&
    !(manifest.tools && manifest.tools.length > 0) &&
    !(manifest.ui ?? []).some((u) => u.type === 'react') &&
    !(await locateEntry(path))
  ) {
    return { plugin: makeManifestOnlyPluginShim(manifest), manifest, path, source };
  }
  return null;
}

/**
 * Map a generic core load-result onto the Papercusp `LoadedPlugin` shape:
 * derive `toolDefinitions` + the resolved `runtime` descriptor from the
 * manifest. WASM runtimes get their `wasmPath` resolved to absolute
 * (matching runtimeDispatch's stat target); JS plugins default to
 * `{ kind: 'js' }`.
 */
function toLoadedPlugin(r: CoreLoadedPlugin<Plugin, ManifestShape>): LoadedPlugin {
  const manifest = r.manifest;
  let runtime: import('@papercusp/plugin-sdk').PluginRuntime = manifest.runtime ?? { kind: 'js' };
  if (runtime.kind === 'wasm' && runtime.wasmPath) {
    runtime = { ...runtime, wasmPath: resolve(r.path, runtime.wasmPath) };
  }
  return {
    plugin: reconcileManifestDeclarations(r.plugin, manifest),
    path: r.path,
    source: r.source as LoadedPlugin['source'],
    toolDefinitions: manifest.tools ?? [],
    runtime,
    manifestReactions: manifest.reactions ?? [],
    triggerPack: manifest.triggerPack,
  };
}

/**
 * The Papercusp-bound loader: the generic `@papercusp/plugin-loader-core`
 * pipeline wired to the Papercusp manifest reader, entry locator, importer,
 * runtime dispatch, and the capability/role/UI validation rules (`validate`)
 * above. The generic kernel owns the discover→read→dispatch→import→validate
 * →dedupe control flow; this object is the seam.
 */
const corePluginLoader = createPluginLoader<Plugin, ManifestShape>({
  readManifest,
  locateEntry,
  importEntry: importPluginEntry,
  runtimeDispatch,
  validatePlugin: validate,
  pluginName: (p) => p.name,
  invalidManifestError: 'missing or invalid papercusp.json',
  noEntryError:
    'no entry point found (looked for index.cjs, dist/index.cjs, index.js, index.mjs, dist/index.js, index.ts, src/index.ts)',
});

/** Load a single plugin from a known directory. */
export async function loadPluginFromDir(dir: string, source: LoadedPlugin['source']): Promise<LoadedPlugin | { error: string; path: string } | { skipped: 'not-a-plugin'; path: string }> {
  const r = await corePluginLoader.loadFromDir(dir, source);
  if ('skipped' in r) return r;
  if ('error' in r) return r;
  return toLoadedPlugin(r);
}

/**
 * Synthetic plugin shim for WASM-runtime manifests. Exposes the
 * minimum surface the JS-side loader expects (no init/handlers — those
 * live in the WASM runtime). The operator's plugin-host-runtime branches
 * on `loaded.runtime?.kind === 'wasm'` and dispatches to
 * @papercusp/plugin-loader/wasm.loadWasmPlugin() at enable time.
 */
function makeWasmPluginShim(manifest: ManifestShape, wasmAbs: string): import('@papercusp/plugin-sdk').Plugin {
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    // Marker so anyone iterating loaded plugins can tell this is a
    // shim and reach for runtime.kind / wasmPath.
    __runtime: 'wasm',
    __wasmAbsPath: wasmAbs,
  } as unknown as import('@papercusp/plugin-sdk').Plugin;
}

/** See makeWasmPluginShim. Same idea for subprocess-daemon manifests. */
function makeDaemonPluginShim(manifest: ManifestShape): import('@papercusp/plugin-sdk').Plugin {
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    __runtime: 'daemon',
  } as unknown as import('@papercusp/plugin-sdk').Plugin;
}

/**
 * See makeWasmPluginShim. Same idea for manifest-only plugins (no code at
 * all — provision scripts / declarative roles / configSchema). No init, no
 * hooks, no tool handlers; the host's optional-chained call sites skip it.
 */
function makeManifestOnlyPluginShim(manifest: ManifestShape): import('@papercusp/plugin-sdk').Plugin {
  return {
    kind: manifest.kind,
    name: manifest.name,
    version: manifest.version,
    papercusp: manifest.papercusp ?? '*',
    description: manifest.description,
    capabilities: manifest.capabilities ?? [],
    configSchema: manifest.configSchema,
    oauth: manifest.oauth,
    actions: manifest.actions,
    ui: manifest.ui,
    dashboardTabs: manifest.dashboardTabs,
    sidebarItems: manifest.sidebarItems,
    provides: manifest.provides,
    dependencies: manifest.dependencies,
    triggerPack: manifest.triggerPack,
    __runtime: 'manifest-only',
  } as unknown as import('@papercusp/plugin-sdk').Plugin;
}

/** Discover and load all plugins reachable via the configured search paths. */
export async function loadPlugins(opts: LoaderOptions = {}): Promise<{
  loaded: LoadedPlugin[];
  errors: Array<{ error: string; path: string }>;
}> {
  // Build the Papercusp search roots (precedence: project > harness >
  // global). The generic kernel walks + dedupes them by plugin name
  // (first-seen wins); the `~/.papercusp` root resolution + scope-recursion
  // policy is the Papercusp-specific part that stays here.
  const roots: DiscoverRoot[] = [];
  if (opts.projectDir) {
    roots.push({ pluginsDir: join(opts.projectDir, 'plugins'), source: 'project' });
  }
  for (const slug of opts.harnessSlugs ?? []) {
    roots.push({
      pluginsDir: join(papercuspRootResolved(), 'harnesses', slug, 'plugins'),
      source: 'harness',
    });
  }
  const globalDir = opts.globalPluginsDir ?? join(papercuspRootResolved(), 'global-plugins');
  // Global plugins may live under npm-style `@scope/` dirs (e.g.
  // `@papercupai/`); recurse those into per-plugin candidates.
  roots.push({ pluginsDir: globalDir, source: 'global', scopeRecurse: true });

  const { loaded, errors } = await corePluginLoader.loadAll(roots);
  return { loaded: loaded.map(toLoadedPlugin), errors };
}

/**
 * Wire a loaded plugin's manifest tools into agent-mcp's projected-tool
 * registry. For each `manifest.tools[]` entry:
 *
 *   1. Look up the matching handler function in `plugin.tools[name]`.
 *   2. Compute defaults for absent `expose.mcp.name` / `expose.http.path`
 *      so plugins can omit the field for the common case.
 *   3. Call `registerProjectedTool` so the function appears on both
 *      transports.
 *
 * Default exposure shapes (when manifest entry omits expose.*):
 *   - mcp.name  →  `<short-pluginName>.<tool.name>`  (drops scope prefix)
 *   - http.path →  `/api/plugins/<short-pluginName>/<tool.name>`
 *
 * Throws on the same validation conditions as registerProjectedTool
 * (duplicate names/paths, missing handlers).
 */
export async function registerPluginTools(
  loaded: LoadedPlugin[],
): Promise<{ registered: number; errors: Array<{ plugin: string; tool: string; error: string }> }> {
  const { registerProjectedTool, unregisterProjectedToolsForPlugin } = await import('@papercusp/agent-mcp');
  let registered = 0;
  const errors: Array<{ plugin: string; tool: string; error: string }> = [];
  for (const lp of loaded) {
    const staticDefs = lp.toolDefinitions ?? [];
    const dynFn = (lp.plugin as { getDynamicTools?: () => Promise<{ definitions: import('@papercusp/plugin-sdk').ToolDefinition[]; handlers: import('@papercusp/plugin-sdk').PluginToolMap }> }).getDynamicTools;
    let dynDefs: import('@papercusp/plugin-sdk').ToolDefinition[] = [];
    let dynHandlers: import('@papercusp/plugin-sdk').PluginToolMap = {};
    if (typeof dynFn === 'function') {
      try {
        // Bound discovery time. MCP-proxy plugins (gitnexus, ast-grep) spawn
        // an external child process; if the child hangs (cold npx fetch,
        // index loading, etc.), we don't want to wedge host startup. The
        // plugin can still be invoked later — the failure here means
        // getDynamicTools didn't surface tools, not that the plugin is
        // broken. 10s is generous for cached binaries; cold-start failures
        // are visible in errors[] for the user to act on. A plugin whose
        // cold start legitimately needs longer (gitnexus loading a large
        // code-graph index) declares `discoveryTimeoutMs` to extend the
        // budget — clamped to [100ms, 120s]: the ceiling stops a typo from
        // wedging boot forever; the floor just blocks a zero/negative
        // (revive-plugin-system-2026-06-04 D-003).
        const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
        const declared = (lp.plugin as { discoveryTimeoutMs?: number }).discoveryTimeoutMs;
        const DISCOVERY_TIMEOUT_MS =
          typeof declared === 'number' && Number.isFinite(declared)
            ? Math.min(Math.max(declared, 100), 120_000)
            : DEFAULT_DISCOVERY_TIMEOUT_MS;
        const r = await Promise.race([
          dynFn(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`getDynamicTools timed out after ${DISCOVERY_TIMEOUT_MS}ms`)),
              DISCOVERY_TIMEOUT_MS,
            ).unref(),
          ),
        ]);
        dynDefs = r?.definitions ?? [];
        dynHandlers = r?.handlers ?? {};
      } catch (err) {
        errors.push({
          plugin: lp.plugin.name,
          tool: '<getDynamicTools>',
          error: `getDynamicTools failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        // Don't skip the plugin — it may still have static tools to register.
      }
    }
    const defs = [...staticDefs, ...dynDefs];
    if (defs.length === 0) continue;
    // Idempotent: drop any prior entries for this plugin so a re-registration
    // (e.g. dev-mode host refresh after a manifest edit) doesn't trip the
    // cross-plugin name-collision guard against its own previous entries.
    unregisterProjectedToolsForPlugin(lp.plugin.name);
    const staticHandlers = (lp.plugin as { tools?: Record<string, import('@papercusp/plugin-sdk').ToolHandler> }).tools ?? {};
    const handlers: Record<string, import('@papercusp/plugin-sdk').ToolHandler> = { ...staticHandlers, ...dynHandlers };
    const shortName = lp.plugin.name.replace(/^@[^/]+\//, ''); // '@papercupai/repomix' → 'repomix'
    for (const def of defs) {
      try {
        const handler = handlers[def.name];
        if (typeof handler !== 'function') {
          errors.push({
            plugin: lp.plugin.name,
            tool: def.name,
            error: `manifest declares tool "${def.name}" but plugin export has no matching handler`,
          });
          continue;
        }
        const expose = def.expose ?? {};
        const mcpName = expose.mcp?.name ?? `${shortName}.${def.name}`;
        const httpPath = expose.http?.path ?? `/api/plugins/${shortName}/${def.name}`;
        // Phase 4 T3.2: plugin manifests can now declare typed events
        // as JSON-Schema. Validate the schema against our supported
        // subset (see packages/agent-mcp/src/plugin-events.ts) and
        // compute wire kinds in one pass; pass both into the
        // projection registry alongside the rest of the tool.
        let eventsJsonSchema: Record<string, Record<string, unknown>> | undefined;
        let eventWireKinds: Record<string, 'string' | 'json' | 'binary'> | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const declaredEvents = (def as any).events as Record<string, Record<string, unknown>> | undefined;
        if (declaredEvents !== undefined) {
          try {
            // Plugin-loader uses dynamic imports for agent-mcp (cf.
            // line above where registerProjectedTool is loaded the
            // same way) so the build stays decoupled.
            const { validateAndClassifyPluginEvents } = await import('@papercusp/agent-mcp');
            eventWireKinds = validateAndClassifyPluginEvents(declaredEvents);
            eventsJsonSchema = declaredEvents;
          } catch (err) {
            errors.push({
              plugin: lp.plugin.name,
              tool: def.name,
              error: `events validation failed: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
          }
        }
        registerProjectedTool({
          pluginName: lp.plugin.name,
          description: def.description,
          inputSchema: def.inputSchema,
          capabilities: def.capabilities,
          agentRoles: def.roles,
          rolesQuota: def.rolesQuota,
          timeoutSec: def.timeoutSec,
          expose: {
            mcp: expose.mcp === undefined && expose.http === undefined
              ? { name: mcpName, streaming: undefined, largeOutput: undefined }
              : expose.mcp ?? { name: mcpName },
            http: expose.http ?? { path: httpPath },
            // Slash exposure (MCP-prompts slash commands) defaults ON when
            // absent; thread the manifest value so `false`/overrides survive.
            ...(expose.slash !== undefined ? { slash: expose.slash } : {}),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fn: handler as any,
          // Plumb plugin-manifest guidance through to the projection so
          // `agent_tools:list` + `assembleRolePrompt` surface it.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          guidance: (def as any).guidance,
          ...(eventsJsonSchema ? { eventsJsonSchema, eventWireKinds } : {}),
        });
        registered += 1;
      } catch (err) {
        errors.push({
          plugin: lp.plugin.name,
          tool: def.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { registered, errors };
}

/**
 * Extract UI contributions from all loaded plugins. The host can iterate
 * these to mount routes, sidebar items, and dashboard tabs.
 */
export function collectUiContributions(loaded: LoadedPlugin[]): {
  routes: Array<{ pluginName: string; ui: import('@papercusp/plugin-sdk').UiContribution }>;
  dashboardTabs: Array<{ pluginName: string; tab: import('@papercusp/plugin-sdk').DashboardTab }>;
  sidebarItems: Array<{ pluginName: string; item: import('@papercusp/plugin-sdk').SidebarItem }>;
} {
  const routes: Array<{ pluginName: string; ui: import('@papercusp/plugin-sdk').UiContribution }> = [];
  const dashboardTabs: Array<{ pluginName: string; tab: import('@papercusp/plugin-sdk').DashboardTab }> = [];
  const sidebarItems: Array<{ pluginName: string; item: import('@papercusp/plugin-sdk').SidebarItem }> = [];

  for (const lp of loaded) {
    if (lp.plugin.ui) routes.push({ pluginName: lp.plugin.name, ui: lp.plugin.ui });
    for (const tab of lp.plugin.dashboardTabs ?? []) {
      dashboardTabs.push({ pluginName: lp.plugin.name, tab });
    }
    for (const item of lp.plugin.sidebarItems ?? []) {
      sidebarItems.push({ pluginName: lp.plugin.name, item });
    }
  }

  return { routes, dashboardTabs, sidebarItems };
}

/**
 * One plugin's effective reaction rules: manifest-declared (declarative
 * subset) merged with the entry plugin's `reactions` export — a code rule
 * overrides a manifest rule with the same id. The host registers each into
 * the reaction registry, capability-scoped (plugin-system-hive-port P-005;
 * event-reaction-system D-012).
 */
export function collectReactionRules(
  lp: LoadedPlugin,
): import('@papercusp/plugin-sdk').PluginReactionRule[] {
  const byId = new Map<string, import('@papercusp/plugin-sdk').PluginReactionRule>();
  for (const r of lp.manifestReactions ?? []) byId.set(r.id, r);
  for (const r of lp.plugin.reactions ?? []) byId.set(r.id, r);
  return [...byId.values()];
}

// ─── Re-exports ──────────────────────────────────────────────────────
export {
  hasCapability,
  requireCapability,
  wrapServiceWithCaps,
  makeFetchProxy,
  makeSecretsProxy,
  MissingCapabilityError,
  UnknownMethodError,
  type CapabilityCheckContext,
} from './capabilities';

// (hookbus.ts — the WordPress-style addAction/addFilter bus — was RETIRED by
// plugin-system-hive-port-2026-06-11 P-006: zero registered consumers, and its
// invocations bypassed dispatch. Plugins hook the host via `reactions` now.)

export {
  createPapercuspApi,
  TasksServiceDef,
  GoalsServiceDef,
  PendingEventsServiceDef,
  RoutinesServiceDef,
  CommentsServiceDef,
  SecretsServiceDef,
  PluginStorageDef,
  PluginDbDef,
  type RealServices,
  type CreatePapercuspApiInput,
} from './api-factory';

export {
  ServerActionRegistry,
  ActionRegistryError,
  type ActionDecl,
  type ActionHandler,
  type ActionResult,
  type InvokeRequest,
  type RegistryOptions,
} from './actions';

export {
  InMemoryAuditWriter,
  type AuditWriter,
  type AuditRow,
} from './audit';
