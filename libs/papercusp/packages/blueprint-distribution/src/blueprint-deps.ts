/**
 * E2a — import-time blueprint **dependency validation**.
 *
 * `harness-blueprint-distribution-2026-06-03` P-003 / P-004 / D-003 / D-004;
 * extended to the pack model by `tool-distribution-granularity-2026-06-05`
 * (D-002/D-006: `dependencies.{tools,packs,plugins}` + provider-aware tools).
 *
 * A blueprint declares the tools + packs + plugins its roles need
 * (`dependencies.{tools,packs,plugins}` — the engine's schema field). Today an
 * unsatisfied tool is only discovered at CALL time, deep in a run, as a
 * `404 unknown_tool` (`apps/operator/lib/capabilities/invoke.ts:69`). This
 * validator resolves the declared deps UPFRONT — at `init --from` /
 * `harness:create` / blueprint-load — against the host's known tools + installed
 * units + Cupboard listings, and fails with an actionable "needs plugin X"
 * before any run starts.
 *
 * **Pure + borrowable.** The host capability sets are INJECTED — the validator
 * touches no catalog, no PG, no filesystem. The operator wires the live tool
 * registry + the installed-unit registries + Cupboard listings into the sets;
 * the CLI wires its own equivalents. Keeps the predicate trivial to cover.
 *
 * Resolution rules (per D-003 "resolve against the catalog + Cupboard" and
 * tool-distribution D-002 "deps are declared on tools, resolved to packs"):
 *   - a declared **tool** is satisfied iff its name is in `availableTools`;
 *     a tool NOT available but provided by a known installable Cupboard unit
 *     (`installableToolProviders`) is **installable** (advisory, non-blocking
 *     — the installer fetches the providing unit). A tool with no known
 *     provider is a hard failure.
 *   - a declared **pack** resolves against ALL distribution units (a plugin IS
 *     a runtime-bearing pack — D-001): installed packs/plugins satisfy it;
 *     Cupboard packs/plugins make it installable; neither is a hard failure.
 *   - a declared **plugin** is satisfied iff it is `installedPlugins` (already
 *     present) OR `cupboardPlugins` (installable from the Cupboard — `init`'s
 *     plugin auto-install step, P-004, will fetch it). A plugin in NEITHER is a
 *     hard failure.
 *
 * Version qualifiers (`name@range`) on a dep are parsed off for the presence
 * check and carried (in `installable`) for the installer; full version
 * reconciliation (semver/exact/hash) reuses the snapshot manifest machinery
 * (`@papercusp/export-state` `SnapshotVersionPin` / `reconcileMigrations`,
 * D-004) and is layered on by the install step, not duplicated here.
 */

import {
  validateSpecificationBundles,
  type ResolvedAgentInput,
  type ResolvedPackageInput,
} from '@papercusp/orchestrator/blueprint';

/** The dependency block a blueprint declares (mirrors the engine's `DependenciesSchema`). */
export interface BlueprintDependencyInput {
  tools?: string[];
  packs?: string[];
  plugins?: string[];
  /** Work-blueprints this blueprint's roles SPAWN as sub-harnesses (a hive declares
   *  the work-blueprints its bees spin up). Resolved like plugins: built-in/installed →
   *  satisfied, Cupboard-listed → installable, neither → hard failure. */
  blueprints?: string[];
  /** First-class datatypes (shared entity TYPES — `bet`, `wager`, … — minted by
   *  `meta:define-datatype`) this blueprint's roles read/write. Resolved like
   *  blueprints: workspace-registered/built-in → satisfied, Cupboard-listed →
   *  installable, neither → hard "needs datatype X".
   *  (`reflexive-platform-extensibility-datatypes-2026-06-24` P-012, D-009.) */
  datatypes?: string[];
}

