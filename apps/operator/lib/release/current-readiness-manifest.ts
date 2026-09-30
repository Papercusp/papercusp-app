/**
 * Current release-readiness manifest (P-519/F8).
 *
 * `ReleaseProfileVerdict` is the signed/evaluated evidence model. This adapter gives
 * that verdict a product-facing, current interpretation without creating another
 * evaluator or persistence path. Historical snapshots are carried through as an
 * append-only list; `current` is the one interpretation consumers should render.
 */
import { createHash } from 'node:crypto';

import type {
  ComponentEvaluation,
  ComponentVerdict,
  EvidenceRef,
  ReleaseProfileVerdict,
} from '@papercusp/release-profile';
import { canonicalJson } from '@papercusp/operator-core/lib/external-bench/reproducibility/canonical-json';

export const CURRENT_READINESS_MANIFEST_SCHEMA_VERSION = 1 as const;

/** Human-facing states stay separate even when they share a profile verdict. */
export type ReadinessState =
  | 'skipped'
  | 'unmeasured'
  | 'advancing'
  | 'source-tested'
  | 'passed-on-this-artifact'
  | 'failed-on-this-artifact';

export type ReadinessArtifactIdentity = {
  /** Stable content identity for the artifact under review. */
  id: string;
  sha256?: string;
  sourceRevision?: string;
  generation?: string;
};

export type ReadinessCapabilityInput = {
  /** Stable capability key. It normally matches a release-profile component key. */
  key: string;
  /** Component to consume when the capability key differs from the profile key. */
  componentKey?: string;
  scenario: string;
  expectedPeers?: readonly string[];
  /** Peers actually observed by the run. Missing expected peers keep a row advancing. */
  observedPeers?: readonly string[];
  /** Explicitly approved exclusions are retained and never silently inferred. */
  approvedExclusions?: readonly string[];
  owner: string;
  dependencies?: readonly string[];
  /** Preserve source-only or intentionally skipped states instead of inferring a pass. */
  executionState?: Exclude<ReadinessState, 'passed-on-this-artifact' | 'failed-on-this-artifact'> | 'executed';
};

export type ReadinessFreshness = {
  measuredAt: string;
  ageMs: number | null;
  windowMs: number | null;
  fresh: boolean;
};

export type ReadinessEvidence = {
  digest: string;
  refs: readonly EvidenceRef[];
};

export type CurrentReadinessRow = {
  capability: string;
  componentKey: string;
  artifactId: string;
  scenario: string;
  state: ReadinessState;
  result: ComponentVerdict;
  reason: string;
  expectedPeers: readonly string[];
  observedPeers: readonly string[];
  missingPeers: readonly string[];
  evidence: ReadinessEvidence;
  freshness: ReadinessFreshness;
  approvedExclusions: readonly string[];
  owner: string;
  dependencies: readonly string[];
};

export type ReadinessHistoryEntry = {
  recordedAt: string;
  artifact: ReadinessArtifactIdentity;
  profileRef: string;
  go: boolean;
  rows: readonly CurrentReadinessRow[];
};

export type ReadinessDependencyNode = {
  capability: string;
  state: ReadinessState;
  remaining: boolean;
};

export type ReadinessDependencyEdge = {
  from: string;
  to: string;
};

export type ReadinessDependencyGraph = {
  nodes: readonly ReadinessDependencyNode[];
  edges: readonly ReadinessDependencyEdge[];
};

export type CurrentReadinessManifest = {
  schemaVersion: typeof CURRENT_READINESS_MANIFEST_SCHEMA_VERSION;
  generatedAt: string;
  artifact: ReadinessArtifactIdentity;
  profile: {
    ref: string;
    evaluatedAt: string;
    go: boolean;
    reason: string;
  };
  /** Exactly one current interpretation. */
  current: {
    go: boolean;
    reason: string;
    rows: readonly CurrentReadinessRow[];
  };
  /** Prior interpretations are copied, never rewritten by this adapter. */
  history: readonly ReadinessHistoryEntry[];
};

