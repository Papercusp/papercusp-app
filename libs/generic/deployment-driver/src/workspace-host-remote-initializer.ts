/**
 * The host-installed remote initializer (P-046 / WI-41711).
 *
 * WHAT WAS MISSING. The controller already knows how to reach a workspace host: it opens one
 * non-interactive OpenSSH invocation over an IAP tunnel and writes
 * `{"protocolVersion":"papercusp-gcp-iap-initialization-v4","step":<step>}` to the remote
 * program's stdin, expecting `{protocolVersion, stepId, status:"succeeded", observedAt,
 * publicEvidence?}` back on stdout. That remote program did not exist anywhere in the tree — the
 * protocol string matched only the controller-side command builder — so every initialization step
 * failed at the host and the route could only ever answer 500. This module is the other end of
 * that pipe.
 *
 * THE RESPONSE VOCABULARY IS DELIBERATELY ONE WORD. The controller's parser accepts
 * `status: "succeeded"` and nothing else, and throws on a non-zero exit. So failure is signalled
 * by EXITING NON-ZERO with a diagnostic on stderr — never by writing a `"failed"` envelope that
 * the controller would reject as a protocol violation and misreport as a malformed response. One
 * failure channel, not two that disagree about what went wrong.
 *
 * SECRET ISOLATION RUNS ON THE WAY IN AND ON THE WAY OUT. The inbound step is asserted because a
 * host should refuse to act on a request that already contains material it must never see, and
 * the outbound evidence is asserted because that is the value the controller will persist into a
 * durable receipt. The controller asserts the same thing on its side; agreeing at both ends is
 * what makes a leak a loud failure at whichever end introduced it.
 */
import {
  WORKSPACE_HOST_CREDENTIAL_CHANNELS,
  WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  WORKSPACE_HOST_INITIALIZATION_STEP_KINDS,
  type WorkspaceHostCredentialChannel,
  type WorkspaceHostCredentialLifecycleStep,
  type WorkspaceHostCredentialLifecycleStepKind,
  type WorkspaceHostInitializationCanaryEvidence,
  type WorkspaceHostInitializationStep,
  type WorkspaceHostInitializationStepKind,
} from "./workspace-host-initialization";
import {
  WORKSPACE_HOST_CANARY_AGENTS,
  resolveWorkspaceHostRequestedAgents,
  workspaceHostAgentAllowedVerificationKinds,
  workspaceHostAgentVerificationKindIsAllowed,
  type WorkspaceHostCanaryAgent,
  type WorkspaceHostAgentVerificationReport,
} from "./workspace-host-agent-authentication";
import {
  WorkspaceHostCredentialResolver,
  type WorkspaceHostCredentialEvidence,
  type WorkspaceHostCredentialOperation,
} from "./workspace-host-credential-namespace";
import { assertWorkspaceHostSecretIsolation } from "./workspace-host-test-harness";

/**
 * The wire protocol version. This is the single source of truth; the controller-side command
 * builder derives its constant from here so the two ends cannot drift apart in a way that only
 * shows up against a real host.
 */
export const WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION =
  "papercusp-gcp-iap-initialization-v4";

/**
 * Every step kind this initializer can execute: the six INITIALIZATION kinds plus the four
 * CREDENTIAL-LIFECYCLE kinds (P-046 / WI-40474, plan decision D-114).
 *
 * WHY THE LIFECYCLE KINDS HAD TO JOIN THE WIRE. `planWorkspaceHostCredentialLifecycle` and
 * `executeWorkspaceHostCredentialLifecycle` were both complete, and the host-side resolver
 * already exposed `executeLifecycleStep` — but the protocol carried only the initialization
 * kinds, so a planned rotation could not reach a host at all. That mattered beyond tidiness:
 * `validateWorkspaceHostInitializationCanary` refuses unless every credential channel shows
 * bound + rotated + previousBindingRevoked + reconnected, and the evidence builder refuses to
 * widen a false observation into `true`. So the canary was unreachable BY CONSTRUCTION until
 * lifecycle steps could be sent. This is the carriage that closes it.
 *
 * WHY THE VERSION BUMPED RATHER THAN ACCEPTING BOTH. A v1 host receiving a lifecycle kind would
 * throw `UnsupportedWorkspaceHostInitializationStepKindError` — a per-step failure that reads
 * like a broken step rather than an out-of-date host. The version check is first and total for
 * exactly this reason (see `parseWorkspaceHostRemoteInitializerRequest`): skew should announce
 * itself as skew. A host packaged before this change is expected to be replaced, not negotiated
 * with.
 */
