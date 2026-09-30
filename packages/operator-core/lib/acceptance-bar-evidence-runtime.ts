/**
 * acceptance-bar-evidence-runtime.ts — WHERE a deployed/live acceptance BAR is measured
 * (acceptance-runtime-plane-not-main-2026-09-23 P-002).
 *
 * `evidencePlane: 'live'` promised "measured live" without saying WHICH live. Agents and
 * graders filled the gap with the one liveness instrument they knew — :3070, green main —
 * and waited on a deploy that could never change code running in bg-host. This module
 * gives the plane a runtime:
 *
 *  - DECLARED  — the criterion names `evidenceRuntime`; the ship door checks current
 *                evidence measured on exactly that runtime.
 *  - INFERRED  — no declaration, but the BAR's text names source paths whose runtime
 *                owners agree; reported and FLAGGED FOR REVIEW, never blocking.
 *  - UNRESOLVED — nothing to infer from; reported null + flagged. Never :3070 by default.
 *
 * For operator-served code the inferred runtime is the STAGING operator, not the release
 * operator: the current working build is the default acceptance plane, and green main is
 * only the final-promotion plane.
 */
import { classifyRuntimeOwners } from './git-pipeline-position';
import {
  resolveServingRuntimeAlias,
  runtimesForHost,
  type ServingRuntimeId,
} from './serving-runtimes';

export interface BarEvidenceRuntime {
  runtime: ServingRuntimeId | null;
  source: 'declared' | 'inferred' | 'unresolved' | 'not-applicable';
  /** True whenever a human should confirm the runtime (inferred or unresolved). */
  reviewFlag: boolean;
  /** Source paths the inference read (empty for declared / not-applicable). */
  inferredFrom: string[];
}

export interface BarEvidenceRuntimeInput {
  evidencePlane?: 'tree' | 'deployed' | 'live' | null;
  evidenceRuntime?: ServingRuntimeId | null;
  model?: string | null;
  method?: string | null;
  driftMarkers?: string | null;
  replication?: string | null;
}

/** Repo-relative source paths named in free text (test files excluded: they are proof, not subject). */
export function sourcePathsIn(text: string): string[] {
  const found = new Set<string>();
  const re = /(?:^|[\s`'"(\[])((?:packages|apps|libs|bin|scripts|papercusp-desktop)\/[A-Za-z0-9_./@-]+\.(?:ts|tsx|mts|mjs|js|cjs|rs))/g;
  for (const match of text.matchAll(re)) {
    const p = match[1]!.replace(/[.,;:)]+$/, '');
    if (/\.(test|spec|integration\.test)\.[a-z]+$/.test(p) || /\.test\.[a-z]+$/.test(p)) continue;
    found.add(p);
  }
  return [...found];
}

/** The runtime an acceptance check should use for a set of owner hosts. */
function acceptanceRuntimeFor(path: string): ServingRuntimeId | null {
  const owners = classifyRuntimeOwners(path);
  if (!owners?.length) return null;
  const runtimes = owners.flatMap((owner) => runtimesForHost(owner.host));
  // Operator code runs on BOTH checkouts; acceptance measures the current build.
  if (runtimes.includes('staging-operator')) return 'staging-operator';
  return runtimes[0] ?? null;
}

export function resolveBarEvidenceRuntime(input: BarEvidenceRuntimeInput): BarEvidenceRuntime {
  if (!input.evidencePlane || input.evidencePlane === 'tree') {
    return { runtime: null, source: 'not-applicable', reviewFlag: false, inferredFrom: [] };
  }
  if (input.evidenceRuntime) {
    return { runtime: input.evidenceRuntime, source: 'declared', reviewFlag: false, inferredFrom: [] };
  }
  const text = [input.model, input.method, input.driftMarkers, input.replication].filter(Boolean).join('\n');
  const paths = sourcePathsIn(text);
  const candidates = [...new Set(paths.map(acceptanceRuntimeFor).filter((r): r is ServingRuntimeId => r !== null))];
  if (candidates.length === 1) {
    return { runtime: candidates[0]!, source: 'inferred', reviewFlag: true, inferredFrom: paths };
  }
  return { runtime: null, source: 'unresolved', reviewFlag: true, inferredFrom: paths };
}

/**
 * The runtime an evidence row says it was measured on, from its free-form `details`.
 * Accepts the canonical id or any alias (`bg-host`, `:3170`, ...). Null when unstated.
 */
export function evidenceRuntimeOf(details: Record<string, unknown> | null | undefined): ServingRuntimeId | null {
  if (!details) return null;
  for (const key of ['evidenceRuntime', 'runtime', 'servingRuntime']) {
    const raw = details[key];
    if (typeof raw === 'string') {
      const id = resolveServingRuntimeAlias(raw);
      if (id) return id;
    }
  }
  return null;
}

/** An evidence row that measured the runtime and recorded the change ABSENT there. */
export function evidenceRecordsAbsent(details: Record<string, unknown> | null | undefined): boolean {
  return details?.containsChange === false;
}

/**
 * Ship-door verdict for a DECLARED runtime: satisfied iff some current evidence was
 * measured on that runtime and none of that runtime's evidence records the change absent.
 * Inferred/unresolved runtimes never block (they are review flags, not promises).
 */
export function evidenceRuntimeUnmet(args: {
  resolution: BarEvidenceRuntime | null | undefined;
  evidenceRuntimes: readonly string[] | null | undefined;
  runtimeAbsent: readonly string[] | null | undefined;
}): boolean {
  const r = args.resolution;
  if (!r || r.source !== 'declared' || !r.runtime) return false;
  if ((args.runtimeAbsent ?? []).includes(r.runtime)) return true;
  return !(args.evidenceRuntimes ?? []).includes(r.runtime);
}
