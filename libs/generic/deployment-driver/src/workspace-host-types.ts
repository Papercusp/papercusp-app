import type { WorkspaceHostBootstrapStatusChannel } from "./workspace-host-bootstrap";

/**
 * Provider-neutral contract for durable Papercusp workspace hosts.
 *
 * This is deliberately separate from `DeploymentDriver`. A deployment frame is
 * disposable execution-plane cattle with four coarse lifecycle verbs. A
 * workspace host owns durable user data and is reconciled as a graph of
 * provider resources, so it needs discovery, planning, per-resource apply,
 * observation, repair, retained-data lifecycle operations, and confirmed
 * deletion.
 */

/** Open provider discriminator (`gcp`, `aws`, `azure`, or a future backend). */
export type WorkspaceHostProviderTarget = string;
/** Provider scope kind (`project`, `account`, `subscription`, or provider-defined). */
export type WorkspaceHostScopeKind = string;
/** Provider resource kind (`network`, `firewall`, `disk`, `vm`, or provider-defined). */
export type WorkspaceHostResourceKind = string;

/** A typed reference into a host-owned resolver. `ref` is never a secret value. */
export interface WorkspaceHostCredentialReference<
  Kind extends "cloud" | "git" | "agent",
> {
  readonly kind: Kind;
  readonly ref: string;
}
export type CloudCredentialRef = WorkspaceHostCredentialReference<"cloud">;
export type GitCredentialRef = WorkspaceHostCredentialReference<"git">;
export type AgentCredentialRef = WorkspaceHostCredentialReference<"agent">;

/** Cloud, Git, and agent authorization remain separate channels. */
export interface WorkspaceHostCredentialRefs {
  cloudCredentialRef: CloudCredentialRef;
  gitCredentialRef?: GitCredentialRef;
  agentCredentialRef?: AgentCredentialRef;
}

export interface WorkspaceHostProviderConnection {
  target: WorkspaceHostProviderTarget;
  cloudCredentialRef: CloudCredentialRef;
  scope?: WorkspaceHostScopeRef;
  /** Non-secret provider-specific connection options. */
  provider?: Record<string, unknown>;
}

export interface WorkspaceHostScopeRef {
  kind: WorkspaceHostScopeKind;
  id: string;
}
export interface WorkspaceHostScope extends WorkspaceHostScopeRef {
  label: string;
  parent?: WorkspaceHostScopeRef;
}
export interface WorkspaceHostRegion {
  id: string;
  label: string;
  available: boolean;
  zones?: readonly string[];
  constraints?: readonly string[];
}
export interface WorkspaceHostSize {
  id: string;
  label: string;
  cpuCount: number;
  memoryMiB: number;
  diskGiB?: number;
  architectures?: readonly string[];
  available: boolean;
  constraints?: readonly string[];
}
export interface WorkspaceHostImageRef {
  id: string;
  version?: string;
}
export interface WorkspaceHostImage extends WorkspaceHostImageRef {
  label: string;
  architecture?: string;
  signed: boolean;
  publishedAt?: string;
  deprecated?: boolean;
}
export interface WorkspaceHostPriceLineItem {
  kind: string;
  description: string;
  hourlyAmount: number;
}
/** Estimate only; provider billing remains authoritative. */
export interface WorkspaceHostPriceEstimate {
  currency: string;
  hourlyAmount: number;
  monthlyAmount?: number;
  observedAt: string;
  confidence: "exact" | "estimated" | "unknown";
  lineItems?: readonly WorkspaceHostPriceLineItem[];
}
export interface WorkspaceHostConnectionValidation {
  ok: boolean;
  checkedAt: string;
  identity?: string;
  warnings: readonly string[];
  errors: readonly string[];
  /**
   * Set when a FAILED validation is transport-class (the provider API was unreachable, answered
   * with a retryable status, or returned an unreadable body) rather than a settled statement that
   * the connection itself is bad. Callers must retry a `retryable` failure instead of failing the
   * operation terminally: a single dropped packet during admission is not evidence that the
   * credential, project, or scope is wrong.
   *
   * Optional and absent-means-unknown, so an existing provider that has not classified its
   * failures keeps its current terminal behaviour rather than silently becoming retryable.
   */
  retryable?: boolean;
}

export const WORKSPACE_HOST_LIFECYCLE_ACTIONS = [
  "provision",
  "start",
  "stop",
  "restart",
  "snapshot",
  "restore",
  "upgrade",
  "repair",
  "destroy",
  // Workspace initialization (create/clone/pair/import + credential binding) is a lifecycle
  // action on an already-provisioned host, so it is recorded as an operation like any other
  // rather than in a parallel ledger. Migration 955 widens the matching DB CHECK constraint.
  "initialize",
] as const;
export type WorkspaceHostLifecycleAction =
  (typeof WORKSPACE_HOST_LIFECYCLE_ACTIONS)[number];

