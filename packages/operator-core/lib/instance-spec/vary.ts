/**
 * `vary(spec, genomeDelta)` — produce a SAME-ORIGIN clone of an instance spec
 * (`retire-snapshots-instance-spec-2026-06-09` P-004; reconciliation D-003).
 *
 * The Apiary's fair Δ-selection (D-008): every variant in a generation starts as an
 * identical clone of the base (same blueprint + SHA + deployment), differing ONLY by
 * a genome delta. Shared T0 ⇒ end-of-window ranking IS the self-improvement ranking,
 * with no headroom/regression bias. `vary` is the pure transform that makes that
 * fairness structural — it touches nothing but the genome.
 */
import { mergeGenome, type GenomeDelta } from './genome';
import { canonicalGenomeJson } from './genome';
import { specOrigin, type InstanceSpec } from './types';

/**
 * Apply a genome delta to a spec → a same-origin clone. Pure: the returned spec has
 * an IDENTICAL `blueprintRef` / `repoSha` / `deploymentConfig` and a genome equal to
 * `mergeGenome(spec.genome, delta)`. By construction `sameOrigin(spec, varied)` holds.
 */
export function varyInstanceSpec(spec: InstanceSpec, delta: GenomeDelta): InstanceSpec {
  return { ...spec, genome: mergeGenome(spec.genome, delta) };
}

/** Deterministic, key-sorted JSON of any value (for origin equality). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * True when two specs are same-origin clones: identical blueprint + repo SHA +
 * deployment config (the genome is allowed — indeed expected — to differ).
 */
export function sameOrigin(a: InstanceSpec, b: InstanceSpec): boolean {
  return canonicalJson(specOrigin(a)) === canonicalJson(specOrigin(b));
}

/** True when two specs are byte-identical (origin AND genome). */
export function specsIdentical(a: InstanceSpec, b: InstanceSpec): boolean {
  return sameOrigin(a, b) && canonicalGenomeJson(a.genome) === canonicalGenomeJson(b.genome);
}
