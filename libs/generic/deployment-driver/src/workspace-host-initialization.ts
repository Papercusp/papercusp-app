import { createHash } from "node:crypto";

import { assertWorkspaceHostSecretIsolation } from "./workspace-host-test-harness";
import {
  resolveWorkspaceHostRequestedAgents,
  workspaceHostAgentVerificationKindIsAllowed,
  type WorkspaceHostAgentVerificationKind,
  type WorkspaceHostCanaryAgent,
} from "./workspace-host-agent-authentication";
import type {
  AgentCredentialRef,
  CloudCredentialRef,
  GitCredentialRef,
  WorkspaceHostCredentialRefs,
} from "./workspace-host-types";

/** Persisted, provider-neutral contract for work performed after host bootstrap. */
export const WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION =
  "papercusp-workspace-host-initialization-v1";

export const WORKSPACE_HOST_CREDENTIAL_CHANNELS = [
  "cloud",
  "git",
  "agent",
] as const;
export type WorkspaceHostCredentialChannel =
  (typeof WORKSPACE_HOST_CREDENTIAL_CHANNELS)[number];

export const WORKSPACE_HOST_IMPORT_UNITS = [
  "repositories",
  "files",
  "database",
  "transcripts",
  "agents",
] as const;
export type WorkspaceHostImportUnit =
  (typeof WORKSPACE_HOST_IMPORT_UNITS)[number];

export type WorkspaceHostCredentialDeliveryKind =
  | "provider-identity"
  | "forwarded-agent"
  | "short-lived-delegation"
  | "encrypted-reference";

/**
 * Public binding metadata only. The resolver named by the typed credential
 * reference delivers the actual authorization material out of band.
 */
export interface WorkspaceHostCredentialDelivery {
  kind: WorkspaceHostCredentialDeliveryKind;
  generation: number;
  audience: string;
  revocationRef: string;
  expiresAt?: string;
}

export interface WorkspaceHostCredentialDeliverySet {
  cloud: WorkspaceHostCredentialDelivery;
  git?: WorkspaceHostCredentialDelivery;
  agent?: WorkspaceHostCredentialDelivery;
}

/**
 * The provider transport declaration the credential channels depend on (D-215 point 6).
 *
 * Deliberately structural and minimal: `WorkspaceHostTransportFeatureSet` is assignable to it, so
 * a caller passes its provider's REAL transport profile features straight through
 * (`profile.transportProfile.features`) instead of transcribing a boolean into a second place.
 * The contract reads only the one feature it actually depends on.
 */
export interface WorkspaceHostDeliveryCapabilities {
  readonly fileTransfer: boolean;
}

/**
 * Channels whose credential material must be WRITTEN to the host before `bind()` can succeed.
 *
 * DERIVED, NOT DECIDED HERE. The source is `requiresDeliveredMaterial` on each family spec in
 * `workspace-host-credential-namespace`, which imports this module — so it cannot be imported back
 * without a cycle, and this is a deliberate literal copy pinned by a guard test
 * (`workspace-host-credential-namespace.test.ts`) that fails if the derived set ever differs.
 * That is rung 2 of the derived-truth ladder with its reason stated, not a hand-maintained list.
 */
export const WORKSPACE_HOST_CHANNELS_REQUIRING_FILE_DELIVERY: readonly WorkspaceHostCredentialChannel[] =
  Object.freeze(["agent", "git"] as WorkspaceHostCredentialChannel[]);

/**
 * A provider was asked to carry a channel its declared transport cannot deliver.
 *
 * Distinct from the contract's generic validation error on purpose: an API edge must be able to
 * tell "this provider structurally cannot do this" from "your request is malformed". The first is
 * not fixed by retrying with a corrected body — it needs a different provider or transport — and
 * inferring that from an error message's shape is exactly the kind of guess that rots.
 */
export class WorkspaceHostCredentialDeliveryCapabilityError extends Error {
  readonly channel: WorkspaceHostCredentialChannel;
  readonly capability = "fileTransfer" as const;

  constructor(channel: WorkspaceHostCredentialChannel) {
    super(
      `The ${channel} credential channel requires delivered material on the host, but this ` +
        `provider's transport declares fileTransfer: false. Refused at plan time: a running host ` +
        `would fail at bind with no way to distinguish a missing capability from a lost delivery.`,
    );
    this.name = "WorkspaceHostCredentialDeliveryCapabilityError";
    this.channel = channel;
  }
}

export interface WorkspaceHostPairingReference {
  readonly kind: "pairing";
  readonly ref: string;
}

export type WorkspaceHostInitializationSource =
  | { kind: "empty" }
  | {
      kind: "git";
      repositoryUrl: string;
      visibility: "public" | "private";
      destination: string;
      revision?: string;
    }
  | {
      kind: "pair";
      sourceWorkspaceId: string;
      pairingReference: WorkspaceHostPairingReference;
      /** Explicit projection exposed through the pair; never an implicit whole-workspace share. */
      include: readonly WorkspaceHostImportUnit[];
    }
  | {
      kind: "import";
      sourceWorkspaceId: string;
      sourceSnapshotRef: string;
      /** Explicit copy allowlist; omitted state remains absent on the destination. */
      include: readonly WorkspaceHostImportUnit[];
    };

export interface WorkspaceHostInitializationRequest {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  operationId: string;
  workspaceId: string;
  hostId: string;
  requestedAt: string;
  source: WorkspaceHostInitializationSource;
  credentialRefs: WorkspaceHostCredentialRefs;
  credentialDelivery: WorkspaceHostCredentialDeliverySet;
  /** Agents to initialize and verify; omission retains all-three coverage. */
  requestedAgents?: readonly WorkspaceHostCanaryAgent[];
  /** The executing provider's declared transport features; gates the delivery-bearing channels. */
  deliveryCapabilities: WorkspaceHostDeliveryCapabilities;
  /** Persistable labels only. */
  publicMetadata?: Readonly<Record<string, unknown>>;
}

export const WORKSPACE_HOST_INITIALIZATION_STEP_KINDS = [
  "create-workspace",
  "clone-repository",
  "pair-workspace",
  "import-workspace",
  "bind-credential",
  "verify-initialization",
] as const;
export type WorkspaceHostInitializationStepKind =
  (typeof WORKSPACE_HOST_INITIALIZATION_STEP_KINDS)[number];

