/**
 * Shared blueprint **instantiation** primitive — the one path both
 * `papercusp init --from` (CLI) and `harness:create` (operator) use to turn a
 * chosen blueprint into the git-canonical `.papercusp/blueprint.yaml`, so the
 * two entry points DON'T diverge (`harness-blueprint-distribution-2026-06-03`
 * brief boundary #1).
 *
 * The canonical on-disk artifact is the THIN inheriting child
 * (`{ id: <slug>, extends: <blueprintId> }`) — NOT the fully-resolved blueprint
 * — exactly as `harness:create` writes it: the file stays a small override and
 * the loader resolves `extends` lazily (D-006/D-021, the engine's
 * source-of-truth model). We resolve+validate to FAIL UPFRONT on a bad
 * blueprint, but persist the thin child.
 *
 * Mirrors `apps/operator/lib/agent-tools/blueprint/_resolve.ts`'s
 * `resolveAndValidate`, but (a) lives in a lib both the CLI and operator import
 * (the operator one can be refactored to delegate here post-carve), and (b)
 * accepts a custom `ResolveExtendsPath` so `extends` resolves across the
 * distribution tiers (local → installed → built-in), not built-in only.
 */
import { stringify as stringifyYaml } from 'yaml';
import {
  BlueprintSchema,
  validateBlueprint,
  resolveExtends,
  type Blueprint,
  type BlueprintValidation,
  type ResolveExtendsPath,
  type BlueprintValidateRegistry,
} from '@papercusp/orchestrator/blueprint';

export interface ResolveResult {
  /** True only when the schema parses AND `validateBlueprint` reports no errors (warnings still allow ok). */
  ok: boolean;
  /** The resolved (extends-merged + schema-parsed) blueprint, when it parsed. */
  blueprint?: Blueprint;
  validation?: BlueprintValidation;
  /** A structural/parse error message, when resolution failed before validation. */
  parseError?: string;
}

/**
 * The thin inheriting child a host instantiates: `{ id, extends }`. The exact
 * shape `harness:create` writes for the `blueprintId` case.
 */
export function makeChildBlueprint(id: string, extendsId: string): Record<string, unknown> {
  return { id, extends: extendsId };
}

/** Serialize a (thin child) blueprint object to canonical YAML — `harness:create`'s format. */
export function serializeBlueprint(obj: Record<string, unknown>): string {
  return stringifyYaml(obj, { lineWidth: 100 });
}

/**
 * Resolve `extends` (via `resolve`, default built-in-only) + schema-parse +
 * semantic-validate a raw blueprint, returning issues rather than throwing.
 * Pass the composed resolver (`makeComposedResolveExtends`) to resolve across
 * the local → installed → built-in tiers.
 */
export function resolveAndValidateBlueprint(
  raw: Record<string, unknown>,
  resolve?: ResolveExtendsPath,
  /**
   * Operator-injected op/role registries → liveness enforcement (P-001). An
   * installed marketplace blueprint that names an op the host hasn't registered
   * fails the import with a clear `unknown-op`, not a runtime throw. Omitted →
   * lenient (the CLI `papercusp init` path, where the op registry isn't loaded).
   */
  registry?: BlueprintValidateRegistry,
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
  const validation = validateBlueprint(blueprint, registry ?? {});
  return { ok: validation.ok, blueprint, validation };
}
