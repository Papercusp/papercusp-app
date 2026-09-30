/**
 * The eval-battery `InstanceSubject` wiring (`retire-snapshots-instance-spec-2026-06-09`
 * P-005; reconciliation D-001/D-002/D-003).
 *
 * The reconciliation's canonical model has ONE eval-battery engine with a Subject
 * port; the Apiary/gen-0 beekeeper is the `InstanceSubject`, whose **variant = a
 * genome delta** and whose **same-origin clone = `vary(spec, delta)`** (Apiary D-008).
 * This module is the adapter from an `InstanceSpec` onto the beekeeper's existing
 * `InstanceManifest` variant port:
 *
 *   - `instanceManifestFromSpec` maps a spec → a manifest (`codeSha = repoSha`,
 *     `genomeId = hashGenome(genome)`), so the beekeeper's
 *     `UNIQUE(workspace_id, code_sha, genome_id)` fairness key IS the same-origin
 *     guarantee (identical code SHA, one genome per variant);
 *   - `sameOriginVariants` turns a base spec + a set of genome deltas into a family
 *     of same-origin variant manifests — the generation the battery scores.
 *
 * The genome surface is defined ONCE in `./genome` (D-002); the beekeeper's opaque
 * `genomeId: string` is just its content-address, so there is no second definition.
 */
import type { InstanceBootSpec, InstanceManifest } from '../iq-battery/instance-manifest';
import { genomeIsEmpty, hashGenome, type GenomeDelta } from './genome';
import { hashInstanceSpec, type InstanceSpec } from './types';
import { varyInstanceSpec } from './vary';

export interface ManifestFromSpecOpts {
  workspaceId: string;
  /** Override the derived instance id (default: content-addressed from the spec). */
  instanceId?: string;
  /** Override the creation timestamp (default: now). */
  createdAt?: Date;
  /** Optional reachable URL for the boot spec form. */
  instanceUrl?: string;
}

/** Map an `InstanceSpec` → the beekeeper's `InstanceManifest` (the variant port). */
export function instanceManifestFromSpec(spec: InstanceSpec, opts: ManifestFromSpecOpts): InstanceManifest {
  const genomeId = genomeIsEmpty(spec.genome) ? undefined : hashGenome(spec.genome);
  return {
    instanceId: opts.instanceId ?? hashInstanceSpec(spec),
    workspaceId: opts.workspaceId,
    codeSha: spec.repoSha ?? 'unknown',
    ...(genomeId ? { genomeId } : {}),
    createdAt: opts.createdAt ?? new Date(),
  };
}

/** Map an `InstanceSpec` → an `InstanceBootSpec` (manifest + reach URL). */
export function instanceBootSpecFromSpec(
  spec: InstanceSpec,
  opts: ManifestFromSpecOpts & { instanceUrl: string },
): InstanceBootSpec {
  return { manifest: instanceManifestFromSpec(spec, opts), instanceUrl: opts.instanceUrl };
}

export interface SameOriginVariant {
  delta: GenomeDelta;
  spec: InstanceSpec;
  manifest: InstanceManifest;
}

/**
 * A generation of SAME-ORIGIN variants from a base spec + genome deltas: every
 * variant shares the base's blueprint + repo SHA + deployment, differing only by its
 * genome (the fair Δ-selection). The base itself is the champion control (delta = {}).
 */
export function sameOriginVariants(
  base: InstanceSpec,
  deltas: GenomeDelta[],
  opts: ManifestFromSpecOpts,
): SameOriginVariant[] {
  const all: GenomeDelta[] = [{}, ...deltas];
  return all.map((delta, i) => {
    const spec = i === 0 ? base : varyInstanceSpec(base, delta);
    return { delta, spec, manifest: instanceManifestFromSpec(spec, opts) };
  });
}