/**
 * Capability kinds a host adapter may advertise to the initialization seam.
 *
 * The concrete remote initializer deliberately serves both the six initialization steps and
 * the four credential-lifecycle steps.  Initialization execution still receives only an
 * `WorkspaceHostInitializationStep`, but its capability manifest is allowed to describe the
 * complete wire surface so one adapter can be shared by the canary's initialization and
 * lifecycle runners.
 */
export type WorkspaceHostInitializationSupportedStepKind =
  | WorkspaceHostInitializationStepKind
  | WorkspaceHostCredentialLifecycleStepKind;

export interface WorkspaceHostInitializationStep {
  id: string;
  kind: WorkspaceHostInitializationStepKind;
  dependsOn: readonly string[];
  idempotencyKey: string;
  input: Readonly<Record<string, unknown>>;
}

export interface WorkspaceHostInitializationPlan {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  operationId: string;
  workspaceId: string;
  hostId: string;
  requestedAt: string;
  steps: readonly WorkspaceHostInitializationStep[];
  publicMetadata?: Readonly<Record<string, unknown>>;
}

export interface WorkspaceHostInitializationStepReceipt {
  stepId: string;
  status: "succeeded";
  observedAt: string;
  /** Structured, redacted evidence. Raw stdout/stderr and resolved authorization are forbidden. */
  publicEvidence?: Readonly<Record<string, unknown>>;
}

/** Host adapter seam: DBOS/provider controllers execute one persisted step at a time. */
export interface WorkspaceHostInitializationExecutor {
  execute(
    step: WorkspaceHostInitializationStep,
  ): Promise<WorkspaceHostInitializationStepReceipt>;
}

export interface WorkspaceHostInitializationHostOperationResult {
  observedAt: string;
  /** Persistable, redacted evidence only. Raw streams and resolved authorization are forbidden. */
  publicEvidence?: Readonly<Record<string, unknown>>;
}

/**
 * Concrete host adapters must declare the exact initialization operations they
 * implement. A transport kind never implies command, transfer, pairing, or
 * credential-delivery parity.
 */
/**
 * Options for the bootstrap-readiness gate. All bounded: a gate that can wait forever is a
 * different outage from the one it replaces.
 */
export interface WorkspaceHostBootstrapReadinessOptions {
  /** Total budget to wait for the host bootstrap to finish. */
  readonly timeoutMs?: number;
  /** Delay between probes. */
  readonly pollIntervalMs?: number;
  /**
   * Called after each NOT-READY probe, so the caller can write durable progress. Without this
   * the wait is indistinguishable from a hang to anyone reading the operation row — which is the
   * failure mode a silent gate would introduce in place of the one it fixes.
   */
  readonly onWaiting?: (status: WorkspaceHostBootstrapReadinessProgress) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

export interface WorkspaceHostBootstrapReadinessProgress {
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly probes: number;
}

export interface WorkspaceHostBootstrapReadinessResult {
  readonly waitedMs: number;
  readonly probes: number;
  /**
   * True when the FIRST probe already found the host ready — i.e. no waiting was needed. Lets a
   * caller distinguish "the gate was a no-op" from "the gate absorbed a real race", which is the
   * measurement that says whether this gate is still earning its place.
   */
  readonly readyImmediately: boolean;
}

export interface WorkspaceHostInitializationHostOperations {
  readonly supportedStepKinds: readonly WorkspaceHostInitializationSupportedStepKind[];
  execute(
    step: WorkspaceHostInitializationStep,
  ): Promise<WorkspaceHostInitializationHostOperationResult>;
  /**
   * OPTIONAL gate: resolve once the host's own bootstrap has finished installing the programs
   * initialization invokes.
   *
   * WHY THIS EXISTS (WI-10001677). `provision` reports success when the provider's resources
   * exist, but the host bootstrap it delivered as instance startup metadata is still RUNNING —
   * it has to mkfs the data disk, download and verify a ~2GB signed bundle, install a Node
   * runtime and then install the vendor agent CLIs, and it installs the privileged conduits near
   * the END of that work. Nothing gated the gap, so an initialization that began promptly after
   * provisioning died on its very first step with a bare
   * `exit 127 … /usr/local/bin/papercusp-workspace-host-initialize: No such file or directory`.
   *
   * That error names a MISSING FILE, so it reads as a packaging defect in the bundle — and the
   * bundle is fine and verified every time. Measured across every initialization attempt on
   * record, the two conduit-missing failures were the two SHORTEST provision→initialize gaps
   * (117s and 304s) while every attempt at 901s or later found the conduit present. A step-0
   * missing-file error is more often an UNFINISHED predecessor than a broken artifact, and this
   * gate is what makes the difference observable instead of a guess.
   *
   * Adapters that cannot probe their host simply omit it; the runner treats absence as "no gate"
   * rather than requiring every provider to implement one.
   */
  awaitBootstrapReady?(
    options?: WorkspaceHostBootstrapReadinessOptions,
  ): Promise<WorkspaceHostBootstrapReadinessResult>;
}

export interface WorkspaceHostInitializationReplayIdentity {
  idempotencyKey: string;
  /** SHA-256 over canonical step JSON; detects same-key/different-input reuse. */
  stepFingerprint: string;
}

/**
 * Durable controller seam. Implementations atomically return the prior receipt
 * for a completed identity or own and persist exactly one execution of `run`.
 */
export interface WorkspaceHostInitializationReplayStore {
  runOnce(
    identity: WorkspaceHostInitializationReplayIdentity,
    run: () => Promise<WorkspaceHostInitializationStepReceipt>,
  ): Promise<WorkspaceHostInitializationStepReceipt>;
}

export interface ReplaySafeWorkspaceHostInitializationExecutorDeps {
  operations: WorkspaceHostInitializationHostOperations;
  replayStore: WorkspaceHostInitializationReplayStore;
}

function canonicalInitializationJson(value: unknown, path: string): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    requireCondition(
      Number.isFinite(value),
      `${path} must contain finite numbers`,
    );
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry, index) =>
        canonicalInitializationJson(entry, `${path}[${index}]`),
      )
      .join(",")}]`;
  }
  requireCondition(
    typeof value === "object" && value !== undefined,
    `${path} must contain JSON-compatible values`,
  );
  const prototype = Object.getPrototypeOf(value);
  requireCondition(
    prototype === Object.prototype || prototype === null,
    `${path} must contain plain JSON objects`,
  );
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => {
      requireCondition(
        entry !== undefined,
        `${path}.${key} must not be undefined`,
      );
      return `${JSON.stringify(key)}:${canonicalInitializationJson(entry, `${path}.${key}`)}`;
    })
    .join(",")}}`;
}

