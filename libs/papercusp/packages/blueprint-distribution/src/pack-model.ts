/**
 * The **pack model** — the unified tool-distribution unit
 * (`tool-distribution-granularity-2026-06-05` D-001/D-006).
 *
 * One distribution concept, not three: a **pack** is the distribution /
 * marketplace unit (n≥1 tools). A *single tool* is the degenerate **n=1**
 * pack; a *plugin* is a pack **with a runtime** (hooks / MCP server / daemon /
 * UI / state). So "tool", "pack", and "plugin" are points on one axis, and
 * the discovery + dependency layers reason about exactly one shape.
 *
 * **Pure + borrowable** (same discipline as `blueprint-deps.ts`): nothing
 * here touches a catalog, PG, the plugin host, or the network. The host
 * derives `PackDescriptor`s from its live registries (the operator wires the
 * projected-tool registry + plugin host + Cupboard listings; the CLI wires
 * its own equivalents) and this module indexes + resolves over them.
 *
 * The resolver answers the one question every consumer has
 * (`tool-distribution-granularity` D-002/D-004): *given a tool name, who
 * provides it?* —
 *   - `available`   — resolvable right now (built-in catalog, or a loaded
 *                     plugin/pack registered it);
 *   - `installable` — not present, but a known Cupboard listing declares it
 *                     in `provides_tools` (install that unit and the tool
 *                     resolves);
 *   - `unknown`     — no known provider.
 *
 * **The same question, asked of EVENTS** (`cupboard-public-release-2026-07-12`
 * D-003, P-007): *given an awaitable event family, who provides it?* Events are
 * a dependency axis exactly like tools — a unit that reacts to `foo:done` is as
 * broken without a provider of `foo:done` as it is without a tool it calls, so
 * the same three-valued ladder answers it ({@link resolveEventProvider}). The
 * one deliberate asymmetry — builtin outranks installed on the event axis, the
 * reverse of the tool axis — is explained on that function; it exists so the
 * resolver and the P-006 catalog merge cannot disagree about a collision.
 */

/** Where a pack's provider sits on the tool→provider resolution ladder. */
export type PackProviderKind = 'builtin' | 'plugin' | 'pack';

/**
 * One awaitable event-key FAMILY a unit declares it provides — the provider
 * half of the events-as-a-dependency axis (D-003, cupboard-public-release
 * P-005/P-007). A structural subset of the plugin-SDK's `ManifestProvidedEvent`
 * and of operator-core's `EventCatalogEntry`, so a manifest declaration and a
 * builtin registry entry both widen to this without a translation layer.
 */
export interface ProvidedEventFamily {
  /** Stable family id — the catalog lookup key and `buildKey` handle. */
  family: string;
  /** Key TEMPLATE with `<param>` placeholders; a no-param family is a literal key. */
  keyTemplate: string;
  describe?: string | null;
}

/**
 * One event FAMILY a unit declares it REQUIRES — the consumer half of the same
 * axis (D-003), and the mirror of `ProvidedEventFamily`. A structural subset of
 * the plugin-SDK's `ManifestEventDependency`.
 *
 * This is a DECLARATION, not a resolution: it says "this unit needs family X",
 * never "X is available". `resolveEventProvider` answers the latter, against a
 * catalog. Keeping the two apart is what lets a listing carry its requirements
 * BEFORE anything is installed — which is the whole point of surfacing them on
 * a listing's detail page: the P-007 install gate HARD-FAILS a required family
 * nothing provides, so the user has to be able to see that coming rather than
 * discover it in a refusal toast after clicking Install.
 */
export interface RequiredEventFamily {
  /** The provided family id this unit needs. */
  family: string;
  /** listen-if-present soft dep — an unresolvable optional dep never blocks an install. */
  optional?: boolean;
}

/**
 * One distribution unit, projected into the pack model. Derived by the host:
 * a loaded/installed plugin, an installed code-tool pack, or a Cupboard
 * listing (kind plugin|pack) that has not been installed yet.
 */
export interface PackDescriptor {
  /** Distribution-unit name (the plugin/pack manifest name). */
  name: string;
  /**
   * Tool names this unit provides (n≥1; a single tool is a pack of n=1).
   * For installed units: the names actually registered (e.g. `repomix.pack`).
   * For Cupboard units: the listing's `provides_tools` declaration.
   */
  tools: readonly string[];
  /**
   * Does the unit carry a runtime beyond its tools (hooks / MCP server /
   * daemon / WASM / UI surfaces / state)? A plugin is a pack WITH a runtime
   * (D-001); a code-tool pack is runtime-less and may install in isolation
   * (D-004/D-005).
   */
  hasRuntime: boolean;
  /**
   * Event-key families this unit declares it PROVIDES (D-003, P-005/P-007) —
   * the event-axis twin of `tools`. For installed units: the manifest's
   * `provides.events`. For Cupboard units: the listing's `provides_events`
   * declaration. Absent/empty on a unit that provides no events (the common
   * case), so every existing caller is unaffected.
   */
  events?: readonly ProvidedEventFamily[];
  /** plugin (runtime-bearing) vs pack (runtime-less code-tool pack). */
  kind: Exclude<PackProviderKind, 'builtin'>;
  /** installed (present on this host) vs cupboard (installable listing). */
  source: 'installed' | 'cupboard';
  version?: string | null;
  description?: string | null;
  /** Cupboard listing id, when `source === 'cupboard'`. */
  listingId?: string | null;
}

