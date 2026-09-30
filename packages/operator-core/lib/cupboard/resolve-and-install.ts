/**
 * resolve-and-install — close the **install loop**
 * (`tool-distribution-discovery-2026-06-08` P-001 / D-002).
 *
 * The shipped dep gate (`tool-distribution-granularity-2026-06-05`) computes
 * which declared deps are `installable` (a Cupboard listing provides the
 * missing tool/pack/plugin) but only REPORTS them advisorily — nothing
 * auto-installs. This module closes that gap:
 *
 *   declared {tools,packs,plugins}
 *     → resolve each installable unit → its providing Cupboard listing
 *     → install it (the caller injects the real installer, which reuses the
 *       shipped `installPluginFromCupboardCore` / `installBlueprintFromCupboardCore`
 *       — NO second install runtime, D-002)
 *     → re-derive the catalog, fold in the installed unit's OWN declared deps,
 *       and recurse until nothing installable remains (visited-set + round cap
 *       so a malformed transitive graph terminates).
 *
 * **Pure + dependency-injected** (same discipline as `pack-catalog.ts`'s
 * pure/IO split): the algorithm — classification, recursion, the guard — is
 * here and unit-tested with injected `deriveCatalog` / `installUnit`; the IO
 * (Cupboard listing-resolve + git-clone + the install cores) lives in the
 * caller (`cupboard-install-deps.ts` / `harness:create`). Nothing here touches
 * git, the network, PG, or the plugin host.
 */
import { resolveEventProvider, resolveToolProvider } from '@papercusp/blueprint-distribution';
import type { DerivedPackCatalog } from './pack-catalog';

/**
 * One declared EVENT dependency (D-003 / plugin-SDK `ManifestEventDependency`).
 *
 * `optional` is the whole subtlety of this axis. A REQUIRED event dep is as
 * hard as a tool dep — a unit whose reaction fires on `foo:done` is inert
 * without a provider of `foo:done`, so shipping it into a host that has none is
 * a broken install, and we fail the install rather than let it sit there
 * silently never firing. But "react to it IF something provides it" is a
 * genuinely useful shape (an optional integration: enrich when the other pack
 * is present, do nothing when it isn't), and hard-failing that would force
 * authors to fork their manifest per host. Hence: hard by DEFAULT, soft on
 * request — never the reverse, because a silently-inert reaction is exactly the
 * failure the event axis exists to prevent.
 */
export interface EventDep {
  family: string;
  optional?: boolean;
}

/** The unified dep declaration (orchestrator `DependenciesSchema`). */
export interface DepSet {
  tools: string[];
  packs: string[];
  plugins: string[];
  /** Declared event-family deps (D-003, P-007). Absent ⇒ [] — every pre-event caller is unaffected. */
  events: EventDep[];
}

/** A Cupboard unit the loop wants to install (resolved from a declared dep). */
export interface InstallableUnitRef {
  /** Distribution-unit name (plugin/pack manifest name == listing_ref). */
  name: string;
  kind: 'plugin' | 'pack';
  /** Cupboard listing id (the install IO resolves it → repo coords). */
  listingId: string | null;
}

export interface InstalledUnitResult extends InstallableUnitRef {
  /** Tool names this unit contributed (from the catalog, post-install). */
  tools: string[];
}

export interface ResolveAndInstallResult {
  /** True when every declared dep is satisfied (or only softened by an
   *  unreachable Cupboard — see `advisory`). */
  ok: boolean;
  /** Units actually installed this run, in install order. */
  installed: InstalledUnitResult[];
  /** Declared deps with NO provider anywhere (tools/events), or that failed to
   *  install (packs/plugins). A non-empty `tools` is always a hard failure;
   *  `events` holds only REQUIRED families (an unresolvable OPTIONAL one is
   *  reported in `advisory` and never blocks). */
  stillMissing: DepSet;
  /** Non-fatal notes: failed installs, cupboard-unreachable softening, unresolved OPTIONAL event deps. */
  advisory: string[];
  /** How many install rounds ran (0 = nothing to install). */
  rounds: number;
}

export interface ResolveAndInstallDeps {
  /**
   * (Re-)derive the live pack catalog. Called once per round so each install's
   * effect (newly-registered tools) is visible to the next classification.
   */
  deriveCatalog: () => Promise<DerivedPackCatalog>;
  /**
   * Install one Cupboard unit. Reuses the shipped install cores in the real
   * wiring. Returns the unit's OWN declared deps that are themselves
   * installable (for transitive recursion), or an error message.
   */
  installUnit: (
    unit: InstallableUnitRef,
  ) => Promise<{ ok: true; declaredDeps?: Partial<DepSet> } | { ok: false; error: string }>;
  /** Termination guard — max install rounds (default 8). */
  maxRounds?: number;
}

const emptyDepSet = (): DepSet => ({ tools: [], packs: [], plugins: [], events: [] });