/** Stable identity for replay collision detection, independent of object key order. */
export function workspaceHostInitializationStepFingerprint(
  step: Omit<WorkspaceHostInitializationStep, 'kind'> & { kind: WorkspaceHostInitializationStepKind | 'install-desktop-pack' },
): string {
  assertWorkspaceHostSecretIsolation(step, "workspaceHost.initialization.step");
  return createHash("sha256")
    .update(
      canonicalInitializationJson(step, "workspaceHost.initialization.step"),
      "utf8",
    )
    .digest("hex");
}

/**
 * Production executor for the provider-neutral plan. The durable controller
 * owns replay serialization while the host adapter owns only declared step
 * kinds; every fresh or replayed receipt crosses the same secret-safe boundary.
 */
export class ReplaySafeWorkspaceHostInitializationExecutor implements WorkspaceHostInitializationExecutor {
  private readonly operations: WorkspaceHostInitializationHostOperations;
  private readonly replayStore: WorkspaceHostInitializationReplayStore;
  private readonly supportedStepKinds: ReadonlySet<WorkspaceHostInitializationSupportedStepKind>;

  constructor(deps: ReplaySafeWorkspaceHostInitializationExecutorDeps) {
    requireCondition(
      deps.operations.supportedStepKinds.length > 0,
      "Workspace-host initialization operations must declare at least one supported step kind",
    );
    const supported = new Set<WorkspaceHostInitializationSupportedStepKind>(
      deps.operations.supportedStepKinds,
    );
    requireCondition(
      supported.size === deps.operations.supportedStepKinds.length,
      "Workspace-host initialization operations must not declare duplicate step kinds",
    );
    for (const kind of supported) {
      requireCondition(
        (
          WORKSPACE_HOST_INITIALIZATION_STEP_KINDS as readonly string[]
        ).includes(kind) ||
          (
            WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS as readonly string[]
          ).includes(kind),
        `Unsupported workspace-host initialization step kind '${kind}'`,
      );
    }
    this.operations = deps.operations;
    this.replayStore = deps.replayStore;
    this.supportedStepKinds = supported;
  }

  async execute(
    step: WorkspaceHostInitializationStep,
  ): Promise<WorkspaceHostInitializationStepReceipt> {
    requireId(step.id, "step.id");
    requireReference(step.idempotencyKey, "step.idempotencyKey");
    requireCondition(
      this.supportedStepKinds.has(step.kind),
      `Workspace-host initialization operation '${step.kind}' is not supported by this adapter`,
    );
    assertWorkspaceHostSecretIsolation(
      step,
      `workspaceHost.initialization.step.${step.id}`,
    );

    const receipt = await this.replayStore.runOnce(
      {
        idempotencyKey: step.idempotencyKey,
        stepFingerprint: workspaceHostInitializationStepFingerprint(step),
      },
      async () => {
        const result = await this.operations.execute(step);
        requireTimestamp(result.observedAt, `receipt.${step.id}.observedAt`);
        assertWorkspaceHostSecretIsolation(
          result.publicEvidence ?? {},
          `workspaceHost.initialization.receipt.${step.id}`,
        );
        return {
          stepId: step.id,
          status: "succeeded",
          observedAt: result.observedAt,
          ...(result.publicEvidence
            ? { publicEvidence: result.publicEvidence }
            : {}),
        };
      },
    );

    requireCondition(
      receipt.stepId === step.id && receipt.status === "succeeded",
      `Initialization replay for '${step.id}' returned an invalid receipt`,
    );
    requireTimestamp(receipt.observedAt, `receipt.${step.id}.observedAt`);
    assertWorkspaceHostSecretIsolation(
      receipt.publicEvidence ?? {},
      `workspaceHost.initialization.receipt.${step.id}`,
    );
    return receipt;
  }
}

type AnyCredentialRef =
  | CloudCredentialRef
  | GitCredentialRef
  | AgentCredentialRef;

interface CredentialBinding {
  channel: WorkspaceHostCredentialChannel;
  credentialRef: AnyCredentialRef;
  delivery: WorkspaceHostCredentialDelivery;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255}$/;

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function requireId(value: string, label: string): void {
  requireCondition(SAFE_ID.test(value), `${label} must be a stable identifier`);
}

function requireTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  requireCondition(
    Number.isFinite(timestamp),
    `${label} must be an ISO timestamp`,
  );
  return timestamp;
}

function requireReference(value: string, label: string): void {
  requireCondition(
    value.trim().length > 0 && value.length <= 1024 && !/[\r\n\0]/.test(value),
    `${label} must be a non-empty resolver reference`,
  );
}

function requireRelativePath(value: string, label: string): void {
  requireCondition(
    SAFE_RELATIVE_PATH.test(value) &&
      !value.startsWith("/") &&
      !value.split("/").some((part) => part === "." || part === ".."),
    `${label} must be a safe relative workspace path`,
  );
}

function requireRepositoryUrl(value: string): void {
  const scpStyle = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(
    value,
  );
  if (scpStyle) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "source.repositoryUrl must be an HTTPS, SSH, or git@ repository URL",
    );
  }
  requireCondition(
    parsed.protocol === "https:" || parsed.protocol === "ssh:",
    "source.repositoryUrl must use HTTPS or SSH",
  );
  requireCondition(
    !parsed.username && !parsed.password && !parsed.search && !parsed.hash,
    "source.repositoryUrl must not contain credentials, query parameters, or fragments",
  );
}

function validateImportSelection(
  include: readonly WorkspaceHostImportUnit[],
  label: string,
): void {
  requireCondition(
    include.length > 0,
    `${label} must explicitly select at least one unit`,
  );
  requireCondition(
    new Set(include).size === include.length,
    `${label} must not contain duplicate units`,
  );
  for (const unit of include) {
    requireCondition(
      (WORKSPACE_HOST_IMPORT_UNITS as readonly string[]).includes(unit),
      `${label} contains unsupported unit '${unit}'`,
    );
  }
}

