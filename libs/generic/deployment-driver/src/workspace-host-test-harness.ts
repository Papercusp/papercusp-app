import type {
  CloudCredentialRef,
  WorkspaceHostApplyResult,
  WorkspaceHostDesiredSpec,
  WorkspaceHostDestroyConfirmation,
  WorkspaceHostDiscoveryCapabilities,
  WorkspaceHostLifecycleCapabilities,
  WorkspaceHostPlan,
  WorkspaceHostPlanRequest,
  WorkspaceHostProvider,
  WorkspaceHostProviderCapabilities,
  WorkspaceHostProviderContext,
  WorkspaceHostProviderTarget,
  WorkspaceHostResourceRef,
  WorkspaceHostScopeRef,
} from "./workspace-host-types";
import {
  WORKSPACE_HOST_CANARY_TAG_KEYS,
  workspaceHostCanaryIdentityLabels,
} from "./workspace-host-canary-identity";

/** Versioned gate shared by fake-adapter conformance and live canary approval. */
export const WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION =
  "workspace-host-provider-contract-v1";
/** Owner-approved cumulative ceiling for the first real-account canary (D-020). */
export const WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS = 2_500;

export const WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS = [
  "target-and-secret-isolation",
  "connection-validation",
  "catalog-discovery",
  "price-estimate",
  "deterministic-plan",
  "idempotent-apply-reconcile",
  "observation-health-transport",
  "confirmed-destroy",
] as const;
export type WorkspaceHostProviderContractCheck =
  (typeof WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS)[number];

export class WorkspaceHostContractAssertionError extends Error {
  constructor(
    readonly check: WorkspaceHostProviderContractCheck,
    message: string,
  ) {
    super(`Workspace-host provider contract '${check}' failed: ${message}`);
    this.name = "WorkspaceHostContractAssertionError";
  }
}

const SECRET_KEY =
  /(?:^|[_-])(api[_-]?key|access[_-]?key|secret|token|password|passphrase|private[_-]?key)(?:$|[_-])/i;
const SECRET_VALUE = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;
const SECRET_POLICY_SEGMENT = /(^|[_-])secret(?=[_-](?:scan|scanning|finding|findings|policy)(?:$|[_-]))/gi;

function isSecretShapedKey(key: string): boolean {
  const normalized = key.replace(/([a-z\d])([A-Z])/g, "$1_$2");
  // `secret` also names the thing a public scanning policy detects. Mask only
  // that policy noun before applying the credential-key heuristic; any real
  // credential segment elsewhere in the key (for example secretScanToken)
  // remains visible and is still rejected.
  return SECRET_KEY.test(normalized.replace(SECRET_POLICY_SEGMENT, "$1policy_subject"));
}

/**
 * Reject secret-shaped values from artifacts that are safe to persist in a
 * plan, contract report, canary ledger, tag set, or destroy receipt. Typed
 * credential references are allowed because they carry only resolver ids.
 */
export function assertWorkspaceHostSecretIsolation(
  value: unknown,
  path = "metadata",
): void {
  const visit = (candidate: unknown, currentPath: string): void => {
    if (typeof candidate === "string") {
      if (SECRET_VALUE.test(candidate)) {
        throw new Error(
          `Secret material is forbidden in workspace-host public metadata at ${currentPath}`,
        );
      }
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) =>
        visit(entry, `${currentPath}[${index}]`),
      );
      return;
    }
    for (const [key, entry] of Object.entries(
      candidate as Record<string, unknown>,
    )) {
      if (isSecretShapedKey(key)) {
        throw new Error(
          `Secret-shaped field '${currentPath}.${key}' is forbidden in workspace-host public metadata`,
        );
      }
      visit(entry, `${currentPath}.${key}`);
    }
  };
  visit(value, path);
}

function requireContract(
  checks: WorkspaceHostProviderContractCheck[],
  check: WorkspaceHostProviderContractCheck,
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new WorkspaceHostContractAssertionError(check, message);
  if (!checks.includes(check)) checks.push(check);
}

function requireNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function requireTimestamp(value: string, label: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis))
    throw new Error(`${label} must be an ISO timestamp`);
  return millis;
}

function requireCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} must be a non-negative safe integer number of cents`,
    );
  }
}

function requireFailedRunTeardown(
  teardown: WorkspaceHostFailedRunTeardown,
): void {
  requireNonEmpty(teardown.actorId, "failedRunTeardown.actorId");
  requireNonEmpty(teardown.reason, "failedRunTeardown.reason");
  requireNonEmpty(teardown.procedureRef, "failedRunTeardown.procedureRef");
  // A teardown that names no failed operation is indistinguishable from one asserting the run
  // failed because saying so is convenient. The operation ids are what an auditor reads back.
  if (teardown.failedOperationIds.length === 0) {
    throw new Error(
      "Failed-run teardown must name at least one failed operation it cleans up after",
    );
  }
  for (const [index, operationId] of teardown.failedOperationIds.entries()) {
    requireNonEmpty(
      operationId,
      `failedRunTeardown.failedOperationIds[${index}]`,
    );
  }
}

function requireSpendSettlement(
  settlement: WorkspaceHostSpendSettlement,
): void {
  requireNonEmpty(settlement.actorId, "spendSettlement.actorId");
  requireNonEmpty(settlement.reason, "spendSettlement.reason");
  requireNonEmpty(settlement.procedureRef, "spendSettlement.procedureRef");
  // A deferral with no date is an obligation nobody can ever be shown to have missed.
  requireTimestamp(settlement.reconcileAfter, "spendSettlement.reconcileAfter");
}

function validatePlanShape(
  checks: WorkspaceHostProviderContractCheck[],
  plan: WorkspaceHostPlan,
  request: WorkspaceHostPlanRequest,
  target: WorkspaceHostProviderTarget,
): void {
  requireContract(
    checks,
    "deterministic-plan",
    plan.target === target,
    "plan target does not match provider target",
  );
  requireContract(
    checks,
    "deterministic-plan",
    plan.operationId === request.operationId,
    "plan changed operationId",
  );
  requireContract(
    checks,
    "deterministic-plan",
    plan.steps.length > 0,
    "plan must contain at least one resource step",
  );

  const seen = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const step of plan.steps) {
    requireContract(
      checks,
      "deterministic-plan",
      !!step.id.trim(),
      "step id must not be empty",
    );
    requireContract(
      checks,
      "deterministic-plan",
      !seen.has(step.id),
      `duplicate step id '${step.id}'`,
    );
    requireContract(
      checks,
      "deterministic-plan",
      !!step.idempotencyKey.trim() && !idempotencyKeys.has(step.idempotencyKey),
      `step '${step.id}' needs a unique provider idempotency key`,
    );
    for (const dependency of step.dependsOn) {
      requireContract(
        checks,
        "deterministic-plan",
        seen.has(dependency),
        `step '${step.id}' dependency '${dependency}' must be declared earlier`,
      );
    }
    seen.add(step.id);
    idempotencyKeys.add(step.idempotencyKey);
  }
}

export interface FakeWorkspaceHostProviderContractFixture {
  /** Runtime guard against accidentally driving a real provider with the fake suite. */
  adapterKind: "fake";
  reportRef: string;
  context: WorkspaceHostProviderContext;
  desired: WorkspaceHostDesiredSpec;
  operationId: string;
  idempotencyKey: string;
  confirmedBy: string;
  now?: () => string;
}

export interface WorkspaceHostProviderContractReport {
  suiteVersion: typeof WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION;
  reportRef: string;
  target: WorkspaceHostProviderTarget;
  completedAt: string;
  passed: true;
  checks: readonly WorkspaceHostProviderContractCheck[];
  provisionedResources: readonly WorkspaceHostResourceRef[];
  destroyConfirmations: readonly WorkspaceHostDestroyConfirmation[];
}

/**
 * Exercise a deterministic fake adapter through the complete shared contract.
 * Concrete provider tests supply their own in-memory fake implementation. Real
 * accounts instead go through WorkspaceHostLiveCanaryHarness below.
 */
export async function runFakeWorkspaceHostProviderContractSuite(
  provider: WorkspaceHostProvider,
  fixture: FakeWorkspaceHostProviderContractFixture,
): Promise<WorkspaceHostProviderContractReport> {
  if (fixture.adapterKind !== "fake")
    throw new Error(
      "The fake provider contract suite refuses non-fake adapters",
    );
  requireNonEmpty(fixture.reportRef, "reportRef");
  requireNonEmpty(fixture.operationId, "operationId");
  requireNonEmpty(fixture.idempotencyKey, "idempotencyKey");
  const now = fixture.now ?? (() => new Date().toISOString());
  const checks: WorkspaceHostProviderContractCheck[] = [];

  assertWorkspaceHostSecretIsolation(
    fixture.context.connection.provider,
    "context.connection.provider",
  );
  assertWorkspaceHostSecretIsolation(
    fixture.desired.provider,
    "desired.provider",
  );
  assertWorkspaceHostSecretIsolation(fixture.desired.labels, "desired.labels");
  requireContract(
    checks,
    "target-and-secret-isolation",
    provider.target === fixture.desired.target,
    "desired target mismatch",
  );
  requireContract(
    checks,
    "target-and-secret-isolation",
    fixture.context.connection.target === provider.target,
    "connection target mismatch",
  );
  requireContract(
    checks,
    "target-and-secret-isolation",
    fixture.context.connection.cloudCredentialRef.kind === "cloud" &&
      !!fixture.context.connection.cloudCredentialRef.ref.trim(),
    "cloud authorization must be a non-empty typed reference",
  );

  const validation = await provider.validateConnection(fixture.context);
  requireContract(
    checks,
    "connection-validation",
    validation.ok,
    validation.errors.join("; ") || "connection rejected",
  );
  requireContract(
    checks,
    "connection-validation",
    validation.errors.length === 0,
    "successful validation returned errors",
  );

  const query = {
    scope: fixture.desired.scope,
    region: fixture.desired.region,
  };
  const [scopes, regions, sizes, images, price] = await Promise.all([
    provider.listScopes(fixture.context),
    provider.listRegions(query, fixture.context),
    provider.listSizes(query, fixture.context),
    provider.listImages(query, fixture.context),
    provider.estimatePrice(fixture.desired, fixture.context),
  ]);
  requireContract(
    checks,
    "catalog-discovery",
    scopes.some(
      (scope) =>
        scope.kind === fixture.desired.scope.kind &&
        scope.id === fixture.desired.scope.id,
    ),
    "desired scope is absent from discovery",
  );
  requireContract(
    checks,
    "catalog-discovery",
    regions.some((region) => region.id === fixture.desired.region),
    "desired region is absent",
  );
  requireContract(
    checks,
    "catalog-discovery",
    sizes.some((size) => size.id === fixture.desired.size),
    "desired size is absent",
  );
  requireContract(
    checks,
    "catalog-discovery",
    images.some((image) => image.id === fixture.desired.image.id),
    "desired image is absent",
  );
  requireContract(
    checks,
    "price-estimate",
    Number.isFinite(price.hourlyAmount) &&
      price.hourlyAmount >= 0 &&
      !!price.currency.trim(),
    "price estimate must use a currency and a non-negative finite hourly amount",
  );

  const provisionRequest: WorkspaceHostPlanRequest = {
    action: "provision",
    operationId: fixture.operationId,
    idempotencyKey: fixture.idempotencyKey,
    desired: fixture.desired,
  };
  const [firstPlan, replayedPlan] = await Promise.all([
    provider.plan(provisionRequest, fixture.context),
    provider.plan(provisionRequest, fixture.context),
  ]);
  validatePlanShape(checks, firstPlan, provisionRequest, provider.target);
  validatePlanShape(checks, replayedPlan, provisionRequest, provider.target);
  requireContract(
    checks,
    "deterministic-plan",
    JSON.stringify(firstPlan.steps) === JSON.stringify(replayedPlan.steps),
    "replaying the same operation produced different resource steps",
  );

  const knownResources: WorkspaceHostResourceRef[] = [];
  const applyResults: WorkspaceHostApplyResult[] = [];
  for (const step of firstPlan.steps) {
    const result = await provider.apply(
      {
        planId: firstPlan.planId,
        operationId: firstPlan.operationId,
        step,
        knownResources: [...knownResources],
      },
      fixture.context,
    );
    requireContract(
      checks,
      "idempotent-apply-reconcile",
      result.operationId === firstPlan.operationId,
      "apply changed operationId",
    );
    requireContract(
      checks,
      "idempotent-apply-reconcile",
      result.stepId === step.id,
      "apply changed stepId",
    );
    requireContract(
      checks,
      "idempotent-apply-reconcile",
      result.state !== "in-progress",
      "fake apply did not settle deterministically",
    );
    if ("resource" in result && result.resource) {
      if (
        !knownResources.some(
          (resource) => resource.providerId === result.resource!.providerId,
        )
      ) {
        knownResources.push(result.resource);
      }
    }
    applyResults.push(result);
  }
  requireContract(
    checks,
    "idempotent-apply-reconcile",
    knownResources.length > 0,
    "provisioning produced no resource identities",
  );

  const firstApplied = applyResults.find(
    (result) => "resource" in result && result.resource,
  );
  requireContract(
    checks,
    "idempotent-apply-reconcile",
    firstApplied && "resource" in firstApplied,
    "no applied resource to reconcile",
  );
  const firstStep = firstPlan.steps.find(
    (step) => step.id === firstApplied.stepId,
  )!;
  const reconciled = await provider.reconcile(
    {
      planId: firstPlan.planId,
      operationId: firstPlan.operationId,
      step: firstStep,
      knownResources,
      reason: "resume",
      previousProviderRequestId: firstApplied.providerRequestId,
    },
    fixture.context,
  );
  requireContract(
    checks,
    "idempotent-apply-reconcile",
    reconciled.operationId === firstApplied.operationId,
    "reconcile changed operationId",
  );
  requireContract(
    checks,
    "idempotent-apply-reconcile",
    reconciled.stepId === firstApplied.stepId,
    "reconcile changed stepId",
  );
  if (
    "resource" in firstApplied &&
    firstApplied.resource &&
    "resource" in reconciled &&
    reconciled.resource
  ) {
    requireContract(
      checks,
      "idempotent-apply-reconcile",
      reconciled.resource.providerId === firstApplied.resource.providerId,
      "reconcile returned a different provider resource identity",
    );
  }

  const host = {
    hostId: fixture.desired.hostId,
    target: provider.target,
    resources: knownResources,
  };
  const [observation, transport, health] = await Promise.all([
    provider.observe(host, fixture.context),
    provider.getTransportProfile(host, fixture.context),
    provider.attestHealth(host, fixture.context),
  ]);
  requireContract(
    checks,
    "observation-health-transport",
    observation.host.hostId === host.hostId,
    "observation changed host identity",
  );
  requireContract(
    checks,
    "observation-health-transport",
    health.hostId === host.hostId,
    "health attestation changed host identity",
  );
  requireContract(
    checks,
    "observation-health-transport",
    !!transport.kind.trim(),
    "transport profile needs a kind",
  );
  requireContract(
    checks,
    "observation-health-transport",
    Object.values(transport.features).some(Boolean),
    "transport profile declares no supported feature",
  );

  const destroyRequest: WorkspaceHostPlanRequest = {
    action: "destroy",
    operationId: `${fixture.operationId}:destroy`,
    idempotencyKey: `${fixture.idempotencyKey}:destroy`,
    host,
    disposition: "discard",
    confirmation: {
      expectedHostId: host.hostId,
      confirmedBy: fixture.confirmedBy,
      confirmedAt: now(),
    },
  };
  const destroyPlan = await provider.plan(destroyRequest, fixture.context);
  validatePlanShape(checks, destroyPlan, destroyRequest, provider.target);
  requireContract(
    checks,
    "confirmed-destroy",
    destroyPlan.steps.some((step) => step.destructive),
    "destroy plan has no destructive step",
  );
  const destroyConfirmations: WorkspaceHostDestroyConfirmation[] = [];
  for (const step of destroyPlan.steps) {
    const result = await provider.apply(
      {
        planId: destroyPlan.planId,
        operationId: destroyPlan.operationId,
        step,
        knownResources,
      },
      fixture.context,
    );
    if (!step.destructive) continue;
    requireContract(
      checks,
      "confirmed-destroy",
      result.state === "destroyed",
      `destructive step '${step.id}' lacks absence proof`,
    );
    if (result.state === "destroyed") {
      requireContract(
        checks,
        "confirmed-destroy",
        result.confirmation.source === "provider-read",
        "destroy proof is not a fresh provider read",
      );
      requireContract(
        checks,
        "confirmed-destroy",
        knownResources.some(
          (resource) =>
            resource.providerId === result.confirmation.providerResourceId,
        ),
        `destroy proof references unknown resource '${result.confirmation.providerResourceId}'`,
      );
      destroyConfirmations.push(result.confirmation);
    }
  }
  requireContract(
    checks,
    "confirmed-destroy",
    destroyConfirmations.length > 0,
    "destroy returned no absence confirmations",
  );

  return {
    suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
    reportRef: fixture.reportRef,
    target: provider.target,
    completedAt: now(),
    passed: true,
    checks: WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS.filter((check) =>
      checks.includes(check),
    ),
    provisionedResources: knownResources,
    destroyConfirmations,
  };
}

export type WorkspaceHostInjectedFaultTiming = "before" | "after";
export type WorkspaceHostInjectedFaultClass =
  | "transient"
  | "throttled"
  | "ambiguous"
  | "terminal";
export interface WorkspaceHostInjectedFaultSpec {
  point: string;
  occurrence: number;
  timing?: WorkspaceHostInjectedFaultTiming;
  retryClass: WorkspaceHostInjectedFaultClass;
  message: string;
}
export interface WorkspaceHostFaultHistoryEntry {
  point: string;
  occurrence: number;
  timing: WorkspaceHostInjectedFaultTiming;
  triggered: boolean;
}

export class WorkspaceHostInjectedFault extends Error {
  constructor(readonly fault: Required<WorkspaceHostInjectedFaultSpec>) {
    super(fault.message);
    this.name = "WorkspaceHostInjectedFault";
  }
}

/** Deterministic before/after-success faults for ambiguous-timeout and retry tests. */
export class DeterministicWorkspaceHostFaultInjector {
  private readonly counts = new Map<string, number>();
  private readonly triggered = new Set<number>();
  private readonly entries: WorkspaceHostFaultHistoryEntry[] = [];

  constructor(
    private readonly script: readonly WorkspaceHostInjectedFaultSpec[],
  ) {
    script.forEach((fault, index) => {
      requireNonEmpty(fault.point, `fault[${index}].point`);
      if (!Number.isSafeInteger(fault.occurrence) || fault.occurrence < 1) {
        throw new Error(
          `fault[${index}].occurrence must be a positive safe integer`,
        );
      }
    });
  }

  async invoke<T>(point: string, operation: () => Promise<T> | T): Promise<T> {
    const occurrence = (this.counts.get(point) ?? 0) + 1;
    this.counts.set(point, occurrence);
    const index = this.script.findIndex(
      (fault, candidate) =>
        !this.triggered.has(candidate) &&
        fault.point === point &&
        fault.occurrence === occurrence,
    );
    const configured = index >= 0 ? this.script[index] : undefined;
    const timing = configured?.timing ?? "before";
    if (configured && timing === "before") {
      this.triggered.add(index);
      this.entries.push({ point, occurrence, timing, triggered: true });
      throw new WorkspaceHostInjectedFault({ ...configured, timing });
    }
    const result = await operation();
    if (configured) {
      this.triggered.add(index);
      this.entries.push({ point, occurrence, timing, triggered: true });
      throw new WorkspaceHostInjectedFault({ ...configured, timing });
    }
    this.entries.push({ point, occurrence, timing, triggered: false });
    return result;
  }

  history(): readonly WorkspaceHostFaultHistoryEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  untriggeredFaults(): readonly WorkspaceHostInjectedFaultSpec[] {
    return this.script.filter((_, index) => !this.triggered.has(index));
  }
}

export interface WorkspaceHostContractApproval {
  status: "approved";
  suiteVersion: typeof WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION;
  reportRef: string;
  approvedBy: string;
  approvedAt: string;
}

/**
 * AUTHORIZATION to tear down a canary host whose run FAILED (D-273, revised by D-274).
 *
 * A failed run can never produce the approved contract report a completed one does, because that
 * report IS the completion artifact of a passing canary. Demanding it anyway makes the hosts most
 * likely to need teardown exactly the ones that cannot be torn down.
 *
 * It authorizes the teardown and NOTHING else. In particular it says nothing about spend: a failed
 * run still provisioned resources and still cost money, and that money settles with the provider on
 * its own clock, exactly like a successful run's. Whether the spend is known yet is the separate
 * question `WorkspaceHostSpendSettlement` answers — D-273 let this type stand in for that one, and
 * D-274 separated them.
 *
 * It is also deliberately NOT the same hatch as an emergency manual destroy, which waives the LABEL
 * requirement for a host provisioned before the canary tag contract existed. Identity — the
 * immutable canary labels and the controller-independent census — is waived by neither, because it
 * is what proves the resources being deleted are ours.
 */
export interface WorkspaceHostFailedRunTeardown {
  actorId: string;
  reason: string;
  procedureRef: string;
  /** The failed operation(s) this teardown cleans up after; at least one. */
  failedOperationIds: readonly string[];
}

/**
 * SETTLEMENT — has the provider's billing for this run settled at the moment of teardown? (D-274)
 *
 * Orthogonal to authorization: any of the four combinations can occur, including a failed-run
 * teardown whose spend HAS since settled because the host was retired days later.
 *
 * Supplying this means the spend is genuinely not knowable yet. `lateObservedSpend` is BY
 * DEFINITION "learned after the initial settle", so at the moment teardown is wanted it cannot
 * exist — and provider billing lags hours, so for a short-lived canary neither can the settled
 * cumulative cost. Requiring them regardless is not a gate but an outage of the delete path.
 *
 * This does not waive the spend ceiling — deleting sooner reduces spend, not increases it — and it
 * does not drop the accounting: it records a dated obligation to reconcile against the persisted
 * cost signal, which survives teardown on the discarded host row.
 */
export interface WorkspaceHostSpendSettlement {
  status: "deferred";
  actorId: string;
  reason: string;
  procedureRef: string;
  /** When the provider's billing is expected to have settled, so the obligation can be chased. */
  reconcileAfter: string;
}

interface WorkspaceHostLiveCanarySpecBase {
  runId: string;
  workspaceId: string;
  target: WorkspaceHostProviderTarget;
  scope: WorkspaceHostScopeRef;
  cloudCredentialRef: CloudCredentialRef;
  /** May be lower than D-020's cap, never higher. Defaults to USD 25. */
  maxSpendCents?: number;
  teardownDeadlineAt: string;
  /**
   * Present when provider billing has NOT settled yet (D-274). Orthogonal to the authorization
   * below — either authorization may carry it. Its only effect on the ledger is to mark the
   * completion receipt's spend as provisional; it never relaxes the spend ceiling.
   */
  spendSettlement?: WorkspaceHostSpendSettlement;
}

/**
 * A canary ledger is authorized either by an approved provider-contract report — the normal path,
 * and the one that gates live provider WORK — or by an audited failed-run teardown, which is
 * teardown-only. The two are mutually exclusive by construction so neither can be supplied as a
 * stand-in for the other.
 */
export type WorkspaceHostLiveCanarySpec =
  | (WorkspaceHostLiveCanarySpecBase & {
      contractApproval: WorkspaceHostContractApproval;
      failedRunTeardown?: undefined;
    })
  | (WorkspaceHostLiveCanarySpecBase & {
      contractApproval?: undefined;
      failedRunTeardown: WorkspaceHostFailedRunTeardown;
    });

export interface WorkspaceHostCanarySpendReservation {
  id: string;
  purpose: string;
  cents: number;
  reservedAt: string;
}
export interface WorkspaceHostCanaryCostEvidence {
  reservationId?: string;
  cents: number;
  observedAt: string;
  providerEvidenceRef: string;
}

/**
 * One cumulative provider billing snapshot, preserving the provider's exact integer-micros
 * accounting separately from the conservative integer-cents value used by safety gates.
 *
 * Micros are canonical decimal strings because these observations are persisted in JSON and can
 * exceed JavaScript's safe-integer range. Credits retain the provider convention of being zero or
 * negative; therefore `netMicros` must equal `grossMicros + creditMicros` exactly.
 */
export interface WorkspaceHostSpendObservationInput {
  readonly currency: string;
  readonly grossMicros: string;
  readonly creditMicros: string;
  readonly netMicros: string;
  readonly observedAt: string;
  readonly providerEvidenceRef: string;
}

export interface WorkspaceHostSpendObservation extends WorkspaceHostSpendObservationInput {
  /** Upward-rounded gross charge exposure for the existing integer-cents budget gates. */
  readonly budgetCents: number;
}

export type WorkspaceHostSpendFinality =
  | {
      readonly status: "pending";
      readonly retryable: true;
      readonly reason:
        | "no-observations"
        | "insufficient-observations"
        | "unstable"
        | "stability-window-open";
      readonly observationCount: number;
      readonly stableObservationCount: number;
      readonly stableForMs: number;
      readonly requiredStableWindowMs: number;
    }
  | {
      readonly status: "settled";
      readonly retryable: false;
      readonly observationCount: number;
      readonly stableObservationCount: number;
      readonly stableSince: string;
      readonly stableForMs: number;
      readonly requiredStableWindowMs: number;
      readonly observation: WorkspaceHostSpendObservation;
    };

const MICROS_PER_CENT = 10_000n;
const CANONICAL_INTEGER_MICROS = /^(?:0|[1-9]\d*|-[1-9]\d*)$/;

function requireCanonicalMicros(value: string, label: string): bigint {
  if (!CANONICAL_INTEGER_MICROS.test(value)) {
    throw new Error(
      `${label} must be a canonical integer-micros decimal string`,
    );
  }
  return BigInt(value);
}

/** Validate and normalize one exact cumulative spend snapshot. */
export function createWorkspaceHostSpendObservation(
  input: WorkspaceHostSpendObservationInput,
): WorkspaceHostSpendObservation {
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error("spend observation currency must be an ISO-4217 code");
  }
  const grossMicros = requireCanonicalMicros(
    input.grossMicros,
    "spend observation grossMicros",
  );
  const creditMicros = requireCanonicalMicros(
    input.creditMicros,
    "spend observation creditMicros",
  );
  const netMicros = requireCanonicalMicros(
    input.netMicros,
    "spend observation netMicros",
  );
  if (grossMicros < 0n) {
    throw new Error("spend observation grossMicros must not be negative");
  }
  if (creditMicros > 0n) {
    throw new Error("spend observation creditMicros must not be positive");
  }
  if (grossMicros + creditMicros !== netMicros) {
    throw new Error(
      "spend observation netMicros must equal grossMicros + creditMicros",
    );
  }
  requireTimestamp(input.observedAt, "spend observation observedAt");
  requireNonEmpty(
    input.providerEvidenceRef,
    "spend observation providerEvidenceRef",
  );
  const budgetCents = (grossMicros + MICROS_PER_CENT - 1n) / MICROS_PER_CENT;
  if (budgetCents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      "spend observation grossMicros exceeds the safe integer-cents budget range",
    );
  }
  return {
    ...input,
    budgetCents: Number(budgetCents),
  };
}

function sameWorkspaceHostSpend(
  left: WorkspaceHostSpendObservation,
  right: WorkspaceHostSpendObservation,
): boolean {
  return (
    left.currency === right.currency &&
    left.grossMicros === right.grossMicros &&
    left.creditMicros === right.creditMicros &&
    left.netMicros === right.netMicros &&
    left.budgetCents === right.budgetCents
  );
}

function validateWorkspaceHostSpendHistory(
  history: readonly WorkspaceHostSpendObservation[],
): WorkspaceHostSpendObservation[] {
  const validated: WorkspaceHostSpendObservation[] = [];
  const evidenceRefs = new Set<string>();
  for (const entry of history) {
    const rebuilt = createWorkspaceHostSpendObservation(entry);
    if (rebuilt.budgetCents !== entry.budgetCents) {
      throw new Error(
        "spend observation budgetCents must equal upward-rounded grossMicros",
      );
    }
    const previous = validated.at(-1);
    if (previous) {
      if (entry.currency !== previous.currency) {
        throw new Error("spend observation history cannot mix currencies");
      }
      if (Date.parse(entry.observedAt) <= Date.parse(previous.observedAt)) {
        throw new Error(
          "spend observation history timestamps must increase strictly",
        );
      }
    }
    if (evidenceRefs.has(entry.providerEvidenceRef)) {
      throw new Error(
        "spend observation history contains a duplicate providerEvidenceRef",
      );
    }
    evidenceRefs.add(entry.providerEvidenceRef);
    validated.push({ ...entry });
  }
  return validated;
}

/**
 * Append a provider snapshot without ever rewriting prior history. An exact retry carrying the
 * same evidence ref is idempotent; a conflicting reuse of that ref is rejected.
 */
export function appendWorkspaceHostSpendObservation(
  history: readonly WorkspaceHostSpendObservation[],
  input: WorkspaceHostSpendObservationInput,
): readonly WorkspaceHostSpendObservation[] {
  const validated = validateWorkspaceHostSpendHistory(history);
  const observation = createWorkspaceHostSpendObservation(input);
  const existing = validated.find(
    (entry) => entry.providerEvidenceRef === observation.providerEvidenceRef,
  );
  if (existing) {
    if (
      existing.observedAt === observation.observedAt &&
      sameWorkspaceHostSpend(existing, observation)
    ) {
      return validated;
    }
    throw new Error(
      "spend observation providerEvidenceRef conflicts with prior history",
    );
  }
  const previous = validated.at(-1);
  if (previous) {
    if (observation.currency !== previous.currency) {
      throw new Error("spend observation history cannot mix currencies");
    }
    if (Date.parse(observation.observedAt) <= Date.parse(previous.observedAt)) {
      throw new Error(
        "spend observation history timestamps must increase strictly",
      );
    }
  }
  return [...validated, observation];
}

/**
 * A cumulative bill is final only after at least two identical trailing snapshots span the
 * caller's positive stability window. Empty, changed, or merely recent readings remain explicit
 * retryable states; none of them are interpreted as zero.
 */
export function evaluateWorkspaceHostSpendFinality(
  history: readonly WorkspaceHostSpendObservation[],
  requiredStableWindowMs: number,
): WorkspaceHostSpendFinality {
  if (
    !Number.isSafeInteger(requiredStableWindowMs) ||
    requiredStableWindowMs <= 0
  ) {
    throw new Error("requiredStableWindowMs must be a positive safe integer");
  }
  const validated = validateWorkspaceHostSpendHistory(history);
  if (validated.length === 0) {
    return {
      status: "pending",
      retryable: true,
      reason: "no-observations",
      observationCount: 0,
      stableObservationCount: 0,
      stableForMs: 0,
      requiredStableWindowMs,
    };
  }
  const latest = validated[validated.length - 1]!;
  let stableStartIndex = validated.length - 1;
  while (
    stableStartIndex > 0 &&
    sameWorkspaceHostSpend(validated[stableStartIndex - 1]!, latest)
  ) {
    stableStartIndex -= 1;
  }
  const stableObservationCount = validated.length - stableStartIndex;
  const stableSince = validated[stableStartIndex]!.observedAt;
  const stableForMs = Date.parse(latest.observedAt) - Date.parse(stableSince);
  if (stableObservationCount < 2) {
    return {
      status: "pending",
      retryable: true,
      reason: validated.length === 1 ? "insufficient-observations" : "unstable",
      observationCount: validated.length,
      stableObservationCount,
      stableForMs,
      requiredStableWindowMs,
    };
  }
  if (stableForMs < requiredStableWindowMs) {
    return {
      status: "pending",
      retryable: true,
      reason: "stability-window-open",
      observationCount: validated.length,
      stableObservationCount,
      stableForMs,
      requiredStableWindowMs,
    };
  }
  return {
    status: "settled",
    retryable: false,
    observationCount: validated.length,
    stableObservationCount,
    stableSince,
    stableForMs,
    requiredStableWindowMs,
    observation: { ...latest },
  };
}
export interface WorkspaceHostCanaryResource {
  resource: WorkspaceHostResourceRef;
  tags: Readonly<Record<string, string>>;
  createdAt: string;
  deletionConfirmation?: WorkspaceHostDestroyConfirmation;
}
export interface WorkspaceHostObservedCanaryResource {
  resource: WorkspaceHostResourceRef;
  tags: Readonly<Record<string, string>>;
}
export interface WorkspaceHostCanaryOrphanCensus {
  clean: boolean;
  observedTagged: readonly WorkspaceHostObservedCanaryResource[];
  untracked: readonly WorkspaceHostObservedCanaryResource[];
  stillLive: readonly WorkspaceHostCanaryResource[];
  missingWithoutReceipt: readonly WorkspaceHostCanaryResource[];
}
export interface WorkspaceHostTeardownWatchdogStatus {
  deadlineAt: string;
  overdue: boolean;
  pending: readonly WorkspaceHostCanaryResource[];
}
export interface WorkspaceHostManualDestroyReceipt {
  kind: "workspace-host-emergency-manual-destroy";
  runId: string;
  resource: WorkspaceHostResourceRef;
  actorId: string;
  reason: string;
  procedureRef: string;
  issuedAt: string;
  confirmation: WorkspaceHostDestroyConfirmation;
  providerEvidence?: Readonly<Record<string, unknown>>;
}
interface WorkspaceHostCanaryCompletionReceiptBase {
  runId: string;
  target: WorkspaceHostProviderTarget;
  completedAt: string;
  /**
   * What the ledger observed. ⚠ When `spendSettlement` is present this is PROVISIONAL — provider
   * billing had not settled when the host was torn down, so the real cost is higher and arrives
   * later. A reader must not report it as the final cost without checking that field.
   */
  spentCents: number;
  maxSpendCents: number;
  resourceCount: number;
  costEvidence: readonly WorkspaceHostCanaryCostEvidence[];
  /**
   * Present when the spend was unsettled at teardown (D-274): carries the dated obligation to
   * reconcile this receipt against the provider's later billing.
   */
  spendSettlement?: WorkspaceHostSpendSettlement;
}

/**
 * Mirrors the ledger's authorization. A completed run cites its approved contract report; a
 * failed-run teardown cites the audited procedure instead and says so, so no reader of a persisted
 * receipt can mistake one for the other.
 */
export type WorkspaceHostCanaryCompletionReceipt =
  | (WorkspaceHostCanaryCompletionReceiptBase & {
      contractReportRef: string;
      failedRunTeardown?: undefined;
    })
  | (WorkspaceHostCanaryCompletionReceiptBase & {
      contractReportRef?: undefined;
      failedRunTeardown: WorkspaceHostFailedRunTeardown;
    });

function sameResource(
  a: WorkspaceHostResourceRef,
  b: WorkspaceHostResourceRef,
): boolean {
  return (
    a.target === b.target && a.kind === b.kind && a.providerId === b.providerId
  );
}

export function createWorkspaceHostManualDestroyReceipt(
  input: Omit<WorkspaceHostManualDestroyReceipt, "kind">,
): WorkspaceHostManualDestroyReceipt {
  requireNonEmpty(input.runId, "manual destroy runId");
  requireNonEmpty(input.actorId, "manual destroy actorId");
  requireNonEmpty(input.reason, "manual destroy reason");
  requireNonEmpty(input.procedureRef, "manual destroy procedureRef");
  requireTimestamp(input.issuedAt, "manual destroy issuedAt");
  if (input.confirmation.source !== "provider-read") {
    throw new Error(
      "Emergency manual destroy requires a fresh provider-read absence confirmation",
    );
  }
  if (input.confirmation.providerResourceId !== input.resource.providerId) {
    throw new Error(
      "Emergency manual destroy confirmation does not match the resource",
    );
  }
  assertWorkspaceHostSecretIsolation(
    input.providerEvidence,
    "manualDestroy.providerEvidence",
  );
  return { kind: "workspace-host-emergency-manual-destroy", ...input };
}

/**
 * Fail-closed ledger around real provider calls. It owns no provider client and
 * no secret bytes: callers must reserve spend before a mutation, attach the
 * required run tags to every created resource, and close with provider-read
 * absence plus cost evidence.
 */
export class WorkspaceHostLiveCanaryHarness {
  readonly maxSpendCents: number;
  private readonly reservations = new Map<
    string,
    WorkspaceHostCanarySpendReservation
  >();
  private readonly costs: WorkspaceHostCanaryCostEvidence[] = [];
  private readonly resources: WorkspaceHostCanaryResource[] = [];

  constructor(
    readonly spec: WorkspaceHostLiveCanarySpec,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    requireNonEmpty(spec.runId, "canary runId");
    requireNonEmpty(spec.workspaceId, "canary workspaceId");
    requireNonEmpty(spec.target, "canary target");
    requireNonEmpty(spec.scope.kind, "canary scope.kind");
    requireNonEmpty(spec.scope.id, "canary scope.id");
    if (
      spec.cloudCredentialRef.kind !== "cloud" ||
      !spec.cloudCredentialRef.ref.trim()
    ) {
      throw new Error(
        "Live canary requires a non-empty typed cloudCredentialRef",
      );
    }
    if (spec.spendSettlement) requireSpendSettlement(spec.spendSettlement);
    if (spec.failedRunTeardown) {
      // Teardown-only authorization: it stands in for the approved contract report a failed run can
      // never produce, never for provider work. Nothing below this branch creates or mutates a
      // resource. It says nothing about spend — that is spendSettlement's question (D-274).
      requireFailedRunTeardown(spec.failedRunTeardown);
    } else {
      const approval = spec.contractApproval;
      if (
        !approval ||
        approval.status !== "approved" ||
        approval.suiteVersion !== WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION ||
        !approval.reportRef?.trim() ||
        !approval.approvedBy?.trim()
      ) {
        throw new Error(
          "Live provider work is blocked until the current fake-provider contract report is approved",
        );
      }
      requireTimestamp(approval.approvedAt, "contractApproval.approvedAt");
    }
    requireTimestamp(spec.teardownDeadlineAt, "teardownDeadlineAt");
    this.maxSpendCents =
      spec.maxSpendCents ?? WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS;
    requireCents(this.maxSpendCents, "maxSpendCents");
    if (
      this.maxSpendCents === 0 ||
      this.maxSpendCents > WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS
    ) {
      throw new Error(
        `Live canary maxSpendCents must be between 1 and ${WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS}`,
      );
    }
    assertWorkspaceHostSecretIsolation(spec.scope, "canary.scope");
  }

  tags(
    extra: Readonly<Record<string, string>> = {},
  ): Readonly<Record<string, string>> {
    assertWorkspaceHostSecretIsolation(extra, "canary.tags");
    // Same synthesizer the provision route uses, so a fake-provider host and a real one carry
    // byte-identical identity labels and the destroy gate cannot be satisfied here in a way the
    // product path could not reproduce.
    const required = workspaceHostCanaryIdentityLabels({
      runId: this.spec.runId,
      workspaceId: this.spec.workspaceId,
    });
    for (const key of Object.keys(required)) {
      if (key in extra && extra[key] !== required[key])
        throw new Error(`Canary tag '${key}' cannot be overridden`);
    }
    return { ...extra, ...required };
  }

  private nowMillis(): number {
    return requireTimestamp(this.clock(), "canary clock");
  }

  private spentCents(): number {
    return this.costs.reduce((total, entry) => total + entry.cents, 0);
  }

  private reservedCents(): number {
    return [...this.reservations.values()].reduce(
      (total, entry) => total + entry.cents,
      0,
    );
  }

  assertCanStartProviderWork(): void {
    if (
      this.nowMillis() >=
      requireTimestamp(this.spec.teardownDeadlineAt, "teardownDeadlineAt")
    ) {
      throw new Error(
        "Live canary teardown deadline has passed; provider mutations are blocked",
      );
    }
    if (this.spentCents() > this.maxSpendCents) {
      throw new Error(
        "Live canary spend ceiling has been exceeded; provider mutations are blocked",
      );
    }
  }

  reserveSpend(
    input: WorkspaceHostCanarySpendReservation,
  ): WorkspaceHostCanarySpendReservation {
    this.assertCanStartProviderWork();
    requireNonEmpty(input.id, "spend reservation id");
    requireNonEmpty(input.purpose, "spend reservation purpose");
    requireCents(input.cents, "spend reservation cents");
    requireTimestamp(input.reservedAt, "spend reservation reservedAt");
    if (input.cents === 0)
      throw new Error("Spend reservations must be positive");
    if (
      this.reservations.has(input.id) ||
      this.costs.some((entry) => entry.reservationId === input.id)
    ) {
      throw new Error(`Duplicate spend reservation '${input.id}'`);
    }
    if (
      this.spentCents() + this.reservedCents() + input.cents >
      this.maxSpendCents
    ) {
      throw new Error(
        `Live canary spend reservation '${input.id}' would exceed the ${this.maxSpendCents}-cent ceiling`,
      );
    }
    const stored = { ...input };
    this.reservations.set(stored.id, stored);
    return { ...stored };
  }

  settleSpend(
    input: WorkspaceHostCanaryCostEvidence & { reservationId: string },
  ): WorkspaceHostCanaryCostEvidence {
    const reservation = this.reservations.get(input.reservationId);
    if (!reservation)
      throw new Error(`Unknown spend reservation '${input.reservationId}'`);
    requireCents(input.cents, "settled spend cents");
    requireTimestamp(input.observedAt, "settled spend observedAt");
    requireNonEmpty(
      input.providerEvidenceRef,
      "settled spend providerEvidenceRef",
    );
    this.reservations.delete(input.reservationId);
    const stored = { ...input };
    this.costs.push(stored);
    return { ...stored };
  }

  /** Record passive/provider-delayed billing evidence even if it reveals an overrun. */
  recordObservedSpend(
    input: WorkspaceHostCanaryCostEvidence,
  ): WorkspaceHostCanaryCostEvidence {
    if (input.reservationId)
      throw new Error("Use settleSpend for reserved provider work");
    requireCents(input.cents, "observed spend cents");
    requireTimestamp(input.observedAt, "observed spend observedAt");
    requireNonEmpty(
      input.providerEvidenceRef,
      "observed spend providerEvidenceRef",
    );
    const stored = { ...input };
    this.costs.push(stored);
    return { ...stored };
  }

  private storeResource(
    input: WorkspaceHostCanaryResource,
    options: { admitProviderWork: boolean },
  ): WorkspaceHostCanaryResource {
    if (options.admitProviderWork) this.assertCanStartProviderWork();
    requireTimestamp(input.createdAt, "canary resource createdAt");
    if (input.resource.target !== this.spec.target)
      throw new Error("Canary resource target does not match the run target");
    const requiredTags = this.tags();
    for (const [key, value] of Object.entries(requiredTags)) {
      if (input.tags[key] !== value)
        throw new Error(
          `Canary resource is missing required tag '${key}=${value}'`,
        );
    }
    assertWorkspaceHostSecretIsolation(input.tags, "canary.resource.tags");
    if (
      this.resources.some((entry) =>
        sameResource(entry.resource, input.resource),
      )
    ) {
      throw new Error(
        `Canary resource '${input.resource.providerId}' is already registered`,
      );
    }
    const stored = { ...input, tags: { ...input.tags } };
    this.resources.push(stored);
    return { ...stored, tags: { ...stored.tags } };
  }

  registerResource(
    input: WorkspaceHostCanaryResource,
  ): WorkspaceHostCanaryResource {
    return this.storeResource(input, { admitProviderWork: true });
  }

  /**
   * Rehydrate a resource that was registered before a controller restart.
   *
   * This validates the same identity/tag contract as registerResource but deliberately does not
   * admit new provider work or re-apply the teardown deadline. Destroy must remain recoverable
   * after its deadline; treating durable-ledger replay as a new create would strand the very
   * resources the deadline exists to remove.
   */
  restoreRegisteredResource(
    input: WorkspaceHostCanaryResource,
  ): WorkspaceHostCanaryResource {
    return this.storeResource(input, { admitProviderWork: false });
  }

  confirmResourceAbsent(confirmation: WorkspaceHostDestroyConfirmation): void {
    if (confirmation.source !== "provider-read")
      throw new Error("Resource deletion requires provider-read absence proof");
    requireTimestamp(confirmation.confirmedAbsentAt, "confirmedAbsentAt");
    const record = this.resources.find(
      (entry) => entry.resource.providerId === confirmation.providerResourceId,
    );
    if (!record)
      throw new Error(
        `Destroy confirmation references unregistered resource '${confirmation.providerResourceId}'`,
      );
    record.deletionConfirmation = { ...confirmation };
  }

  recordManualDestroyReceipt(receipt: WorkspaceHostManualDestroyReceipt): void {
    if (
      receipt.kind !== "workspace-host-emergency-manual-destroy" ||
      receipt.runId !== this.spec.runId
    ) {
      throw new Error(
        "Manual destroy receipt does not belong to this canary run",
      );
    }
    const checked = createWorkspaceHostManualDestroyReceipt(receipt);
    const record = this.resources.find((entry) =>
      sameResource(entry.resource, checked.resource),
    );
    if (!record)
      throw new Error(
        `Manual destroy receipt references unregistered resource '${checked.resource.providerId}'`,
      );
    record.deletionConfirmation = { ...checked.confirmation };
  }

  teardownWatchdog(at = this.clock()): WorkspaceHostTeardownWatchdogStatus {
    const now = requireTimestamp(at, "teardown watchdog time");
    const pending = this.resources.filter(
      (entry) => !entry.deletionConfirmation,
    );
    return {
      deadlineAt: this.spec.teardownDeadlineAt,
      overdue:
        pending.length > 0 &&
        now >=
          requireTimestamp(this.spec.teardownDeadlineAt, "teardownDeadlineAt"),
      pending: pending.map((entry) => ({ ...entry, tags: { ...entry.tags } })),
    };
  }

  orphanCensus(
    observed: readonly WorkspaceHostObservedCanaryResource[],
  ): WorkspaceHostCanaryOrphanCensus {
    const tagged = observed.filter(
      (entry) =>
        entry.tags[WORKSPACE_HOST_CANARY_TAG_KEYS.runId] === this.spec.runId,
    );
    const untracked = tagged.filter(
      (entry) =>
        !this.resources.some((known) =>
          sameResource(known.resource, entry.resource),
        ),
    );
    const stillLive = this.resources.filter(
      (known) =>
        !known.deletionConfirmation &&
        tagged.some((entry) => sameResource(known.resource, entry.resource)),
    );
    const missingWithoutReceipt = this.resources.filter(
      (known) =>
        !known.deletionConfirmation &&
        !tagged.some((entry) => sameResource(known.resource, entry.resource)),
    );
    return {
      clean:
        tagged.length === 0 &&
        this.resources.every((entry) => !!entry.deletionConfirmation),
      observedTagged: tagged.map((entry) => ({
        ...entry,
        tags: { ...entry.tags },
      })),
      untracked: untracked.map((entry) => ({
        ...entry,
        tags: { ...entry.tags },
      })),
      stillLive: stillLive.map((entry) => ({
        ...entry,
        tags: { ...entry.tags },
      })),
      missingWithoutReceipt: missingWithoutReceipt.map((entry) => ({
        ...entry,
        tags: { ...entry.tags },
      })),
    };
  }

  finalize(
    observed: readonly WorkspaceHostObservedCanaryResource[],
    completedAt = this.clock(),
  ): WorkspaceHostCanaryCompletionReceipt {
    requireTimestamp(completedAt, "canary completedAt");
    if (this.reservations.size > 0)
      throw new Error(
        "Cannot finalize a canary with unsettled spend reservations",
      );
    if (this.costs.length === 0)
      throw new Error(
        "Cannot finalize a canary without provider cost evidence",
      );
    if (this.spentCents() > this.maxSpendCents)
      throw new Error(
        "Cannot finalize a canary that exceeded its hard spend ceiling",
      );
    const census = this.orphanCensus(observed);
    if (!census.clean)
      throw new Error(
        "Cannot finalize a canary until the orphan census is clean",
      );
    // A const alias, so the spec's authorization union narrows on the check below.
    const spec = this.spec;
    const authorization = spec.failedRunTeardown
      ? {
          failedRunTeardown: {
            ...spec.failedRunTeardown,
            failedOperationIds: [...spec.failedRunTeardown.failedOperationIds],
          },
        }
      : { contractReportRef: spec.contractApproval.reportRef };
    return {
      runId: spec.runId,
      target: spec.target,
      ...authorization,
      ...(spec.spendSettlement
        ? { spendSettlement: { ...spec.spendSettlement } }
        : {}),
      completedAt,
      spentCents: this.spentCents(),
      maxSpendCents: this.maxSpendCents,
      resourceCount: this.resources.length,
      costEvidence: this.costs.map((entry) => ({ ...entry })),
    };
  }
}

function notStubbed(member: keyof WorkspaceHostProvider): never {
  throw new Error(
    `Fake workspace-host provider: '${String(member)}' was called but this test did not stub it. ` +
      `Pass it to makeFakeWorkspaceHostProvider({ ${String(member)}: ... }).`,
  );
}

/**
 * Complete capabilities for a fake provider, every flag off.
 *
 * Annotated `WorkspaceHostProviderCapabilities` with NO cast on purpose: this is the single
 * place a newly-required capability field must be filled in, and until it is, the compiler
 * stops every fake built from it. The alternative — `capabilities: {}` behind
 * `as unknown as WorkspaceHostProvider` — is what let provisioning-runner.integration.test.ts
 * sit red for two days after `lifecycle.hostBootstrap` became load-bearing (WI-2144032): the
 * cast erased the one error that would have named the missing field.
 *
 * Defaults are all `false`/empty so a fake declares only the capability its test exercises,
 * and a test that needs a capability has to say so.
 */
export function fakeWorkspaceHostCapabilities(
  overrides: {
    discovery?: Partial<WorkspaceHostDiscoveryCapabilities>;
    lifecycle?: Partial<WorkspaceHostLifecycleCapabilities>;
    transportKinds?: readonly string[];
    constraints?: readonly string[];
  } = {},
): WorkspaceHostProviderCapabilities {
  return {
    discovery: {
      scopes: false,
      regions: false,
      sizes: false,
      images: false,
      priceEstimates: false,
      ...overrides.discovery,
    },
    lifecycle: {
      start: false,
      stop: false,
      restart: false,
      snapshot: false,
      restore: false,
      upgrade: false,
      repair: false,
      confirmedDestroy: false,
      hostBootstrap: false,
      ...overrides.lifecycle,
    },
    transportKinds: overrides.transportKinds ?? [],
    ...(overrides.constraints ? { constraints: overrides.constraints } : {}),
  };
}

/**
 * Build a fake provider that genuinely satisfies `WorkspaceHostProvider`, so a test never has
 * to reach for `as unknown as WorkspaceHostProvider` to get one.
 *
 * Every interface member is present. The ones a test does not supply throw when called, naming
 * themselves — a fake that is missing a method a code path reaches now fails loudly instead of
 * answering `undefined` and surfacing as an unrelated TypeError deep inside the runner.
 *
 * `Extra` carries members that are NOT on the interface (an optional capability the runner
 * probes for with `'x' in provider`, for instance) through to the return type, so those stay
 * typed at the call site rather than forcing the cast back.
 */
export function makeFakeWorkspaceHostProvider<
  Extra extends object = Record<never, never>,
>(
  parts: Partial<WorkspaceHostProvider> & Extra,
): WorkspaceHostProvider & Extra {
  const base: WorkspaceHostProvider = {
    target: "gcp",
    capabilities: fakeWorkspaceHostCapabilities(),
    validateConnection: () => notStubbed("validateConnection"),
    listScopes: () => notStubbed("listScopes"),
    listRegions: () => notStubbed("listRegions"),
    listSizes: () => notStubbed("listSizes"),
    listImages: () => notStubbed("listImages"),
    estimatePrice: () => notStubbed("estimatePrice"),
    plan: () => notStubbed("plan"),
    apply: () => notStubbed("apply"),
    observe: () => notStubbed("observe"),
    reconcile: () => notStubbed("reconcile"),
    getTransportProfile: () => notStubbed("getTransportProfile"),
    attestHealth: () => notStubbed("attestHealth"),
  };
  return { ...base, ...parts };
}