export const WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS = [
  ...WORKSPACE_HOST_INITIALIZATION_STEP_KINDS,
  ...WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS,
  "install-desktop-pack",
] as const;
export type WorkspaceHostRemoteInitializerStepKind =
  (typeof WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS)[number];

/** Fixed argv the controller passes; the CLI refuses anything else. */
export const WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV = [
  "--protocol-version",
  WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
  "--json-stdin",
] as const;

/**
 * The wire step. Deliberately ONE envelope shape for both step families.
 *
 * A `WorkspaceHostCredentialLifecycleStep` carries `channel`/`credentialRef`/`delivery` at the
 * top level rather than inside `input`. Rather than teach the wire two envelope shapes — which
 * would fork the parser, the secret-isolation assert, and every test that exercises them — the
 * controller-side adapter flattens those fields INTO `input`. So `input` remains present and
 * object-typed for every kind, one parse path serves both families, and
 * `assertWorkspaceHostSecretIsolation` keeps covering the whole step exactly as before.
 */
export interface WorkspaceHostRemoteInitializerStep {
  id: string;
  kind: WorkspaceHostRemoteInitializerStepKind;
  dependsOn: readonly string[];
  idempotencyKey: string;
  input: Readonly<Record<string, unknown>>;
}

export interface WorkspaceHostRemoteInitializerRequest {
  protocolVersion: typeof WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION;
  step: WorkspaceHostRemoteInitializerStep;
}

/**
 * Encode a planned credential-lifecycle step for the wire.
 *
 * This lives HERE, beside the parser that will read it back, rather than in the controller that
 * calls it. The flattening described on `WorkspaceHostRemoteInitializerStep` is a property of the
 * protocol, not of any one caller, and a controller that open-coded it would be a second
 * definition of the wire format sitting where nobody would think to look when the format changed.
 * Encoder and parser being adjacent is what lets a round-trip test cover both at once.
 */
export function encodeWorkspaceHostCredentialLifecycleStep(
  step: WorkspaceHostCredentialLifecycleStep,
): WorkspaceHostRemoteInitializerStep {
  return {
    id: step.id,
    kind: step.kind,
    dependsOn: step.dependsOn,
    idempotencyKey: step.idempotencyKey,
    input: {
      channel: step.channel,
      credentialRef: step.credentialRef,
      delivery: step.delivery,
    },
  };
}

export interface WorkspaceHostRemoteInitializerResponse {
  protocolVersion: typeof WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION;
  stepId: string;
  status: "succeeded";
  observedAt: string;
  publicEvidence?: Readonly<Record<string, unknown>>;
}

export class WorkspaceHostRemoteInitializerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceHostRemoteInitializerProtocolError";
  }
}

export class UnsupportedWorkspaceHostInitializationStepKindError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(
      `Remote initializer has no handler for step kind '${kind}'. Supported: ` +
        `${WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS.join(", ")}.`,
    );
    this.name = "UnsupportedWorkspaceHostInitializationStepKindError";
    this.kind = kind;
  }
}

/** Public evidence returned by a handler; the envelope adds `stepId`/`observedAt`. */
export type WorkspaceHostRemoteStepEvidence = Readonly<Record<string, unknown>>;

export interface WorkspaceHostCreateWorkspaceInput {
  readonly workspaceId: string;
  readonly hostId: string;
}