function bindings(
  refs: WorkspaceHostCredentialRefs,
  delivery: WorkspaceHostCredentialDeliverySet,
): CredentialBinding[] {
  const result: CredentialBinding[] = [
    {
      channel: "cloud",
      credentialRef: refs.cloudCredentialRef,
      delivery: delivery.cloud,
    },
  ];
  if (refs.gitCredentialRef && delivery.git) {
    result.push({
      channel: "git",
      credentialRef: refs.gitCredentialRef,
      delivery: delivery.git,
    });
  }
  if (refs.agentCredentialRef && delivery.agent) {
    result.push({
      channel: "agent",
      credentialRef: refs.agentCredentialRef,
      delivery: delivery.agent,
    });
  }
  return result;
}

const ALLOWED_DELIVERY: Readonly<
  Record<
    WorkspaceHostCredentialChannel,
    readonly WorkspaceHostCredentialDeliveryKind[]
  >
> = {
  cloud: ["provider-identity", "short-lived-delegation", "encrypted-reference"],
  git: ["forwarded-agent", "short-lived-delegation", "encrypted-reference"],
  agent: ["forwarded-agent", "short-lived-delegation", "encrypted-reference"],
};

/**
 * Refuse, at PLAN time, any channel whose material must be written to a host the provider cannot
 * write to (D-215 point 6).
 *
 * This is what makes the `fileTransfer` capability load-bearing rather than decorative. Without it
 * the refusal happens on a RUNNING host inside `bind()`, as
 * `delivered material for family 'X' is not present on the host` — a message that cannot
 * distinguish "this provider was never able to deliver" from "delivery was attempted and lost",
 * and which has already cost a provisioned VM by the time anyone reads it.
 *
 * Applied uniformly to every lifecycle action, revocation included: if the provider could never
 * place the file, there is no artifact for a revoke to remove, and planning one would assert a
 * cleanup that never had anything to clean.
 */
function requireDeliveryCapability(
  bindings: readonly CredentialBinding[],
  capabilities: WorkspaceHostDeliveryCapabilities,
): void {
  requireCondition(
    typeof capabilities?.fileTransfer === "boolean",
    "deliveryCapabilities.fileTransfer must be declared",
  );
  if (capabilities.fileTransfer) return;
  for (const binding of bindings) {
    if (
      WORKSPACE_HOST_CHANNELS_REQUIRING_FILE_DELIVERY.includes(binding.channel)
    ) {
      throw new WorkspaceHostCredentialDeliveryCapabilityError(binding.channel);
    }
  }
}

/**
 * @param capabilities the executing provider's declared transport, or `null` for a METADATA-ONLY
 *   validation that plans no host work (a backup manifest, a request body that a planner will
 *   gate later). The parameter is required rather than optional so every call site has to say
 *   which of the two it is — an omittable capability check is the decorative boolean again.
 */
function validateCredentialSet(
  refs: WorkspaceHostCredentialRefs,
  delivery: WorkspaceHostCredentialDeliverySet,
  requestedAt: string,
  capabilities: WorkspaceHostDeliveryCapabilities | null,
): CredentialBinding[] {
  requireCondition(
    refs.cloudCredentialRef?.kind === "cloud",
    "cloudCredentialRef must be a typed cloud reference",
  );
  requireCondition(
    refs.gitCredentialRef?.kind !== "git" ? !refs.gitCredentialRef : true,
    "gitCredentialRef must be a typed Git reference",
  );
  requireCondition(
    refs.agentCredentialRef?.kind !== "agent" ? !refs.agentCredentialRef : true,
    "agentCredentialRef must be a typed agent reference",
  );
  requireCondition(
    Boolean(refs.gitCredentialRef) === Boolean(delivery.git),
    "gitCredentialRef and credentialDelivery.git must be supplied together",
  );
  requireCondition(
    Boolean(refs.agentCredentialRef) === Boolean(delivery.agent),
    "agentCredentialRef and credentialDelivery.agent must be supplied together",
  );

  const requestedAtMs = requireTimestamp(requestedAt, "requestedAt");
  const resolved = bindings(refs, delivery);
  const seenRefs = new Set<string>();
  const seenRevocationRefs = new Set<string>();
  for (const binding of resolved) {
    requireCondition(
      binding.credentialRef.kind === binding.channel,
      `${binding.channel} credential reference kind does not match its channel`,
    );
    requireReference(
      binding.credentialRef.ref,
      `${binding.channel}CredentialRef.ref`,
    );
    requireCondition(
      !seenRefs.has(binding.credentialRef.ref),
      "cloud, Git, and agent credential references must be distinct",
    );
    seenRefs.add(binding.credentialRef.ref);
    requireCondition(
      ALLOWED_DELIVERY[binding.channel].includes(binding.delivery.kind),
      `credentialDelivery.${binding.channel}.kind is not allowed for that channel`,
    );
    requireCondition(
      Number.isSafeInteger(binding.delivery.generation) &&
        binding.delivery.generation >= 1,
      `credentialDelivery.${binding.channel}.generation must be a positive safe integer`,
    );
    requireId(
      binding.delivery.audience,
      `credentialDelivery.${binding.channel}.audience`,
    );
    requireReference(
      binding.delivery.revocationRef,
      `credentialDelivery.${binding.channel}.revocationRef`,
    );
    requireCondition(
      !seenRevocationRefs.has(binding.delivery.revocationRef),
      "cloud, Git, and agent revocation references must be distinct",
    );
    seenRevocationRefs.add(binding.delivery.revocationRef);
    if (binding.delivery.kind === "short-lived-delegation") {
      requireCondition(
        typeof binding.delivery.expiresAt === "string",
        `credentialDelivery.${binding.channel}.expiresAt is required for short-lived delegation`,
      );
      requireCondition(
        requireTimestamp(
          binding.delivery.expiresAt!,
          `credentialDelivery.${binding.channel}.expiresAt`,
        ) > requestedAtMs,
        `credentialDelivery.${binding.channel}.expiresAt must be after requestedAt`,
      );
    }
  }
  if (capabilities) requireDeliveryCapability(resolved, capabilities);
  assertWorkspaceHostSecretIsolation(
    { refs, delivery },
    "workspaceHost.credentialBindings",
  );
  return resolved;
}

