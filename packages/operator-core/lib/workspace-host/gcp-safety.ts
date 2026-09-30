import { createHash } from 'node:crypto';
import {
  assertWorkspaceHostSecretIsolation,
  type WorkspaceHostPriceEstimate,
  type WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';

export const GCP_WORKSPACE_HOST_SAFETY_VERSION = 'gcp-workspace-host-safety-v1';
export const GCP_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF =
  'runbook://workspace-host/gcp/ambiguous-operation-recovery-v1';

export const GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS = {
  managed: 'papercusp-managed',
  hostId: 'papercusp-host-id',
  workspaceId: 'papercusp-workspace-id',
} as const;

/** Match Compute Engine's label grammar while retaining a stable identity for long/opaque ids. */
export function gcpWorkspaceHostLabelValue(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  if (normalized.length > 0 && normalized.length <= 63) return normalized;
  return `id-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  return value;
}

function timestamp(value: string, label: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} must be an ISO timestamp`);
  return millis;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
  return value;
}

function nonNegativeCents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer number of cents`);
  }
  return value;
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer duration`);
  return value;
}

function evidenceIsFresh(observedAt: string, evaluatedAtMs: number, maxAgeMs: number): boolean {
  const age = evaluatedAtMs - timestamp(observedAt, 'evidence observedAt');
  return age >= 0 && age <= maxAgeMs;
}

export interface GcpWorkspaceHostQuotaRequirement {
  metric: string;
  minimumAvailable: number;
  unit: string;
}

export interface GcpWorkspaceHostQuotaEvidence {
  metric: string;
  limit: number;
  usage: number;
  unit: string;
  observedAt: string;
  providerEvidenceRef: string;
}

export interface GcpWorkspaceHostCapacityEvidence {
  zone: string;
  machineType: string;
  available: boolean;
  observedAt: string;
  providerEvidenceRef: string;
  detail?: string;
}

export interface GcpWorkspaceHostPriceProvenance {
  estimate: WorkspaceHostPriceEstimate;
  source: 'cloud-billing-catalog' | 'provider-estimator';
  providerEvidenceRef: string;
  skuRefs: readonly string[];
  assumptions: readonly string[];
}

export type GcpWorkspaceHostSafetyIssueCode =
  | 'quota-unverified'
  | 'quota-invalid'
  | 'quota-insufficient'
  | 'capacity-unverified'
  | 'capacity-unavailable'
  | 'price-unverified'
  | 'price-unknown'
  | 'evidence-stale';

export interface GcpWorkspaceHostSafetyIssue {
  code: GcpWorkspaceHostSafetyIssueCode;
  message: string;
  providerEvidenceRef?: string;
}

export interface GcpWorkspaceHostSafetyPreflightInput {
  requirements: readonly GcpWorkspaceHostQuotaRequirement[];
  quotas: readonly GcpWorkspaceHostQuotaEvidence[];
  capacity?: GcpWorkspaceHostCapacityEvidence;
  price?: GcpWorkspaceHostPriceProvenance;
  evaluatedAt: string;
  maxEvidenceAgeMs: number;
}

export interface GcpWorkspaceHostSafetyPreflightReport {
  version: typeof GCP_WORKSPACE_HOST_SAFETY_VERSION;
  ready: boolean;
  evaluatedAt: string;
  quotaEvidence: readonly GcpWorkspaceHostQuotaEvidence[];
  capacityEvidence?: GcpWorkspaceHostCapacityEvidence;
  priceProvenance?: GcpWorkspaceHostPriceProvenance;
  issues: readonly GcpWorkspaceHostSafetyIssue[];
}