export interface WorkspaceHostDiscoveryCapabilities {
  scopes: boolean;
  regions: boolean;
  sizes: boolean;
  images: boolean;
  priceEstimates: boolean;
}
export interface WorkspaceHostLifecycleCapabilities {
  start: boolean;
  stop: boolean;
  restart: boolean;
  snapshot: boolean;
  restore: boolean;
  upgrade: boolean;
  repair: boolean;
  /** Destroy is confirmed by a fresh provider read, never only by request acceptance. */
  confirmedDestroy: boolean;
  /**
   * The provider attaches `WorkspaceHostProviderContext.hostBootstrapScript` to a newly created
   * instance's startup metadata.
   *
   * Declared by the provider rather than inferred from its target so the controller has one
   * place to read it: rendering the bootstrap is expensive and FAILS CLOSED when the controller
   * is unconfigured, so a runner that guessed wrong would either refuse a provision that never
   * needed a bootstrap, or silently skip one that did. `false` means the provider ignores the
   * field today and its hosts must be bootstrapped some other way.
   */
  hostBootstrap: boolean;
  /**
   * The out-of-band channel this provider's hosts report bootstrap status through, and the
   * controller reads it back from (WI-10002837). Omitted means no report is rendered.
   */
  bootstrapStatusChannel?: WorkspaceHostBootstrapStatusChannel;
}
export interface WorkspaceHostProviderCapabilities {
  discovery: WorkspaceHostDiscoveryCapabilities;
  lifecycle: WorkspaceHostLifecycleCapabilities;
  transportKinds: readonly string[];
  constraints?: readonly string[];
}

export interface WorkspaceHostTransportFeatureSet {
  command: boolean;
  pty: boolean;
  tcpForward: boolean;
  fileTransfer: boolean;
  clipboard?: boolean;
}
export type WorkspaceHostTransportFeature =
  keyof WorkspaceHostTransportFeatureSet;
export type WorkspaceHostTransportTrafficClass =
  | "interactive"
  | "bulk-transfer";
export type WorkspaceHostTransportSuitability =
  | "recommended"
  | "supported"
  | "discouraged"
  | "unsupported";
export type WorkspaceHostTransportRequirementKind =
  | "client-tool"
  | "client-plugin"
  | "remote-agent"
  | "provider-permission"
  | "network";
export interface WorkspaceHostTransportRequirement {
  /** Stable key used to join provider requirements with preflight observations. */
  id: string;
  label: string;
  kind: WorkspaceHostTransportRequirementKind;
  minimumVersion?: string;
  platforms?: readonly string[];
  requiredFor: readonly WorkspaceHostTransportFeature[];
}
export type WorkspaceHostTransportLimitKind =
  | "session-duration"
  | "idle-timeout"
  | "concurrency"
  | "throughput";
export interface WorkspaceHostTransportLimits {
  sessionDurationMinutes?: number;
  idleTimeoutMinutes?: number;
  concurrentSessions?: number;
  throughputMbps?: number;
  /** Explicitly distinguishes unpublished/provider-dependent limits from unlimited service. */
  unknown: readonly WorkspaceHostTransportLimitKind[];
  notes: readonly string[];
}
export interface WorkspaceHostTransportProxyPolicy {
  mode:
    | "supported"
    | "allowlist-required"
    | "provider-dependent"
    | "unsupported";
  requiredDomains?: readonly string[];
  notes: readonly string[];
}
export interface WorkspaceHostTransportCostPolicy {
  model: "included" | "network-metered" | "provider-metered" | "third-party";
  requiredSkus?: readonly string[];
  meters: readonly string[];
  notes: readonly string[];
}
export interface WorkspaceHostTransportAuditPolicy {
  controlPlaneEvents: boolean;
  sessionMetadata: boolean;
  sessionContent: boolean;
  fileTransferEvents: boolean;
  notes: readonly string[];
}
export interface WorkspaceHostTransportHostKeyPolicy {
  initialEnrollment:
    | "verify-before-connect"
    | "provider-managed"
    | "not-applicable";
  replacement: "block-and-reverify" | "provider-managed" | "not-applicable";
  notes: readonly string[];
}
export interface WorkspaceHostTransportFallback {
  feature: WorkspaceHostTransportFeature;
  trafficClass?: WorkspaceHostTransportTrafficClass;
  strategy: "alternate-transport" | "provider-object-storage" | "unsupported";
  transportKind?: string;
  description: string;
}
export interface WorkspaceHostTransportCompatibilityContract {
  requirements: readonly WorkspaceHostTransportRequirement[];
  traffic: Readonly<
    Record<
      WorkspaceHostTransportTrafficClass,
      WorkspaceHostTransportSuitability
    >
  >;
  limits: WorkspaceHostTransportLimits;
  proxy: WorkspaceHostTransportProxyPolicy;
  cost: WorkspaceHostTransportCostPolicy;
  audit: WorkspaceHostTransportAuditPolicy;
  hostKey: WorkspaceHostTransportHostKeyPolicy;
  fallbacks: readonly WorkspaceHostTransportFallback[];
}
/** A concrete profile declares real abilities and constraints; it does not promise false SSH parity. */
export interface WorkspaceHostTransportProfile {
  kind: string;
  endpoint?: string;
  supportedClientPlatforms: readonly string[];
  features: WorkspaceHostTransportFeatureSet;
  prerequisites: readonly string[];
  constraints: readonly string[];
  reconnect: "resume" | "recreate" | "unsupported";
  sessionLimit?: number;
  throughputMbps?: number;
  audited: boolean;
  /** Structured, preflight-consumable compatibility and policy contract. */
  compatibility: WorkspaceHostTransportCompatibilityContract;
}