function validateSource(
  source: WorkspaceHostInitializationSource,
  refs: WorkspaceHostCredentialRefs,
): void {
  if (source.kind === "empty") return;
  if (source.kind === "git") {
    requireRepositoryUrl(source.repositoryUrl);
    requireRelativePath(source.destination, "source.destination");
    if (source.revision) {
      requireCondition(
        SAFE_REVISION.test(source.revision),
        "source.revision must be a safe Git revision",
      );
    }
    requireCondition(
      source.visibility !== "private" || Boolean(refs.gitCredentialRef),
      "A private repository requires gitCredentialRef",
    );
    return;
  }
  requireId(source.sourceWorkspaceId, "source.sourceWorkspaceId");
  validateImportSelection(source.include, "source.include");
  if (source.kind === "pair") {
    requireCondition(
      source.pairingReference.kind === "pairing",
      "source.pairingReference must be a typed pairing reference",
    );
    requireReference(
      source.pairingReference.ref,
      "source.pairingReference.ref",
    );
  } else {
    requireReference(source.sourceSnapshotRef, "source.sourceSnapshotRef");
  }
}

function initStep(
  request: WorkspaceHostInitializationRequest,
  id: string,
  kind: WorkspaceHostInitializationStepKind,
  dependsOn: readonly string[],
  input: Readonly<Record<string, unknown>>,
): WorkspaceHostInitializationStep {
  return {
    id,
    kind,
    dependsOn,
    idempotencyKey: `workspace-init:${request.operationId}:${id}`,
    input,
  };
}

/** Build a deterministic, persistable post-bootstrap plan. */
export function planWorkspaceHostInitialization(
  request: WorkspaceHostInitializationRequest,
): WorkspaceHostInitializationPlan {
  requireCondition(
    request.contractVersion === WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    `Unsupported workspace-host initialization contract '${request.contractVersion}'`,
  );
  requireId(request.operationId, "operationId");
  requireId(request.workspaceId, "workspaceId");
  requireId(request.hostId, "hostId");
  requireTimestamp(request.requestedAt, "requestedAt");
  validateSource(request.source, request.credentialRefs);
  const credentialBindings = validateCredentialSet(
    request.credentialRefs,
    request.credentialDelivery,
    request.requestedAt,
    request.deliveryCapabilities,
  );
  assertWorkspaceHostSecretIsolation(
    request.publicMetadata ?? {},
    "workspaceHost.initialization.publicMetadata",
  );

  const steps: WorkspaceHostInitializationStep[] = [
    initStep(request, "workspace", "create-workspace", [], {
      workspaceId: request.workspaceId,
      hostId: request.hostId,
    }),
  ];
  const bindingStepIds = credentialBindings.map(
    (binding) => `bind-${binding.channel}`,
  );
  const addBindingStep = (
    binding: CredentialBinding,
    dependsOn: readonly string[],
  ): void => {
    const id = `bind-${binding.channel}`;
    steps.push(
      initStep(request, id, "bind-credential", dependsOn, {
        channel: binding.channel,
        credentialRef: binding.credentialRef,
        delivery: binding.delivery,
      }),
    );
  };
  const privateGitBinding =
    request.source.kind === "git" && request.source.visibility === "private"
      ? credentialBindings.find((binding) => binding.channel === "git")
      : undefined;
  if (privateGitBinding) {
    addBindingStep(privateGitBinding, ["workspace"]);
  }

  let sourceStepId = "workspace";
  if (request.source.kind !== "empty") {
    const kind =
      request.source.kind === "git"
        ? "clone-repository"
        : request.source.kind === "pair"
          ? "pair-workspace"
          : "import-workspace";
    sourceStepId = "source";
    steps.push(
      initStep(
        request,
        sourceStepId,
        kind,
        privateGitBinding ? ["bind-git"] : ["workspace"],
        request.source.kind === "git" && request.source.visibility === "private"
          ? { ...request.source, credentialChannel: "git" }
          : { ...request.source },
      ),
    );
  }

  for (const binding of credentialBindings) {
    if (binding === privateGitBinding) continue;
    addBindingStep(binding, [sourceStepId]);
  }
  steps.push(
    initStep(request, "verify", "verify-initialization", bindingStepIds, {
      sourceKind: request.source.kind,
      ...(request.requestedAgents !== undefined
        ? { requestedAgents: resolveWorkspaceHostRequestedAgents(request.requestedAgents) }
        : {}),
      requiredChannels: credentialBindings.map((binding) => binding.channel),
      ...(request.source.kind === "git"
        ? {
            repository: {
              destination: request.source.destination,
              visibility: request.source.visibility,
            },
          }
        : {}),
    }),
  );

  const plan: WorkspaceHostInitializationPlan = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    hostId: request.hostId,
    requestedAt: request.requestedAt,
    steps,
    ...(request.publicMetadata
      ? { publicMetadata: request.publicMetadata }
      : {}),
  };
  assertWorkspaceHostSecretIsolation(plan, "workspaceHost.initialization.plan");
  return plan;
}

/** Execute a plan through the existing durable host controller's injected adapter seam. */
export async function executeWorkspaceHostInitialization(
  plan: WorkspaceHostInitializationPlan,
  executor: WorkspaceHostInitializationExecutor,
): Promise<readonly WorkspaceHostInitializationStepReceipt[]> {
  assertWorkspaceHostSecretIsolation(plan, "workspaceHost.initialization.plan");
  const completed = new Set<string>();
  const receipts: WorkspaceHostInitializationStepReceipt[] = [];
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      requireCondition(
        completed.has(dependency),
        `Initialization step '${step.id}' dependency '${dependency}' has not completed`,
      );
    }
    const receipt = await executor.execute(step);
    requireCondition(
      receipt.stepId === step.id && receipt.status === "succeeded",
      `Initialization step '${step.id}' returned an invalid receipt`,
    );
    requireTimestamp(receipt.observedAt, `receipt.${step.id}.observedAt`);
    assertWorkspaceHostSecretIsolation(
      receipt.publicEvidence ?? {},
      `workspaceHost.initialization.receipt.${step.id}`,
    );
    receipts.push(receipt);
    completed.add(step.id);
  }
  return receipts;
}

