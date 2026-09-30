/**
 * pack-catalog — derive the live **pack catalog** (the unified
 * tool-distribution view) from the operator's real registries
 * (`tool-distribution-granularity-2026-06-05` P-001/P-002/D-006).
 *
 * The pure pack model (`@papercusp/blueprint-distribution` `pack-model.ts`)
 * knows nothing about hosts; this module is the operator's wiring of it:
 *
 *   - **built-in tools** — the legacy `getCatalog()` names ∪ projected tools
 *     registered under the synthetic `'agent-mcp'` plugin;
 *   - **installed units** — every plugin/pack manifest on disk
 *     (`listAllInstalledPlugins`), with its tool names taken from the live
 *     projected registry when the unit is loaded (covers dynamic-tool
 *     plugins) and from the manifest `tools[]` declarations otherwise;
 *   - **Cupboard units** — `GET /listings?kind=plugin|pack` rows with their
 *     `provides_tools` declarations (installable, not installed).
 *
 * The assembly is split pure/IO: `assemblePackCatalog` is pure (unit-tested
 * with injected inputs); `derivePackCatalog` does the IO and delegates.
 *
 * This view also FIXES a recon-found gap: `harness:create`'s tool-dep gate
 * previously resolved against `getCatalog()` only, so a blueprint depending
 * on a plugin-PROVIDED tool (e.g. `repomix.pack`) hard-failed even with the
 * plugin installed. `availableToolNames(view)` unions both registries.
 */
import {
  availableToolNames,
  buildPackCatalogView,
  type DependencyHostSets,
  type PackCatalogView,
  type PackDescriptor,
  type ProvidedEventFamily,
  type RequiredEventFamily,
} from '@papercusp/blueprint-distribution';
import { EVENT_CATALOG } from '../events/await/catalog';
import { availableBlueprintIds } from '../blueprint/installed-blueprints';
import { getCatalog, listAllProjectedTools } from '@papercusp/agent-mcp';
import { resolveCupboardBaseUrl } from './base-url';
import { listAllInstalledPlugins, type InstalledPlugin } from './plugin-listings';

/** The synthetic pluginName built-in defineTool projections register under. */
export const BUILTIN_PLUGIN_NAME = 'agent-mcp';