export type BuildCurrentReadinessManifestOptions = {
  profile: ReleaseProfileVerdict;
  artifact?: ReadinessArtifactIdentity | string;
  /** Alias accepted for callers that already use the release manifest vocabulary. */
  artifactIdentity?: ReadinessArtifactIdentity | string;
  capabilities?: readonly ReadinessCapabilityInput[];
  /** Defaults used when capabilities are derived from profile components. */
  scenario?: string;
  expectedPeers?: readonly string[];
  observedPeers?: readonly string[];
  approvedExclusions?: readonly string[];
  owner?: string;
  dependencies?: readonly string[];
  /** Optional freshness window; the evaluator's stale verdict remains authoritative. */
  freshnessWindowMs?: number;
  now?: number | string;
  history?: readonly ReadinessHistoryEntry[];
};

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function artifactIdentity(value: ReadinessArtifactIdentity | string | undefined): ReadinessArtifactIdentity {
  if (typeof value === 'string') return { id: nonEmpty(value, 'artifact id') };
  if (!value) throw new Error('artifact or artifactIdentity is required');
  return {
    id: nonEmpty(value.id, 'artifact.id'),
    ...(value.sha256 ? { sha256: nonEmpty(value.sha256, 'artifact.sha256') } : {}),
    ...(value.sourceRevision ? { sourceRevision: nonEmpty(value.sourceRevision, 'artifact.sourceRevision') } : {}),
    ...(value.generation ? { generation: nonEmpty(value.generation, 'artifact.generation') } : {}),
  };
}

function profileComponentsByKey(profile: ReleaseProfileVerdict): Map<string, ComponentEvaluation> {
  const byKey = new Map<string, ComponentEvaluation>();
  for (const component of profile.components) {
    if (byKey.has(component.key)) throw new Error(`profile contains duplicate component '${component.key}'`);
    byKey.set(component.key, component);
  }
  return byKey;
}

function normalizeCapabilities(options: BuildCurrentReadinessManifestOptions): ReadinessCapabilityInput[] {
  if (options.capabilities && options.capabilities.length > 0) {
    return options.capabilities.map((capability) => ({
      ...capability,
      key: nonEmpty(capability.key, 'capability.key'),
      scenario: nonEmpty(capability.scenario, `capability '${capability.key}' scenario`),
      owner: nonEmpty(capability.owner, `capability '${capability.key}' owner`),
      expectedPeers: uniqueSorted(capability.expectedPeers),
      observedPeers: uniqueSorted(capability.observedPeers),
      approvedExclusions: uniqueSorted(capability.approvedExclusions),
      dependencies: uniqueSorted(capability.dependencies),
    }));
  }

  const scenario = nonEmpty(options.scenario ?? '', 'scenario');
  const owner = nonEmpty(options.owner ?? '', 'owner');
  return options.profile.components.map((component) => ({
    key: component.key,
    componentKey: component.key,
    scenario,
    expectedPeers: uniqueSorted(options.expectedPeers),
    observedPeers: uniqueSorted(options.observedPeers),
    approvedExclusions: uniqueSorted(options.approvedExclusions),
    owner,
    dependencies: uniqueSorted(options.dependencies),
    executionState: 'executed',
  }));
}

function evidenceDigest(
  artifact: ReadinessArtifactIdentity,
  capability: ReadinessCapabilityInput,
  component: ComponentEvaluation | undefined,
): string {
  const material = {
    artifact,
    capability: capability.key,
    componentKey: capability.componentKey ?? capability.key,
    scenario: capability.scenario,
    result: component?.verdict ?? 'unknown',
    measuredAt: component?.measuredAt ?? null,
    evidence: component?.evidence ?? [],
  };
  return createHash('sha256').update(canonicalJson(material), 'utf8').digest('hex');
}