export interface WorkspaceHostBackupCredentialManifest {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  workspaceId: string;
  capturedAt: string;
  authorizationMaterial: "excluded";
  credentialReferences: "excluded";
  rebindRequired: readonly WorkspaceHostCredentialChannel[];
  /** Public comparison metadata only; neither reference is retained. */
  bindingState: readonly WorkspaceHostBackupCredentialBindingState[];
}

export interface WorkspaceHostBackupCredentialBindingState {
  channel: WorkspaceHostCredentialChannel;
  generation: number;
  revocationRefSha256: string;
}

/**
 * Backups remember which runtime channels must be rebound and only enough
 * one-way metadata to prove the replacement is newer. Neither resolved
 * authorization nor credential-reference locations enter the backup.
 */
export function buildWorkspaceHostBackupCredentialManifest(
  workspaceId: string,
  capturedAt: string,
  refs: WorkspaceHostCredentialRefs,
  delivery: WorkspaceHostCredentialDeliverySet,
): WorkspaceHostBackupCredentialManifest {
  requireId(workspaceId, "workspaceId");
  // Metadata-only: recording WHICH channels a restore must rebind plans no host work, and a
  // provider that cannot deliver must still be able to back up the record of what was bound.
  const current = validateCredentialSet(refs, delivery, capturedAt, null);
  const manifest: WorkspaceHostBackupCredentialManifest = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    workspaceId,
    capturedAt,
    authorizationMaterial: "excluded",
    credentialReferences: "excluded",
    rebindRequired: current.map((binding) => binding.channel),
    bindingState: current.map((binding) => ({
      channel: binding.channel,
      generation: binding.delivery.generation,
      revocationRefSha256: createHash("sha256")
        .update(binding.delivery.revocationRef, "utf8")
        .digest("hex"),
    })),
  };
  assertWorkspaceHostSecretIsolation(
    manifest,
    "workspaceHost.backupCredentialManifest",
  );
  return manifest;
}

interface WorkspaceHostCredentialLifecycleBase {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  operationId: string;
  workspaceId: string;
  hostId: string;
  requestedAt: string;
  /** The executing provider's declared transport features; gates the delivery-bearing channels. */
  deliveryCapabilities: WorkspaceHostDeliveryCapabilities;
}

/** Route-ready restore body; controller-owned ids and timestamps are added by the runner. */
export interface WorkspaceHostBackupRestoreCredentialRebindRequest {
  action: "restore-rebind";
  backup: WorkspaceHostBackupCredentialManifest;
  nextCredentialRefs: WorkspaceHostCredentialRefs;
  nextDelivery: WorkspaceHostCredentialDeliverySet;
}

export type WorkspaceHostCredentialLifecycleRequest =
  | (WorkspaceHostCredentialLifecycleBase & {
      action: "rotate";
      currentCredentialRefs: WorkspaceHostCredentialRefs;
      currentDelivery: WorkspaceHostCredentialDeliverySet;
      nextCredentialRefs: WorkspaceHostCredentialRefs;
      nextDelivery: WorkspaceHostCredentialDeliverySet;
    })
  | (WorkspaceHostCredentialLifecycleBase & {
      action: "revoke";
      currentCredentialRefs: WorkspaceHostCredentialRefs;
      currentDelivery: WorkspaceHostCredentialDeliverySet;
      channels: readonly WorkspaceHostCredentialChannel[];
    })
  | (WorkspaceHostCredentialLifecycleBase & {
      action: "reconnect";
      currentCredentialRefs: WorkspaceHostCredentialRefs;
      currentDelivery: WorkspaceHostCredentialDeliverySet;
    })
  | (WorkspaceHostCredentialLifecycleBase &
      WorkspaceHostBackupRestoreCredentialRebindRequest);

/**
 * The four lifecycle step kinds, as a RUNTIME array.
 *
 * This used to be a hand-written type union, which meant no caller could validate an inbound
 * `kind` string against it — a wire parser had to restate the four literals to check membership,
 * and a restated list is the copy that silently stops matching. The initialization step kinds
 * next door were already declared this way; this mirrors them so the remote-initializer protocol
 * can validate lifecycle steps from the same source that defines them.
 *
 * The values deliberately equal `WorkspaceHostCredentialOperation` in workspace-host-credential-
 * namespace.ts: a lifecycle step IS a request to run one credential operation, which is why
 * `WorkspaceHostCredentialResolver.executeLifecycleStep` can dispatch on `step.kind` directly.
 */
export const WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS = [
  "bind",
  "verify-bound",
  "revoke",
  "verify-revoked",
] as const;
export type WorkspaceHostCredentialLifecycleStepKind =
  (typeof WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS)[number];

export interface WorkspaceHostCredentialLifecycleStep {
  id: string;
  kind: WorkspaceHostCredentialLifecycleStepKind;
  channel: WorkspaceHostCredentialChannel;
  dependsOn: readonly string[];
  idempotencyKey: string;
  credentialRef: AnyCredentialRef;
  /** Public resolver metadata required for binding and revocation. */
  delivery: WorkspaceHostCredentialDelivery;
}

export interface WorkspaceHostCredentialLifecyclePlan {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  operationId: string;
  workspaceId: string;
  hostId: string;
  action: WorkspaceHostCredentialLifecycleRequest["action"];
  requestedAt: string;
  steps: readonly WorkspaceHostCredentialLifecycleStep[];
}

function lifecycleStep(
  request: WorkspaceHostCredentialLifecycleRequest,
  id: string,
  kind: WorkspaceHostCredentialLifecycleStepKind,
  binding: CredentialBinding,
  dependsOn: readonly string[],
): WorkspaceHostCredentialLifecycleStep {
  return {
    id,
    kind,
    channel: binding.channel,
    dependsOn,
    idempotencyKey: `workspace-credential:${request.operationId}:${id}`,
    credentialRef: binding.credentialRef,
    delivery: binding.delivery,
  };
}

function validateLifecycleBase(
  request: WorkspaceHostCredentialLifecycleRequest,
): void {
  requireCondition(
    request.contractVersion === WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    `Unsupported workspace-host initialization contract '${request.contractVersion}'`,
  );
  requireId(request.operationId, "operationId");
  requireId(request.workspaceId, "workspaceId");
  requireId(request.hostId, "hostId");
  requireTimestamp(request.requestedAt, "requestedAt");
}

