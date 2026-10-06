/**
 * Phase 6b items 1 + 4 — process-level plugin lifecycle host.
 *
 * Owns:
 *   - the discovered `LoadedPlugin[]` cache
 *   - per-(plugin, harness) lazy initialization of `init()` + `hooks.onLoad()`
 *   - the host-side typed fire helper `firePluginLifecycle()`
 *   - plugin reaction-rule registration into the event-reaction registry
 *
 * Lifecycle hooks (the typed `PluginHooks` shape on the SDK) are called by
 * direct iteration — a FROZEN back-compat surface (plugin-system-hive-port
 * D-003). The extension surface is event-reaction rules: plugins declare
 * `reactions` (manifest or entry export); the host registers each into the
 * one reaction registry, capability-scoped, firing through normal dispatch.
 * Plugin-emitted events (the WASM event sink, `plugins:fire_event`) feed the
 * same registry as synthetic events via `emitSystemEvent`. (The WordPress-
 * style HookBus addAction/addFilter layer was retired by that plan's P-006.)
 *
 * Keep this module side-effect-free at import time — the first `await
 * getPluginHost()` triggers discovery so we don't wedge dev-server boot
 * behind plugin loading.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  loadPlugins,
  hasCapability,
  ServerActionRegistry,
  collectReactionRules,
  type LoadedPlugin,
  type CapabilityCheckContext,
  type ActionDecl,
  type ActionResult,
} from '@papercusp/plugin-loader';
import type {
  PapercuspContext,
  PluginHooks,
  PluginReactionRule,
  PluginSpawn,
  PluginSpawnResult,
} from '@papercusp/plugin-sdk';

import { papercuspRoot } from './papercusp-root';
import {
  appendLogEventSync,
  installConsoleInterceptor,
  jsonlPathForStateDir,
  runWithPluginExecCtx,
  currentPluginExecCtx,
} from './log-events';
import { getGrantsForPluginInHarness } from './plugin-grants';
import { PgAuditWriter } from './plugin-audit-writer';
import { InMemoryAuditWriter as _InMemoryAuditWriter } from '@papercusp/plugin-loader';
import { cooperativeYield } from './event-loop-lag-monitor';
import { pinModuleState } from '@papercusp/module-singleton';
import { trackDetached } from './detached-imports';
import {
  providerRegistry,
  ProviderRegistrationError,
  type ProviderRegistry,
} from './integrations/provider-registry';
import {
  startDaemonProvider,
  stopDaemonProvider,
  trackDaemonProvider,
  type DaemonProviderRuntime,
  type StartDaemonProviderOptions,
} from './integrations/daemon-provider';

// operator-core is an ESM package (`type: module`); under the host's ESM
// runtime (tsx) the CommonJS globals `require` and `__dirname` are UNDEFINED.
// This module uses bare `require(...)` (lazy node-builtin + sibling-module
// loads, plus `require.cache` eviction for hot-reload) and `__dirname` (the
// bundled-plugin + global-plugin path walks) in many places. Bind ESM-safe
// shims once so every bare use resolves. Without this,
// findBundledPluginsParent()/discoverHarnessSlugs() throw on their first
// `require('node:fs')` → the surrounding try/catch swallows it → discover()
// runs with projectDir:undefined + harnessSlugs:[] → ZERO plugins load on the
// live host (EI-3 / revive-plugin-system-2026-06-04). Matches the established
// operator-core pattern (pty-bridge.ts createRequire, prompt-assembly.ts
// fileURLToPath __dirname).
//
// BROWSER-SAFE: the operator SPA pulls this module in via the route tree and
// externalizes node:module for the browser (→ `createRequire` is undefined). An
// EAGER top-level call threw at module eval — "createRequire is not a function" —
// and blanked the entire desktop app on load. Guard the creation so importing is
// browser-safe; `require(...)` + `require.cache` below only ever execute
// server-side (plugin discovery/hot-reload), never in the SPA.
const require = (typeof createRequire === 'function'
  ? createRequire(import.meta.url)
  : undefined) as NodeRequire;
const __dirname = dirname(fileURLToPath(import.meta.url));

let _operatorAuditWriter: import('@papercusp/plugin-loader').AuditWriter | null = null;
function getOperatorAuditWriter(): import('@papercusp/plugin-loader').AuditWriter {
  if (_operatorAuditWriter) return _operatorAuditWriter;
  // Tests opt out of PG audit by setting NODE_ENV=test, which keeps the
  // legacy in-memory writer (rows queryable via rowsForInspection()).
  // Production / dev / staging all hit PG. Audit fail-closed semantics
  // (Batch C5) live in the host's invoke path, not here.
  _operatorAuditWriter = process.env.NODE_ENV === 'test'
    ? new _InMemoryAuditWriter()
    : new PgAuditWriter();
  return _operatorAuditWriter;
}

/**
 * Tier-2 grants loader — never throws. PG unavailability or a transient
 * read failure must not kill plugin init; we fall back to "no grants"
 * which combined with manifest-only behavior denies user-grant-required
 * caps but doesn't crash the host.
 */
async function loadGrantedCapsSafe(
  pluginName: string,
  pluginVersion: string,
  harnessSlug: string,
): Promise<string[] | undefined> {
  try {
    const rows = await getGrantsForPluginInHarness(pluginName, pluginVersion, harnessSlug);
    // Empty result → no grant info on file (PG unreachable + no legacy
    // file, OR no consent flow has run for this plugin yet). Fall back
    // to legacy single-tier (manifest-only) semantics rather than denying
    // every cap. Operator's install flow backfills grants at enable time,
    // so a real user-revoke path is expressed by deleting only specific
    // caps — never as an empty array. Returning `undefined` (vs `[]`)
    // signals hasCapability to skip the tier-2 check.
    return rows.length === 0 ? undefined : rows;
  } catch (e) {
    console.warn(`[plugin-grants] read failed for ${pluginName}@${pluginVersion} in ${harnessSlug}:`, (e as Error)?.message);
    return undefined;
  }
}

// papercuspRoot() invalidates on registry mtime, so call it per-use.

// Install the global console.* interceptor on first import. AsyncLocalStorage
// scopes attribution to the active plugin handler — calls outside a plugin
// stack pass through unchanged. Idempotent.
installConsoleInterceptor();

interface HostState {
  loaded: LoadedPlugin[];
  loadErrors: Array<{ error: string; path: string }>;
  /** (pluginName, installSlug) → already initialized */
  initialized: Set<string>;
  /** (pluginName, installSlug) → sealed action registry from `init()`. */
  registries: Map<string, ServerActionRegistry>;
  /**
   * (pluginName, installSlug) → user-granted caps loaded at init time.
   * Hot-path readers (spawn, action invoke) consult this cache instead of
   * re-querying PG. Invalidated alongside `initialized` on plugin reload.
   * Tier 2 of the two-tier capability check (Batch B).
   */
  grants: Map<string, string[] | undefined>;
  /**
   * (pluginName, installSlug) → live WASM plugin handle (Batch G3).
   * Populated when manifest.runtime.kind === 'wasm'. JS plugins have no
   * entry here. Consumed by callWasmAction() and by the host's
   * uninstall/disable paths.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wasmHandles: Map<string, any>;
}

// This module's ENTIRE realm-pinned state, pinned ONCE. It previously used TWO
// hand-rolled `globalThis[key]` pairs — the discovery cache here and the dev
// file-watcher handle ~1250 lines below. Hand-rolling shares them correctly but
// leaves both invisible to listModuleDuplications(), which then answers a
// confident `[]` while this module is split (EI-19479108855357092).
//
// Folded into one pin rather than two: one `pinModuleState` call per module body
// keeps the primitive's `evaluations` an honest count of module RECORDS, and it
// forecloses the half-migrated shape where the cache is pinned and the watcher
// handle is not (which on a split installs one fs.watch per record).
const __cache = pinModuleState<{
  promise: Promise<HostState> | null;
  state: HostState | null;
  rootAtCache: string | null;
  watcher: { dispose: () => void } | null;
}>('@papercusp/operator-core.pluginHostRuntime', () => ({
  promise: null,
  state: null,
  rootAtCache: null,
  watcher: null,
}));

function discoverHarnessSlugs(): string[] {
  const dir = join(papercuspRoot(), 'harnesses');
  if (!existsSync(dir)) return [];
  try {
    // dynamic require to keep the module import-side-effect-free
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export interface PluginHostStatus {
  loaded: number;
  errors: number;
  /** Reaction rules contributed by plugins (`plugin:<name>:<rule-id>`). */
  reactionRules: Array<{ id: string; on: string | string[]; fire: string; plugin: string }>;
  /**
   * Installed trigger-pack descriptors. `armed:false` is structural: plugin
   * discovery makes a pack available but never crosses the trigger arm gate.
   */
  triggerPacks: Array<{
    plugin: string;
    targetCount: number;
    bindingCount: number;
    edgeCount: number;
    sourceKinds: string[];
    armed: false;
  }>;
}