function freshness(
  component: ComponentEvaluation | undefined,
  nowMs: number,
  windowMs: number | null,
  verdict: ComponentVerdict | undefined = component?.verdict,
): ReadinessFreshness {
  const measuredAt = component?.measuredAt ?? new Date(nowMs).toISOString();
  const measuredMs = Date.parse(measuredAt);
  const ageMs = Number.isFinite(measuredMs) ? Math.max(0, nowMs - measuredMs) : null;
  const fresh = component !== undefined && verdict !== 'stale' && verdict !== 'lineage-mismatch' && ageMs !== null && (windowMs === null || ageMs <= windowMs);
  return { measuredAt, ageMs, windowMs, fresh };
}

function artifactLineageMismatches(
  artifact: ReadinessArtifactIdentity,
  component: ComponentEvaluation | undefined,
): string[] {
  if (!component?.lineage) return [];
  const mismatches: string[] = [];
  if (artifact.sha256 && component.lineage.sha && artifact.sha256 !== component.lineage.sha) mismatches.push('sha256');
  if (artifact.generation && component.lineage.generation && artifact.generation !== component.lineage.generation) mismatches.push('generation');
  return mismatches;
}

function stateFor(
  component: ComponentEvaluation | undefined,
  capability: ReadinessCapabilityInput,
  missingPeers: readonly string[],
): ReadinessState {
  const explicit = capability.executionState;
  if (explicit && explicit !== 'executed') return explicit;
  if (!component) return 'unmeasured';
  if (component.verdict === 'pass' && missingPeers.length === 0) return 'passed-on-this-artifact';
  if (component.verdict === 'fail') return 'failed-on-this-artifact';
  if (component.verdict === 'pass' && missingPeers.length > 0) return 'advancing';
  return 'unmeasured';
}

function rowFor(
  artifact: ReadinessArtifactIdentity,
  capability: ReadinessCapabilityInput,
  component: ComponentEvaluation | undefined,
  nowMs: number,
  windowMs: number | null,
): CurrentReadinessRow {
  const expectedPeers = uniqueSorted(capability.expectedPeers);
  const observedPeers = uniqueSorted(capability.observedPeers);
  const approvedExclusions = uniqueSorted(capability.approvedExclusions);
  const missingPeers = expectedPeers.filter((peer) => !observedPeers.includes(peer) && !approvedExclusions.includes(peer));
  const lineageMismatches = artifactLineageMismatches(artifact, component);
  const result: ComponentVerdict = lineageMismatches.length > 0 ? 'lineage-mismatch' : component?.verdict ?? 'unknown';
  const baseReason = component?.reason ?? `no release-profile component '${capability.componentKey ?? capability.key}' was evaluated`;
  const reasonParts = [
    baseReason,
    ...(lineageMismatches.length > 0 ? [`artifact lineage mismatch on: ${lineageMismatches.join(', ')}`] : []),
    ...(missingPeers.length > 0 ? [`missing expected peer(s): ${missingPeers.join(', ')}`] : []),
  ];
  const reason = reasonParts.join('; ');
  const stateComponent = lineageMismatches.length > 0 ? undefined : component;
  return {
    capability: capability.key,
    componentKey: capability.componentKey ?? capability.key,
    artifactId: artifact.id,
    scenario: capability.scenario,
    state: stateFor(stateComponent, capability, missingPeers),
    result,
    reason,
    expectedPeers,
    observedPeers,
    missingPeers,
    evidence: { digest: evidenceDigest(artifact, capability, component), refs: component?.evidence ?? [] },
    freshness: freshness(component, nowMs, windowMs, result),
    approvedExclusions,
    owner: capability.owner,
    dependencies: uniqueSorted(capability.dependencies),
  };
}