export interface WorkspaceHostCloneRepositoryInput {
  readonly repositoryUrl: string;
  readonly visibility: "public" | "private";
  readonly destination: string;
  readonly revision?: string;
  /** Present exactly when the clone must authenticate; the planner hoists the git bind first. */
  readonly credentialChannel?: WorkspaceHostCredentialChannel;
}

export interface WorkspaceHostPairWorkspaceInput {
  readonly sourceWorkspaceId: string;
  readonly pairingReference: { readonly kind: "pairing"; readonly ref: string };
  readonly include: readonly string[];
}

export interface WorkspaceHostImportWorkspaceInput {
  readonly sourceWorkspaceId: string;
  readonly sourceSnapshotRef: string;
  readonly include: readonly string[];
}

export interface WorkspaceHostVerifyInitializationInput {
  readonly sourceKind: string;
  readonly requiredChannels: readonly WorkspaceHostCredentialChannel[];
  /** Re-carried because every remote step is a fresh process with no prior clone object. */
  readonly repository?: {
    readonly destination: string;
    readonly visibility: "public" | "private";
  };
}

/**
 * The host-side operations the initializer performs. Everything that touches the filesystem, git,
 * or another workspace lives behind this seam so the protocol engine above it is a pure function
 * of its inputs and can be tested exhaustively without a VM.
 */
export interface WorkspaceHostRemoteInitializerHost {
  /** Optional post-provision pack; never part of ordinary headless initialization. */
  installDesktopPack?(input: { hostId: string }): Promise<WorkspaceHostRemoteStepEvidence>;
  createWorkspace(
    input: WorkspaceHostCreateWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence>;
  cloneRepository(
    input: WorkspaceHostCloneRepositoryInput,
  ): Promise<WorkspaceHostRemoteStepEvidence>;
  pairWorkspace(
    input: WorkspaceHostPairWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence>;
  importWorkspace(
    input: WorkspaceHostImportWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence>;
  /** Probe the requested agents. Omission retains all-three coverage. */
  probeAgentVerification(requestedAgents?: readonly WorkspaceHostCanaryAgent[]): Promise<WorkspaceHostAgentVerificationReport>;
  /** Confirm the private clone landed, for the verify step's repository evidence. */
  describeClonedRepository(input?: {
    readonly destination: string;
    readonly visibility: "public" | "private";
  }): Promise<{
    readonly visibility: "public" | "private";
    readonly cloned: boolean;
  }>;
}

export interface WorkspaceHostRemoteInitializerDeps {
  readonly host: WorkspaceHostRemoteInitializerHost;
  readonly credentials: WorkspaceHostCredentialResolver;
  readonly now?: () => Date;
}

function requireObject(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `${label} must be an object`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

/**
 * Validate an inbound request envelope.
 *
 * The protocol-version check is FIRST and total. A host that executed a step from an envelope it
 * did not understand would be acting on a contract it cannot verify — and unlike a malformed
 * field, a version skew means every later assumption in this file may be wrong too.
 */
export function parseWorkspaceHostRemoteInitializerRequest(
  raw: unknown,
): WorkspaceHostRemoteInitializerRequest {
  const body = requireObject(raw, "request");
  if (
    body.protocolVersion !== WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION
  ) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `unsupported protocol version '${String(body.protocolVersion)}'; this initializer speaks ` +
        `'${WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION}'`,
    );
  }
  const step = requireObject(body.step, "request.step");
  const id = requireString(step.id, "request.step.id");
  const kind = requireString(step.kind, "request.step.kind");
  if (
    !(
      WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS as readonly string[]
    ).includes(kind)
  ) {
    throw new UnsupportedWorkspaceHostInitializationStepKindError(kind);
  }
  requireString(step.idempotencyKey, "request.step.idempotencyKey");
  if (!Array.isArray(step.dependsOn)) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      "request.step.dependsOn must be an array",
    );
  }
  requireObject(step.input, "request.step.input");
  assertWorkspaceHostSecretIsolation(
    step,
    `workspaceHost.remoteInitializer.request.${id}`,
  );

