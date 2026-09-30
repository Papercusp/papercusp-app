/**
 * The EFFECTIVE harness config — blueprint knobs (shape defaults) overlaid UNDER
 * the per-install INSTANCE config (instance overrides win). The instance layer is
 * delivered SOLELY via the `HARNESS_CONFIG_JSON` env-transport (the operator
 * assembles it from the workspace-PG store); `.papercusp/config.json` is NOT read
 * (`deprecate-harness-config-json-2026-06-06` — the file is deprecated to zero).
 *
 * The overlay carries ONLY the residual-knob keys (`promptOverrides`, `aiBackend`,
 * `parallelWorkers`, `scoper`, `snapshotRetention`); a blueprint that declares none
 * of them produces an EMPTY overlay (so the effective config equals the bare
 * instance layer). The already-migrated knobs (maxCostUsd, debuggerThreshold,
 * dispatch.concurrency) keep their own ad-hoc resolution (resolveDispatchPolicy /
 * the debuggerThreshold fallback) and are deliberately NOT in this overlay, so this
 * can't double-apply or disturb them.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from './types';
import { loadBlueprintFromFile, type Blueprint } from './blueprint';

/**
 * The residual config fields this overlay migrates (cloud-deployment P-006). NOT
 * the already-migrated knobs (maxCostUsd/logRetention/branchIsolation/worktrees/
 * reviewer/product/models/debuggerThreshold) — those resolve elsewhere and must
 * not be double-applied here.
 */
const RESIDUAL_KNOB_KEYS = [
  'promptOverrides',
  'aiBackend',
  'parallelWorkers',
  'scoper',
  'snapshotRetention',
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `override` onto `base`: nested plain objects merge recursively;
 * arrays + scalars + null in `override` REPLACE the base value; `undefined` in
 * `override` is ignored (never clobbers a base default). `override` wins.
 */
export function deepMergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, ov] of Object.entries(override)) {
    if (ov === undefined) continue;
    const bv = out[k];
    out[k] = isPlainObject(bv) && isPlainObject(ov) ? deepMergeConfig(bv, ov) : ov;
  }
  return out;
}

/** Project a blueprint's knobs into a config-shaped overlay (residual keys only). */
export function blueprintKnobsToConfigOverlay(
  knobs: Blueprint['knobs'] | null | undefined,
): Partial<HarnessConfig> {
  if (!knobs) return {};
  const overlay: Record<string, unknown> = {};
  for (const k of RESIDUAL_KNOB_KEYS) {
    const v = (knobs as Record<string, unknown>)[k];
    if (v !== undefined) overlay[k] = v;
  }
  return overlay as Partial<HarnessConfig>;
}

/**
 * Load the effective blueprint's knobs from `<stateDir>/blueprint.yaml`
 * (best-effort; `null` when there's no blueprint file or it fails to load/parse —
 * a non-blueprint harness then behaves exactly as before the migration). Mirrors
 * operator-core's `harnessBlueprintKnobs`.
 */
export function loadHarnessKnobs(stateDir: string): Blueprint['knobs'] | null {
  try {
    const f = join(stateDir, 'blueprint.yaml');
    if (!existsSync(f)) return null;
    return loadBlueprintFromFile(f).blueprint.knobs;
  } catch {
    return null; // fail-safe: a bad blueprint never strands a run on config alone
  }
}

/**
 * The effective blueprint's `acceptance.kind` from `<stateDir>/blueprint.yaml`
 * (hive-blueprint-generalization P-008) — `undefined` for a non-blueprint / coding
 * harness (which declares no `acceptance`), so the spawned-agent preamble keeps its
 * tests-based `TESTING_STANDARD` there. A generic hive (`acceptance.kind: judge` etc.)
 * makes `buildPrompt` emit the domain-agnostic `VERIFICATION_STANDARD` instead, so a
 * deliverable-producing bee is NOT told to write tests. Mirrors operator-core's
 * finalize-gate `harnessAcceptanceKind` so the spawn preamble + the DONE gate read the
 * SAME source (the two-base sync the de-code rests on). Fail-safe: a bad/absent
 * blueprint ⇒ undefined ⇒ unchanged coding behavior.
 */
export function loadHarnessAcceptanceKind(
  stateDir: string,
): 'tests' | 'judge' | 'human-gate' | 'none' | undefined {
  try {
    const f = join(stateDir, 'blueprint.yaml');
    if (!existsSync(f)) return undefined;
    return loadBlueprintFromFile(f).blueprint.acceptance?.kind;
  } catch {
    return undefined;
  }
}