/** `'@papercupai/repomix'` → `'repomix'` (the loader's MCP-name convention). */
export const shortUnitName = (name: string): string => name.replace(/^@[^/]+\//, '');

/** One Cupboard listing row projected to a distribution unit. */
export interface CupboardUnitRow {
  name: string;
  kind: 'plugin' | 'pack';
  listingId: string | null;
  providesTools: string[];
  /** Event families the listing declares (`provides_events`, D1 migration 012). */
  providesEvents?: ProvidedEventFamily[];
  description?: string | null;
}

export interface DerivedPackCatalog {
  view: PackCatalogView;
  /** Deduped descriptors, installed units first (the view's order). */
  packs: readonly PackDescriptor[];
  builtinTools: ReadonlySet<string>;
  /** False if the Cupboard fetch failed — callers soften missing-dep verdicts. */
  cupboardReachable: boolean;
}

/** Minimal manifest surface the assembler reads (matches `PluginManifest`). */
export interface InstalledUnitInput {
  name: string;
  version?: string;
  description?: string;
  kind?: string;
  tools?: Array<{ name?: unknown; expose?: { mcp?: { name?: unknown } } } | null>;
  /** Unit-level provisions (D-003, P-005): the event families this unit provides. */
  provides?: { events?: unknown } | null;
  /** Unit-level dependencies (D-003, P-005): the event families this unit REQUIRES. */
  dependencies?: { events?: unknown } | null;
}

/**
 * Coerce a unit's declared event families (manifest `provides.events` or a
 * listing's `provides_events` JSON) into the pure model's shape. Fail-soft:
 * a malformed entry is DROPPED, never thrown — a bad third-party manifest must
 * not take down the whole catalog derivation for every other unit.
 */
export function parseProvidedEvents(raw: unknown): ProvidedEventFamily[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: ProvidedEventFamily[] = [];
  const seen = new Set<string>();
  for (const e of value) {
    if (e == null || typeof e !== 'object') continue;
    const { family, keyTemplate, describe } = e as Record<string, unknown>;
    if (typeof family !== 'string' || family.length === 0) continue;
    if (typeof keyTemplate !== 'string' || keyTemplate.length === 0) continue;
    if (seen.has(family)) continue; // first declaration wins within a unit
    seen.add(family);
    out.push({ family, keyTemplate, describe: typeof describe === 'string' ? describe : null });
  }
  return out;
}

/**
 * Coerce a unit's declared event DEPENDENCIES (manifest `dependencies.events`
 * or a listing's `requires_events` JSON) into the pure model's shape. Fail-soft
 * for the same reason as `parseProvidedEvents`.
 *
 * Two deliberate rules, both mirroring `uniqEvents` in resolve-and-install so a
 * declaration reads identically wherever it is parsed:
 *  - a bare STRING entry reads as REQUIRED (`{ family, optional: false }`) — the
 *    safe reading of an under-specified declaration: fail loudly rather than
 *    install a unit whose reactions silently never fire.
 *  - on a duplicate family, REQUIRED WINS. A soft re-declaration must never be
 *    able to downgrade a hard dependency into a no-op.
 */
export function parseRequiredEvents(raw: unknown): RequiredEventFamily[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const byFamily = new Map<string, RequiredEventFamily>();
  for (const e of value) {
    let family: string | undefined;
    let optional = false;
    if (typeof e === 'string') {
      family = e;
    } else if (e != null && typeof e === 'object') {
      const rec = e as Record<string, unknown>;
      if (typeof rec.family === 'string') family = rec.family;
      optional = rec.optional === true;
    }
    if (!family) continue;
    const prev = byFamily.get(family);
    // REQUIRED WINS: once any declaration says required, an optional one cannot
    // relax it back.
    if (prev) {
      if (prev.optional && !optional) byFamily.set(family, { family, optional: false });
      continue;
    }
    byFamily.set(family, { family, optional });
  }
  return [...byFamily.values()];
}

/**
 * Tool names a not-loaded unit's manifest promises, using the loader's
 * naming convention (`expose.mcp.name` override, else `<short>.<name>`).
 */
export function manifestToolNames(manifest: InstalledUnitInput): string[] {
  const short = shortUnitName(manifest.name);
  const out: string[] = [];
  for (const t of manifest.tools ?? []) {
    if (t == null || typeof t !== 'object') continue;
    const override = t.expose?.mcp?.name;
    if (typeof override === 'string' && override.length > 0) {
      out.push(override);
      continue;
    }
    if (typeof t.name === 'string' && t.name.length > 0) out.push(`${short}.${t.name}`);
  }
  return out;
}

export interface PackCatalogInputs {
  /** Manifests on disk (installed plugins + packs). */
  installed: InstalledUnitInput[];
  /** The live projected-tool registry: `{ pluginName, mcpName }` per tool. */
  projectedTools: Array<{ pluginName: string; mcpName: string }>;
  /** Names from the legacy built-in catalog (`getCatalog()`). */
  legacyCatalogNames: string[];
  /** Cupboard listing rows (kind plugin|pack), already fetched. */
  cupboardUnits: CupboardUnitRow[];
  cupboardReachable: boolean;
  /**
   * The host's BUILTIN event families (family → keyTemplate), i.e. operator-core's
   * `EVENT_CATALOG`. INJECTED so the assembler stays pure + testable, exactly as
   * `legacyCatalogNames` is for tools; `derivePackCatalog` supplies the real one.
   * Omitted ⇒ no builtin event floor (every existing caller keeps its behavior).
   */
  builtinEvents?: ReadonlyMap<string, string>;
}

/** Pure assembly of the pack catalog from injected registry snapshots. */
export function assemblePackCatalog(inputs: PackCatalogInputs): DerivedPackCatalog {
  const builtinTools = new Set<string>(inputs.legacyCatalogNames);
  const registeredByUnit = new Map<string, string[]>();
  for (const t of inputs.projectedTools) {
    if (!t.mcpName) continue;
    if (t.pluginName === BUILTIN_PLUGIN_NAME) {
      builtinTools.add(t.mcpName);
      continue;
    }
    const list = registeredByUnit.get(t.pluginName);
    if (list) list.push(t.mcpName);
    else registeredByUnit.set(t.pluginName, [t.mcpName]);
  }

  const packs: PackDescriptor[] = [];
  const seen = new Set<string>();
  for (const m of inputs.installed) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    const live = registeredByUnit.get(m.name);
    const isPack = m.kind === 'pack';
    packs.push({
      name: m.name,
      tools: live && live.length > 0 ? live : manifestToolNames(m),
      events: parseProvidedEvents(m.provides?.events),
      kind: isPack ? 'pack' : 'plugin',
      hasRuntime: !isPack,
      source: 'installed',
      version: m.version ?? null,
      description: m.description ?? null,
    });
  }
  // Live-registered units with no manifest on disk (dev/in-process
  // registrations) still deserve attribution.
  for (const [unitName, tools] of registeredByUnit) {
    if (seen.has(unitName)) continue;
    seen.add(unitName);
    packs.push({ name: unitName, tools, kind: 'plugin', hasRuntime: true, source: 'installed' });
  }

  for (const u of inputs.cupboardUnits) {
    packs.push({
      name: u.name,
      tools: u.providesTools,
      events: u.providesEvents ?? [],
      kind: u.kind,
      hasRuntime: u.kind === 'plugin',
      source: 'cupboard',
      listingId: u.listingId,
      description: u.description ?? null,
    });
  }

  const view = buildPackCatalogView(packs, builtinTools, inputs.builtinEvents ?? new Map());
  return { view, packs: view.packs, builtinTools, cupboardReachable: inputs.cupboardReachable };
}