  return {
    protocolVersion: WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
    step: {
      id,
      kind: kind as WorkspaceHostRemoteInitializerStepKind,
      dependsOn: step.dependsOn as readonly string[],
      idempotencyKey: step.idempotencyKey as string,
      input: step.input as Readonly<Record<string, unknown>>,
    },
  };
}

function readInclude(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `${label} must be an array of strings`,
    );
  }
  return value as readonly string[];
}

/**
 * Execute ONE credential operation named by a step, and project its evidence for the wire.
 *
 * Shared by the initialization `bind-credential` step and by all four credential-lifecycle
 * steps, because they are the same act: resolve the channel's materializer and run one operation
 * against it. Sharing matters more than the few saved lines — the projection below is the
 * allowlist that decides what leaves the host, so a second copy of it is a second place for a
 * field to be added without anyone re-asking whether it is safe to emit.
 */
async function runCredentialOperation(
  operation: WorkspaceHostCredentialOperation,
  input: Readonly<Record<string, unknown>>,
  deps: WorkspaceHostRemoteInitializerDeps,
  now: () => Date,
): Promise<WorkspaceHostRemoteStepEvidence> {
  const channel = requireString(input.channel, "step.input.channel");
  if (
    !WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(
      channel as WorkspaceHostCredentialChannel,
    )
  ) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `step.input.channel '${channel}' is not a credential channel`,
    );
  }
  const credentialRef = requireObject(
    input.credentialRef,
    "step.input.credentialRef",
  );
  const delivery = requireObject(input.delivery, "step.input.delivery");
  // `requestedAt` is not carried on the step, so the binding's expiry is judged against the
  // delivery's own window rather than against a clock the controller never saw. Using the
  // host clock here would let a host accept a delegation the controller had already refused.
  const requestedAt = new Date(now().getTime() - 1).toISOString();
  const evidence: WorkspaceHostCredentialEvidence = await deps.credentials.run(
    operation,
    {
      channel: channel as WorkspaceHostCredentialChannel,
      credentialRef: {
        kind: requireString(
          credentialRef.kind,
          "step.input.credentialRef.kind",
        ),
        ref: requireString(credentialRef.ref, "step.input.credentialRef.ref"),
      },
      delivery: delivery as never,
      requestedAt,
    },
  );
  return {
    channel: evidence.channel,
    family: evidence.family,
    operation: evidence.operation,
    deliveryKind: evidence.deliveryKind,
    generation: evidence.generation,
    audience: evidence.audience,
    referenceDigest: evidence.referenceDigest,
    detail: evidence.detail,
  };
}

/**
 * Execute one step and produce the response the controller expects.
 *
 * `observedAt` is stamped AFTER the handler returns, so it records when the work finished rather
 * than when the request was parsed. The controller validates it as an ISO timestamp and persists
 * it as the receipt's observation time; a stamp taken before a two-minute clone would describe an
 * instant at which the evidence was not yet true.
 */