/**
 * The effective blueprint's `id` from `<stateDir>/blueprint.yaml`
 * (domain-generic-agent-personas-2026-06-17 P-013) — the coding-vs-generic signal for a
 * NORMAL pipeline spawn, which (unlike a program-blueprint spawn) carries no `BLUEPRINT_ID`
 * extra. `undefined` for a non-blueprint harness or an unreadable file. The replace-base path
 * resolves the coding overlay (`agent-base-overlay.md`) by walking this blueprint's
 * extends-chain, so a `coding` harness keeps its SWE framing once the Claude default is
 * replaced. Fail-safe: a bad/absent blueprint ⇒ undefined ⇒ neutral preamble only.
 */
export function loadHarnessBlueprintId(stateDir: string): string | undefined {
  return loadHarnessBlueprintPromptContext(stateDir)?.blueprintId;
}

/**
 * The harness-local blueprint identity plus its RESOLVED inheritance chain for
 * prompt lookup.  The harness document lives at `<stateDir>/blueprint.yaml`, not
 * under a prompt root's `blueprints/<id>/` directory, so resolving from the id
 * alone silently loses every parent declared by that document.  Reuse the
 * loader's already-resolved raw layers instead: it is the authority that found
 * local → installed → built-in parents and validated the composition.
 *
 * `layers` are returned base-first by the loader; prompt resolution consumes a
 * leaf-first, base-terminated chain.  Invalid/absent files remain fail-safe and
 * preserve the pre-blueprint neutral/base-only behavior.
 */
export function loadHarnessBlueprintPromptContext(
  stateDir: string,
): { blueprintId: string; extendsChain: string[] } | undefined {
  try {
    const f = join(stateDir, 'blueprint.yaml');
    if (!existsSync(f)) return undefined;
    const loaded = loadBlueprintFromFile(f);
    const blueprintId = loaded.blueprint.id || undefined;
    if (!blueprintId) return undefined;
    const extendsChain = Array.from(
      new Set(loaded.layers.map((layer) => layer.id).reverse()),
    );
    if (extendsChain[0] !== blueprintId) extendsChain.unshift(blueprintId);
    return { blueprintId, extendsChain };
  } catch {
    return undefined;
  }
}

/**
 * The effective blueprint's `lexicon` — the hive's noun overrides
 * (hive-blueprint-generalization P-016), e.g. `{ workUnit: 'deliverable', reviewGate:
 * 'review' }`. `undefined`/empty for a hive that declares none (the coding hive), so
 * `buildPrompt` emits no vocabulary block and the agent keeps the built-in nouns. A
 * generic hive's lexicon is injected as a small "Hive vocabulary" reminder so a bee
 * reading the SHARED base personas (which say "feature"/"PR") maps them to the hive's
 * own nouns. (Persona side only — the UI-resolver side of P-016 is hive-scoping the
 * global lexicon pack, a separate refactor.)
 */
export function loadHarnessLexicon(stateDir: string): Record<string, string> | undefined {
  try {
    const f = join(stateDir, 'blueprint.yaml');
    if (!existsSync(f)) return undefined;
    const lex = loadBlueprintFromFile(f).blueprint.lexicon;
    return lex && Object.keys(lex).length > 0 ? lex : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The per-install INSTANCE config, delivered SOLELY via the `HARNESS_CONFIG_JSON`
 * env-transport (the operator assembles it from workspace PG and passes it on
 * spawn; a cloud frame receives it the same way). `.papercusp/config.json` is no
 * longer read (`deprecate-harness-config-json-2026-06-06` — the file is deprecated
 * to ZERO for instance/shape config). Absent / malformed env ⇒ empty instance
 * config (the blueprint supplies every default), never a file fall-back.
 */
export function readInstanceConfig(): HarnessConfig {
  const raw = process.env.HARNESS_CONFIG_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as HarnessConfig;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* malformed env — instance config is empty (blueprint defaults apply) */
    }
  }
  return {};
}

/**
 * The EFFECTIVE config: the instance layer (HARNESS_CONFIG_JSON env-transport) over
 * the blueprint-knob overlay. The orchestrator's run-config load boundary, so every
 * `configGet(cfg, …)` read resolves instance-then-blueprint without touching the
 * read sites. (`.papercusp/config.json` is never consulted — deprecated to zero.)
 */
export function readEffectiveConfig(stateDir: string): HarnessConfig {
  const cfg = readInstanceConfig();
  const overlay = blueprintKnobsToConfigOverlay(loadHarnessKnobs(stateDir));
  if (Object.keys(overlay).length === 0) return cfg;
  return deepMergeConfig(overlay as Record<string, unknown>, cfg as Record<string, unknown>) as HarnessConfig;
}