/**
 * Dedup event deps by family. When the SAME family is declared both required
 * and optional (a unit requires it; a transitive dep merely listens), REQUIRED
 * WINS — the strictest declaration governs. The other way round would let a
 * soft transitive declaration silently downgrade a hard one, turning a blocking
 * dep into a no-op install.
 */
function uniqEvents(xs: unknown): EventDep[] {
  const byFamily = new Map<string, EventDep>();
  for (const e of Array.isArray(xs) ? xs : []) {
    if (e == null || typeof e !== 'object') continue;
    const { family, optional } = e as Record<string, unknown>;
    if (typeof family !== 'string' || family.length === 0) continue;
    const isOptional = optional === true;
    const prior = byFamily.get(family);
    if (prior && !prior.optional) continue; // an existing REQUIRED dep is never softened
    byFamily.set(family, { family, optional: isOptional });
  }
  return [...byFamily.values()];
}

function normalize(d: Partial<DepSet> | undefined): DepSet {
  const uniq = (xs: unknown): string[] =>
    Array.from(new Set((Array.isArray(xs) ? xs : []).filter((x): x is string => typeof x === 'string' && x.length > 0)));
  return { tools: uniq(d?.tools), packs: uniq(d?.packs), plugins: uniq(d?.plugins), events: uniqEvents(d?.events) };
}

function mergeDeps(a: DepSet, b: Partial<DepSet>): DepSet {
  const nb = normalize(b);
  return {
    tools: Array.from(new Set([...a.tools, ...nb.tools])),
    packs: Array.from(new Set([...a.packs, ...nb.packs])),
    plugins: Array.from(new Set([...a.plugins, ...nb.plugins])),
    events: uniqEvents([...a.events, ...nb.events]),
  };
}

interface Classification {
  /** Tools with no provider anywhere (hard-missing — the in-process catalog is authoritative). */
  unknownTools: string[];
  /** Declared pack/plugin names with no provider at all. */
  unknownPacks: string[];
  unknownPlugins: string[];
  /** REQUIRED event families no unit provides (hard-missing, like a tool). */
  unknownRequiredEvents: string[];
  /** OPTIONAL event families no unit provides — advisory only; never blocks (D-003). */
  unknownOptionalEvents: string[];
  /** Distinct Cupboard units (by name) that would satisfy a still-unmet dep. */
  installable: InstallableUnitRef[];
}

/**
 * Classify a declared dep set against a catalog view: what's unknown (no
 * provider), and which distinct Cupboard units would satisfy the rest. A
 * declared unit name that's already INSTALLED is satisfied (absent from both).
 */
function classify(working: DepSet, cat: DerivedPackCatalog): Classification {
  const view = cat.view;
  const unknownTools: string[] = [];
  const unknownPacks: string[] = [];
  const unknownPlugins: string[] = [];
  const installable = new Map<string, InstallableUnitRef>();

  for (const tool of working.tools) {
    const r = resolveToolProvider(tool, view);
    if (r.status === 'available') continue;
    if (r.status === 'installable') {
      // builtins never reach here (status 'available'); installable providers are plugin|pack.
      installable.set(r.provider.name, {
        name: r.provider.name,
        kind: r.provider.kind,
        listingId: r.provider.listingId ?? null,
      });
    } else {
      unknownTools.push(tool);
    }
  }

  // Event deps ride the SAME install loop as tools: an `installable` family
  // pulls in its providing Cupboard unit exactly as an installable tool does —
  // which is the point of making events a dependency axis rather than a
  // separate concept (D-003). The ONLY divergence is the terminal case: an
  // unresolvable REQUIRED family is a hard miss (like a tool), while an
  // unresolvable OPTIONAL one is advisory and never blocks the install.
  const unknownRequiredEvents: string[] = [];
  const unknownOptionalEvents: string[] = [];
  for (const dep of working.events) {
    const r = resolveEventProvider(dep.family, view);
    if (r.status === 'available') continue;
    if (r.status === 'installable') {
      installable.set(r.provider.name, {
        name: r.provider.name,
        kind: r.provider.kind,
        listingId: r.provider.listingId ?? null,
      });
      continue;
    }
    (dep.optional ? unknownOptionalEvents : unknownRequiredEvents).push(dep.family);
  }

  const classifyUnit = (name: string, kind: 'plugin' | 'pack', unknownSink: string[]) => {
    const d = view.byName.get(name);
    if (d && d.source === 'installed') return; // already present
    if (d && d.source === 'cupboard') {
      installable.set(d.name, { name: d.name, kind: d.kind, listingId: d.listingId ?? null });
      return;
    }
    unknownSink.push(name);
  };
  for (const name of working.packs) classifyUnit(name, 'pack', unknownPacks);
  for (const name of working.plugins) classifyUnit(name, 'plugin', unknownPlugins);

  return {
    unknownTools,
    unknownPacks,
    unknownPlugins,
    unknownRequiredEvents,
    unknownOptionalEvents,
    installable: [...installable.values()],
  };
}