export interface WorkspaceHostDataPolicy {
  /** Stop/start retains this data resource; it is never implicitly ephemeral. */
  volumeGiB: number;
  encrypted: boolean;
  backupPolicyRef?: string;
}
export interface WorkspaceHostDesiredSpec {
  /** Stable Papercusp identity, distinct from any provider resource id. */
  hostId: string;
  target: WorkspaceHostProviderTarget;
  scope: WorkspaceHostScopeRef;
  region: string;
  zone?: string;
  size: string;
  image: WorkspaceHostImageRef;
  data: WorkspaceHostDataPolicy;
  credentials: WorkspaceHostCredentialRefs;
  transportPreference?: string;
  labels?: Readonly<Record<string, string>>;
  /** Non-secret provider-specific desired state. */
  provider?: Readonly<Record<string, unknown>>;
}

/** Stable identity of one external resource; persist before applying dependent steps. */
export interface WorkspaceHostResourceRef {
  target: WorkspaceHostProviderTarget;
  kind: WorkspaceHostResourceKind;
  providerId: string;
  /**
   * Provider-issued identity for this allocation, distinct from its reusable address. For
   * example, GCE assigns a fresh numeric instance id whenever a VM name is recreated.
   */
  incarnationId?: string;
  parentProviderId?: string;
  region?: string;
  zone?: string;
}
export interface WorkspaceHostRef {
  hostId: string;
  target: WorkspaceHostProviderTarget;
  resources: readonly WorkspaceHostResourceRef[];
}
export interface WorkspaceHostSnapshotRef {
  target: WorkspaceHostProviderTarget;
  providerId: string;
  hostId: string;
  createdAt?: string;
  /** Non-secret KMS/resource reference needed to consume a CMEK snapshot. */
  encryptionKeyRef?: string;
  /** Provider-side retention boundary, when the snapshot policy supplies one. */
  retainUntil?: string;
}

interface WorkspaceHostOperationBase {
  /** Stable across retries and process restarts. */
  operationId: string;
  /** Passed to provider request-id/idempotency facilities where available. */
  idempotencyKey: string;
}
export type WorkspaceHostPlanRequest =
  | (WorkspaceHostOperationBase & {
      action: "provision";
      desired: WorkspaceHostDesiredSpec;
    })
  | (WorkspaceHostOperationBase & {
      action: "start" | "stop" | "restart" | "repair";
      host: WorkspaceHostRef;
    })
  | (WorkspaceHostOperationBase & {
      action: "snapshot";
      host: WorkspaceHostRef;
      name?: string;
    })
  | (WorkspaceHostOperationBase & {
      action: "restore";
      /** Source host remains intact until the recovered host is independently verified. */
      host: WorkspaceHostRef;
      snapshot: WorkspaceHostSnapshotRef;
      /** Full desired state for a distinct replacement host and immutable boot image. */
      desired: WorkspaceHostDesiredSpec;
    })
  | (WorkspaceHostOperationBase & {
      action: "upgrade";
      host: WorkspaceHostRef;
      image: WorkspaceHostImageRef;
      rollbackImage?: WorkspaceHostImageRef;
      /**
       * The host's recorded desired spec. A provider whose upgrade launches a REPLACEMENT instance
       * (AWS: a new EC2 instance id) rebuilds its launch settings from this; a provider that
       * re-reads the live instance (GCP's recreateInput) ignores it.
       */
      desired?: WorkspaceHostDesiredSpec;
    })
  | (WorkspaceHostOperationBase & {
      action: "destroy";
      host: WorkspaceHostRef;
      disposition: "snapshot" | "backup" | "discard";
      confirmation: {
        expectedHostId: string;
        confirmedBy: string;
        confirmedAt: string;
      };
    });