/** Fail-closed preflight over persisted provider evidence; it performs no provider calls. */
export function evaluateGcpWorkspaceHostSafetyPreflight(
  input: GcpWorkspaceHostSafetyPreflightInput,
): GcpWorkspaceHostSafetyPreflightReport {
  assertWorkspaceHostSecretIsolation(input, 'gcpSafety.preflight');
  const evaluatedAtMs = timestamp(input.evaluatedAt, 'preflight evaluatedAt');
  const maxAgeMs = positiveDuration(input.maxEvidenceAgeMs, 'preflight maxEvidenceAgeMs');
  const issues: GcpWorkspaceHostSafetyIssue[] = [];
  const quotasByMetric = new Map<string, GcpWorkspaceHostQuotaEvidence>();

  for (const quota of input.quotas) {
    requireNonEmpty(quota.metric, 'quota metric');
    requireNonEmpty(quota.unit, `quota '${quota.metric}' unit`);
    requireNonEmpty(quota.providerEvidenceRef, `quota '${quota.metric}' providerEvidenceRef`);
    const limit = nonNegativeFinite(quota.limit, `quota '${quota.metric}' limit`);
    const usage = nonNegativeFinite(quota.usage, `quota '${quota.metric}' usage`);
    if (usage > limit) {
      issues.push({
        code: 'quota-invalid',
        message: `Quota '${quota.metric}' reports usage ${usage} above limit ${limit}.`,
        providerEvidenceRef: quota.providerEvidenceRef,
      });
    }
    if (!evidenceIsFresh(quota.observedAt, evaluatedAtMs, maxAgeMs)) {
      issues.push({
        code: 'evidence-stale',
        message: `Quota '${quota.metric}' evidence is stale or future-dated.`,
        providerEvidenceRef: quota.providerEvidenceRef,
      });
    }
    if (quotasByMetric.has(quota.metric)) {
      issues.push({ code: 'quota-invalid', message: `Quota '${quota.metric}' has duplicate evidence.` });
    } else {
      quotasByMetric.set(quota.metric, quota);
    }
  }

  for (const requirement of input.requirements) {
    requireNonEmpty(requirement.metric, 'quota requirement metric');
    requireNonEmpty(requirement.unit, `quota requirement '${requirement.metric}' unit`);
    nonNegativeFinite(requirement.minimumAvailable, `quota requirement '${requirement.metric}' minimumAvailable`);
    const evidence = quotasByMetric.get(requirement.metric);
    if (!evidence || evidence.unit !== requirement.unit) {
      issues.push({
        code: 'quota-unverified',
        message: `Quota '${requirement.metric}' needs ${requirement.minimumAvailable} ${requirement.unit} available.`,
        ...(evidence ? { providerEvidenceRef: evidence.providerEvidenceRef } : {}),
      });
    } else if (evidence.limit - evidence.usage < requirement.minimumAvailable) {
      issues.push({
        code: 'quota-insufficient',
        message:
          `Quota '${requirement.metric}' has ${evidence.limit - evidence.usage} ${evidence.unit} available; ` +
          `${requirement.minimumAvailable} required.`,
        providerEvidenceRef: evidence.providerEvidenceRef,
      });
    }
  }

  if (!input.capacity) {
    issues.push({ code: 'capacity-unverified', message: 'Selected zone and machine type lack capacity evidence.' });
  } else {
    requireNonEmpty(input.capacity.zone, 'capacity zone');
    requireNonEmpty(input.capacity.machineType, 'capacity machineType');
    requireNonEmpty(input.capacity.providerEvidenceRef, 'capacity providerEvidenceRef');
    if (!evidenceIsFresh(input.capacity.observedAt, evaluatedAtMs, maxAgeMs)) {
      issues.push({
        code: 'evidence-stale',
        message: `Capacity evidence for '${input.capacity.machineType}' in '${input.capacity.zone}' is stale or future-dated.`,
        providerEvidenceRef: input.capacity.providerEvidenceRef,
      });
    }
    if (!input.capacity.available) {
      issues.push({
        code: 'capacity-unavailable',
        message:
          input.capacity.detail ??
          `Machine type '${input.capacity.machineType}' is unavailable in '${input.capacity.zone}'.`,
        providerEvidenceRef: input.capacity.providerEvidenceRef,
      });
    }
  }

  if (!input.price) {
    issues.push({ code: 'price-unverified', message: 'Price estimate lacks provider provenance.' });
  } else {
    requireNonEmpty(input.price.providerEvidenceRef, 'price providerEvidenceRef');
    requireNonEmpty(input.price.estimate.currency, 'price currency');
    nonNegativeFinite(input.price.estimate.hourlyAmount, 'price hourlyAmount');
    if (input.price.estimate.monthlyAmount !== undefined) {
      nonNegativeFinite(input.price.estimate.monthlyAmount, 'price monthlyAmount');
    }
    input.price.estimate.lineItems?.forEach((lineItem, index) => {
      requireNonEmpty(lineItem.kind, `price lineItems[${index}].kind`);
      requireNonEmpty(lineItem.description, `price lineItems[${index}].description`);
      nonNegativeFinite(lineItem.hourlyAmount, `price lineItems[${index}].hourlyAmount`);
    });
    input.price.skuRefs.forEach((skuRef, index) => requireNonEmpty(skuRef, `price skuRefs[${index}]`));
    if (!input.price.skuRefs.length) {
      issues.push({
        code: 'price-unverified',
        message: 'Price provenance must identify at least one provider SKU.',
        providerEvidenceRef: input.price.providerEvidenceRef,
      });
    }
    if (!evidenceIsFresh(input.price.estimate.observedAt, evaluatedAtMs, maxAgeMs)) {
      issues.push({
        code: 'evidence-stale',
        message: 'Price estimate is stale or future-dated.',
        providerEvidenceRef: input.price.providerEvidenceRef,
      });
    }
    if (input.price.estimate.confidence === 'unknown') {
      issues.push({
        code: 'price-unknown',
        message: 'Price estimate confidence is unknown.',
        providerEvidenceRef: input.price.providerEvidenceRef,
      });
    }
  }

  return {
    version: GCP_WORKSPACE_HOST_SAFETY_VERSION,
    ready: issues.length === 0,
    evaluatedAt: input.evaluatedAt,
    quotaEvidence: input.quotas.map((entry) => ({ ...entry })),
    ...(input.capacity ? { capacityEvidence: { ...input.capacity } } : {}),
    ...(input.price
      ? {
          priceProvenance: {
            ...input.price,
            estimate: { ...input.price.estimate },
            skuRefs: [...input.price.skuRefs],
            assumptions: [...input.price.assumptions],
          },
        }
      : {}),
    issues,
  };
}

