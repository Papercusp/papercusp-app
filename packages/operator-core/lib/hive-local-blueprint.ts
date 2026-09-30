/**
 * hive-local-blueprint — materialize a Hive's per-hive override into a LOCAL-TIER
 * blueprint tree on disk, so the tier-aware prompt resolver (prompt-resolve P-014)
 * picks the hive's customized role prompts over the built-in blueprint's.
 * (domain-generic-hive-architecture-2026-06-18 P-012 / D-005 / D-006 / D-007 / D-012.)
 *
 * WHERE THE OVERRIDE LIVES: `harness_shared.pot_settings` under `promptOverride.<role>`
 * (the existing federated key — hive-settings-store.ts), so it already syncs over the
 * Hive's peer-log to every node of a shared Hive (D-007 / I1) with NO new transport.
 * This module is the read-side: it turns those settings into files at launch.
 *
 * MODEL (D-012 — a SAME-ID local override, composed at materialize time):
 *   For a Hive whose blueprint is `<bp>`, each `promptOverride.<role>` is written as a
 *   COMPOSED full persona file at `<root>/blueprints/<bp>/prompts/<role>.md`, where
 *   `<root>` is a DEDICATED materialization dir (`<hiveDir>/.papercusp/.materialized`).
 *   Composition = the resolved BUILT-IN persona for `<role>` + the hive's override delta
 *   (so an override authored as an append-delta is written as a COMPLETE file → the
 *   resolver's first-match/replace picks it without needing append-at-resolve).
 *
 *   The spawn keeps `blueprintId=<bp>` and just adds this root to `blueprintRoots`
 *   (P-014). NO blueprint-LOADER change and NO blueprintId switch: the loader
 *   (spine/decider/structured config) stays built-in-only because the per-hive delta
 *   overrides PROMPTS only. Structured config (e.g. the `scout` block, P-009) flows on
 *   its own payload channel; feeding it per-hive from the local blueprint is a follow-on.
 *
 * The materialization root is DEDICATED + cleaned wholesale each launch, so it never
 * collides with (or clobbers) a hand-authored `<hiveDir>/.papercusp/blueprints` tree,
 * and a removed override leaves no stale file behind.
 *
 * Side-effecting (writes files) but DI-pure: the settings reader + the built-in persona
 * resolver are injected, so the unit tests run with a temp dir + fakes (no PG/LLM) — the
 * gym:judge pattern used across lib/.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The dedicated materialization root under a hive dir (passed to blueprintRoots). */
export function hiveLocalBlueprintRoot(hiveDir: string): string {
  return join(hiveDir, '.papercusp', '.materialized');
}

export interface MaterializeHiveLocalDeps {
  /**
   * role → override markdown for the hive (default wiring: the federated
   * `promptOverride.*` settings via listHiveInstancePromptOverrides). An empty map
   * means "no per-hive override" → nothing is materialized.
   */
  readOverrides: () => Promise<Record<string, string>>;
  /**
   * Resolve the BUILT-IN persona markdown for `<role>` (the resolved file content from
   * the built-in tier only — NOT the local tier, to avoid self-reference). Returns null
   * when the role has no built-in persona; then the override stands alone.
   */
  readBuiltinPersona: (role: string) => string | null;
}

export interface MaterializeHiveLocalInput {
  /** The Hive's built-in blueprint id (e.g. 'hive' today, 'coding' post-rename). */
  hiveBlueprintId: string;
  /** The Hive's root dir (the one containing `.papercusp/`). */
  hiveDir: string;
}

export interface MaterializeHiveLocalResult {
  /** The local-tier root to prepend to `PromptResolveContext.blueprintRoots`. */
  localRoot: string;
  /** Roles whose composed persona was written (sorted). */
  materializedRoles: string[];
}

/** Join an override delta below the built-in persona, mirroring the prompts README's
 *  "later sections override earlier ones" (the resolvePromptFiles join). */
function compose(builtin: string | null, override: string): string {
  const o = override.trim();
  const b = builtin?.trim();
  return b ? `${b}\n\n---\n\n${o}\n` : `${o}\n`;
}

/**
 * Materialize the Hive's per-hive prompt overrides into the dedicated local-tier root.
 * Returns the root + the roles written, or `null` when there is no override (the caller
 * then leaves `blueprintRoots` empty — byte-identical to a Hive with no customization).
 *
 * Idempotent: the materialization root is removed + rewritten each call, so it always
 * reflects exactly the current federated override set (a removed `promptOverride.<role>`
 * leaves no stale file).
 */
export async function materializeHiveLocalBlueprint(
  input: MaterializeHiveLocalInput,
  deps: MaterializeHiveLocalDeps,
): Promise<MaterializeHiveLocalResult | null> {
  const overrides = await deps.readOverrides();
  const roles = Object.keys(overrides)
    .filter((r) => typeof overrides[r] === 'string' && overrides[r].trim().length > 0)
    .sort();

  const localRoot = hiveLocalBlueprintRoot(input.hiveDir);

  // Always clean the dedicated root first so a removed override never lingers.
  if (existsSync(localRoot)) rmSync(localRoot, { recursive: true, force: true });
  if (roles.length === 0) return null;

  const promptsDir = join(localRoot, 'blueprints', input.hiveBlueprintId, 'prompts');
  mkdirSync(promptsDir, { recursive: true });

  for (const role of roles) {
    const composed = compose(deps.readBuiltinPersona(role), overrides[role]);
    writeFileSync(join(promptsDir, `${role}.md`), composed);
  }

  return { localRoot, materializedRoles: roles };
}

/** Read a file's content or null (a small helper for wiring `readBuiltinPersona`). */
export function readFileOrNull(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}
