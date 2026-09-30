/**
 * hive-local-blueprint-resolve — the PRODUCER side of the per-hive override
 * (domain-generic-hive-architecture-2026-06-18 P-012 / P-013 / D-013).
 *
 * Wraps the pure materializer (hive-local-blueprint.ts) with the live wiring a spawner
 * has: resolve the harness's home Hive, read its FEDERATED `promptOverride.*` settings
 * (hive-settings-store — synced over the peer-log, D-007), resolve each role's BUILT-IN
 * persona, materialize the composed files into the hive's dedicated local tier, and
 * return the root to hand to invoke.ts as a `BLUEPRINT_LOCAL_ROOT=<path>` spawn extra.
 *
 * THE GAP THIS CLOSES (D-013): autonomous fleet spawns (bees/queen/scout via invoke.ts)
 * apply NO per-hive override today — only interactive/psu launches do (the append in
 * role-launch-spec). This is the producer that makes a hive's customized role prompts
 * reach its AUTONOMOUS agents — required for dogfood (P-026/P-027). The interactive
 * append path is unchanged (D-013: keep it).
 *
 * STRICTLY BEST-EFFORT: every failure (no hive, PG miss, fs error) returns null, so a
 * caller appends no extra and invoke.ts resolves built-in-only — byte-identical to
 * before. NEVER throws — it sits on the hot spawn path (operator-spawn.ts).
 */
import { harnessRoot } from '@papercusp/harness/paths';
import { resolvePromptFile } from '@papercusp/orchestrator/role-prompt';
import {
  materializeHiveLocalBlueprint,
  readFileOrNull,
} from './hive-local-blueprint';

export interface ResolveHiveLocalRootInput {
  workspaceId: string;
  /** The spawning harness's slug. */
  harnessSlug: string;
  /**
   * The spawning harness's project dir (the one containing `.papercusp/`). The local
   * tier is materialized under here, so the files exist on whatever machine runs the
   * spawn (a shared Hive may spawn on a member node — D-007/I1).
   */
  harnessDir: string;
  /**
   * The blueprint id the spawn resolves prompts under (the one it sets as the
   * `BLUEPRINT_ID=` extra — e.g. 'hive' for a bee). The materialized override files
   * land under `blueprints/<this>/prompts/<role>.md` so the tier-aware resolver matches
   * them to the SAME id. The caller passes the exact id it uses (never re-derived here —
   * a mismatch would silently drop the override).
   */
  hiveBlueprintId: string;
}

/**
 * Resolve + materialize the per-hive local-tier blueprint for a spawn, returning the
 * root path (to pass as `BLUEPRINT_LOCAL_ROOT=<root>`), or null when the harness is not
 * in a Hive, the Hive has no overrides, or anything fails (best-effort).
 */
export async function resolveHiveLocalBlueprintRoot(
  input: ResolveHiveLocalRootInput,
): Promise<string | null> {
  try {
    const { potHomeSlugForHarness } = await import('./hive-federation');
    const potSlug = await potHomeSlugForHarness(input.workspaceId, input.harnessSlug);
    if (!potSlug) return null; // not part of a Hive → no per-hive override

    const { listHiveInstancePromptOverrides } = await import('./hive-settings-store');
    const overrides = await listHiveInstancePromptOverrides(input.workspaceId, potSlug);
    if (Object.keys(overrides).length === 0) return null;

    const hiveBlueprintId = input.hiveBlueprintId || 'base';
    const builtinHarnessDir = harnessRoot();

    const result = await materializeHiveLocalBlueprint(
      { hiveBlueprintId, hiveDir: input.harnessDir },
      {
        readOverrides: async () => overrides,
        // The built-in MAIN persona file (most-specific; the resolver re-adds any
        // `<role>.base.md` generic prefix separately, so we must NOT include it here —
        // else the prefix would double). Compose = built-in main + hive delta.
        readBuiltinPersona: (role) => {
          const file = resolvePromptFile(
            { harnessDir: builtinHarnessDir, phase: '', dept: '', blueprintId: hiveBlueprintId },
            role,
          );
          return file ? readFileOrNull(file) : null;
        },
      },
    );
    return result?.localRoot ?? null;
  } catch {
    return null; // best-effort: never break a spawn
  }
}

/** The `BLUEPRINT_LOCAL_ROOT=<path>` spawn extra for a resolved local root (or null). */
export function blueprintLocalRootExtra(localRoot: string | null): string | null {
  return localRoot ? `BLUEPRINT_LOCAL_ROOT=${localRoot}` : null;
}