/**
 * Resolve a declared dep set to its providers and auto-install everything the
 * Cupboard can provide, recursively. See the module header for the loop shape.
 *
 * Failure modes:
 *   - a tool with NO provider anywhere → `stillMissing.tools` (ok:false), no installs attempted that round for it;
 *   - a REQUIRED event family with no provider → `stillMissing.events` (ok:false) — as hard as a tool (D-003);
 *   - an OPTIONAL event family with no provider → `advisory` only (listen-if-present; never blocks);
 *   - a unit whose install fails → `stillMissing` (by kind) + an advisory note;
 *   - the Cupboard unreachable → unknown packs/plugins are SOFTENED to advisory
 *     (mirrors the shipped gate: a transient outage must not hard-fail a
 *     possibly-installable unit), but a missing tool still fails.
 */
export async function resolveAndInstallDeps(
  declared: Partial<DepSet>,
  deps: ResolveAndInstallDeps,
): Promise<ResolveAndInstallResult> {
  const maxRounds = deps.maxRounds ?? 8;
  let working = normalize(declared);
  const installed: InstalledUnitResult[] = [];
  const advisory: string[] = [];
  const failed = new Set<string>(); // unit names whose install threw/errored
  const visited = new Set<string>(); // unit names already attempted (loop guard)

  let cat = await deps.deriveCatalog();
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    const c = classify(working, cat);
    const todo = c.installable.filter((u) => !visited.has(u.name));
    if (todo.length === 0) break;

    for (const u of todo) {
      visited.add(u.name);
      let res: Awaited<ReturnType<ResolveAndInstallDeps['installUnit']>>;
      try {
        res = await deps.installUnit(u);
      } catch (e) {
        res = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (res.ok) {
        installed.push({ ...u, tools: cat.view.byName.get(u.name)?.tools.slice() ?? [] });
        if (res.declaredDeps) working = mergeDeps(working, res.declaredDeps);
      } else {
        failed.add(u.name);
        advisory.push(`install ${u.kind} "${u.name}" failed: ${res.error}`);
      }
    }
    cat = await deps.deriveCatalog(); // reflect this round's installs for the next pass
  }
  if (rounds >= maxRounds) {
    advisory.push(`install loop hit the round cap (${maxRounds}); stopping — dep graph may be cyclic or unusually deep`);
  }

  // Final classification against the post-install catalog.
  const finalC = classify(working, cat);
  const stillMissing = emptyDepSet();
  stillMissing.tools = finalC.unknownTools; // no provider — always hard

  // Event deps (D-003). A REQUIRED family that is not AVAILABLE after the loop
  // is a hard miss — the unit's reactions would never fire, so the install is
  // broken and we say so now rather than shipping something silently inert.
  //
  // "Not available" is deliberately broader than "unknown": a family whose only
  // provider was a Cupboard unit we TRIED and FAILED to install is still not
  // emitted by anything, so it belongs here too. (The tool axis reports that
  // case only as a failed UNIT, in stillMissing.packs/plugins. For events the
  // family is what the author declared and what an awaiter blocks on, so the
  // family-level answer is the one that has to be truthful — otherwise
  // stillMissing.events reads empty while a required dep is plainly unmet.)
  //
  // An OPTIONAL family is the listen-if-present contract: report it, never block.
  stillMissing.events = working.events
    .filter((d) => !d.optional && resolveEventProvider(d.family, cat.view).status !== 'available')
    .map((d) => ({ family: d.family }));
  if (finalC.unknownOptionalEvents.length > 0) {
    advisory.push(
      `optional event dep(s) unresolved (nothing provides them; the unit installs and simply won't react): ${finalC.unknownOptionalEvents.join(', ')}`,
    );
  }
  // Units still classified installable after the loop are failures (we attempted them); also fold genuinely-unknown units.
  const remainingInstallable = finalC.installable;
  for (const u of remainingInstallable) {
    (u.kind === 'pack' ? stillMissing.packs : stillMissing.plugins).push(u.name);
  }
  // Unknown declared units: hard-missing only when the Cupboard was reachable
  // (an unreachable Cupboard can't disprove a listing — soften to advisory).
  if (cat.cupboardReachable) {
    stillMissing.packs.push(...finalC.unknownPacks);
    stillMissing.plugins.push(...finalC.unknownPlugins);
  } else {
    const soft = [...finalC.unknownPacks, ...finalC.unknownPlugins];
    if (soft.length > 0) {
      advisory.push(`Cupboard unreachable — could not verify ${soft.join(', ')} (left unsatisfied, not failed)`);
    }
  }
  stillMissing.packs = Array.from(new Set(stillMissing.packs));
  stillMissing.plugins = Array.from(new Set(stillMissing.plugins));

  const ok =
    stillMissing.tools.length === 0 &&
    stillMissing.packs.length === 0 &&
    stillMissing.plugins.length === 0 &&
    stillMissing.events.length === 0 &&
    failed.size === 0;

  return { ok, installed, stillMissing, advisory, rounds };
}