export interface GcpWorkspaceHostSpendEvidence {
  accruedCents: number;
  pendingCents: number;
  observedAt: string;
  providerEvidenceRef: string;
}

export interface GcpWorkspaceHostRuntimeSafetyInput {
  lifecycleState: 'running' | 'stopped';
  lastActivityAt?: string;
  spend?: GcpWorkspaceHostSpendEvidence;
  evaluatedAt: string;
  idleStopAfterMs: number;
  hardSpendCents: number;
  maxSpendEvidenceAgeMs: number;
}

export type GcpWorkspaceHostRuntimeSafetyAction = 'none' | 'stop' | 'block-start' | 'stop-and-block-start';

export interface GcpWorkspaceHostRuntimeSafetyDecision {
  action: GcpWorkspaceHostRuntimeSafetyAction;
  stopInstance: boolean;
  blockStart: boolean;
  preserveData: true;
  evaluatedAt: string;
  reasons: readonly ('idle-timeout' | 'hard-spend-ceiling' | 'spend-unverified')[];
}

/** Runtime policy can stop compute and block starts, but never destroys the durable data disk. */
export function decideGcpWorkspaceHostRuntimeSafety(
  input: GcpWorkspaceHostRuntimeSafetyInput,
): GcpWorkspaceHostRuntimeSafetyDecision {
  assertWorkspaceHostSecretIsolation(input, 'gcpSafety.runtime');
  const evaluatedAtMs = timestamp(input.evaluatedAt, 'runtime evaluatedAt');
  const idleStopAfterMs = positiveDuration(input.idleStopAfterMs, 'runtime idleStopAfterMs');
  const maxSpendEvidenceAgeMs = positiveDuration(input.maxSpendEvidenceAgeMs, 'runtime maxSpendEvidenceAgeMs');
  const hardSpendCents = nonNegativeCents(input.hardSpendCents, 'runtime hardSpendCents');
  const reasons: Array<'idle-timeout' | 'hard-spend-ceiling' | 'spend-unverified'> = [];

  let blockStart = false;
  if (!input.spend) {
    reasons.push('spend-unverified');
    blockStart = true;
  } else {
    requireNonEmpty(input.spend.providerEvidenceRef, 'runtime spend providerEvidenceRef');
    const accrued = nonNegativeCents(input.spend.accruedCents, 'runtime spend accruedCents');
    const pending = nonNegativeCents(input.spend.pendingCents, 'runtime spend pendingCents');
    if (!Number.isSafeInteger(accrued + pending))
      throw new Error('runtime total spend cents exceeds safe integer range');
    if (!evidenceIsFresh(input.spend.observedAt, evaluatedAtMs, maxSpendEvidenceAgeMs)) {
      reasons.push('spend-unverified');
      blockStart = true;
    } else if (accrued + pending >= hardSpendCents) {
      reasons.push('hard-spend-ceiling');
      blockStart = true;
    }
  }

  if (input.lifecycleState === 'running' && input.lastActivityAt) {
    const inactiveForMs = evaluatedAtMs - timestamp(input.lastActivityAt, 'runtime lastActivityAt');
    if (inactiveForMs >= idleStopAfterMs) reasons.push('idle-timeout');
  }

  const stopInstance = input.lifecycleState === 'running' && reasons.length > 0;
  const action: GcpWorkspaceHostRuntimeSafetyAction = stopInstance
    ? blockStart
      ? 'stop-and-block-start'
      : 'stop'
    : blockStart
      ? 'block-start'
      : 'none';
  return { action, stopInstance, blockStart, preserveData: true, evaluatedAt: input.evaluatedAt, reasons };
}

