/**
 * Shared resolve+validate helper for the `blueprint:*` authoring tools
 * (`harness-blueprint-orchestration-2026-06-03` P-007 / B1). Wraps the engine's
 * loader so the tools RETURN validation issues instead of throwing — an agent
 * authoring a blueprint wants the errors back, not an exception.
 *
 * `extends` resolution is COMPOSED (official-blueprints-cupboard-publish
 * D-005): local dirs (when the caller has a project context) → installed
 * (`~/.papercusp/blueprints`, Cupboard-installed) → built-in. The old
 * built-in-only default artificially restricted `blueprint:extend`/`validate`
 * to bundled parents while the distribution layer already resolved all three
 * tiers.
 */
import { parse as parseYaml } from 'yaml';
import {
  BlueprintSchema,
  validateBlueprint,
  resolveExtends,
  type Blueprint,
  type BlueprintValidation,
  type ResolveExtendsPath,
} from '@papercusp/orchestrator/blueprint';
import { operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { blueprintRegistrySets } from '../../blueprint/registry-sets';
import { registerHarnessOpProxies } from '../../harness-ops/proxy';

export interface ResolveResult {
  ok: boolean;
  /** The resolved (extends-merged + schema-parsed) blueprint, when it parsed. */
  blueprint?: Blueprint;
  validation?: BlueprintValidation;
  /** A structural/parse error message, when resolution failed before validation. */
  parseError?: string;
}

/**
 * Parse a YAML or JSON source string into a raw blueprint object. `yaml.parse`
 * accepts JSON too (YAML ⊇ JSON), so one path handles both.
 */
export function parseBlueprintSource(source: string): Record<string, unknown> {
  const parsed = parseYaml(source);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('blueprint source is not a YAML/JSON mapping');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve `extends` + schema-parse + semantic-validate a raw blueprint, returning
 * issues rather than throwing. `ok` is true only when the schema parses AND
 * `validateBlueprint` reports no errors (warnings still allow ok).
 *
 * `resolve` defaults to the operator's composed local→installed→built-in
 * resolver; pass one with extra `localDirs` when a project context exists
 * (harness:create does, for the target repo's `.papercusp/blueprints`).
 */
export function resolveAndValidate(
  raw: Record<string, unknown>,
  resolve: ResolveExtendsPath = operatorResolveExtends(),
): ResolveResult {
  let merged: Record<string, unknown>;
  try {
    merged = resolveExtends(raw, resolve);
  } catch (e) {
    return { ok: false, parseError: `extends resolution failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  let blueprint: Blueprint;
  try {
    blueprint = BlueprintSchema.parse(merged);
  } catch (e) {
    return { ok: false, parseError: `schema validation failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  // P-002: register a PROXY CoordOp for any harness-provided ops this blueprint
  // declares (`ops:` manifest) BEFORE we snapshot the op registry below — so the
  // spine may reference an op that lives in the harness and validation resolves it
  // instead of flagging `unknown-op`. Default-inert when `ops` is empty.
  registerHarnessOpProxies(blueprint.ops);
  // P-001: enforce the op/role liveness contract at authoring time — a
  // `blueprint:validate`/`blueprint:extend` over a deterministic program that
  // names an unregistered op now returns a clear `unknown-op` error instead of
  // passing here and throwing later at run time.
  const validation = validateBlueprint(blueprint, blueprintRegistrySets());
  return { ok: validation.ok, blueprint, validation };
}