export async function executeWorkspaceHostRemoteInitializerStep(
  request: WorkspaceHostRemoteInitializerRequest,
  deps: WorkspaceHostRemoteInitializerDeps,
): Promise<WorkspaceHostRemoteInitializerResponse> {
  const { step } = request;
  const now = deps.now ?? (() => new Date());
  const input = step.input;

  let publicEvidence: WorkspaceHostRemoteStepEvidence;
  switch (step.kind) {
    case "install-desktop-pack": {
      // This crosses the existing privileged conduit. The caller selects ONLY the host,
      // never a script, download URL, checksum, or Unix account for root to execute.
      if (Object.keys(input).some((key) => key !== "hostId")) {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "install-desktop-pack accepts only step.input.hostId",
        );
      }
      const hostId = requireString(input.hostId, "step.input.hostId");
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(hostId)) {
        throw new WorkspaceHostRemoteInitializerProtocolError("invalid desktop-pack hostId");
      }
      if (!deps.host.installDesktopPack) {
        throw new UnsupportedWorkspaceHostInitializationStepKindError(step.kind);
      }
      publicEvidence = await deps.host.installDesktopPack({ hostId });
      break;
    }
    case "create-workspace": {
      publicEvidence = await deps.host.createWorkspace({
        workspaceId: requireString(input.workspaceId, "step.input.workspaceId"),
        hostId: requireString(input.hostId, "step.input.hostId"),
      });
      break;
    }
    case "clone-repository": {
      const visibility = requireString(
        input.visibility,
        "step.input.visibility",
      );
      if (visibility !== "public" && visibility !== "private") {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "step.input.visibility must be 'public' or 'private'",
        );
      }
      const credentialChannel = input.credentialChannel;
      if (
        credentialChannel !== undefined &&
        !WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(
          credentialChannel as WorkspaceHostCredentialChannel,
        )
      ) {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          `step.input.credentialChannel '${String(credentialChannel)}' is not a credential channel`,
        );
      }
      // A private clone with no channel would silently attempt an unauthenticated fetch and fail
      // as "repository not found", which reads like a wrong URL rather than a missing binding.
      if (visibility === "private" && credentialChannel === undefined) {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "a private clone step must name the credential channel it authenticates with",
        );
      }
      publicEvidence = await deps.host.cloneRepository({
        repositoryUrl: requireString(
          input.repositoryUrl,
          "step.input.repositoryUrl",
        ),
        visibility,
        destination: requireString(input.destination, "step.input.destination"),
        ...(typeof input.revision === "string"
          ? { revision: input.revision }
          : {}),
        ...(credentialChannel
          ? {
              credentialChannel:
                credentialChannel as WorkspaceHostCredentialChannel,
            }
          : {}),
      });
      break;
    }
    case "pair-workspace": {
      const pairing = requireObject(
        input.pairingReference,
        "step.input.pairingReference",
      );
      if (pairing.kind !== "pairing") {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "step.input.pairingReference.kind must be 'pairing'",
        );
      }
      publicEvidence = await deps.host.pairWorkspace({
        sourceWorkspaceId: requireString(
          input.sourceWorkspaceId,
          "step.input.sourceWorkspaceId",
        ),
        pairingReference: {
          kind: "pairing",
          ref: requireString(pairing.ref, "step.input.pairingReference.ref"),
        },
        include: readInclude(input.include, "step.input.include"),
      });
      break;
    }
    case "import-workspace": {
      publicEvidence = await deps.host.importWorkspace({
        sourceWorkspaceId: requireString(
          input.sourceWorkspaceId,
          "step.input.sourceWorkspaceId",
        ),
        sourceSnapshotRef: requireString(
          input.sourceSnapshotRef,
          "step.input.sourceSnapshotRef",
        ),
        include: readInclude(input.include, "step.input.include"),
      });
      break;
    }
    case "bind-credential": {
      publicEvidence = await runCredentialOperation("bind", input, deps, now);
      break;
    }
    // The four CREDENTIAL-LIFECYCLE kinds (D-114). A lifecycle step is exactly a request to run
    // one credential operation against one channel, and `WorkspaceHostCredentialOperation` has
    // the same four members as `WorkspaceHostCredentialLifecycleStepKind` — so the kind IS the
    // operation and needs no mapping table. That identity is asserted by a test rather than
    // assumed here, because a table nobody checks is how the two lists drift apart.
    //
    // Note `bind-credential` above and `bind` here differ only in provenance: the first is the
    // initial binding planned by `planWorkspaceHostInitialization`, the second is a binding
    // planned by `planWorkspaceHostCredentialLifecycle` (a rotation's new generation, or a
    // restore's rebind). They execute identically and deliberately share one implementation.
    case "bind":
    case "verify-bound":
    case "revoke":
    case "verify-revoked": {
      publicEvidence = await runCredentialOperation(
        step.kind,
        input,
        deps,
        now,
      );
      break;
    }
    case "verify-initialization": {
      const requestedAgents = resolveWorkspaceHostRequestedAgents(input.requestedAgents);
      const sourceKind = requireString(
        input.sourceKind,
        "step.input.sourceKind",
      );
      const requiredChannels = readInclude(
        input.requiredChannels,
        "step.input.requiredChannels",
      ) as readonly WorkspaceHostCredentialChannel[];
      let repositoryInput:
        | {
            readonly destination: string;
            readonly visibility: "public" | "private";
          }
        | undefined;
      if (sourceKind === "git") {
        const repository = requireObject(
          input.repository,
          "step.input.repository",
        );
        const visibility = requireString(
          repository.visibility,
          "step.input.repository.visibility",
        );
        if (visibility !== "public" && visibility !== "private") {
          throw new WorkspaceHostRemoteInitializerProtocolError(
            "step.input.repository.visibility must be 'public' or 'private'",
          );
        }
        repositoryInput = {
          destination: requireString(
            repository.destination,
            "step.input.repository.destination",
          ),
          visibility,
        };
      } else if (input.repository !== undefined) {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "step.input.repository is allowed only for a git source",
        );
      }
      const report = await deps.host.probeAgentVerification(
        input.requestedAgents !== undefined ? requestedAgents : undefined,
      );
      const reportedAgents = resolveWorkspaceHostRequestedAgents(report.requestedAgents);
      if (JSON.stringify(reportedAgents) !== JSON.stringify(requestedAgents) ||
          Object.keys(report.agents).some((agent) => !requestedAgents.includes(agent as WorkspaceHostCanaryAgent))) {
        throw new Error("agent verification requestedAgents coverage does not match initialization");
      }
      const repository =
        await deps.host.describeClonedRepository(repositoryInput);
      const failed = requestedAgents.filter(
        (agent) => !report.agents[agent]?.ready,
      );
      // The verify step is the last gate before the controller records a successful
      // initialization, so an unready agent has to stop it here. Succeeding and merely
      // reporting the failure in evidence would reproduce the exact defect this work exists to
      // remove: a green verdict backed by a boolean nobody checked.
      if (failed.length > 0) {
        // Name each agent's REASON CODE, not just the agent. These codes are the closed
        // `WorkspaceHostAgentProbeFailureReason` union — never CLI output — so this stays inside
        // the same secret-isolation rule the evidence itself obeys, while telling the reader
        // whether to look at a credential or at a provider account. WI-2144034: this message
        // previously said only `codex`, and the real cause (an exhausted provider quota) cost two
        // GCP canaries to rediscover. The capped stderr byte count distinguishes a silent probe
        // from one whose unclassified output was deliberately withheld.
        const detail = failed
          .map((agent) => {
            const evidence = report.agents[agent];
            const failure = evidence?.failure ?? "not-reported";
            const stderrBytes = evidence?.stderrByteCount;
            const stderrDetail =
              typeof stderrBytes !== "number"
                ? ""
                : evidence?.stderrByteCountTruncated
                  ? `; stderr-bytes-at-least=${stderrBytes}`
                  : `; stderr-bytes=${stderrBytes}`;
            return `${agent} (${failure}${stderrDetail})`;
          })
          .join(", ");
        throw new Error(`agent readiness did not pass for: ${detail}`);
      }
      publicEvidence = {
        sourceKind,
        requiredChannels,
        repository,
        agents: report.agents,
        ...(input.requestedAgents !== undefined ? { requestedAgents } : {}),
        allReady: WORKSPACE_HOST_CANARY_AGENTS.every((agent) => report.agents[agent]?.ready === true),
        agentContractVersion: report.contractVersion,
      };
      break;
    }
    default: {
      throw new UnsupportedWorkspaceHostInitializationStepKindError(step.kind);
    }
  }

  const observedAt = now().toISOString();
  const response: WorkspaceHostRemoteInitializerResponse = {
    protocolVersion: WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
    stepId: step.id,
    status: "succeeded",
    observedAt,
    ...(publicEvidence && Object.keys(publicEvidence).length > 0
      ? { publicEvidence }
      : {}),
  };
  assertWorkspaceHostSecretIsolation(
    response,
    `workspaceHost.remoteInitializer.response.${step.id}`,
  );
  return response;
}