export interface GcpManagedWorkspaceHostResourceObservation {
  resource: WorkspaceHostResourceRef;
  labels: Readonly<Record<string, string>>;
  observedAt: string;
  firstObservedAt?: string;
}

export const GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS = [
  'vm',
  'disk',
  'firewall',
  'subnetwork',
  'network',
  'snapshot',
  'router',
  'nat',
] as const;

export type GcpWorkspaceHostCensusResourceKind = (typeof GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS)[number];

export interface GcpWorkspaceHostInventoryEvidence {
  kind: GcpWorkspaceHostCensusResourceKind;
  strategy: 'managed-labels' | 'deterministic-name';
  providerEvidenceRef: string;
  deterministicNames?: readonly string[];
}

export interface GcpWorkspaceHostOrphanReaperStep {
  resource: WorkspaceHostResourceRef;
  state: 'quarantine' | 'eligible';
  notBefore: string;
  action: 'confirm-and-delete';
  requiredLabels: Readonly<Record<string, string>>;
  preconditions: readonly (
    | 'fresh-provider-read'
    | 'labels-still-match'
    | 'absent-from-controller-records'
    | 'durable-data-disposition'
    | 'provider-read-delete-confirmation'
  )[];
}

export interface GcpWorkspaceHostResourceCensusInput {
  hostId: string;
  workspaceId: string;
  expected: readonly WorkspaceHostResourceRef[];
  /**
   * Ordinary host teardown: retain the full registered population, including resources expected
   * absent, so a survivor cannot evade the census by changing its host label. Explicitly labelled
   * peers outside this population are not defects. Omit for the strict workspace-wide canary census.
   */
  registeredHostResources?: readonly WorkspaceHostResourceRef[];
  /**
   * Registered recovery points that legitimately OUTLIVE the host (D-389): a snapshot the host's
   * own snapshot operation recorded. They may survive without being untracked — so they are never
   * planned for reaping — but unlike `expected` their absence is not a finding (a user may have
   * deleted a backup). An UNREGISTERED managed snapshot stays untracked: that is a real finding.
   */
  retained?: readonly WorkspaceHostResourceRef[];
  observed: readonly GcpManagedWorkspaceHostResourceObservation[];
  inventoryEvidence: readonly GcpWorkspaceHostInventoryEvidence[];
  evaluatedAt: string;
  orphanGraceMs: number;
}

export interface GcpWorkspaceHostResourceCensus {
  controllerIndependent: true;
  inventoryComplete: true;
  clean: boolean;
  evaluatedAt: string;
  inventoryEvidence: readonly GcpWorkspaceHostInventoryEvidence[];
  managed: readonly GcpManagedWorkspaceHostResourceObservation[];
  untracked: readonly GcpManagedWorkspaceHostResourceObservation[];
  missing: readonly WorkspaceHostResourceRef[];
  labelMismatches: readonly GcpManagedWorkspaceHostResourceObservation[];
  reaperPlan: readonly GcpWorkspaceHostOrphanReaperStep[];
}

function resourceKey(resource: WorkspaceHostResourceRef): string {
  return `${resource.target}:${resource.kind}:${resource.providerId}`;
}