/** The host capability sets the validator resolves declared deps against. */
export interface DependencyHostSets {
  /** Tool names currently resolvable (built-ins + tools registered by installed units). */
  availableTools: Set<string>;
  /** Plugins installed/enabled in this host. */
  installedPlugins: Set<string>;
  /** Plugins listed in the Cupboard (installable but not necessarily installed). */
  cupboardPlugins?: Set<string>;
  /** Code-tool packs (runtime-less units, manifest kind='pack') installed in this host. */
  installedPacks?: Set<string>;
  /** Packs listed in the Cupboard (installable but not necessarily installed). */
  cupboardPacks?: Set<string>;
  /**
   * tool name → the installable Cupboard unit that declares it in
   * `provides_tools`. Powers provider-aware tool resolution (D-002): a tool
   * absent from `availableTools` but present here is installable-advisory
   * instead of a hard failure. Derive via `pack-model.ts` /
   * `buildPackCatalogView().cupboardToolIndex`.
   */
  installableToolProviders?: Map<string, { kind: 'plugin' | 'pack'; name: string }>;
  /** Blueprint ids resolvable now — built-ins + installed under ~/.papercusp/blueprints. */
  availableBlueprints?: Set<string>;
  /** Blueprints listed in the Cupboard (installable but not necessarily installed). */
  cupboardBlueprints?: Set<string>;
  /** Datatype ids resolvable now — built-ins + workspace-registered (the datatype
   *  registry, P-013). Optional: a host that has no registry wired passes none,
   *  and a blueprint that declares no `datatypes` is unaffected. */
  availableDatatypes?: Set<string>;
  /** Datatypes published to the Cupboard (installable but not necessarily registered locally). */
  cupboardDatatypes?: Set<string>;
}

export interface BlueprintDependencyValidation {
  /** Exact complete-content pins from the existing compiled input closure, when supplied. */
  pins?: ResolvedPackageInput[];
  /** True iff no declared tool/pack/plugin is unresolvable (installable deps do NOT block). */
  ok: boolean;
  /** Unresolvable declared deps — the dep strings as written (with any `@range`). */
  missing: { tools: string[]; packs: string[]; plugins: string[]; blueprints: string[]; datatypes: string[] };
  /**
   * Declared deps not present but resolvable from the Cupboard. Advisory:
   * `init --from`'s auto-install step should fetch these. Does not affect
   * `ok`. `tools` lists tools whose *providing unit* is installable.
   */
  installable: { tools: string[]; packs: string[]; plugins: string[]; blueprints: string[]; datatypes: string[] };
  /** One human-readable line per unresolvable dep — surfaced to the user. */
  messages: string[];
}

/**
 * Split a dependency spec `"name@range"` → `{ name, range }`. Tolerates scoped
 * names (`@scope/pkg`, `@scope/pkg@1.2.0`): a leading `@` is part of the name,
 * only a LATER `@` introduces a version. No version → `range: null`.
 */
export function parseDepSpec(spec: string): { name: string; range: string | null } {
  const at = spec.lastIndexOf('@');
  if (at > 0) return { name: spec.slice(0, at), range: spec.slice(at + 1) };
  return { name: spec, range: null };
}

/**
 * Resolve a blueprint's declared `dependencies` against the host sets, returning
 * the missing/installable breakdown + actionable messages. Pure.
 */