/**
 * Handle one raw stdin payload and return the exact bytes to write to stdout.
 *
 * Kept separate from the CLI so the whole request/response cycle — including malformed JSON — is
 * testable without spawning a process.
 */
export async function handleWorkspaceHostRemoteInitializerPayload(
  payload: string,
  deps: WorkspaceHostRemoteInitializerDeps,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      "request body is not valid JSON",
    );
  }
  const request = parseWorkspaceHostRemoteInitializerRequest(parsed);
  const response = await executeWorkspaceHostRemoteInitializerStep(
    request,
    deps,
  );
  return `${JSON.stringify(response)}\n`;
}

/** Reject argv that is not exactly what the controller's command builder emits. */
export function assertWorkspaceHostRemoteInitializerArgv(
  argv: readonly string[],
): void {
  const expected = WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV;
  const matches =
    argv.length === expected.length &&
    expected.every((value, index) => argv[index] === value);
  if (!matches) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `remote initializer expects argv ${expected.join(" ")}, got ${argv.join(" ") || "(none)"}`,
    );
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Canary evidence production                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface BuildWorkspaceHostInitializationCanaryEvidenceInput {
  readonly runId: string;
  readonly workspaceId: string;
  readonly hostId: string;
  readonly observedAt: string;
  readonly repository: {
    readonly visibility: "public" | "private";
    readonly cloned: boolean;
  };
  readonly agents: WorkspaceHostAgentVerificationReport;
  /**
   * Per-channel lifecycle evidence gathered from a real rotate/revoke/reconnect run, keyed by
   * channel. Each channel must show all four transitions.
   */
  readonly channelLifecycle: Readonly<
    Record<
      WorkspaceHostCredentialChannel,
      {
        readonly bound: boolean;
        readonly rotated: boolean;
        readonly previousBindingRevoked: boolean;
        readonly reconnected: boolean;
      }
    >
  >;
  readonly backupRestore: {
    readonly authorizationMaterialExcluded: boolean;
    readonly credentialReferencesExcluded: boolean;
    readonly reboundChannels: readonly WorkspaceHostCredentialChannel[];
  };
}