function assertGcpResource(resource: WorkspaceHostResourceRef, label: string): void {
  if (resource.target !== 'gcp') throw new Error(`${label} must target 'gcp'`);
  requireNonEmpty(resource.kind, `${label} kind`);
  requireNonEmpty(resource.providerId, `${label} providerId`);
}

function cloneObserved(
  observation: GcpManagedWorkspaceHostResourceObservation,
): GcpManagedWorkspaceHostResourceObservation {
  return { ...observation, resource: { ...observation.resource }, labels: { ...observation.labels } };
}

/** Build a deterministic reaper plan from fresh provider inventory plus durable controller records. */
export function censusGcpWorkspaceHostResources(
  input: GcpWorkspaceHostResourceCensusInput,
): GcpWorkspaceHostResourceCensus {
  assertWorkspaceHostSecretIsolation(input, 'gcpSafety.census');
  requireNonEmpty(input.hostId, 'census hostId');
  requireNonEmpty(input.workspaceId, 'census workspaceId');
  const evaluatedAtMs = timestamp(input.evaluatedAt, 'census evaluatedAt');
  const orphanGraceMs = positiveDuration(input.orphanGraceMs, 'census orphanGraceMs');
  input.expected.forEach((resource, index) => assertGcpResource(resource, `census expected[${index}]`));
  input.registeredHostResources?.forEach((resource, index) =>
    assertGcpResource(resource, `census registeredHostResources[${index}]`),
  );
  input.retained?.forEach((resource, index) => {
    assertGcpResource(resource, `census retained[${index}]`);
    if (resource.kind !== 'snapshot') {
      throw new Error(`census retained[${index}] must be a snapshot recovery point, not '${resource.kind}'`);
    }
  });
  input.observed.forEach((entry, index) => assertGcpResource(entry.resource, `census observed[${index}].resource`));
  const inventoryByKind = new Map<GcpWorkspaceHostCensusResourceKind, GcpWorkspaceHostInventoryEvidence>();
  for (const [index, evidence] of input.inventoryEvidence.entries()) {
    requireNonEmpty(evidence.providerEvidenceRef, `census inventoryEvidence[${index}].providerEvidenceRef`);
    if (!GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS.includes(evidence.kind)) {
      throw new Error(`census inventoryEvidence[${index}].kind is unsupported`);
    }
    if (inventoryByKind.has(evidence.kind)) {
      throw new Error(`census inventoryEvidence contains duplicate kind '${evidence.kind}'`);
    }
    inventoryByKind.set(evidence.kind, evidence);
  }
  const missingInventoryKinds = GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS.filter((kind) => !inventoryByKind.has(kind));
  if (missingInventoryKinds.length > 0) {
    throw new Error(`GCP workspace-host census inventory incomplete: ${missingInventoryKinds.join(', ')}`);
  }
  const deterministicKinds = new Set<GcpWorkspaceHostCensusResourceKind>([
    'firewall',
    'subnetwork',
    'network',
    'router',
    'nat',
  ]);
  const deterministicNames = new Map<GcpWorkspaceHostCensusResourceKind, Set<string>>();
  for (const kind of GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS) {
    const evidence = inventoryByKind.get(kind)!;
    if (deterministicKinds.has(kind)) {
      if (evidence.strategy !== 'deterministic-name' || !evidence.deterministicNames?.length) {
        throw new Error(`GCP workspace-host census '${kind}' inventory requires deterministic names`);
      }
      deterministicNames.set(
        kind,
        new Set(evidence.deterministicNames.map((name) => requireNonEmpty(name, `${kind} name`))),
      );
    } else if (evidence.strategy !== 'managed-labels') {
      throw new Error(`GCP workspace-host census '${kind}' inventory requires managed-label enumeration`);
    }
  }
  const requiredLabels = {
    [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed]: 'true',
    [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: gcpWorkspaceHostLabelValue(input.hostId),
    [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId]: gcpWorkspaceHostLabelValue(input.workspaceId),
  } as const;
  const expectedKeys = new Set(input.expected.map(resourceKey));
  const registeredKeys = new Set(input.registeredHostResources?.map(resourceKey));
  const observedByKey = new Map(input.observed.map((entry) => [resourceKey(entry.resource), entry]));
  const matchesManagedIdentity = (entry: GcpManagedWorkspaceHostResourceObservation) => {
    const kind = entry.resource.kind as GcpWorkspaceHostCensusResourceKind;
    if (deterministicKinds.has(kind)) {
      return deterministicNames.get(kind)?.has(entry.resource.providerId) === true;
    }
    return Object.entries(requiredLabels).every(([key, value]) => entry.labels[key] === value);
  };
  const matchesManagedWorkspace = (entry: GcpManagedWorkspaceHostResourceObservation) => {
    const kind = entry.resource.kind as GcpWorkspaceHostCensusResourceKind;
    return (
      !deterministicKinds.has(kind) &&
      entry.labels[GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed] === 'true' &&
      entry.labels[GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId] ===
        requiredLabels[GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId]
    );
  };
  const managed = input.observed.filter(matchesManagedIdentity);
  const labelMismatches = input.observed.filter(
    (entry) =>
      !matchesManagedIdentity(entry) &&
      (expectedKeys.has(resourceKey(entry.resource)) ||
        registeredKeys.has(resourceKey(entry.resource)) ||
        (matchesManagedWorkspace(entry) &&
          (input.registeredHostResources === undefined ||
            !entry.labels[GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]?.trim()))),
  );
  const retainedKeys = new Set(input.retained?.map(resourceKey));
  const untracked = managed.filter(
    (entry) => !expectedKeys.has(resourceKey(entry.resource)) && !retainedKeys.has(resourceKey(entry.resource)),
  );
  const missing = input.expected.filter((entry) => {
    const observed = observedByKey.get(resourceKey(entry));
    return !observed || !matchesManagedIdentity(observed);
  });
  const reaperPlan = untracked.map((entry): GcpWorkspaceHostOrphanReaperStep => {
    const firstObservedAtMs = timestamp(entry.firstObservedAt ?? entry.observedAt, 'orphan firstObservedAt');
    const notBeforeMs = firstObservedAtMs + orphanGraceMs;
    return {
      resource: { ...entry.resource },
      state: evaluatedAtMs >= notBeforeMs ? 'eligible' : 'quarantine',
      notBefore: new Date(notBeforeMs).toISOString(),
      action: 'confirm-and-delete',
      requiredLabels: { ...requiredLabels },
      preconditions: [
        'fresh-provider-read',
        'labels-still-match',
        'absent-from-controller-records',
        ...(entry.resource.kind === 'disk' ? (['durable-data-disposition'] as const) : []),
        'provider-read-delete-confirmation',
      ],
    };
  });

  return {
    controllerIndependent: true,
    inventoryComplete: true,
    clean: untracked.length === 0 && missing.length === 0 && labelMismatches.length === 0,
    evaluatedAt: input.evaluatedAt,
    inventoryEvidence: GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS.map((kind) => {
      const evidence = inventoryByKind.get(kind)!;
      return {
        ...evidence,
        ...(evidence.deterministicNames ? { deterministicNames: [...evidence.deterministicNames] } : {}),
      };
    }),
    managed: managed.map(cloneObserved),
    untracked: untracked.map(cloneObserved),
    missing: missing.map((entry) => ({ ...entry })),
    labelMismatches: labelMismatches.map(cloneObserved),
    reaperPlan,
  };
}

export const GCP_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK = {
  ref: GCP_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF,
  steps: [
    'Look up the provider operation by its deterministic request id; do not issue an uncorrelated retry.',
    'Read the resource directly from the provider and verify its exact identity and managed labels.',
    'Record the provider evidence reference and normalized observed state in a recovery record.',
    'Close the durable step only when the fresh observed state proves the attempted action completed.',
    'Otherwise resume reconciliation with the original operation and idempotency identity.',
  ],
} as const;

export type GcpWorkspaceHostAmbiguousAction = 'create' | 'update' | 'delete' | 'start' | 'stop';
export type GcpWorkspaceHostAmbiguousObservedState = 'present' | 'absent' | 'running' | 'stopped';

export interface GcpWorkspaceHostAmbiguousProviderRead {
  resource: WorkspaceHostResourceRef;
  state: GcpWorkspaceHostAmbiguousObservedState;
  observedAt: string;
  providerEvidenceRef: string;
  labels?: Readonly<Record<string, string>>;
  providerRequestId?: string;
}

export interface GcpWorkspaceHostAmbiguousOperationRecoveryInput {
  operationId: string;
  idempotencyKey: string;
  attemptedAction: GcpWorkspaceHostAmbiguousAction;
  resource: WorkspaceHostResourceRef;
  hostId: string;
  workspaceId: string;
  actorId: string;
  reason: string;
  issuedAt: string;
  maxEvidenceAgeMs: number;
  providerRead: GcpWorkspaceHostAmbiguousProviderRead;
  providerEvidence?: Readonly<Record<string, unknown>>;
}

export interface GcpWorkspaceHostAmbiguousOperationRecoveryRecord extends GcpWorkspaceHostAmbiguousOperationRecoveryInput {
  kind: 'gcp-workspace-host-ambiguous-operation-recovery';
  runbookRef: typeof GCP_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF;
  closesOperation: boolean;
  nextAction: 'mark-step-applied' | 'mark-step-destroyed' | 'resume-reconcile-with-same-idempotency-key';
}

function ambiguousActionCompleted(
  action: GcpWorkspaceHostAmbiguousAction,
  state: GcpWorkspaceHostAmbiguousObservedState,
): boolean {
  if (action === 'delete') return state === 'absent';
  if (action === 'start') return state === 'running';
  if (action === 'stop') return state === 'stopped';
  return state === 'present' || state === 'running' || state === 'stopped';
}

/** Produce the only typed evidence that may manually close an ambiguous GCP operation. */
export function createGcpWorkspaceHostAmbiguousOperationRecoveryRecord(
  input: GcpWorkspaceHostAmbiguousOperationRecoveryInput,
): GcpWorkspaceHostAmbiguousOperationRecoveryRecord {
  assertWorkspaceHostSecretIsolation(input, 'gcpSafety.ambiguousRecovery');
  requireNonEmpty(input.operationId, 'ambiguous operationId');
  requireNonEmpty(input.idempotencyKey, 'ambiguous idempotencyKey');
  requireNonEmpty(input.hostId, 'ambiguous hostId');
  requireNonEmpty(input.workspaceId, 'ambiguous workspaceId');
  requireNonEmpty(input.actorId, 'ambiguous actorId');
  requireNonEmpty(input.reason, 'ambiguous reason');
  requireNonEmpty(input.providerRead.providerEvidenceRef, 'ambiguous providerEvidenceRef');
  const issuedAtMs = timestamp(input.issuedAt, 'ambiguous issuedAt');
  const maxEvidenceAgeMs = positiveDuration(input.maxEvidenceAgeMs, 'ambiguous maxEvidenceAgeMs');
  const observedAtMs = timestamp(input.providerRead.observedAt, 'ambiguous providerRead.observedAt');
  if (observedAtMs > issuedAtMs || issuedAtMs - observedAtMs > maxEvidenceAgeMs) {
    throw new Error('Ambiguous-operation recovery requires a fresh, non-future provider read');
  }
  if (resourceKey(input.resource) !== resourceKey(input.providerRead.resource)) {
    throw new Error('Ambiguous-operation provider read does not match the attempted resource');
  }
  assertGcpResource(input.resource, 'ambiguous resource');
  if (input.providerRead.state !== 'absent') {
    const expectedLabels = {
      [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed]: 'true',
      [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: gcpWorkspaceHostLabelValue(input.hostId),
      [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId]: gcpWorkspaceHostLabelValue(input.workspaceId),
    };
    if (
      !input.providerRead.labels ||
      !Object.entries(expectedLabels).every(([key, value]) => input.providerRead.labels?.[key] === value)
    ) {
      throw new Error('Ambiguous-operation provider read lacks the exact managed host/workspace labels');
    }
  }
  const closesOperation = ambiguousActionCompleted(input.attemptedAction, input.providerRead.state);
  const nextAction = closesOperation
    ? input.attemptedAction === 'delete'
      ? 'mark-step-destroyed'
      : 'mark-step-applied'
    : 'resume-reconcile-with-same-idempotency-key';
  return {
    kind: 'gcp-workspace-host-ambiguous-operation-recovery',
    runbookRef: GCP_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF,
    ...input,
    resource: { ...input.resource },
    providerRead: {
      ...input.providerRead,
      resource: { ...input.providerRead.resource },
      ...(input.providerRead.labels ? { labels: { ...input.providerRead.labels } } : {}),
    },
    closesOperation,
    nextAction,
  };
}
