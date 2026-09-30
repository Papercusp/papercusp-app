/**
 * The `InstanceSpec` — the reproducible unit of a papercusp instance
 * (`retire-snapshots-instance-spec-2026-06-09` D-002; `self-improvement-stack-
 * reconciliation-2026-06-09` D-003).
 *
 * A LIGHTWEIGHT, declarative descriptor that *boots* an identical instance — NOT a
 * frozen state tarball. It is exactly what's needed to reproduce or vary an
 * instance and nothing more:
 *
 *     InstanceSpec = (blueprintRef, repoSha, deploymentConfig, genome)
 *
 * The new layered design already produces every piece: the blueprint id (from
 * `.papercusp/blueprint.yaml`), the harness's git SHA, the deployment-driver config
 * (`harness:create { deployment }`), and the genome (the config-variation surface).
 * This is the only job the retired snapshot system still did — re-homed off a
 * tarball onto this descriptor: **deploy = `boot(spec)`**, **same-origin clone =
 * `vary(spec, genomeDelta)`** (the eval-battery's fair Δ-selection, Apiary D-008).
 */
import { createHash } from 'node:crypto';
import type { DeploymentConfig } from '@papercusp/deployment-driver';
import type { Genome } from './genome';
import { canonicalGenomeJson, hashGenome } from './genome';

/** Schema version of the spec artifact (bump on a breaking shape change). */
export const INSTANCE_SPEC_VERSION = 1;

/**
 * A reference to the blueprint an instance was created from. The blueprint stays
 * git-canonical (`.papercusp/blueprint.yaml`); this captures enough to re-instantiate
 * it on `boot`. The full `blueprint` object is carried so boot reproduces the exact
 * authored shape even when host-side `extends` resolution would differ.
 */
export interface BlueprintRef {
  /** The instance's own blueprint id (usually the harness slug). */
  id: string;
  /** The built-in/installed family it extends (e.g. `'coding'`, `'research'`). */
  extends?: string;
  /** The resolved blueprint version at capture, for provenance. */
  version?: string;
  /** The git-canonical authored blueprint object (the create-time `childObj`). */
  blueprint?: Record<string, unknown>;
}

/**
 * The reproducible instance descriptor. Captures→boots an identical instance and
 * varies into fair same-origin clones (the same blueprint + SHA + deployment,
 * differing only by the genome).
 */
export interface InstanceSpec {
  specVersion: number;
  blueprintRef: BlueprintRef;
  /** Git SHA of the harness repo at capture; `null` for a repo-less instance. */
  repoSha: string | null;
  /** Where the execution plane runs (a sibling to the blueprint). */
  deploymentConfig: DeploymentConfig;
  /** The config-variation surface (the one job that varies between same-origin clones). */
  genome: Genome;
}

/** Deterministic, key-sorted JSON of any value — equal values stringify identically. */
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

/** The "origin" of a spec — everything that must match for two specs to be
 *  same-origin clones (i.e. everything BUT the genome). */
export function specOrigin(spec: InstanceSpec): {
  blueprintRef: BlueprintRef;
  repoSha: string | null;
  deploymentConfig: DeploymentConfig;
} {
  return {
    blueprintRef: spec.blueprintRef,
    repoSha: spec.repoSha,
    deploymentConfig: spec.deploymentConfig,
  };
}

/** Canonical content-address of the WHOLE spec (origin + genome) → `inst_<hex16>`. */
export function hashInstanceSpec(spec: InstanceSpec): string {
  const pre = canonicalJson({ origin: specOrigin(spec), genome: canonicalGenomeJson(spec.genome) });
  const hex = createHash('sha256').update(pre).digest('hex').slice(0, 16);
  return `inst_${hex}`;
}

/** The genome content-address of a spec (its `genomeId` for the eval-battery). */
export function specGenomeId(spec: InstanceSpec): string {
  return hashGenome(spec.genome);
}