/**
 * One durable-workflow unit. A step creates or mutates at most one external
 * resource; the caller persists its result before running dependent steps.
 */
export interface WorkspaceHostPlanStep {
  id: string;
  action: WorkspaceHostLifecycleAction;
  resourceKind: WorkspaceHostResourceKind;
  dependsOn: readonly string[];
  idempotencyKey: string;
  destructive: boolean;
  input: Readonly<Record<string, unknown>>;
  /**
   * Compensating apply for when this step cannot complete after its destructive predecessor
   * already applied (an upgrade's re-insert after the old VM is deleted). The controller applies
   * it in this step's place so the host is not left without what the predecessor removed.
   * Precomputed at plan time: once the predecessor has applied, the resource it describes can no
   * longer be read, so the rollback cannot be planned later.
   */
  rollback?: WorkspaceHostPlanStepRollback;
}
export interface WorkspaceHostPlanStepRollback {
  /** Distinct from the step's own key; the rollback apply may itself be replayed. */
  idempotencyKey: string;
  input: Readonly<Record<string, unknown>>;
}
export interface WorkspaceHostPlan {
  planId: string;
  operationId: string;
  target: WorkspaceHostProviderTarget;
  hostId: string;
  generatedAt: string;
  steps: readonly WorkspaceHostPlanStep[];
  warnings: readonly string[];
}
export interface WorkspaceHostApplyRequest {
  planId: string;
  operationId: string;
  step: WorkspaceHostPlanStep;
  /** Provider resources already persisted by the host workflow. */
  knownResources: readonly WorkspaceHostResourceRef[];
}
interface WorkspaceHostApplyResultBase {
  operationId: string;
  stepId: string;
  providerRequestId?: string;
  observedAt: string;
}
export type WorkspaceHostApplyResult =
  | (WorkspaceHostApplyResultBase & {
      state: "applied" | "unchanged";
      /** Newly created/observed identity to persist before dependent work. */
      resource?: WorkspaceHostResourceRef;
      snapshot?: WorkspaceHostSnapshotRef;
    })
  | (WorkspaceHostApplyResultBase & {
      state: "in-progress";
      retryAfterMs?: number;
    })
  | (WorkspaceHostApplyResultBase & {
      state: "destroyed";
      /** Valid only after a fresh provider read observes absence. */
      confirmation: WorkspaceHostDestroyConfirmation;
    });
export interface WorkspaceHostReconcileRequest extends WorkspaceHostApplyRequest {
  reason: "ambiguous-timeout" | "resume" | "drift";
  previousProviderRequestId?: string;
}
export interface WorkspaceHostDestroyConfirmation {
  hostId: string;
  providerResourceId: string;
  /** The exact provider incarnation confirmed absent, when the provider exposes one. */
  incarnationId?: string;
  confirmedAbsentAt: string;
  source: "provider-read";
  providerRequestId?: string;
}

export type WorkspaceHostLifecycleState =
  | "provisioning"
  | "running"
  | "stopped"
  | "degraded"
  | "repairing"
  | "destroying"
  | "absent";
export interface WorkspaceHostObservation {
  host: WorkspaceHostRef;
  state: WorkspaceHostLifecycleState;
  resources: readonly WorkspaceHostResourceRef[];
  image?: WorkspaceHostImageRef;
  observedAt: string;
  drift: readonly string[];
}
/**
 * One health signal.
 *
 * `ok: null` means NOT MEASURED: the probe behind this signal was never run, or this
 * provider has no way to run it. That is a THIRD outcome, distinct from both pass and
 * fail, and it must never be collapsed into a boolean. A provider that reads an optional
 * observation field as `field === true` turns "nobody measured" into "failing", and one
 * that reads it as `field === false` turns the same absence into "passing" — both are
 * confident verdicts about a measurement that does not exist, and two call sites reading
 * one unset field landed on opposite coercions here (WI-2143924: `attestHealth` reported
 * `degraded` while `observe` reported `running`, for the same healthy host).
 */