/** Build one current interpretation from the existing release-profile verdict. */
export function buildCurrentReadinessManifest(options: BuildCurrentReadinessManifestOptions): CurrentReadinessManifest {
  const artifact = artifactIdentity(options.artifact ?? options.artifactIdentity);
  const profileComponents = profileComponentsByKey(options.profile);
  const capabilities = normalizeCapabilities(options);
  const seenCapabilities = new Set<string>();
  for (const capability of capabilities) {
    if (seenCapabilities.has(capability.key)) throw new Error(`duplicate capability '${capability.key}'`);
    seenCapabilities.add(capability.key);
  }
  const nowMs = typeof options.now === 'string' ? Date.parse(options.now) : options.now ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`now '${String(options.now)}' is not a parseable timestamp`);
  const windowMs = options.freshnessWindowMs ?? null;
  if (windowMs !== null && (!Number.isFinite(windowMs) || windowMs < 0)) throw new Error('freshnessWindowMs must be a non-negative number');
  const rows = capabilities.map((capability) =>
    rowFor(artifact, capability, profileComponents.get(capability.componentKey ?? capability.key), nowMs, windowMs),
  );
  const mandatoryKeys = new Set(options.profile.components.filter((component) => component.mandatory).map((component) => component.key));
  const coveredMandatory = [...mandatoryKeys].every((key) => rows.some((row) => row.componentKey === key));
  const generatedAt = new Date(nowMs).toISOString();
  const current = {
    go: options.profile.go && rows.length > 0 && coveredMandatory && rows.every((row) => row.state === 'passed-on-this-artifact'),
    reason: options.profile.go && rows.length > 0 && coveredMandatory && rows.every((row) => row.state === 'passed-on-this-artifact')
      ? 'all current capability rows passed on this artifact'
      : `current capability evidence is incomplete or not passing: ${rows.filter((row) => row.state !== 'passed-on-this-artifact').map((row) => `${row.capability} (${row.state})`).join('; ') || 'no rows'}`,
    rows,
  };
  return {
    schemaVersion: CURRENT_READINESS_MANIFEST_SCHEMA_VERSION,
    generatedAt,
    artifact,
    profile: {
      ref: options.profile.profileRef,
      evaluatedAt: options.profile.evaluatedAt,
      go: options.profile.go,
      reason: options.profile.reason,
    },
    current,
    history: [...(options.history ?? [])],
  };
}

/** Append a completed interpretation without mutating an existing manifest. */
export function appendReadinessHistory(
  manifest: CurrentReadinessManifest,
  recordedAt: string = manifest.generatedAt,
): CurrentReadinessManifest {
  const entry: ReadinessHistoryEntry = {
    recordedAt: nonEmpty(recordedAt, 'recordedAt'),
    artifact: manifest.artifact,
    profileRef: manifest.profile.ref,
    go: manifest.current.go,
    rows: manifest.current.rows,
  };
  return { ...manifest, history: [...manifest.history, entry] };
}

/** Derive the unresolved dependency graph from the current rows. */
export function deriveReadinessDependencyGraph(manifest: CurrentReadinessManifest): ReadinessDependencyGraph {
  const keys = new Set(manifest.current.rows.map((row) => row.capability));
  const nodes = manifest.current.rows.map((row) => ({
    capability: row.capability,
    state: row.state,
    remaining: row.state !== 'passed-on-this-artifact',
  }));
  const edges: ReadinessDependencyEdge[] = [];
  for (const row of manifest.current.rows) {
    for (const dependency of row.dependencies) {
      if (keys.has(dependency)) edges.push({ from: row.capability, to: dependency });
    }
  }
  return { nodes, edges };
}

/** Compact human-readable table generated solely from the current manifest. */
export function renderReadinessTable(manifest: CurrentReadinessManifest): string {
  const lines = [
    '| Capability | State | Result | Scenario | Evidence | Owner |',
    '| --- | --- | --- | --- | --- | --- |',
    ...manifest.current.rows.map((row) =>
      `| ${row.capability} | ${row.state} | ${row.result} | ${row.scenario} | ${row.evidence.digest.slice(0, 12)} | ${row.owner} |`,
    ),
  ];
  return lines.join('\n');
}

/** Stable JSON bytes for signing or storing a manifest. */
export function serializeCurrentReadinessManifest(manifest: CurrentReadinessManifest): string {
  return canonicalJson(manifest);
}

// Concise aliases for callers that use the noun-first naming found in the plan text.
export const deriveCurrentReadinessManifest = buildCurrentReadinessManifest;
export const currentReadinessDependencyGraph = deriveReadinessDependencyGraph;
export const readinessTable = renderReadinessTable;