/**
 * In development we also look for plugins bundled inside the monorepo
 * at `<repo-root>/libs/papercusp/plugins/`. We walk up from the
 * operator's working directory (a bundled runtime can make `__dirname`
 * unreliable, so process.cwd() is also tried).
 * Returns null in installed builds where the in-repo path doesn't exist.
 */
function findBundledPluginsParent(): string | null {
  try {
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    const { dirname, join } = require('node:path') as typeof import('node:path');
    // Search both cwd and __dirname-equivalent (this module's path).
    // The operator dev server is typically launched from the home dir
    // (`/home/dev`), so cwd won't find the in-repo plugin
    // dir; the module's own path always traces back to
    // packages/operator-core/lib and walking up gets us to the repo root.
    const seeds = [process.cwd(), __dirname];
    for (const seed of seeds) {
      let dir = seed;
      for (let i = 0; i < 12; i++) {
        if (existsSync(join(dir, 'libs', 'papercusp', 'plugins'))) {
          return join(dir, 'libs', 'papercusp');
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch { /* not in dev */ }
  return null;
}

/**
 * Register every loaded plugin's reaction rules into the one reaction
 * registry (plugin-system-hive-port P-005; event-reaction-system D-012).
 *
 * MUST run after the plugin-tool sweep — fire-target resolution needs the
 * projection registry. Per rule:
 *   - `fire` must resolve to a projected tool OWNED by this plugin;
 *   - the reaction is sandboxed to ONE capability (the rule's declared one,
 *     else the fired tool's declared capability) — `buildReactionCtx` runs
 *     the fire under a principal holding only it, so the tool's required
 *     capabilities must be covered or registration refuses;
 *   - registered as `plugin:<name>:<rule-id>` with source `plugin:<name>`.
 *
 * Full re-sync semantics: all prior `plugin:`-sourced rules are dropped
 * first, so a dev re-discovery or a removed plugin can't leave stale rules.
 * Failures land in loadErrors (visible via plugins:runtime_status).
 */
export async function registerPluginReactionRules(
  loaded: LoadedPlugin[],
  pushErr: (e: { plugin: string; rule: string; error: string }) => void,
): Promise<void> {
  const { lookupByMcpName } = await import('@papercusp/agent-mcp');
  const { registerReactionRule, unregisterReactionRule, listReactionRules } = await import('./events/registry');

  for (const r of listReactionRules()) {
    if (typeof r.source === 'string' && r.source.startsWith('plugin:')) unregisterReactionRule(r.id);
  }

  for (const lp of loaded) {
    let rules: PluginReactionRule[];
    try {
      rules = collectReactionRules(lp);
    } catch (e) {
      pushErr({ plugin: lp.plugin.name, rule: '<collect>', error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    for (const rule of rules) {
      try {
        const projected = lookupByMcpName(rule.fire);
        if (!projected) {
          throw new Error(`fire target "${rule.fire}" is not a registered tool (plugin tools project as "<plugin>.<verb>")`);
        }
        if (projected.pluginName !== lp.plugin.name) {
          throw new Error(
            `fire target "${rule.fire}" belongs to "${projected.pluginName}" — a plugin rule may only fire the plugin's OWN tools`,
          );
        }
        const required = (projected.capabilities ?? []) as string[];
        if (required.length > 1) {
          throw new Error(
            `fire target "${rule.fire}" requires ${required.length} capabilities — a capability-scoped reaction runs under ONE; split the tool's capabilities or pick a single-capability target`,
          );
        }
        const capability = rule.capability ?? required[0] ?? `plugin:${lp.plugin.name}`;
        if (required.length === 1 && required[0] !== capability) {
          throw new Error(
            `reaction capability "${capability}" does not cover fire target "${rule.fire}"'s required capability "${required[0]}"`,
          );
        }
        registerReactionRule({
          id: `plugin:${lp.plugin.name}:${rule.id}`,
          on: rule.on,
          // PluginReactionEvent is a structural subset of ToolInvocationEvent,
          // and a data-match object passes through to @papercusp/rules as-is.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(rule.when !== undefined ? { when: rule.when as any } : {}),
          fire: rule.fire,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: (rule.args ?? {}) as any,
          ...(rule.onlyOnSuccess !== undefined ? { onlyOnSuccess: rule.onlyOnSuccess } : {}),
          source: `plugin:${lp.plugin.name}`,
          capability,
        });
      } catch (e) {
        pushErr({ plugin: lp.plugin.name, rule: rule.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}

async function discover(): Promise<HostState> {
  let loaded: LoadedPlugin[] = [];
  let loadErrors: Array<{ error: string; path: string }> = [];
  const harnessSlugs = discoverHarnessSlugs();

  // Publish the design-compare verb surface BEFORE plugins load (P-006, D-017).
  //
  // The design-phase plugin is CommonJS in the `libs/papercusp` submodule and
  // deliberately does not require this package; it reads a slot pinned on
  // globalThis instead. Installing here is what puts anything in that slot —
  // without it, design-phase.compare_render / ratify_reference / get_design_evidence
  // refuse with `engine-unavailable`, which is the correct behaviour for a
  // standalone papercusp install and a silent feature outage in the operator.
  //
  // Ordering is not load-bearing (the plugin reads the slot per call, not at
  // load), but installing first means the surface is never briefly absent for a
  // plugin that loaded fast. Install is lazy — no PG connection is opened here.
  try {
    const { installDesignCompareForHarness } = await import('./design-compare/host-install');
    for (const slug of harnessSlugs) installDesignCompareForHarness(slug);
  } catch (e: any) {
    loadErrors.push({
      error: `design-compare host install failed: ${e?.message ?? e}`,
      path: '<design-compare-host-install>',
    });
  }

  try {
    const r = await loadPlugins({
      harnessSlugs,
      // Pick up bundled in-repo plugins (Repomix, fetch-plus, code2prompt,
      // firecrawl-bridge, etc) without requiring symlinks into ~/.papercusp.
      projectDir: findBundledPluginsParent() ?? undefined,
    });
    loaded = r.loaded;
    loadErrors = r.errors;
  } catch (e: any) {
    loadErrors = [{ error: `discovery threw: ${e?.message ?? e}`, path: '<discovery>' }];
  }

  // Register integration providers (generalized-integrations D-006 / P-001).
  // Runs before the tool sweep so a provider is resolvable by the time any
  // plugin tool or connector driver reaches for it. A refused registration is
  // recorded on the host status and leaves the rest of the plugin loaded.
  await registerPluginProviders(loaded, (err) => {
    loadErrors.push({
      error: `provider registration failed for "${err.provider}" in plugin "${err.plugin}" (${err.code}): ${err.error}`,
      path: err.plugin,
    });
  });

  // Wire plugin-contributed tools into agent-mcp's projected-tool registry
  // (PR 0c.A-E). Each manifest tools[] entry is mounted on both HTTP and
  // MCP transports automatically, with sensible defaults derived from
  // plugin name + tool function key.
  if (loaded.length > 0) {
    // Never let the dynamic-tool sweep wedge discovery (hence getPluginHost +
    // every plugin-dependent request). Each plugin's getDynamicTools probe is
    // already bounded by its own discoveryTimeoutMs inside registerPluginTools,
    // but MCP-proxy plugins (gitnexus) spawn a child whose hang can defeat that;
    // as belt-and-suspenders we cap the WHOLE sweep. Tools registered before the
    // cap stay live (registerProjectedTool is a synchronous side-effect); a slow
    // sweep finishes in the background and its errors drain into loadErrors (the
    // returned state holds this same array). (revive-plugin-system EI-3.)
    const SWEEP_BUDGET_MS = 60_000;
    const pushWiringErr = (err: { plugin: string; tool: string; error: string }): void => {
      loadErrors.push({
        error: `tool wiring failed for "${err.tool}" in plugin "${err.plugin}": ${err.error}`,
        path: err.plugin,
      });
    };
    // Reaction-rule registration rides AFTER the tool sweep (fire-target
    // resolution needs the projection registry). On a sweep timeout it moves
    // into the background continuation for the same reason.
    const pushReactionErr = (err: { plugin: string; rule: string; error: string }): void => {
      loadErrors.push({
        error: `reaction wiring failed for rule "${err.rule}" in plugin "${err.plugin}": ${err.error}`,
        path: err.plugin,
      });
    };
    const wireReactions = () =>
      registerPluginReactionRules(loaded, pushReactionErr).catch((e: unknown) => {
        loadErrors.push({
          error: `plugin-reaction wiring threw: ${e instanceof Error ? e.message : String(e)}`,
          path: '<plugin-reaction-wiring>',
        });
      });
    try {
      const { registerPluginTools } = await import('@papercusp/plugin-loader');
      const sweep = registerPluginTools(loaded);
      const outcome = await Promise.race([
        sweep.then((r) => ({ kind: 'done' as const, r })),
        new Promise<{ kind: 'timeout' }>((res) =>
          setTimeout(() => res({ kind: 'timeout' }), SWEEP_BUDGET_MS).unref(),
        ),
      ]);
      if (outcome.kind === 'done') {
        outcome.r.errors.forEach(pushWiringErr);
        await wireReactions();
      } else {
        loadErrors.push({
          error: `plugin-tool wiring exceeded ${SWEEP_BUDGET_MS}ms — continuing with partial registration (a dynamic-tool probe is slow/hung); it finishes in the background`,
          path: '<plugin-tool-wiring>',
        });
        // Drain the late result into the (mutable) state loadErrors so a delayed
        // completion is still observable via plugin host status.
        void sweep.then((r) => r.errors.forEach(pushWiringErr), () => { /* noted above */ }).then(wireReactions);
      }
    } catch (e: any) {
      loadErrors.push({
        error: `plugin-tool wiring threw: ${e?.message ?? e}`,
        path: '<plugin-tool-wiring>',
      });
    }
  }

  return { loaded, loadErrors, initialized: new Set(), registries: new Map(), grants: new Map(), wasmHandles: new Map() };
}

export interface ProviderRegistrationFailure {
  plugin: string;
  provider: string;
  code: string;
  error: string;
}

/**
 * Register every loaded plugin's integration provider into the process-wide
 * provider registry. The manifest descriptor (validated by the loader) is
 * authoritative; an entry-exported `provider` is the fallback for plugins
 * that declare it only in code. Each plugin's previous registrations are
 * dropped first, so a re-discovery (hot reload, no-op Cupboard reinstall,
 * workspace switch) re-registers instead of colliding with itself.
 *
 * `daemon` providers are started here under the fixed provider sandbox
 * (P-002, D-006) and registered once the sandboxed process answers
 * `describe`; a refused start (no sandbox on this host, a describe that
 * disagrees with the manifest) is reported, never retried unsandboxed. WASM
 * plugins cannot carry a provider.
 */
export async function registerPluginProviders(
  loaded: LoadedPlugin[],
  onError: (err: ProviderRegistrationFailure) => void,
  registry: ProviderRegistry = providerRegistry(),
  startDaemon: (opts: StartDaemonProviderOptions) => Promise<DaemonProviderRuntime> = startDaemonProvider,
): Promise<string[]> {
  const registered: string[] = [];
  for (const lp of loaded) {
    const descriptor = lp.provider ?? lp.plugin.provider;
    if (!descriptor) continue;
    const pluginName = lp.plugin.name;
    registry.unregisterPlugin(pluginName);
    // A re-discovery replaces the running daemon: its code may have changed in place.
    await stopDaemonProvider(pluginName);
    const runtimeKind = lp.runtime?.kind ?? 'js';
    if (runtimeKind === 'daemon') {
      const id = await registerDaemonProvider(lp, descriptor, registry, startDaemon, onError);
      if (id) registered.push(id);
      continue;
    }
    if (runtimeKind !== 'js') {
      onError({
        plugin: pluginName,
        provider: descriptor.id,
        code: 'unsupported-runtime',
        error: `runtime "${runtimeKind}" cannot host a provider adapter (use js or daemon)`,
      });
      continue;
    }
    try {
      await registry.register({
        descriptor,
        adapter: lp.plugin.providerAdapter,
        pluginName,
        runtime: 'js',
      });
      registered.push(descriptor.id);
    } catch (e: unknown) {
      onError({
        plugin: pluginName,
        provider: descriptor.id,
        code: e instanceof ProviderRegistrationError ? e.code : 'register-threw',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return registered;
}

function errorCode(e: unknown, fallback: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : fallback;
}

async function registerDaemonProvider(
  lp: LoadedPlugin,
  descriptor: NonNullable<LoadedPlugin['provider']>,
  registry: ProviderRegistry,
  startDaemon: (opts: StartDaemonProviderOptions) => Promise<DaemonProviderRuntime>,
  onError: (err: ProviderRegistrationFailure) => void,
): Promise<string | null> {
  const pluginName = lp.plugin.name;
  const fail = (code: string, e: unknown): null => {
    onError({ plugin: pluginName, provider: descriptor.id, code, error: e instanceof Error ? e.message : String(e) });
    return null;
  };
  const cmd = lp.runtime?.daemonCommand;
  if (!cmd || cmd.length === 0) return fail('daemon-command-missing', 'runtime.daemonCommand is empty');
  let runtime: DaemonProviderRuntime;
  try {
    runtime = await startDaemon({
      pluginName,
      pluginDir: lp.path,
      cmd,
      declared: descriptor,
      onLog: (line: string) => console.log(`[daemon-provider ${pluginName}] ${line}`),
    });
  } catch (e: unknown) {
    return fail(errorCode(e, 'daemon-start-failed'), e);
  }
  try {
    // The MANIFEST descriptor is what gets registered, so its egress hosts are
    // the ones host.fetch enforces; the daemon cannot widen them by describing more.
    await registry.register({ descriptor, adapter: runtime.adapter, pluginName, runtime: 'daemon' });
  } catch (e: unknown) {
    await runtime.shutdown().catch(() => {});
    return fail(e instanceof ProviderRegistrationError ? e.code : 'register-threw', e);
  }
  trackDaemonProvider(pluginName, runtime);
  return descriptor.id;
}

/**
 * Drop every provider registered by the given plugins and stop their
 * sandboxed provider daemons (unload half of the lifecycle).
 */
export function unregisterPluginProviders(
  loaded: LoadedPlugin[],
  registry: ProviderRegistry = providerRegistry(),
): string[] {
  const removed: string[] = [];
  for (const lp of loaded) {
    removed.push(...registry.unregisterPlugin(lp.plugin.name));
    void stopDaemonProvider(lp.plugin.name);
  }
  return removed;
}

/**
 * A daemon plugin that declares a provider runs ONLY as the sandboxed provider
 * daemon started by {@link registerPluginProviders}. The legacy action daemon
 * must not also be started for it: that would be a second, unsandboxed copy of
 * the same third-party code with the host's network and filesystem (D-006).
 */
export function isDaemonProviderPlugin(lp: LoadedPlugin): boolean {
  return lp.runtime?.kind === 'daemon' && Boolean(lp.provider ?? lp.plugin.provider);
}

function regKey(pluginName: string, installSlug: string): string {
  return `${pluginName}::${installSlug}`;
}

const SPAWN_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Snapshot of $PATH at host startup (Batch D1, Rust-port-feedback item
 * 10). Every plugin spawn uses this PATH regardless of subsequent
 * mutations to process.env.PATH. The snapshot is intentionally captured
 * at module import time — the host's PATH is whatever the supervisor
 * (systemd unit / shell) handed to us at boot.
 */
const FROZEN_PATH: string = process.env.PATH ?? '';
const SPAWN_DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * Build a capability-gated `ctx.spawn` for one plugin instance.
 *
 * Rejection cases (synchronous reject of the promise):
 *   - `bin` contains a path separator — only PATH-resolvable basenames are
 *     allowed. Plugins that need an absolute path should declare a wildcard
 *     cap like `compute:exec:my-tool*` and pass the basename.
 *   - Plugin lacks `compute:exec:<basename>` capability.
 *
 * Successful invocation:
 *   - Spawns via `node:child_process.spawn` with `shell: false` (no shell
 *     interpolation; args go to argv directly).
 *   - cwd defaults to the plugin's `pluginDataDir`.
 *   - Stdout/stderr captured up to `maxBufferBytes` (default 1 MiB each);
 *     overflow truncates with a `[truncated]` marker.
 *   - `timeoutMs` (default 30s) sends SIGTERM, then SIGKILL after 2s grace.
 */
function makePluginSpawn(args: {
  pluginName: string;
  pluginVersion?: string;
  harnessSlug?: string;
  capabilities: readonly string[];
  granted?: readonly string[];
  defaultCwd: string;
}): PluginSpawn {
  const capCtx: CapabilityCheckContext = {
    pluginName: args.pluginName,
    capabilities: args.capabilities as any,
    granted: args.granted as any,
  };
  return async function spawn(bin, argv, opts) {
    if (typeof bin !== 'string' || bin.length === 0) {
      throw new Error(`plugin "${args.pluginName}" ctx.spawn: bin must be a non-empty string`);
    }
    // Absolute-path policy (Batch D2, Rust-port-feedback item 10): an
    // absolute path is allowed iff the plugin declared either an exact
    // matching cap `compute:exec:<abs>` or a wildcard cap that covers it
    // (e.g. `compute:exec:/usr/bin/*`). This prevents `which`-style
    // discovery from finding ffmpeg in a writable dir and bypassing the
    // intended exec gate.
    const isAbsolute = bin.startsWith('/') || /^[A-Za-z]:[\\/]/.test(bin);
    if (bin.includes('/') || bin.includes('\\')) {
      if (!isAbsolute) {
        throw new Error(
          `plugin "${args.pluginName}" ctx.spawn: bin "${bin}" must be either a basename or an absolute path. ` +
          `Relative paths are rejected because $PATH semantics make them ambiguous.`,
        );
      }
      const cap = `compute:exec:${bin}`;
      if (!hasCapability(capCtx, cap)) {
        throw new Error(
          `plugin "${args.pluginName}" missing capability "${cap}". ` +
          `Absolute-path spawns require the manifest to declare the exact path or a covering wildcard like 'compute:exec:/usr/bin/*'.`,
        );
      }
    } else {
      const cap = `compute:exec:${bin}`;
      if (!hasCapability(capCtx, cap)) {
        throw new Error(
          `plugin "${args.pluginName}" missing capability "${cap}". ` +
          `Add it to the plugin's manifest \`capabilities[]\` (or a wildcard like 'compute:exec:py-*').`,
        );
      }
    }
    const cp = require('node:child_process') as typeof import('node:child_process');
    const fsSync = require('node:fs') as typeof import('node:fs');
    const cwd = opts?.cwd ?? args.defaultCwd;
    // The default cwd is the plugin's pluginDataDir, which may not exist yet
    // on first spawn. Ensure it before handing to libuv (which would
    // otherwise reject the spawn with ENOENT).
    try { fsSync.mkdirSync(cwd, { recursive: true }); } catch { /* ignore — caller will see the spawn error */ }
    // PATH snapshot (Batch D1, Rust-port-feedback item 10): plugins must
    // not be able to alter the resolution of basename binaries by
    // mutating process.env.PATH at runtime. We pin the host's $PATH at
    // module load (FROZEN_PATH below) and force every spawn to use it.
    // Plugins can still pass per-spawn env additions, but a PATH key in
    // opts.env is silently overridden.
    const optsEnv = { ...(opts?.env ?? {}) } as Record<string, string>;
    delete optsEnv.PATH;
    const env = { ...process.env, ...optsEnv, PATH: FROZEN_PATH };
    const timeoutMs = opts?.timeoutMs ?? SPAWN_DEFAULT_TIMEOUT_MS;
    const maxBuffer = opts?.maxBufferBytes ?? SPAWN_DEFAULT_MAX_BUFFER;
    return new Promise<PluginSpawnResult>((resolve, reject) => {
      let child: import('node:child_process').ChildProcessWithoutNullStreams;
      try {
        child = cp.spawn(bin, [...argv], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        reject(e);
        return;
      }
      let stdout = '';
      let stderr = '';
      let stdoutTrunc = false;
      let stderrTrunc = false;
      let killed = false;
      const append = (which: 'stdout' | 'stderr', chunk: Buffer) => {
        if (which === 'stdout') {
          if (stdoutTrunc) return;
          if (stdout.length + chunk.length > maxBuffer) {
            stdout += chunk.toString('utf8', 0, Math.max(0, maxBuffer - stdout.length));
            stdout += '\n[truncated]';
            stdoutTrunc = true;
          } else {
            stdout += chunk.toString('utf8');
          }
        } else {
          if (stderrTrunc) return;
          if (stderr.length + chunk.length > maxBuffer) {
            stderr += chunk.toString('utf8', 0, Math.max(0, maxBuffer - stderr.length));
            stderr += '\n[truncated]';
            stderrTrunc = true;
          } else {
            stderr += chunk.toString('utf8');
          }
        }
      };
      child.stdout.on('data', (c: Buffer) => append('stdout', c));
      child.stderr.on('data', (c: Buffer) => append('stderr', c));
      child.on('error', (e) => reject(e));
      const timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000).unref();
      }, timeoutMs);
      timer.unref();
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, killed });
      });
      if (opts?.stdin !== undefined) {
        try { child.stdin.write(opts.stdin); } catch { /* ignore */ }
      }
      try { child.stdin.end(); } catch { /* ignore */ }
    });
  };
}

export function getPluginHost(): Promise<HostState> {
  // Workspace-switch invalidation: if papercuspRoot() resolves to a
  // different path than when the cache was populated, re-discover.
  // Tauri's app.restart() handles this in production by replacing the
  // entire process; this branch covers dev/web mode where workspaces
  // can flip via registry edits without a process restart.
  //
  // The check is against rootAtCache being NOT EQUAL to rootNow (rather
  // than rootAtCache being truthy) so it correctly invalidates when the
  // global cache survived a Next HMR cycle but rootAtCache wasn't yet
  // tracked by the prior module instance.
  const rootNow = papercuspRoot();
  if (__cache.promise && __cache.rootAtCache !== rootNow) {
    _resetPluginHostForTests();
    __cache.rootAtCache = null;
  }
  if (__cache.promise) return __cache.promise;
  __cache.rootAtCache = rootNow;
  __cache.promise = (async () => {
    const state = await discover();
    __cache.state = state;
    return state;
  })();
  return __cache.promise;
}

/**
 * Build a per-(plugin, harness) `PapercuspContext`. The plugin's
 * `pluginDataDir` is rooted at `<stateDir>/plugins/<plugin-name>/`.
 *
 * Caller passes a project's filesystem layout — the host doesn't reach
 * back into project-registry code so that this module stays pure.
 */
export function buildPapercuspContext(args: {
  pluginName: string;
  installSlug: string;
  projectDir: string;
  stateDir: string;
  log?: (msg: string) => void;
  /**
   * Override the default `stateDir/plugin-data/<name>/` location for the
   * plugin's data dir. Needed when the run.log lives in one tree (the
   * project's `.papercusp/`) but plugin configs live in a different tree
   * (the workspace's `<harnessDir>/plugin-data/<scoped-slug>/`). When
   * omitted the legacy default applies.
   */
  pluginDataDirOverride?: string;
}): PapercuspContext {
  const { pluginName, installSlug, projectDir, stateDir, log, pluginDataDirOverride } = args;
  const jsonlPath = jsonlPathForStateDir(stateDir);
  // Default ctx.log writes a structured event to run.log.jsonl AND mirrors
  // to stdout (which the console interceptor will also capture if we're
  // inside a plugin exec scope — that's deliberate; lets plugins use either
  // ctx.log() or console.log() interchangeably).
  const defaultLog = (msg: string): void => {
    const exec = currentPluginExecCtx();
    appendLogEventSync(jsonlPath, {
      ts: new Date().toISOString(),
      source: `plugin:${pluginName}`,
      level: 'info',
      msg,
      ...(exec?.corrId ? { corrId: exec.corrId } : {}),
    });
    // Mirror to stdout so existing dev workflows (tail of the operator
    // host log) still see the line. The console interceptor would re-record this,
    // so guard with the same exec context check it uses — but we already
    // wrote the JSONL line above, so just print plain.
    process.stdout.write(`[plugin:${pluginName}@${installSlug}] ${msg}\n`);
  };
  return {
    installSlug,
    projectDir,
    stateDir,
    // 'plugin-data/' (with dash) matches the convention the papercusp CLI
    // uses when it mirrors plugin-configs/<slug>.json → plugin-data/<slug>/
    // config.json at invoke time. Plugins read from ctx.pluginDataDir, so
    // both code paths must agree on this prefix or in-process invocations
    // see no config and the CLI does.
    pluginDataDir: pluginDataDirOverride ?? join(stateDir, 'plugin-data', pluginName),
    log: log ?? defaultLog,
  };
}

/**
 * Attach the dynamic ctx extras (actions registry, capability-gated spawn)
 * to a freshly-built `PapercuspContext`. The lifecycle-firing loop builds
 * a fresh ctx for each handler invocation; this helper keeps the shape
 * consistent across `init()`, `onLoad()`, and every typed lifecycle hook.
 *
 * ServerActionRegistry's handler signature uses `ctx: unknown` (host-
 * agnostic). PluginActionRegistry types it as `ctx: PapercuspContext`.
 * The cast bridges that contravariance — the host always passes a real
 * PapercuspContext.
 */
function attachPluginCtxExtras(
  ctx: PapercuspContext,
  lp: LoadedPlugin,
  registry: ServerActionRegistry,
  granted?: readonly string[],
): void {
  ctx.actions = registry as unknown as PapercuspContext['actions'];
  ctx.spawn = makePluginSpawn({
    pluginName: lp.plugin.name,
    pluginVersion: lp.plugin.version,
    harnessSlug: ctx.installSlug,
    capabilities: lp.plugin.capabilities ?? [],
    granted,
    defaultCwd: ctx.pluginDataDir,
  });

  // ctx.kv: plugin-private K/V store backed by harness_shared.plugin_kv
  // (Migration 054). Quotas configurable per-plugin via manifest.kvQuota.
  // Lazy require so test contexts without PG don't crash on context build.
  try {
    const { makePluginKv } = require('./plugin-kv');
    const { getOrgPg } = require('@papercusp/db-org');
    const { sql } = getOrgPg();
    const manifestQuota = (lp.plugin as unknown as {
      kvQuota?: { maxBytesPerKey?: number; maxBytesPerPlugin?: number };
    }).kvQuota;
    ctx.kv = makePluginKv({
      pluginId: lp.plugin.name,
      harnessSlug: ctx.installSlug,
      sql,
      quota: manifestQuota,
    });
  } catch {
    // PG unavailable or test stub — leave ctx.kv undefined; plugins must
    // tolerate this (sdk doc says optional like ctx.spawn).
  }

  // ctx.oauth.token(field): plugins that declare oauth in their manifest
  // can call this to acquire a fresh access token. Resolution of which
  // provider backs `field` comes from the plugin's manifest oauth[] entries.
  const oauthDecls =
    ((lp.plugin as unknown as { oauth?: { provider: string; scopes?: string[]; fieldName: string }[] }).oauth) ?? [];
  ctx.oauth = {
    async token(field: string): Promise<string | null> {
      // Lazy-loaded to avoid a circular import at module-eval time.
      const { getOAuthToken } = await import('./oauth/token');
      const { fsTokenStorage } = await import('./oauth/storage-fs');
      return getOAuthToken(
        {
          plugin: lp.plugin.name,
          harness: ctx.installSlug,
          resolveProvider: (f) => {
            const decl = oauthDecls.find((o) => o.fieldName === f);
            if (!decl) return null;
            return { provider: decl.provider, scopes: decl.scopes };
          },
          storage: fsTokenStorage,
        },
        field,
      );
    },
  };

  // ctx.recordResource: writes a record to the provision WAL. Used by
  // in-process plugins that don't shell out to a setup script — for
  // example, a plugin that creates a GitHub repo from a hook handler.
  ctx.recordResource = async (input) => {
    const { appendWalEntry } = await import('./provision/state-store');
    await appendWalEntry(ctx.installSlug, lp.plugin.name, {
      kind: input.kind,
      externalId: input.externalId,
      recordedAt: new Date().toISOString(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  };
}

/**
 * Run a plugin handler under the AsyncLocalStorage scope so console.log/.warn/.error
 * inside it (and anywhere down the async stack) get attributed to this
 * plugin/harness pair in run.log.jsonl. Returns whatever the wrapped
 * function returns (sync or async — handled transparently).
 */
async function runUnderPluginCtx<T>(
  pluginName: string,
  ctx: PapercuspContext,
  corrId: string | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  return Promise.resolve(
    runWithPluginExecCtx(
      {
        pluginSlug: pluginName,
        harnessSlug: ctx.installSlug,
        jsonlPath: jsonlPathForStateDir(ctx.stateDir),
        ...(corrId ? { corrId } : {}),
      },
      fn,
    ),
  );
}

async function ensureInitialized(
  state: HostState,
  lp: LoadedPlugin,
  ctx: PapercuspContext,
): Promise<void> {
  const key = regKey(lp.plugin.name, ctx.installSlug);
  // Sealed init() contract (Batch C1, Rust-port-feedback item 4): exactly
  // once per (plugin, harness) pair. The guard below makes the second
  // call a no-op (the documented happy path); explicit reload via
  // resetInitialized() is the only way to re-init. If we ever observe
  // double-init in the wild, surface a warning so authors fix the
  // calling pattern instead of relying on the silent skip.
  if (state.initialized.has(key)) return;
  state.initialized.add(key);

  // Batch G3 dispatch: WASM plugins skip the JS init/hooks/registry
  // path entirely. Their actions are dispatched via callWasmAction()
  // below, which routes through the WasmPlugin handle stored in
  // state.wasmHandles. JS-style hook subscriptions are NOT supported
  // for WASM plugins in v1; only manifest-declared `actions` are
  // reachable.
  if (lp.runtime?.kind === 'wasm') {
    try {
      await initializeWasmPlugin(state, lp, ctx);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log(`wasm plugin init threw: ${msg}`);
    }
    return;
  }
  if (lp.runtime?.kind === 'daemon') {
    try {
      await initializeDaemonPlugin(state, lp, ctx);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log(`daemon plugin init threw: ${msg}`);
    }
    return;
  }

  // Tier 2 of the capability check: load the user-granted set for this
  // (plugin@version, harness) pair so dispatch-time checks AND the manifest
  // with the granted set. See lib/plugin-grants.ts.
  const granted = await loadGrantedCapsSafe(
    lp.plugin.name,
    lp.plugin.version,
    ctx.installSlug,
  );
  state.grants.set(key, granted);

  // Build a per-(plugin, harness) action registry. Plugins receive it as
  // `ctx.actions` and call `ctx.actions.register(name, handler)` from
  // `init()`. The registry validates each registration against the
  // manifest-declared `actions[]` and the plugin's declared capabilities.
  // After init returns we seal the registry so registrations are immutable.
  //
  // The SDK's typed `PapercuspContext` doesn't declare `actions` (intentionally
  // — the SDK is host-agnostic), so we attach via cast. Plugins that don't
  // touch ctx.actions are unaffected.
  const declaredActions = ((lp.plugin as unknown as { actions?: ActionDecl[] }).actions) ?? [];
  let registry: ServerActionRegistry;
  try {
    registry = new ServerActionRegistry(declaredActions, {
      pluginName: lp.plugin.name,
      pluginCapabilities: lp.plugin.capabilities ?? [],
      audit: getOperatorAuditWriter(),
    });
  } catch (e: any) {
    ctx.log(`action registry init threw: ${e?.message ?? e}`);
    return;
  }
  state.registries.set(key, registry);
  attachPluginCtxExtras(ctx, lp, registry, state.grants.get(regKey(lp.plugin.name, ctx.installSlug)));

  try {
    await runUnderPluginCtx(lp.plugin.name, ctx, undefined, async () => {
      if (typeof lp.plugin.init === 'function') {
        await lp.plugin.init(ctx);
      }
      const onLoad = lp.plugin.hooks?.onLoad;
      if (typeof onLoad === 'function') {
        await onLoad(ctx);
      }
      // Hot-reload state restore: if the plugin opted in via
      // manifest.hotReload.preserveState AND a row exists in
      // harness_shared.plugin_reload_state for this (plugin, harness),
      // pop it and feed it to restoreFromReload. One-shot — failure
      // discards the state, host moves on.
      if (
        (lp.plugin as unknown as { hotReload?: { preserveState?: boolean } }).hotReload?.preserveState &&
        typeof lp.plugin.hooks?.restoreFromReload === 'function'
      ) {
        try {
          const { popPluginReloadState } = require('./plugin-reload-state');
          const { getOrgPg } = require('@papercusp/db-org');
          const { sql } = getOrgPg();
          const state = await popPluginReloadState({
            pluginId: lp.plugin.name,
            harnessSlug: ctx.installSlug,
            sql,
          });
          if (state !== undefined) {
            await lp.plugin.hooks.restoreFromReload(ctx, state);
          }
        } catch (e: any) {
          ctx.log(`restoreFromReload threw (state discarded): ${e?.message ?? e}`);
        }
      }
    });
  } catch (e: any) {
    // Roll back partial state so a retry re-runs init() cleanly (Batch
    // C1/C2, Rust-port-feedback item 5). The previous behavior left
    // `initialized` set + an empty registry, so the plugin appeared
    // healthy to the rest of the host but never actually finished
    // setup. Better to surface the failure on the next dispatch.
    ctx.log(`init/onLoad threw: ${e?.message ?? e}`);
    state.initialized.delete(key);
    state.registries.delete(key);
    state.grants.delete(key);
    return;
  } finally {
    registry.seal();
  }
}

/**
 * Batch G3 — instantiate a manifest-declared WASM plugin via
 * @papercusp/plugin-loader/wasm. Capability granter, audit sink, event
 * sink, and secrets store are all derived from the same operator
 * infrastructure JS plugins use, so the WASM plugin sees consistent
 * security + observability semantics.
 *
 * Stores the live handle in state.wasmHandles[regKey]. Subsequent
 * action calls go through callWasmAction(); disable/uninstall paths
 * call wasm.shutdown() and drop the handle.
 */
async function initializeWasmPlugin(
  state: HostState,
  lp: LoadedPlugin,
  ctx: PapercuspContext,
): Promise<void> {
  const key = regKey(lp.plugin.name, ctx.installSlug);
  const wasmAbsPath = lp.runtime?.wasmPath;
  if (!wasmAbsPath) {
    throw new Error(`wasm runtime requested but runtime.wasmPath missing on ${lp.plugin.name}`);
  }

  // Hot import to keep the WASM dependency optional; JS-only operator
  // installs don't pay the jco / wasm-plugin-host startup cost.
  const wasm = await import('@papercusp/plugin-loader/wasm');

  // Per-plugin secrets sourced from the existing PG-mirrored
  // plugin-config store. Capability gating (secrets:read:<NAME>) is
  // applied by the WASM host's secrets impl; the host just needs the
  // raw map. Non-string values are silently skipped (not secrets).
  const secrets = new Map<string, string>();
  try {
    const { loadPluginConfig } = await import('./plugin-configs-pg');
    const cfg = await loadPluginConfig(ctx.installSlug, lp.plugin.name);
    if (cfg) {
      for (const [k, v] of Object.entries(cfg)) {
        if (typeof v === 'string') secrets.set(k, v);
      }
    }
  } catch {
    // PG layer optional in tests; empty secrets is the dev default.
  }

  // Capability granter: ANDed manifest ∩ user-granted caps.
  const granted = state.grants.get(key) ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const capCtx = {
    pluginName: lp.plugin.name,
    capabilities: (lp.plugin.capabilities ?? []) as string[],
    granted: granted as string[],
  } as unknown as Parameters<typeof wasm.loadWasmPlugin>[2]['capCtx'];

  // Audit sink → operator audit writer. The plugin-loader AuditRow
  // shape is task-action-shaped (actionName/triggerSource/triggerId/...);
  // for WASM host-import calls (logging/http/secrets/events/compute) we
  // synthesize a row whose actionName encodes the WIT method and whose
  // params carry the structured detail. Outcome maps to the AuditWriter
  // enum.
  const auditWriter = getOperatorAuditWriter();
  const wasmOutcome = (o: string): 'ok' | 'error' | 'capability-denied' => {
    if (o === 'ok' || o === 'success') return 'ok';
    if (o === 'capability-denied' || o === 'denied') return 'capability-denied';
    return 'error';
  };
  const auditSink = {
    record: (row: { interface: string; method: string; cap: string; outcome: string; detail: string }) => {
      try {
        void auditWriter.write({
          ts: Date.now(),
          pluginName: lp.plugin.name,
          installSlug: ctx.installSlug,
          actionName: `wasm:${row.interface}.${row.method}`,
          triggerSource: 'api',
          triggerId: `${lp.plugin.name}/${ctx.installSlug}`,
          params: { cap: row.cap, detail: row.detail, surface: 'wasm' },
          outcome: wasmOutcome(row.outcome),
          durationMs: 0,
          capabilitiesUsed: row.cap ? [row.cap] : [],
        });
      } catch { /* never throw from audit */ }
    },
  };

  // Event sink → feed the reaction registry as a synthetic event so other
  // plugins' reaction rules (`on: '<namespace>.<event>'`) can trigger on
  // WASM-emitted events. (Replaces the retired HookBus topic fire — P-006.)
  const eventSink = {
    emit: (namespace: string, event: string, payloadJson: string) => {
      const topic = `${namespace}.${event}`;
      let payload: unknown = payloadJson;
      try { payload = payloadJson ? JSON.parse(payloadJson) : null; } catch { /* keep raw */ }
      void trackDetached(import('./events/engine'))
        .then((m) => m.emitSystemEvent({
          tool: topic,
          args: (payload && typeof payload === 'object' ? payload : { value: payload }) as Record<string, unknown>,
          harnessSlug: ctx.installSlug,
        }))
        .catch((e) => ctx.log(`wasm event emit failed for ${topic}: ${e instanceof Error ? e.message : e}`));
    },
  };

  // Memory budget from manifest, default 64 MiB.
  const budget = lp.runtime?.memoryBudgetMb;

  const handle = await wasm.loadWasmPlugin(lp.plugin.name, wasmAbsPath, {
    cacheRoot: join(papercuspRoot(), 'plugins', '_wasm-cache'),
    transpiler: wasm.realJcoTranspiler,
    capCtx,
    secrets,
    eventSink: eventSink as unknown as Parameters<typeof wasm.loadWasmPlugin>[2]['eventSink'],
    auditSink: auditSink as unknown as Parameters<typeof wasm.loadWasmPlugin>[2]['auditSink'],
    memoryBudgetMb: budget,
  });

  state.wasmHandles.set(key, handle);
  ctx.log(`wasm plugin loaded: ${lp.plugin.name} (budget=${budget ?? 64} MiB)`);
}

/**
 * Batch I — daemon plugin initialization. Hands off to the daemon
 * supervisor which manages the long-running subprocess + JSON-RPC
 * bridge. See packages/plugin-loader/src/daemon/.
 *
 * The supervisor stores its handle in state.wasmHandles under the same
 * key (the map name is historical — it holds non-JS runtime handles
 * generally). callDaemonAction() routes to the supervisor.
 */
async function initializeDaemonPlugin(
  state: HostState,
  lp: LoadedPlugin,
  ctx: PapercuspContext,
): Promise<void> {
  const key = regKey(lp.plugin.name, ctx.installSlug);
  if (isDaemonProviderPlugin(lp)) {
    ctx.log(`daemon plugin ${lp.plugin.name} is a provider: served by its sandboxed provider daemon, no action daemon started`);
    return;
  }
  const cmd = lp.runtime?.daemonCommand;
  if (!cmd || cmd.length === 0) {
    throw new Error(`daemon runtime requested but runtime.daemonCommand empty on ${lp.plugin.name}`);
  }
  const daemon = await import('@papercusp/plugin-loader/daemon');
  const handle = await daemon.startDaemonPlugin({
    pluginName: lp.plugin.name,
    cmd,
    cwd: lp.path,
    restart: lp.runtime?.daemonRestart,
    onLog: (line: string) => ctx.log(`[daemon ${lp.plugin.name}] ${line}`),
  });
  state.wasmHandles.set(key, handle);
  ctx.log(`daemon plugin started: ${lp.plugin.name} (cmd=${cmd[0]})`);
}

/**
 * Invoke a manifest-declared WASM action via the live WasmPlugin handle.
 * Returns the plugin's response bytes. Throws if no WASM plugin is
 * registered for (pluginName, installSlug) — caller should ensureInitialized
 * first via the standard action-invoke path.
 */
export async function callWasmAction(args: {
  pluginName: string;
  installSlug: string;
  actionName: string;
  payload: Uint8Array;
  origin?: 'core' | 'ui';
}): Promise<{ ok: true; payload: Uint8Array } | { ok: false; error: string }> {
  const state = await getPluginHost();
  const handle = state.wasmHandles.get(regKey(args.pluginName, args.installSlug));
  if (!handle) {
    return { ok: false, error: `no WASM plugin loaded for (${args.pluginName}, ${args.installSlug})` };
  }
  const result = await handle.callAction(args.actionName, args.payload);
  if (result.ok) return { ok: true, payload: result.payload as Uint8Array };
  return { ok: false, error: result.error?.message ?? 'unknown error' };
}

/**
 * Look up a sealed action registry for a (plugin, harness) pair. Returns
 * null if the pair hasn't been initialized yet — caller may want to fire
 * a lifecycle event first (e.g., `beforeMissionStart`) to trigger init.
 */
export async function getActionRegistry(
  pluginName: string,
  installSlug: string,
): Promise<ServerActionRegistry | null> {
  const state = await getPluginHost();
  return state.registries.get(regKey(pluginName, installSlug)) ?? null;
}

/**
 * Invoke a plugin action by name. Triggers lazy `(plugin, harness)` init
 * if needed, then dispatches to the registered handler with the supplied
 * params + an AbortSignal. Returns the handler's `{ok, result?, error?}`
 * envelope.
 */
export async function invokePluginAction(args: {
  pluginName: string;
  actionName: string;
  installSlug: string;
  projectDir: string;
  stateDir: string;
  pluginDataDirOverride?: string;
  params?: unknown;
  triggerSource?: 'cli' | 'ui' | 'mission-done' | 'webhook' | 'api';
  triggerId?: string;
}): Promise<ActionResult> {
  const state = await getPluginHost();
  const lp = state.loaded.find((p) => p.plugin.name === args.pluginName);
  if (!lp) return { ok: false, error: `plugin "${args.pluginName}" not loaded` };
  const ctx = buildPapercuspContext({
    pluginName: lp.plugin.name,
    installSlug: args.installSlug,
    projectDir: args.projectDir,
    stateDir: args.stateDir,
    ...(args.pluginDataDirOverride ? { pluginDataDirOverride: args.pluginDataDirOverride } : {}),
  });
  await ensureInitialized(state, lp, ctx);
  const registry = state.registries.get(regKey(lp.plugin.name, args.installSlug));
  if (!registry) return { ok: false, error: `no action registry for "${args.pluginName}@${args.installSlug}" — init may have failed` };
  // ensureInitialized worked on its own ctx — attach the same extras to
  // this ctx (which is what the action handler will receive as its first arg).
  attachPluginCtxExtras(ctx, lp, registry, state.grants.get(regKey(lp.plugin.name, ctx.installSlug)));
  // Mint a correlation id per invocation so every line emitted during
  // this run (ctx.log + console.* + final result) is threadable in the UI.
  const corrId = args.triggerId ?? `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const jsonlPath = jsonlPathForStateDir(ctx.stateDir);
  // Mark invocation start in run.log.jsonl so the UI can scope the "this
  // invocation only" filter chip.
  appendLogEventSync(jsonlPath, {
    ts: new Date().toISOString(),
    source: `plugin:${lp.plugin.name}`,
    level: 'info',
    msg: `→ invoke ${args.actionName}`,
    corrId,
    attrs: { triggerSource: args.triggerSource ?? 'api', params: args.params },
  });
  const result = await runUnderPluginCtx(lp.plugin.name, ctx, corrId, () =>
    registry.invoke({
      name: args.actionName,
      ctx,
      params: args.params,
      triggerSource: args.triggerSource ?? 'api',
      triggerId: corrId,
    }),
  );
  // Final structured event: always lands in run.log.jsonl regardless of
  // whether the plugin called ctx.log itself. This is what makes the
  // cloudflare-pages publish URL visible in the panel even though the
  // plugin's runPublish() doesn't emit a final ctx.log.
  appendLogEventSync(jsonlPath, {
    ts: new Date().toISOString(),
    source: `plugin:${lp.plugin.name}`,
    level: result.ok ? 'info' : 'error',
    msg: result.ok
      ? `✓ ${args.actionName} ok`
      : `✗ ${args.actionName} failed: ${result.error ?? 'unknown error'}`,
    corrId,
    attrs: result.ok ? { result: result.result } : { error: result.error },
  });
  return result;
}

/**
 * Initialize every loaded plugin for the given harness slug. Idempotent
 * per (plugin, slug) pair — repeat calls are no-ops. Errors in one plugin's
 * init are caught + logged; never aborts the others.
 *
 * Called eagerly by `firePluginLifecycle` on every fire so plugins without
 * the specific hook handler still get their `init()` run on first contact
 * with a harness. Also exposed for explicit warm-up paths (e.g., a server
 * startup hook that wants to surface init errors before the first event).
 */
export async function warmUpPluginsForSlug(args: {
  installSlug: string;
  projectDir: string;
  stateDir: string;
}): Promise<void> {
  const state = await getPluginHost();
  // COOPERATIVE YIELD between plugin inits (event-loop-lag root fix). Warming N
  // plugins × M harness slugs at boot runs each plugin's synchronous `init()`
  // back-to-back on the main thread — long enough (22 plugins) to starve the
  // routine ticker past the watchdog's freeze threshold → a restart loop that
  // reclaim-kills in-flight queen/bee spawns. Yielding the macrotask queue between
  // inits lets the ticker (and IO) interleave, so a slow warm no longer freezes the
  // host. Quiet boot pays ≤1 macrotask hop per few plugins; a saturated loop yields
  // every iteration (cooperativeYield reads loopPressure()).
  let yielded = 0;
  for (const lp of state.loaded) {
    const ctx = buildPapercuspContext({
      pluginName: lp.plugin.name,
      installSlug: args.installSlug,
      projectDir: args.projectDir,
      stateDir: args.stateDir,
    });
    await ensureInitialized(state, lp, ctx);
    yielded = await cooperativeYield(yielded);
  }
}

/**
 * Fire one of the typed `PluginHooks` events at every loaded plugin that
 * declares a handler. Each handler runs sequentially with its own
 * per-(plugin, harness) ctx. Errors are caught + logged; one bad plugin
 * never aborts the chain.
 *
 * Lazy-initializes every loaded plugin for the slug on first fire (so
 * plugins without this specific hook handler still run their `init()`).
 */
export async function firePluginLifecycle<K extends keyof PluginHooks>(
  event: K,
  args: {
    installSlug: string;
    projectDir: string;
    stateDir: string;
  },
  ...payload: PluginHooks[K] extends ((ctx: PapercuspContext, ...rest: infer R) => any) | undefined ? R : never
): Promise<void> {
  await warmUpPluginsForSlug(args);
  const state = await getPluginHost();
  for (const lp of state.loaded) {
    const handler = lp.plugin.hooks?.[event];
    if (typeof handler !== 'function') continue;
    const ctx = buildPapercuspContext({
      pluginName: lp.plugin.name,
      installSlug: args.installSlug,
      projectDir: args.projectDir,
      stateDir: args.stateDir,
    });
    const registry = state.registries.get(regKey(lp.plugin.name, args.installSlug));
    if (registry) attachPluginCtxExtras(ctx, lp, registry, state.grants.get(regKey(lp.plugin.name, ctx.installSlug)));
    try {
      await runUnderPluginCtx(lp.plugin.name, ctx, undefined, async () => {
        // Cast through `any` — the conditional-type indexed handler doesn't
        // narrow well across the Promise return inside Array#forEach style
        // iteration; we've validated `typeof handler === 'function'`.
        await (handler as any)(ctx, ...payload);
      });
    } catch (e: any) {
      ctx.log(`hook "${String(event)}" threw: ${e?.message ?? e}`);
    }
  }

}

export async function pluginHostStatus(): Promise<PluginHostStatus & {
  plugins: Array<{ name: string; version: string; source: string }>;
  loadErrors: Array<{ error: string; path: string }>;
  initializedPairs: string[];
  registeredActions: Array<{ key: string; declared: string[]; registered: string[] }>;
}> {
  const state = await getPluginHost();
  const { listReactionRules } = await import('./events/registry');
  const reactionRules = listReactionRules()
    .filter((r) => typeof r.source === 'string' && r.source.startsWith('plugin:'))
    .map((r) => ({ id: r.id, on: r.on, fire: r.fire, plugin: (r.source as string).slice('plugin:'.length) }));
  return {
    loaded: state.loaded.length,
    errors: state.loadErrors.length,
    reactionRules,
    triggerPacks: state.loaded.flatMap((lp) => lp.triggerPack
      ? [{
          plugin: lp.plugin.name,
          targetCount: lp.triggerPack.targets.length,
          bindingCount: lp.triggerPack.bindings.length,
          edgeCount: lp.triggerPack.edges.length,
          // Provider-pinned sources only: a portable (datatype) source names no
          // provider until install binds it to a local source (D-013 §1).
          sourceKinds: [...new Set(lp.triggerPack.bindings.flatMap((binding) =>
            binding.source.kind === 'external' && binding.source.sourceKind ? [binding.source.sourceKind] : []))].sort(),
          armed: false as const,
        }]
      : []),
    plugins: state.loaded.map((lp) => ({ name: lp.plugin.name, version: lp.plugin.version, source: lp.source })),
    loadErrors: state.loadErrors,
    initializedPairs: Array.from(state.initialized).sort(),
    registeredActions: Array.from(state.registries.entries()).map(([key, r]) => ({
      key,
      declared: r.declaredNames(),
      registered: r.registeredNames(),
    })),
  };
}

/** Tests-only: drop the cached host so the next call re-discovers. */
/**
 * Before resetting the host, walk each initialized (plugin, harness)
 * pair, call `getStateForReload` on plugins that opted in via
 * `manifest.hotReload.preserveState`, and stash the result in PG.
 * On the next init() for that pair the host will call
 * `restoreFromReload(state)`.
 *
 * Errors per-plugin are swallowed with a log — a misbehaving plugin
 * mustn't block the rest of the reset.
 */
export async function captureReloadStates(): Promise<void> {
  const state = __cache.state;
  if (!state) return;
  let sql: any;
  let savePluginReloadState: any;
  try {
    const dep = await import('@papercusp/db-org');
    sql = dep.getOrgPg().sql;
    ({ savePluginReloadState } = await import('./plugin-reload-state'));
  } catch {
    return;
  }
  for (const key of state.initialized) {
    const [pluginName, harnessSlug] = splitRegKey(key);
    const lp = state.loaded.find((p) => p.plugin.name === pluginName);
    if (!lp) continue;
    const manifest = lp.plugin as unknown as { hotReload?: { preserveState?: boolean } };
    if (!manifest.hotReload?.preserveState) continue;
    const getStateForReload = lp.plugin.hooks?.getStateForReload;
    if (typeof getStateForReload !== 'function') continue;
    try {
      const ctx = await buildContextFor(lp, harnessSlug);
      if (!ctx) continue;
      const stash = await getStateForReload(ctx);
      await savePluginReloadState({ pluginId: pluginName, harnessSlug, sql }, stash);
    } catch (e: any) {
       
      console.warn(`[plugin-host] getStateForReload(${pluginName}, ${harnessSlug}) threw — state discarded: ${e?.message ?? e}`);
    }
  }
}

function splitRegKey(key: string): [string, string] {
  const idx = key.lastIndexOf('::');
  if (idx < 0) return [key, ''];
  return [key.slice(0, idx), key.slice(idx + 2)];
}

async function buildContextFor(lp: LoadedPlugin, harnessSlug: string): Promise<PapercuspContext | null> {
  // Mirror the minimal ctx shape ensureInitialized uses: discovery
  // already gave us the dataDir + projectDir for the harness.
  // Reuses the same project-resolution path as enable/handler dispatch.
  try {
    const { resolveHarnessPaths } = await import('./resolve-harness-paths');
    const paths = await resolveHarnessPaths(harnessSlug, lp.plugin.name);
    if (!paths) return null;
    return {
      projectDir: paths.projectDir,
      stateDir: paths.stateDir,
      // resolveHarnessPaths returns only {projectDir, stateDir}; derive the
      // data dir the same way buildPapercuspContext does.
      pluginDataDir: join(paths.stateDir, 'plugin-data', lp.plugin.name),
      installSlug: harnessSlug,
      log: (msg: string) => {
         
        console.log(`[${lp.plugin.name}/${harnessSlug}] ${msg}`);
      },
    } as PapercuspContext;
  } catch {
    return null;
  }
}

export function _resetPluginHostForTests(): void {
  // Every unload path (uninstall, host refresh, Cupboard install, hot reload,
  // workspace switch) funnels through this reset, so it is where providers
  // leave the registry. The next discovery re-registers the survivors.
  if (__cache.state) unregisterPluginProviders(__cache.state.loaded);
  __cache.promise = null;
  __cache.state = null;
  // Also clear Node's CJS require.cache for plugin entry files so
  // freshly-recompiled plugin code is actually re-read on next discovery.
  // Without this, `createRequire(...).require(entryPath)` returns the
  // previously-loaded module object even after the host cache is cleared.
  // Symlinks under ~/.papercusp/global-plugins/ are followed to their real
  // paths before being cached, so we match against the resolved targets.
  try {
    const root = join(papercuspRoot(), 'global-plugins');
    const fs = require('node:fs') as typeof import('node:fs');
    const resolvedRoots = new Set<string>();
    const collectRealpaths = (dir: string, depth: number): void => {
      if (depth > 2) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        try {
          const real = fs.realpathSync(full);
          resolvedRoots.add(real);
        } catch {
          continue;
        }
        // npm-style scope dirs (`@papercupai/`) hold one or more plugin
        // dirs as children; their symlink targets must be resolved too,
        // otherwise require.cache keyed on the source-tree realpath
        // survives a reset and stale module objects keep being served.
        if (entry.name.startsWith('@')) {
          collectRealpaths(full, depth + 1);
        }
      }
    };
    if (fs.existsSync(root)) {
      collectRealpaths(root, 0);
    }
    // Also walk project-plugin roots (libs/papercusp/plugins/ and any
    // <projectDir>/plugins/) so freshly-edited project plugins reload too.
    // Without this, project-plugin .cjs entries survive refresh and stale
    // module objects keep being served — visible as edits to a project
    // plugin's index.cjs not taking effect after POST /api/plugins/host/refresh.
    //
    // Search from BOTH cwd and __dirname. Dev operator launched from the
    // home dir has cwd=/home/dev where no libs/papercusp/plugins
    // exists — the module's own __dirname is what reliably traces back
    // to the repo.
    const projectPluginRoots = [
      ...(() => {
        const found: string[] = [];
        for (const seed of [process.cwd(), __dirname]) {
          let cur = seed;
          for (let i = 0; i < 12; i++) {
            const candidate = join(cur, 'libs', 'papercusp', 'plugins');
            if (fs.existsSync(candidate) && !found.includes(candidate)) {
              found.push(candidate);
              break;
            }
            const parent = join(cur, '..');
            if (parent === cur) break;
            cur = parent;
          }
        }
        return found;
      })(),
    ];
    for (const r of projectPluginRoots) {
      collectRealpaths(r, 0);
    }
    for (const k of Object.keys(require.cache)) {
      const matches =
        k.startsWith(root) ||
        projectPluginRoots.some((r) => k.startsWith(r)) ||
        Array.from(resolvedRoots).some((r) => k.startsWith(r));
      if (matches) delete require.cache[k];
    }
  } catch {
    /* require.cache may not exist in non-CJS contexts */
  }
}

/**
 * Tests-only: inject a fixed list of `LoadedPlugin` records directly,
 * bypassing filesystem discovery. The next `getPluginHost()` call returns
 * the injected state (instead of running `loadPlugins`). Subsequent
 * `_resetPluginHostForTests()` clears the override and restores normal
 * filesystem discovery on the next call.
 */
export function _injectPluginHostForTests(loaded: LoadedPlugin[]): void {
  const state: HostState = {
    loaded,
    loadErrors: [],
    initialized: new Set(),
    registries: new Map(),
    grants: new Map(),
    wasmHandles: new Map(),
  };
  __cache.state = state;
  __cache.promise = Promise.resolve(state);
  // Pin rootAtCache so getPluginHost()'s workspace-switch invalidation
  // doesn't immediately wipe the injected state on first call.
  __cache.rootAtCache = papercuspRoot();
}

/**
 * Dev-mode plugin hot-reload: watch the global-plugins directory and reset
 * the host cache whenever a plugin's manifest or entry file changes. Idempotent
 * — repeat calls are no-ops once the watcher is armed.
 *
 * Returns a `dispose()` to stop watching. Watcher is intentionally cheap
 * (manifest-level only); it doesn't try to re-import in place. Next request
 * after a change pays the discovery cost.
 *
 * Opt in via `PAPERCUSP_DEV_PLUGIN_WATCH=1` (the operator's bootstrap reads
 * this env on startup). Avoid in production where filesystem-watch overhead
 * compounds on shared hosts.
 */
// The watcher handle lives on the module's single pin (`__cache.watcher`, declared
// at the top of this file) rather than a second hand-rolled globalThis key.
export function watchPluginsForReload(opts: { dir?: string } = {}): { dispose: () => void } {
  if (__cache.watcher) return __cache.watcher;
  const dir = opts.dir ?? join(papercuspRoot(), 'global-plugins');
  const fs = require('node:fs') as typeof import('node:fs');
  if (!existsSync(dir)) {
    const noop = { dispose: () => {} };
    __cache.watcher = noop;
    return noop;
  }
  let pending: NodeJS.Timeout | null = null;
  const reset = (filename: string | null) => {
    // Debounce — editor saves can stat-touch the same file 3-4 times in a
    // row, and we only need one reset per burst.
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      if (filename) console.log(`[plugin-host] hot-reload: ${filename} changed → resetting plugin runtime cache`);
      _resetPluginHostForTests();
      try {
        const { _resetPluginApiRoutesForTests } = require('./plugin-api-mount');
        _resetPluginApiRoutesForTests();
      } catch { /* ignore */ }
    }, 250);
  };
  const watcher = fs.watch(dir, { recursive: true }, (_evt, filename) => {
    if (!filename) return;
    // Only react to manifest / entry-point changes — node_modules churn or
    // editor swap files would otherwise reset on every keystroke.
    if (/papercusp\.json$|\/index\.(?:m?js|ts)$|\/dist\/index\.js$/.test(filename)) {
      reset(filename);
    }
  });
  const handle = {
    dispose: () => {
      if (pending) clearTimeout(pending);
      try { watcher.close(); } catch { /* ignore */ }
      __cache.watcher = null;
    },
  };
  __cache.watcher = handle;
  console.log(`[plugin-host] hot-reload watcher armed on ${dir}`);
  return handle;
}