function sameChannels(
  a: readonly WorkspaceHostCredentialChannel[],
  b: readonly WorkspaceHostCredentialChannel[],
): boolean {
  return a.length === b.length && a.every((channel) => b.includes(channel));
}

function validateBackupCredentialManifest(
  backup: WorkspaceHostBackupCredentialManifest,
  workspaceId: string,
): void {
  requireCondition(
    backup.contractVersion === WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION &&
      backup.workspaceId === workspaceId &&
      backup.authorizationMaterial === "excluded" &&
      backup.credentialReferences === "excluded",
    "Restore requires a matching credential-free backup manifest",
  );
  requireTimestamp(backup.capturedAt, "backup.capturedAt");
  requireCondition(
    Array.isArray(backup.bindingState) && backup.bindingState.length > 0,
    "Restore backup must include credential replacement metadata",
  );
  const channels = backup.bindingState.map((binding) => binding.channel);
  requireCondition(
    new Set(channels).size === channels.length &&
      channels.every((channel) =>
        (WORKSPACE_HOST_CREDENTIAL_CHANNELS as readonly string[]).includes(
          channel,
        ),
      ) &&
      sameChannels(backup.rebindRequired, channels),
    "Restore backup replacement metadata must cover every channel named by the manifest",
  );
  for (const binding of backup.bindingState) {
    requireCondition(
      Number.isSafeInteger(binding.generation) && binding.generation >= 1,
      `Restore backup generation for ${binding.channel} must be a positive safe integer`,
    );
    requireCondition(
      /^[a-f0-9]{64}$/.test(binding.revocationRefSha256),
      `Restore backup revocation fingerprint for ${binding.channel} must be SHA-256`,
    );
  }
}

function requireCredentialReplacements(
  label: "Rotation" | "Restore",
  previous: readonly WorkspaceHostBackupCredentialBindingState[],
  next: readonly CredentialBinding[],
): void {
  requireCondition(
    sameChannels(
      previous.map((entry) => entry.channel),
      next.map((entry) => entry.channel),
    ),
    `${label} must ${label === "Restore" ? "rebind" : "replace"} every currently bound credential channel`,
  );
  for (const replacement of next) {
    const prior = previous.find(
      (entry) => entry.channel === replacement.channel,
    )!;
    requireCondition(
      replacement.delivery.generation > prior.generation,
      `${label} generation for ${replacement.channel} must increase`,
    );
    requireCondition(
      createHash("sha256")
        .update(replacement.delivery.revocationRef, "utf8")
        .digest("hex") !== prior.revocationRefSha256,
      `${label} revocation reference for ${replacement.channel} must change`,
    );
  }
}

/**
 * Build the exact restore-rebind body accepted by the operator route. The
 * backup's one-way binding metadata is the authority for the replacement
 * checks, so callers cannot bypass them by constructing the body themselves.
 */
export function buildWorkspaceHostBackupRestoreCredentialRebindRequest(
  backup: WorkspaceHostBackupCredentialManifest,
  nextCredentialRefs: WorkspaceHostCredentialRefs,
  nextDelivery: WorkspaceHostCredentialDeliverySet,
  requestedAt: string,
): WorkspaceHostBackupRestoreCredentialRebindRequest {
  validateBackupCredentialManifest(backup, backup.workspaceId);
  // Metadata-only: this builds a request BODY. `planWorkspaceHostCredentialLifecycle` applies the
  // capability gate when that body is actually planned, which is where D-215 puts the refusal.
  const next = validateCredentialSet(
    nextCredentialRefs,
    nextDelivery,
    requestedAt,
    null,
  );
  requireCredentialReplacements("Restore", backup.bindingState, next);
  return {
    action: "restore-rebind",
    backup,
    nextCredentialRefs,
    nextDelivery,
  };
}

/**
 * Plan rotation/revocation/reconnect/restore rebinding without ever persisting
 * resolved authorization. Rotation verifies the replacement before revoking
 * the previous binding; restore starts from a reference-free backup manifest.
 */
export function planWorkspaceHostCredentialLifecycle(
  request: WorkspaceHostCredentialLifecycleRequest,
): WorkspaceHostCredentialLifecyclePlan {
  validateLifecycleBase(request);
  const steps: WorkspaceHostCredentialLifecycleStep[] = [];
  let tail: string[] = [];

  if (request.action === "rotate") {
    const current = validateCredentialSet(
      request.currentCredentialRefs,
      request.currentDelivery,
      request.requestedAt,
      request.deliveryCapabilities,
    );
    const next = validateCredentialSet(
      request.nextCredentialRefs,
      request.nextDelivery,
      request.requestedAt,
      request.deliveryCapabilities,
    );
    requireCredentialReplacements(
      "Rotation",
      current.map((binding) => ({
        channel: binding.channel,
        generation: binding.delivery.generation,
        revocationRefSha256: createHash("sha256")
          .update(binding.delivery.revocationRef, "utf8")
          .digest("hex"),
      })),
      next,
    );
    for (const replacement of next) {
      const previous = current.find(
        (entry) => entry.channel === replacement.channel,
      )!;
      const bindId = `bind-next-${replacement.channel}`;
      const verifyId = `verify-next-${replacement.channel}`;
      const revokeId = `revoke-previous-${replacement.channel}`;
      const revokedId = `verify-revoked-${replacement.channel}`;
      steps.push(lifecycleStep(request, bindId, "bind", replacement, tail));
      steps.push(
        lifecycleStep(request, verifyId, "verify-bound", replacement, [bindId]),
      );
      steps.push(
        lifecycleStep(request, revokeId, "revoke", previous, [verifyId]),
      );
      steps.push(
        lifecycleStep(request, revokedId, "verify-revoked", previous, [
          revokeId,
        ]),
      );
      tail = [revokedId];
    }
  } else if (request.action === "revoke") {
    const current = validateCredentialSet(
      request.currentCredentialRefs,
      request.currentDelivery,
      request.requestedAt,
      request.deliveryCapabilities,
    );
    requireCondition(
      request.channels.length > 0 &&
        new Set(request.channels).size === request.channels.length,
      "Revocation channels must be a non-empty unique list",
    );
    for (const channel of request.channels) {
      const binding = current.find((entry) => entry.channel === channel);
      requireCondition(binding, `Cannot revoke unbound ${channel} channel`);
      const revokeId = `revoke-${channel}`;
      const verifyId = `verify-revoked-${channel}`;
      steps.push(lifecycleStep(request, revokeId, "revoke", binding, tail));
      steps.push(
        lifecycleStep(request, verifyId, "verify-revoked", binding, [revokeId]),
      );
      tail = [verifyId];
    }
  } else {
    const refs =
      request.action === "restore-rebind"
        ? request.nextCredentialRefs
        : request.currentCredentialRefs;
    const delivery =
      request.action === "restore-rebind"
        ? request.nextDelivery
        : request.currentDelivery;
    const current = validateCredentialSet(
      refs,
      delivery,
      request.requestedAt,
      request.deliveryCapabilities,
    );
    if (request.action === "restore-rebind") {
      validateBackupCredentialManifest(request.backup, request.workspaceId);
      requireCredentialReplacements(
        "Restore",
        request.backup.bindingState,
        current,
      );
    }
    for (const binding of current) {
      const bindId = `bind-${binding.channel}`;
      const verifyId = `verify-${binding.channel}`;
      steps.push(lifecycleStep(request, bindId, "bind", binding, tail));
      steps.push(
        lifecycleStep(request, verifyId, "verify-bound", binding, [bindId]),
      );
      tail = [verifyId];
    }
  }

  const plan: WorkspaceHostCredentialLifecyclePlan = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    hostId: request.hostId,
    action: request.action,
    requestedAt: request.requestedAt,
    steps,
  };
  assertWorkspaceHostSecretIsolation(
    plan,
    "workspaceHost.credentialLifecycle.plan",
  );
  return plan;
}