export interface WorkspaceHostHealthCheck {
  name: string;
  /** `true` = measured, passing · `false` = measured, failing · `null` = NOT MEASURED. */
  ok: boolean | null;
  detail?: string;
  /**
   * AMBER: a measured, PASSING check that is about to stop passing (for example an agent login
   * whose access token expires soon and cannot renew itself). Only meaningful with `ok: true`.
   * It deliberately does NOT change the resolved status: a caller polling for `healthy` must not
   * break because a deadline is approaching. A surface that wants amber reads this flag; when
   * the deadline passes, the producer reports `ok: false` and the status goes `degraded`.
   */
  warn?: boolean;
}
/**
 * `unknown` = the host is reachable and nothing measured has failed, but at least one
 * check was never measured — so "healthy" is not a claim the attestation is entitled to
 * make. A caller that gates on health MUST handle it explicitly: treating `unknown` as
 * healthy ships a premature success, and polling for a `healthy` the provider cannot
 * produce hangs forever.
 */
export const WORKSPACE_HOST_HEALTH_STATUSES = [
  "healthy",
  "degraded",
  "unreachable",
  "unknown",
] as const;
export type WorkspaceHostHealthStatus =
  (typeof WORKSPACE_HOST_HEALTH_STATUSES)[number];
export interface WorkspaceHostHealthAttestation {
  hostId: string;
  observedAt: string;
  status: WorkspaceHostHealthStatus;
  image?: WorkspaceHostImageRef;
  bootstrapVersion?: string;
  checks: readonly WorkspaceHostHealthCheck[];
  attestation?: string;
}

export type WorkspaceHostLogLevel = "info" | "warn" | "error";
export interface WorkspaceHostProviderContext {
  workspaceId: string;
  requestId: string;
  connection: WorkspaceHostProviderConnection;
  actorId?: string;
  signal?: AbortSignal;
  /**
   * SERVER-AUTHORED host bootstrap, rendered by the controller at plan time and attached to the
   * new instance's provider startup metadata after the durable-filesystem mount.
   *
   * It arrives on the CONTEXT rather than on the desired spec because of what the rendered script
   * contains: the release `bundleUrl`/`bundleSha256`/`signingPublicKey` trust pins AND the
   * OpenSSH public key authorized for the workspace SSH account. A caller who can name any of
   * those chooses which code the host installs and who may log into it, so a caller-supplied
   * value is an access-granting trust hole rather than a convenience. Providers therefore REFUSE
   * a `desired.provider.startupScript` outright and read this field instead — the desired spec is
   * caller-authored and durably persisted, the context is controller-authored per operation.
   *
   * Rendering here rather than persisting into `desired_spec` is also why the ~20KB script never
   * enters the stored intent: the spec keeps the small provisioning intent, and the script is
   * re-derived from the controller's own trusted release each time it is needed.
   *
   * Omitted ⇒ the instance gets the durable mount only (the pre-P-046 behaviour). Lifecycle
   * actions that create a fresh boot/runtime layer (`restore`, `upgrade`) or deliberately repair
   * startup state MUST re-render this value; ordinary start/stop/restart/snapshot actions omit it.
   */
  hostBootstrapScript?: string;
  log?: (
    level: WorkspaceHostLogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ) => void;
}
export interface WorkspaceHostCatalogQuery {
  scope: WorkspaceHostScopeRef;
  region?: string;
  architecture?: string;
}

/**
 * Provider contract for a durable workspace host. `apply` handles exactly one
 * planned step. After an ambiguous timeout, `reconcile` uses the same operation
 * and idempotency identity instead of issuing an uncorrelated retry.
 */
export interface WorkspaceHostProvider {
  readonly target: WorkspaceHostProviderTarget;
  readonly capabilities: WorkspaceHostProviderCapabilities;

  validateConnection(
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostConnectionValidation>;
  listScopes(
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostScope[]>;
  listRegions(
    query: WorkspaceHostCatalogQuery,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostRegion[]>;
  listSizes(
    query: WorkspaceHostCatalogQuery,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostSize[]>;
  listImages(
    query: WorkspaceHostCatalogQuery,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostImage[]>;
  estimatePrice(
    desired: WorkspaceHostDesiredSpec,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostPriceEstimate>;

  plan(
    request: WorkspaceHostPlanRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostPlan>;
  apply(
    request: WorkspaceHostApplyRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostApplyResult>;
  observe(
    host: WorkspaceHostRef,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostObservation>;
  reconcile(
    request: WorkspaceHostReconcileRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostApplyResult>;
  getTransportProfile(
    host: WorkspaceHostRef,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostTransportProfile>;
  attestHealth(
    host: WorkspaceHostRef,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostHealthAttestation>;
}