export class WorkspaceHostInitializationCanaryEvidenceError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Canary evidence cannot be constructed: ${problems.join("; ")}`);
    this.name = "WorkspaceHostInitializationCanaryEvidenceError";
    this.problems = problems;
  }
}

/**
 * Construct `WorkspaceHostInitializationCanaryEvidence` from observations.
 *
 * WHY A BUILDER AND NOT AN OBJECT LITERAL. The evidence type declares every field as a literal
 * (`cloned: true`, `ready: true`, `bound: true`, …), so TypeScript makes a FAILING canary
 * literally unrepresentable. That is a good property for the validator's contract and a terrible
 * one for honesty: the only way to obtain a value of that type is to assert the success you were
 * supposed to be proving. This builder is the seam where observed booleans meet that type — it
 * REFUSES to widen a false observation into the literal `true`, throwing with the specific
 * shortfall instead. So an unauthenticated agent or an unrotated channel cannot become canary
 * evidence at all, rather than becoming evidence that then fails validation somewhere later.
 */
export function buildWorkspaceHostInitializationCanaryEvidence(
  input: BuildWorkspaceHostInitializationCanaryEvidenceInput,
): WorkspaceHostInitializationCanaryEvidence {
  const problems: string[] = [];

  if (input.repository.visibility !== "private") {
    problems.push("canary repository must be private");
  }
  if (!input.repository.cloned)
    problems.push("private-repository clone was not observed");

  for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
    const observed = input.channelLifecycle?.[channel];
    if (!observed) {
      problems.push(`no lifecycle evidence for the '${channel}' channel`);
      continue;
    }
    for (const [flag, value] of Object.entries(observed)) {
      if (value !== true)
        problems.push(`${channel} channel did not observe '${flag}'`);
    }
  }

  // Derive coverage from the report itself rather than re-deciding it here: `requestedAgents` is
  // the report's own declared scope and resolves to all three when absent, so a legacy/default
  // report is unchanged while a deliberately scoped one (D-338's Codex skip) is not failed for the
  // agent it was never asked to probe. Reading `agents` alone cannot tell "skipped" from "missing".
  const coveredAgents = resolveWorkspaceHostRequestedAgents(input.agents?.requestedAgents);
  for (const agent of coveredAgents) {
    const evidence = input.agents?.agents?.[agent];
    if (!evidence) {
      problems.push(`no readiness probe was run for '${agent}'`);
      continue;
    }
    if (!evidence.ready) {
      problems.push(
        `${agent} live readiness did not pass (${evidence.failure ?? "unknown"}, exit ${evidence.exitStatus})`,
      );
    }
    // WI-10002402: DERIVED from the agent's probe table — see
    // workspaceHostAgentAllowedVerificationKinds for why the literal this replaced could never
    // admit a real claude credential.
    if (
      !workspaceHostAgentVerificationKindIsAllowed(
        agent,
        evidence.verificationKind,
      )
    ) {
      problems.push(
        `${agent} verification kind '${evidence.verificationKind}' is not allowed (allowed: ${[
          ...workspaceHostAgentAllowedVerificationKinds(agent),
        ].join(", ")})`,
      );
    }
  }

  if (!input.backupRestore.authorizationMaterialExcluded) {
    problems.push("backup retained authorization material");
  }
  if (!input.backupRestore.credentialReferencesExcluded) {
    problems.push("backup retained credential references");
  }
  const rebound = new Set(input.backupRestore.reboundChannels);
  for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
    if (!rebound.has(channel))
      problems.push(`restore did not rebind the '${channel}' channel`);
  }
  for (const channel of rebound) {
    if (!WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(channel)) {
      problems.push(`restore rebound an unknown channel '${channel}'`);
    }
  }

  if (!Number.isFinite(Date.parse(input.observedAt))) {
    problems.push("canary observedAt must be an ISO timestamp");
  }

  if (problems.length > 0)
    throw new WorkspaceHostInitializationCanaryEvidenceError(problems);

  const channels = Object.fromEntries(
    WORKSPACE_HOST_CREDENTIAL_CHANNELS.map((channel) => [
      channel,
      {
        bound: true,
        rotated: true,
        previousBindingRevoked: true,
        reconnected: true,
      } as const,
    ]),
  ) as WorkspaceHostInitializationCanaryEvidence["channels"];

  // Same resolved coverage the validation loop above used — sharing the one binding is what stops
  // the proven set and the emitted set from silently diverging (reading the constant here crashed
  // on the skipped agent's absent evidence, after validation had correctly allowed it).
  const agents = Object.fromEntries(
    coveredAgents.map((agent) => [
      agent,
      {
        ready: true,
        verificationKind: input.agents.agents[agent]!.verificationKind,
      } as const,
    ]),
  ) as WorkspaceHostInitializationCanaryEvidence["agents"];

  const evidence: WorkspaceHostInitializationCanaryEvidence = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    kind: "live",
    runId: input.runId,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    observedAt: input.observedAt,
    repository: { visibility: "private", cloned: true },
    channels,
    // Propagate the report's declared coverage onto the assembled artifact so the validator (and
    // any later reader of ratified evidence) can tell a deliberately scoped run from a truncated
    // one. Omitted when the report was unscoped, preserving the default artifact shape byte for byte.
    ...(input.agents?.requestedAgents !== undefined ? { requestedAgents: coveredAgents } : {}),
    agents,
    backupRestore: {
      authorizationMaterial: "excluded",
      credentialReferences: "excluded",
      reboundChannels: [...WORKSPACE_HOST_CREDENTIAL_CHANNELS],
    },
  };
  assertWorkspaceHostSecretIsolation(
    evidence,
    "workspaceHost.initialization.canary",
  );
  return evidence;
}