/** The resolver's answer for one tool name (D-002's tool→provider mapping). */
export type ToolProviderResolution =
  | {
      tool: string;
      status: 'available';
      provider: { kind: PackProviderKind; name: string };
    }
  | {
      tool: string;
      status: 'installable';
      provider: { kind: Exclude<PackProviderKind, 'builtin'>; name: string; listingId?: string | null };
    }
  | { tool: string; status: 'unknown'; provider?: undefined };

/**
 * The resolver's answer for one event FAMILY id (D-003's event→provider
 * mapping) — the event-axis twin of {@link ToolProviderResolution}.
 */
export type EventProviderResolution =
  | {
      family: string;
      status: 'available';
      provider: { kind: PackProviderKind; name: string };
      /** The key template to build a concrete key from (the whole point of resolving). */
      keyTemplate?: string;
    }
  | {
      family: string;
      status: 'installable';
      provider: { kind: Exclude<PackProviderKind, 'builtin'>; name: string; listingId?: string | null };
      keyTemplate?: string;
    }
  | { family: string; status: 'unknown'; provider?: undefined; keyTemplate?: undefined };

/**
 * An indexed snapshot of every known distribution unit + the host's
 * un-packaged built-in tools. Build once per resolution pass with
 * {@link buildPackCatalogView}; cheap to query.
 */
export interface PackCatalogView {
  /** Every known unit, installed first, in input order (dedup by name — first wins). */
  packs: readonly PackDescriptor[];
  /** name → descriptor for every known unit. */
  byName: ReadonlyMap<string, PackDescriptor>;
  /** tool name → INSTALLED providing unit (precedence over cupboard). */
  installedToolIndex: ReadonlyMap<string, PackDescriptor>;
  /** tool name → CUPBOARD providing unit (first listing claiming it wins). */
  cupboardToolIndex: ReadonlyMap<string, PackDescriptor>;
  /**
   * First-party tools available in-process that belong to no distribution
   * unit (the operator's built-in catalog). These resolve as
   * `{ kind: 'builtin' }` — the floor of the resolution ladder.
   */
  builtinTools: ReadonlySet<string>;
  /** family id → INSTALLED providing unit (see the ladder note on resolveEventProvider). */
  installedEventIndex: ReadonlyMap<string, PackDescriptor>;
  /** family id → CUPBOARD providing unit (first listing claiming it wins). */
  cupboardEventIndex: ReadonlyMap<string, PackDescriptor>;
  /**
   * Event families the host's BUILTIN registry owns (operator-core's
   * `EVENT_CATALOG`). Injected, not imported — this module stays pure and
   * host-agnostic, exactly as `builtinTools` is. Maps family → key template so
   * a resolution can hand back the template without a second lookup.
   */
  builtinEvents: ReadonlyMap<string, string>;
}

/**
 * Index a host's derived pack descriptors + built-in tool names into a
 * queryable view. Pure; stable under re-ordering except that the FIRST
 * descriptor with a given name wins (callers should list installed units
 * before Cupboard listings so an installed copy shadows its listing).
 */
export function buildPackCatalogView(
  packs: readonly PackDescriptor[],
  builtinTools: ReadonlySet<string>,
  builtinEvents: ReadonlyMap<string, string> = new Map(),
): PackCatalogView {
  const byName = new Map<string, PackDescriptor>();
  const installedToolIndex = new Map<string, PackDescriptor>();
  const cupboardToolIndex = new Map<string, PackDescriptor>();
  const installedEventIndex = new Map<string, PackDescriptor>();
  const cupboardEventIndex = new Map<string, PackDescriptor>();
  const ordered: PackDescriptor[] = [];

  // Installed units index before cupboard units regardless of input order, so
  // an installed copy always shadows its own (or another unit's) listing.
  const sorted = [...packs].sort((a, b) =>
    a.source === b.source ? 0 : a.source === 'installed' ? -1 : 1,
  );

  for (const pack of sorted) {
    if (byName.has(pack.name)) continue; // dedup by unit name — first wins
    byName.set(pack.name, pack);
    ordered.push(pack);
    const index = pack.source === 'installed' ? installedToolIndex : cupboardToolIndex;
    for (const tool of pack.tools) {
      if (!index.has(tool)) index.set(tool, pack);
    }
    const eventIndex = pack.source === 'installed' ? installedEventIndex : cupboardEventIndex;
    for (const ev of pack.events ?? []) {
      if (!ev?.family) continue;
      if (!eventIndex.has(ev.family)) eventIndex.set(ev.family, pack);
    }
  }

  return {
    packs: ordered,
    byName,
    installedToolIndex,
    cupboardToolIndex,
    builtinTools,
    installedEventIndex,
    cupboardEventIndex,
    builtinEvents,
  };
}