export interface WorkspaceHostInitializationCanaryEvidence {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  kind: "live";
  runId: string;
  workspaceId: string;
  hostId: string;
  observedAt: string;
  repository: { visibility: "private"; cloned: true };
  channels: Readonly<
    Record<
      WorkspaceHostCredentialChannel,
      {
        bound: true;
        rotated: true;
        previousBindingRevoked: true;
        reconnected: true;
      }
    >
  >;
  /**
   * Explicit agent coverage, mirroring `WorkspaceHostAgentVerificationReport.requestedAgents`:
   * omitted on a default all-agent artifact, so existing evidence is unchanged.
   *
   * A deliberately skipped agent (D-338's Codex leg) is ABSENT from `agents` — never present and
   * passing. Keeping the declaration ON the artifact is what lets a later reader tell a scoped
   * run from a truncated one; `agents` alone cannot.
   */
  requestedAgents?: readonly WorkspaceHostCanaryAgent[];
  agents: Readonly<
    Partial<{
      // WI-10002402: the per-agent kind is NOT pinned here. Pinning claude/codex to
      // `authenticated-account` made this type unable to REPRESENT the evidence those agents
      // actually produce — claude emits `live-inference` and has no authenticated-account probe
      // at all (WI-10001689) — so real evidence was unassignable while forged-shaped evidence
      // typechecked. Which kinds are admissible is a runtime question answered from the probe
      // table by workspaceHostAgentVerificationKindIsAllowed, not a literal restated here.
      claude: { ready: true; verificationKind: WorkspaceHostAgentVerificationKind };
      codex: { ready: true; verificationKind: WorkspaceHostAgentVerificationKind };
      omp: { ready: true; verificationKind: WorkspaceHostAgentVerificationKind };
    }>
  >;
  backupRestore: {
    authorizationMaterial: "excluded";
    credentialReferences: "excluded";
    reboundChannels: readonly WorkspaceHostCredentialChannel[];
  };
}

export interface WorkspaceHostInitializationCanaryValidation {
  ok: boolean;
  errors: readonly string[];
}

/** Validate only structured, non-secret evidence from a real host canary. */
export function validateWorkspaceHostInitializationCanary(
  evidence: WorkspaceHostInitializationCanaryEvidence,
): WorkspaceHostInitializationCanaryValidation {
  const errors: string[] = [];
  try {
    assertWorkspaceHostSecretIsolation(
      evidence,
      "workspaceHost.initialization.canary",
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (
    evidence.contractVersion !== WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION
  ) {
    errors.push("canary contract version mismatch");
  }
  if (evidence.kind !== "live")
    errors.push("canary evidence must come from a live host");
  for (const [value, label] of [
    [evidence.runId, "runId"],
    [evidence.workspaceId, "workspaceId"],
    [evidence.hostId, "hostId"],
  ] as const) {
    if (!SAFE_ID.test(value))
      errors.push(`canary ${label} must be a stable identifier`);
  }
  if (!Number.isFinite(Date.parse(evidence.observedAt))) {
    errors.push("canary observedAt must be an ISO timestamp");
  }
  if (
    evidence.repository?.visibility !== "private" ||
    !evidence.repository.cloned
  ) {
    errors.push("private-repository clone did not pass");
  }
  for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
    const result = evidence.channels?.[channel];
    if (
      !result?.bound ||
      !result.rotated ||
      !result.previousBindingRevoked ||
      !result.reconnected
    ) {
      errors.push(`${channel} credential lifecycle did not pass`);
    }
  }
  // Derive coverage from the artifact's own declaration (absent => all three, so default evidence
  // validates exactly as before). A skipped agent is not validated here because it carries no
  // evidence to validate — it is never treated as having passed.
  for (const agent of resolveWorkspaceHostRequestedAgents(evidence.requestedAgents)) {
    const result = evidence.agents?.[agent];
    if (!result?.ready) errors.push(`${agent} live readiness did not pass`);
    // WI-10002402: DERIVED from the agent's probe table — see
    // workspaceHostAgentAllowedVerificationKinds.
    if (
      !workspaceHostAgentVerificationKindIsAllowed(
        agent,
        result?.verificationKind,
      )
    ) {
      errors.push(`${agent} verification kind is not allowed`);
    }
  }
  if (
    evidence.backupRestore?.authorizationMaterial !== "excluded" ||
    evidence.backupRestore?.credentialReferences !== "excluded"
  ) {
    errors.push("backup retained credential authorization or references");
  }
  if (
    !sameChannels(
      evidence.backupRestore?.reboundChannels ?? [],
      WORKSPACE_HOST_CREDENTIAL_CHANNELS,
    )
  ) {
    errors.push("restore did not rebind all credential channels");
  }
  return { ok: errors.length === 0, errors };
}
