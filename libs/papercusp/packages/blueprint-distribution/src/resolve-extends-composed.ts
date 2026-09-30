/**
 * E1a — the composed `extends` resolver: **local → installed → built-in**.
 *
 * `harness-blueprint-distribution-2026-06-03` P-001 / D-001 / D-002.
 *
 * The frozen loader (`@papercusp/orchestrator/blueprint`) resolves `extends`
 * parents through a `ResolveExtendsPath` seam whose default
 * (`resolveBuiltinExtends`) only finds the BUILT-IN blueprints shipped under
 * `@papercusp/harness/blueprints/<id>/`. The distribution layer widens that to
 * the three distribution tiers (D-001):
 *
 *   1. **local**     — a project's own `<project>/.papercusp/blueprints/<id>/blueprint.yaml`
 *   2. **installed** — a Cupboard-installed `~/.papercusp/blueprints/<id>/blueprint.yaml`
 *   3. **built-in**  — `resolveBuiltinExtends` (the engine default)
 *
 * First hit wins (local shadows installed shadows built-in), so a project can
 * override a shared/built-in parent without forking it. This is the only thing
 * the loader needs from the distribution layer — pass the composed resolver as
 * `resolveBlueprint(raw, { resolve })` / `loadBlueprintFromFile(path, resolve)`
 * and the engine's existing depth-first merge handles the rest unchanged.
 *
 * **Pure + borrowable.** The host-specific roots are INJECTED (`localDirs`,
 * `installedDir`) — the module names no `~/.papercusp` path itself (the CLI /
 * operator supply them), and the filesystem probe (`exists`) is injectable so
 * the composition is unit-testable without touching disk. We touch only the
 * engine's PUBLIC seam (`resolveBuiltinExtends` + the `ResolveExtendsPath` type);
 * the engine barrel stays frozen.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBuiltinExtends, type ResolveExtendsPath } from '@papercusp/orchestrator/blueprint';

export interface ComposedResolveOptions {
  /**
   * Project-local blueprint roots, **highest precedence first**. Each is a
   * directory holding `<id>/blueprint.yaml` (typically a single
   * `<project>/.papercusp/blueprints`). Empty/omitted → no local tier.
   */
  localDirs?: string[];
  /**
   * The installed/global blueprint root (typically `~/.papercusp/blueprints`),
   * holding `<id>/blueprint.yaml`. `null`/omitted → no installed tier.
   */
  installedDir?: string | null;
  /**
   * The built-in tier resolver. Defaults to the engine's `resolveBuiltinExtends`;
   * injectable so tests can stub the built-in floor without a real harness dir.
   */
  builtin?: ResolveExtendsPath;
  /**
   * Existence predicate (defaults to `fs.existsSync`). Injectable so the
   * composition is unit-testable purely (no disk), and so a host can supply a
   * virtualized lookup.
   */
  exists?: (path: string) => boolean;
}

/**
 * The on-disk path of a blueprint `id` under a `<root>/<id>/blueprint.yaml`
 * layout — the convention every distribution tier uses.
 */
export function blueprintFileIn(root: string, id: string): string {
  return join(root, id, 'blueprint.yaml');
}

/**
 * Build a `ResolveExtendsPath` that tries each local root (in order), then the
 * installed root, then the built-in resolver — returning the first existing
 * file, or `null` when no tier has the id. Drop-in for the loader's `resolve`
 * arg; the default-only `resolveBuiltinExtends` is the `localDirs:[],
 * installedDir:null` degenerate case.
 */
export function makeComposedResolveExtends(opts: ComposedResolveOptions = {}): ResolveExtendsPath {
  const localDirs = opts.localDirs ?? [];
  const installedDir = opts.installedDir ?? null;
  const builtin = opts.builtin ?? resolveBuiltinExtends;
  const exists = opts.exists ?? existsSync;

  return (id: string): string | null => {
    for (const dir of localDirs) {
      const candidate = blueprintFileIn(dir, id);
      if (exists(candidate)) return candidate;
    }
    if (installedDir) {
      const candidate = blueprintFileIn(installedDir, id);
      if (exists(candidate)) return candidate;
    }
    return builtin(id);
  };
}