/**
 * Resolve one tool name to its provider (D-002). Ladder:
 *   1. an INSTALLED unit registered it → `available` (plugin|pack);
 *   2. the built-in catalog has it → `available` (builtin);
 *   3. a Cupboard listing declares it in `provides_tools` → `installable`;
 *   4. nobody knows it → `unknown`.
 *
 * Installed units outrank built-ins only nominally — a live registry never
 * holds the same name twice (the tooldef registry fails loud on collision),
 * so 1 vs 2 ordering is about attribution, not shadowing.
 */
export function resolveToolProvider(tool: string, view: PackCatalogView): ToolProviderResolution {
  const installed = view.installedToolIndex.get(tool);
  if (installed) {
    return { tool, status: 'available', provider: { kind: installed.kind, name: installed.name } };
  }
  if (view.builtinTools.has(tool)) {
    return { tool, status: 'available', provider: { kind: 'builtin', name: 'builtin' } };
  }
  const cupboard = view.cupboardToolIndex.get(tool);
  if (cupboard) {
    return {
      tool,
      status: 'installable',
      provider: { kind: cupboard.kind, name: cupboard.name, listingId: cupboard.listingId ?? null },
    };
  }
  return { tool, status: 'unknown' };
}

/** Every tool name resolvable right now (installed units + built-ins). */
export function availableToolNames(view: PackCatalogView): Set<string> {
  const out = new Set<string>(view.builtinTools);
  for (const tool of view.installedToolIndex.keys()) out.add(tool);
  return out;
}

/** The template a unit declares for `family`, if it declares it at all. */
function templateOf(pack: PackDescriptor, family: string): string | undefined {
  return pack.events?.find((e) => e?.family === family)?.keyTemplate;
}

/**
 * Resolve one event FAMILY id to its provider (D-003) — the event-axis twin of
 * {@link resolveToolProvider}. Ladder:
 *   1. the BUILTIN registry owns it → `available` (builtin);
 *   2. an INSTALLED unit declares it → `available` (plugin|pack);
 *   3. a Cupboard listing declares it in `provides_events` → `installable`;
 *   4. nobody declares it → `unknown`.
 *
 * ⚠ NOTE THE ORDER — builtin outranks installed here, the REVERSE of
 * `resolveToolProvider`. That inversion is deliberate and load-bearing:
 *
 *   - For TOOLS the two rungs can never both hold: the tooldef registry fails
 *     loud on a duplicate name, so a tool is in exactly one of them and
 *     ordering is mere attribution (see resolveToolProvider's note).
 *   - For EVENTS they CAN both hold — a pack is free to declare a family id the
 *     builtin catalog already owns — and the catalog merge (P-006) resolves
 *     that collision by REFUSING the installed declaration: builtin always
 *     wins, because the sugar verbs resolve key templates by family id, so
 *     letting a pack re-point e.g. `deploy` would leave `deploy:await` waiting
 *     on a key nothing emits — an agent hung forever, silently.
 *
 * So checking installed first would make this resolver ANSWER A COLLISION
 * DIFFERENTLY FROM THE CATALOG THAT REFUSED IT ("pack X provides deploy" vs
 * "builtin provides deploy; pack X's declaration was rejected") — two truths
 * for one family, which is precisely the class of drift that strands awaiters.
 * One policy, stated once, enforced in both places.
 */
export function resolveEventProvider(family: string, view: PackCatalogView): EventProviderResolution {
  const builtinTemplate = view.builtinEvents.get(family);
  if (builtinTemplate !== undefined) {
    return {
      family,
      status: 'available',
      provider: { kind: 'builtin', name: 'builtin' },
      keyTemplate: builtinTemplate,
    };
  }
  const installed = view.installedEventIndex.get(family);
  if (installed) {
    return {
      family,
      status: 'available',
      provider: { kind: installed.kind, name: installed.name },
      keyTemplate: templateOf(installed, family),
    };
  }
  const cupboard = view.cupboardEventIndex.get(family);
  if (cupboard) {
    return {
      family,
      status: 'installable',
      provider: { kind: cupboard.kind, name: cupboard.name, listingId: cupboard.listingId ?? null },
      keyTemplate: templateOf(cupboard, family),
    };
  }
  return { family, status: 'unknown' };
}

/** Every event family awaitable right now (built-ins + installed units). */
export function availableEventFamilies(view: PackCatalogView): Set<string> {
  const out = new Set<string>(view.builtinEvents.keys());
  for (const family of view.installedEventIndex.keys()) out.add(family);
  return out;
}
