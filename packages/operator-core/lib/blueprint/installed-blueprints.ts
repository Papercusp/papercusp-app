/**
 * The operator's blueprint distribution tiers
 * (official-blueprints-cupboard-publish-2026-06-05 P-004/P-006, D-005).
 *
 * One place that names where Cupboard-installed blueprints live
 * (`~/.papercusp/blueprints/<id>/blueprint.yaml` — the same root the CLI's
 * `init --from` already resolves) and builds the composed
 * local → installed → built-in `extends` resolver for the operator's
 * authoring + create surfaces. Before this, the operator tools resolved
 * built-ins ONLY (`blueprint:extend` refused non-built-in parents) while the
 * distribution layer already supported all three tiers — the tool gating was
 * the artificial restriction, retired per D-005.
 */
import { dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import {
  blueprintRetirement,
  builtinBlueprintPath,
  loadBlueprintFromFile,
  type ResolveExtendsPath,
} from '@papercusp/orchestrator/blueprint';
import { makeComposedResolveExtends } from '@papercusp/blueprint-distribution';
import { papercuspRoot } from '../papercusp-root';

/** Cupboard-installed blueprints root — `~/.papercusp/blueprints`. */
export function INSTALLED_BLUEPRINTS_DIR(): string {
  return join(papercuspRoot(), 'blueprints');
}

/**
 * The operator's composed `extends` resolver: optional project-local dirs
 * (e.g. a target repo's `.papercusp/blueprints`) → installed
 * (`~/.papercusp/blueprints`) → built-in. Drop-in for the loader's `resolve`
 * arg and for "does blueprint id X exist?" probes.
 */
export function operatorResolveExtends(opts: { localDirs?: string[] } = {}): ResolveExtendsPath {
  return makeComposedResolveExtends({
    localDirs: opts.localDirs ?? [],
    installedDir: INSTALLED_BLUEPRINTS_DIR(),
  });
}

/** Ids under a `<root>/<id>/blueprint.yaml` layout (the tier convention). */
function listBlueprintIdsIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'blueprint.yaml')))
    .map((e) => e.name);
}

/**
 * The set of blueprint ids resolvable NOW without a Cupboard fetch — every
 * built-in plus every Cupboard-installed blueprint. Feeds the dep-validator's
 * `availableBlueprints` host set so a `dependencies.blueprints` entry (a hive
 * declaring it spawns `coding`/`research`) resolves as satisfied
 * (blueprint-role-bundling P-007). The built-in root is derived from
 * `builtinBlueprintPath` so enumeration never drifts from resolution.
 */
export function availableBlueprintIds(): Set<string> {
  return new Set(availableBlueprintSources().map((entry) => entry.id));
}

export interface BlueprintSourceLocation {
  id: string;
  tier: 'builtin' | 'installed' | 'local';
  file: string;
}

/** The existing file catalog, with the same local → installed → built-in precedence as resolution. */
export function availableBlueprintSources(opts: { localDirs?: string[] } = {}): BlueprintSourceLocation[] {
  const roots: Array<{ root: string; tier: BlueprintSourceLocation['tier'] }> = [
    { root: dirname(dirname(builtinBlueprintPath('probe'))), tier: 'builtin' },
    { root: INSTALLED_BLUEPRINTS_DIR(), tier: 'installed' },
    ...(opts.localDirs ?? []).slice().reverse().map((root) => ({ root, tier: 'local' as const })),
  ];
  const selected = new Map<string, BlueprintSourceLocation>();
  for (const { root, tier } of roots) {
    for (const id of listBlueprintIdsIn(root)) selected.set(id, { id, tier, file: join(root, id, 'blueprint.yaml') });
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The available blueprint ids whose declared `kind` is 'hive' — the installable hive
 * templates a `pot:create` picker offers + the set `pot:create` validates its
 * `blueprintId` against (hive-blueprint-generalization P-019). Reads each
 * resolved blueprint is `kind: hive|pot` and remains launchable. Resolution matters:
 * retirement is inherited, so a raw leaf scan would advertise descendants of a retired
 * parent (for example `work`, which inherits retirement from `coding`).
 */
export function availableHiveBlueprintIds(): string[] {
  const resolve = operatorResolveExtends();
  const out: string[] = [];
  for (const { id, file } of availableBlueprintSources()) {
    try {
      const { blueprint } = loadBlueprintFromFile(file, resolve);
      if (blueprint.kind === 'pot' && !blueprintRetirement(blueprint)) out.push(id);
    } catch {
      /* skip an unreadable, unparseable, or unresolvable blueprint */
    }
  }
  return out.sort();
}