/**
 * The builtin event floor: operator-core's `EVENT_CATALOG` projected to
 * family → keyTemplate. This is the set an installed/Cupboard unit may NEVER
 * shadow (P-006 merge policy; `resolveEventProvider`'s builtin-first ladder).
 */
export function builtinEventFamilies(): ReadonlyMap<string, string> {
  return new Map(EVENT_CATALOG.map((e) => [e.family, e.keyTemplate]));
}

interface CupboardListingRow {
  id?: string | number;
  listing_kind?: string;
  listing_ref?: string | null;
  title?: string | null;
  description?: string | null;
  provides_tools?: unknown;
  /** D1 migration 012 — JSON array of declared event families. Absent on a worker predating it. */
  provides_events?: unknown;
}

/** Parse a listing's `provides_tools` (JSON string or array) → string[]. */
export function parseProvidesTools(raw: unknown): string[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === 'string' && t.length > 0);
}

/**
 * Fetch the Cupboard's distribution-unit listings (kind plugin + pack).
 * Reachability is keyed on the PLUGIN fetch (the long-deployed kind); a
 * worker predating the 'pack' kind 400s the pack fetch, which degrades to
 * "no packs listed" rather than "Cupboard down".
 */
export async function fetchCupboardUnits(
  opts: { timeoutMs?: number } = {},
): Promise<{ units: CupboardUnitRow[]; reachable: boolean }> {
  const base = resolveCupboardBaseUrl();
  const timeout = opts.timeoutMs ?? 8_000;
  const fetchKind = async (kind: 'plugin' | 'pack') => {
    const res = await fetch(`${base}/listings?kind=${kind}&limit=200`, {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`listings?kind=${kind} → ${res.status}`);
    const data = (await res.json()) as { results?: CupboardListingRow[] };
    const rows = Array.isArray(data?.results) ? data.results : [];
    const units: CupboardUnitRow[] = [];
    for (const r of rows) {
      const name = (r.listing_ref ?? r.title ?? '').trim();
      if (!name) continue;
      units.push({
        name,
        kind,
        listingId: r.id != null ? String(r.id) : null,
        providesTools: parseProvidesTools(r.provides_tools),
        // Absent on a worker deployed before D1 012 → [] (no events declared),
        // which is exactly right: an old worker cannot claim to provide any.
        providesEvents: parseProvidedEvents(r.provides_events),
        description: r.description ?? null,
      });
    }
    return units;
  };

  const [plugins, packs] = await Promise.allSettled([fetchKind('plugin'), fetchKind('pack')]);
  const units: CupboardUnitRow[] = [];
  if (plugins.status === 'fulfilled') units.push(...plugins.value);
  if (packs.status === 'fulfilled') units.push(...packs.value);
  return { units, reachable: plugins.status === 'fulfilled' };
}

/**
 * Derive the live pack catalog. `includeCupboard:false` skips the network
 * read (local-only view — `cupboardReachable` reports `true` vacuously).
 *
 * Warms the plugin host first (memoized after the first call) so the
 * projected registry carries every loaded unit's tools — without it, a cold
 * host under-reports DYNAMIC-tool plugins (gitnexus-style), whose tool list
 * exists only at runtime (static manifests fall back to `tools[]` either
 * way). `warmHost:false` opts out (pure-ish contexts/tests).
 */
export async function derivePackCatalog(
  opts: { harnessSlug?: string; includeCupboard?: boolean; timeoutMs?: number; warmHost?: boolean } = {},
): Promise<DerivedPackCatalog> {
  // The warmed host's `loaded` list is the truthful installed set — it
  // includes the BUNDLED units (libs/papercusp/plugins) that the
  // plugin-listings manifest scan does not walk, and carries each unit's
  // kind/version/description. Without it a bundled pack mis-attributes as a
  // registry-only `kind: 'plugin'` fallback with null metadata.
  const hostUnits: InstalledUnitInput[] = [];
  if (opts.warmHost !== false) {
    try {
      const { getPluginHost } = await import('../plugin-host-runtime');
      const host = await getPluginHost();
      for (const lp of host.loaded) {
        const p = lp.plugin as InstalledUnitInput & { kind?: string };
        hostUnits.push({
          name: p.name,
          version: p.version,
          description: p.description,
          kind: p.kind,
          tools: (lp as { toolDefinitions?: InstalledUnitInput['tools'] }).toolDefinitions ?? p.tools,
          provides: p.provides ?? null,
        });
      }
    } catch {
      /* headless/test context without a host — manifest fallback still applies */
    }
  }
  const scanned = (await listAllInstalledPlugins(opts.harnessSlug)) as Array<
    InstalledPlugin & InstalledUnitInput
  >;
  // Host-loaded units first (richer + truthful); the scan adds
  // installed-but-not-loaded units (assemblePackCatalog dedups by name).
  const installed: InstalledUnitInput[] = [...hostUnits, ...scanned];
  const projectedTools = listAllProjectedTools()
    .map((t) => ({ pluginName: t.pluginName, mcpName: t.expose?.mcp?.name ?? '' }))
    .filter((t) => t.mcpName.length > 0);
  const legacyCatalogNames = getCatalog().map((t) => t.name);
  const cupboard =
    opts.includeCupboard === false
      ? { units: [] as CupboardUnitRow[], reachable: true }
      : await fetchCupboardUnits({ timeoutMs: opts.timeoutMs });
  return assemblePackCatalog({
    installed,
    projectedTools,
    legacyCatalogNames,
    cupboardUnits: cupboard.units,
    cupboardReachable: cupboard.reachable,
    builtinEvents: builtinEventFamilies(),
  });
}

/**
 * Project a derived catalog into the dep-validator's host sets
 * (`validateBlueprintDependencies`) — the `{tools, packs, plugins}` gate's
 * one-call wiring (D-002/D-003).
 */
export function depHostSetsFromCatalog(
  cat: DerivedPackCatalog,
  /**
   * Registered datatype ids for the resolving workspace (P-012↔P-013 loop closure):
   * `listRegisteredDatatypeNames(sql, ws)`, threaded in by the DB-aware callers (harness
   * create / blueprint install). A blueprint's `dependencies.datatypes` then resolve as
   * `ok` against these (else `needs datatype "X"`). Default `[]` ⇒ no datatype is
   * registered/satisfiable — byte-identical to before, for pure-validation callers.
   */
  datatypeNames: readonly string[] = [],
): DependencyHostSets {
  const installedPlugins = new Set<string>();
  const installedPacks = new Set<string>();
  const cupboardPlugins = new Set<string>();
  const cupboardPacks = new Set<string>();
  for (const p of cat.view.packs) {
    if (p.source === 'installed') (p.kind === 'pack' ? installedPacks : installedPlugins).add(p.name);
    else (p.kind === 'pack' ? cupboardPacks : cupboardPlugins).add(p.name);
  }
  const installableToolProviders = new Map<string, { kind: 'plugin' | 'pack'; name: string }>();
  for (const [tool, pack] of cat.view.cupboardToolIndex) {
    installableToolProviders.set(tool, { kind: pack.kind, name: pack.name });
  }
  return {
    availableTools: availableToolNames(cat.view),
    installedPlugins,
    cupboardPlugins,
    installedPacks,
    cupboardPacks,
    installableToolProviders,
    // Spawned-blueprint deps resolve against the built-in + installed tiers
    // (blueprint-role-bundling P-007). Cupboard blueprint listings are pulled by
    // the install route when it resolves the closure.
    availableBlueprints: availableBlueprintIds(),
    // P-012↔P-013 loop closure: the workspace's registered datatypes satisfy a
    // blueprint's `dependencies.datatypes`. Empty by default (no datatype registered).
    availableDatatypes: new Set(datatypeNames),
  };
}