export function validateBlueprintDependencies(
  deps: BlueprintDependencyInput | undefined | null,
  host: DependencyHostSets,
  closure?: {
    bundles: readonly { kind: string; ref: string; version?: string }[];
    inputs: readonly ResolvedAgentInput[];
  },
): BlueprintDependencyValidation {
  const missingTools: string[] = [];
  const missingPacks: string[] = [];
  const missingPlugins: string[] = [];
  const installableTools: string[] = [];
  const installablePacks: string[] = [];
  const installablePlugins: string[] = [];
  const missingBlueprints: string[] = [];
  const installableBlueprints: string[] = [];
  const missingDatatypes: string[] = [];
  const installableDatatypes: string[] = [];
  const messages: string[] = [];
  let pins: ResolvedPackageInput[] | undefined;
  let pinsValid = true;
  if (closure) {
    try { pins = validateSpecificationBundles(closure.bundles, closure.inputs); }
    catch (error) {
      pinsValid = false;
      messages.push(error instanceof Error ? error.message : String(error));
    }
  }

  const cupboardPlugins = host.cupboardPlugins ?? new Set<string>();
  const installedPacks = host.installedPacks ?? new Set<string>();
  const cupboardPacks = host.cupboardPacks ?? new Set<string>();
  const toolProviders = host.installableToolProviders ?? new Map<string, { kind: 'plugin' | 'pack'; name: string }>();
  const availableBlueprints = host.availableBlueprints ?? new Set<string>();
  const cupboardBlueprints = host.cupboardBlueprints ?? new Set<string>();
  const availableDatatypes = host.availableDatatypes ?? new Set<string>();
  const cupboardDatatypes = host.cupboardDatatypes ?? new Set<string>();

  for (const raw of deps?.tools ?? []) {
    const { name } = parseDepSpec(raw);
    if (host.availableTools.has(name)) continue; // resolvable now → satisfied
    const provider = toolProviders.get(name);
    if (provider) {
      installableTools.push(raw); // its providing unit is one install away
      continue;
    }
    missingTools.push(raw);
    messages.push(
      `needs tool "${name}" — not in the tool catalog and no Cupboard pack/plugin provides it`,
    );
  }

  // A plugin IS a runtime-bearing pack (D-001), so a `packs` dep resolves
  // against every distribution unit, not only kind='pack' manifests.
  for (const raw of deps?.packs ?? []) {
    const { name } = parseDepSpec(raw);
    if (installedPacks.has(name) || host.installedPlugins.has(name)) continue;
    if (cupboardPacks.has(name) || cupboardPlugins.has(name)) {
      installablePacks.push(raw);
      continue;
    }
    missingPacks.push(raw);
    messages.push(`needs pack "${name}" — not installed and not available in the Cupboard`);
  }

  for (const raw of deps?.plugins ?? []) {
    const { name } = parseDepSpec(raw);
    if (host.installedPlugins.has(name)) continue; // already installed → satisfied
    if (cupboardPlugins.has(name)) {
      installablePlugins.push(raw); // resolvable from the Cupboard → init installs it
      continue;
    }
    missingPlugins.push(raw);
    messages.push(`needs plugin "${name}" — not installed and not available in the Cupboard`);
  }

  // A `blueprints` dep is a work-blueprint this blueprint's roles spawn (e.g. a hive
  // spinning up `coding`). Resolved like plugins: a built-in/installed blueprint
  // satisfies it; a Cupboard-listed one is installable (the install path pulls the
  // closure); neither is a hard failure. (blueprint-role-bundling P-007.)
  for (const raw of deps?.blueprints ?? []) {
    const { name } = parseDepSpec(raw);
    if (availableBlueprints.has(name)) continue; // built-in or installed → satisfied
    if (cupboardBlueprints.has(name)) {
      installableBlueprints.push(raw); // resolvable from the Cupboard → install pulls it
      continue;
    }
    missingBlueprints.push(raw);
    messages.push(
      `needs blueprint "${name}" — not a built-in/installed blueprint and not available in the Cupboard`,
    );
  }

  // A `datatypes` dep is a shared entity TYPE this blueprint's roles read/write
  // (`bet`, `wager`, … — minted by meta:define-datatype). Resolved like
  // blueprints: a built-in/workspace-registered datatype satisfies it; a
  // Cupboard-published one is installable (the install path pulls it); neither is
  // a hard failure ("needs datatype X"). Backward-compatible: with no datatype
  // registry wired the available sets are empty, and a blueprint that declares no
  // `datatypes` skips this loop entirely. (reflexive-platform-extensibility P-012, D-009.)
  for (const raw of deps?.datatypes ?? []) {
    const { name } = parseDepSpec(raw);
    if (availableDatatypes.has(name)) continue; // built-in or workspace-registered → satisfied
    if (cupboardDatatypes.has(name)) {
      installableDatatypes.push(raw); // published to the Cupboard → install pulls it
      continue;
    }
    missingDatatypes.push(raw);
    messages.push(
      `needs datatype "${name}" — not a built-in/registered datatype and not published to the Cupboard`,
    );
  }

  return {
    ok: pinsValid &&
      missingTools.length === 0 &&
      missingPacks.length === 0 &&
      missingPlugins.length === 0 &&
      missingBlueprints.length === 0 &&
      missingDatatypes.length === 0,
    missing: {
      tools: missingTools,
      packs: missingPacks,
      plugins: missingPlugins,
      blueprints: missingBlueprints,
      datatypes: missingDatatypes,
    },
    installable: {
      tools: installableTools,
      packs: installablePacks,
      plugins: installablePlugins,
      blueprints: installableBlueprints,
      datatypes: installableDatatypes,
    },
    messages,
    ...(closure ? { pins: pins ?? [] } : {}),
  };
}
