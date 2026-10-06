/**
 * The controller side of credential-material delivery over GCP IAP (P-046 / WI-40474, D-215).
 *
 * WHY THIS IS A SEPARATE FILE FROM `gcp-iap-initialization-operations`. That module's contract is
 * that no resolved credential bytes cross its boundary, and it asserts that on every step and
 * every encoded request. This module's contract is the exact opposite: it exists to carry those
 * bytes. Putting both in one file would make that header claim conditional — a reader could no
 * longer take "credential bytes never cross this boundary" at face value, and the assertion would
 * have to grow an exception. Two files, two unambiguous contracts, one shared TRANSPORT
 * (`buildGcpIapSshInvocation`) so the security-critical SSH options cannot drift between them.
 *
 * MATERIAL TRAVELS ON STDIN, NEVER IN ARGV. `/proc/<pid>/cmdline` is world-readable on Linux, so
 * an argument is visible to every local process for the lifetime of the command — and to `ps`, the
 * audit log, and any transport that echoes what it ran. The remote argv here is a fixed three
 * tokens with no caller input in it at all; the bytes go down the pipe.
 */
import {
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
  WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS,
  encodeWorkspaceHostCredentialDeliveryRequest,
  parseWorkspaceHostCredentialReference,
  type WorkspaceHostCredentialMaterial,
} from '@papercusp/deployment-driver';
import type {
  WorkspaceHostBootstrapReadinessOptions,
  WorkspaceHostBootstrapReadinessResult,
  WorkspaceHostCredentialChannel,
  WorkspaceHostCredentialLifecycleStep,
  WorkspaceHostInitializationHostOperationResult,
  WorkspaceHostInitializationHostOperations,
  WorkspaceHostInitializationStep,
  WorkspaceHostInitializationSupportedStepKind,
  WorkspaceHostRemoteInitializerStep,
} from '@papercusp/deployment-driver';

import {
  UNCONFIGURED_WORKSPACE_HOST_CREDENTIAL_MATERIAL_SOURCE,
  type WorkspaceHostCredentialMaterialSource,
} from './credential-material-source';
import {
  NodeGcpIapWorkspaceHostInitializationCommandRunner,
  buildWorkspaceHostSshInvocation,
  type GcpIapWorkspaceHostInitializationCommand,
  type GcpIapWorkspaceHostInitializationCommandRunner,
  type GcpIapWorkspaceHostInitializationStep,
  type WorkspaceHostSshTransportProfile,
} from './gcp-iap-initialization-operations';

/**
 * The delivery profile: the shared transport plus the delivery binary.
 *
 * `deliveryEntrypoint` is deliberately its own field rather than reusing `remoteEntrypoint`. They
 * are two different programs in the signed release, and a profile that carried one path for both
 * would silently send delivery requests to the initializer — which would refuse them as a protocol
 * version mismatch, reported as a broken step rather than as a misconfigured profile.
 */
export type GcpIapWorkspaceHostCredentialDeliveryProfile = WorkspaceHostSshTransportProfile & {
  /** Absolute path to `bin/papercusp-deliver-material` in the extracted release. */
  deliveryEntrypoint: string;
};

export interface GcpIapWorkspaceHostCredentialDeliveryInput {
  readonly channel: WorkspaceHostCredentialChannel;
  readonly credentialRef: string;
  readonly generation: number;
  readonly material: WorkspaceHostCredentialMaterial;
}

/**
 * The receipt a successful delivery returns. Structurally the host's receipt; re-declared here as
 * what the controller is willing to PERSIST, so a host that grew an extra field cannot smuggle it
 * into a durable record just because the parser was permissive.
 */
export interface GcpIapWorkspaceHostCredentialDeliveryReceipt {
  readonly protocolVersion: typeof WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION;
  readonly family: string;
  readonly generation: number;
  readonly present: true;
  readonly observedAt: string;
}

export class GcpIapWorkspaceHostCredentialDeliveryError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'GcpIapWorkspaceHostCredentialDeliveryError';
    this.exitCode = exitCode;
  }
}

/**
 * Build the delivery invocation.
 *
 * NOTE THE ABSENT ASSERTION. `assertWorkspaceHostSecretIsolation` is not called on the request, and
 * that is the whole point of the operation rather than an omission — see D-215's inbound/outbound
 * asymmetry. It IS called on the receipt, in `parse...Receipt` below, because that is the value
 * that gets persisted.
 */
export function buildGcpIapWorkspaceHostCredentialDeliveryCommand(
  profile: GcpIapWorkspaceHostCredentialDeliveryProfile,
  input: GcpIapWorkspaceHostCredentialDeliveryInput,
): GcpIapWorkspaceHostInitializationCommand {
  const request = encodeWorkspaceHostCredentialDeliveryRequest({
    channel: input.channel,
    credentialRef: input.credentialRef,
    generation: input.generation,
    material: input.material,
  });

  return buildWorkspaceHostSshInvocation(profile, {
    entrypoint: profile.deliveryEntrypoint,
    entrypointLabel: 'Credential delivery entrypoint',
    // A fixed argv with no caller input spliced into it. Everything variable is in stdin.
    args: [...WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV],
    stdin: `${JSON.stringify(request)}\n`,
  });
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      `credential delivery receipt ${label} must be a non-empty string`,
      1,
    );
  }
  return value;
}

/**
 * Parse the host's receipt.
 *
 * Fields are read INDIVIDUALLY rather than the object being passed through, so a host that
 * returned extra fields — a size, a digest, an echo of the material — cannot have them land in a
 * durable record. D-215 point 3 forbids anything derived from the bytes, and the cheapest way to
 * enforce that at the controller is to construct the persisted value from named fields only.
 */
export function parseGcpIapWorkspaceHostCredentialDeliveryReceipt(
  stdout: string,
): GcpIapWorkspaceHostCredentialDeliveryReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      'credential delivery returned a malformed response',
      1,
    );
  }
  const body = parsed as Record<string, unknown>;
  if (body?.protocolVersion !== WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      `credential delivery answered protocol '${String(body?.protocolVersion)}'; the controller ` +
        `speaks '${WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION}'`,
      1,
    );
  }
  if (body.present !== true) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      'credential delivery did not report the material as present',
      1,
    );
  }
  const generation = body.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      'credential delivery receipt generation must be a positive safe integer',
      1,
    );
  }
  return {
    protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
    family: requireString(body.family, 'family'),
    generation: generation as number,
    present: true,
    observedAt: requireString(body.observedAt, 'observedAt'),
  };
}

/**
 * Deliver one generation's material to the host and return its receipt.
 *
 * Reuses the initialization runner interface: the transport, timeout and output bounds are the
 * same problem, and a second runner would be a second place to get the bounded-stderr handling
 * wrong. A non-zero exit carries the host's stderr tail, which the delivery CLI writes as
 * `name: message` and never as the request.
 */
export async function deliverGcpIapWorkspaceHostCredentialMaterial(
  profile: GcpIapWorkspaceHostCredentialDeliveryProfile,
  input: GcpIapWorkspaceHostCredentialDeliveryInput,
  runner: GcpIapWorkspaceHostInitializationCommandRunner,
): Promise<GcpIapWorkspaceHostCredentialDeliveryReceipt> {
  const command = buildGcpIapWorkspaceHostCredentialDeliveryCommand(profile, input);
  const result = await runner.run(command);
  if (result.exitCode !== 0) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      `credential delivery failed with exit ${result.exitCode}: ${result.stderr.trim() || '(no diagnostic output)'}`,
      result.exitCode,
    );
  }
  return parseGcpIapWorkspaceHostCredentialDeliveryReceipt(result.stdout);
}

/* ------------------------------------------------------------------------------------------ */

interface WorkspaceHostCredentialBindingNeed {
  readonly channel: WorkspaceHostCredentialChannel;
  readonly credentialRef: string;
  readonly generation: number;
}

function readBindingField(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(`binding step ${label} must be an object`, 1);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Recover what a step needs delivered, or `null` when it is not a binding step at all.
 *
 * The two binding shapes differ only in where the fields sit: an initialization `bind-credential`
 * step carries them inside `input`, a credential-lifecycle `bind` step carries them at the top
 * level. Both are handled because both bind — a rotation's new generation needs its material on
 * the host exactly as much as the first one does, and a decorator that only understood
 * initialization would leave rotation failing at bind with the same misleading host-side message.
 */
function bindingNeedOf(
  step: GcpIapWorkspaceHostInitializationStep,
): WorkspaceHostCredentialBindingNeed | null {
  if (step.kind !== 'bind-credential' && step.kind !== 'bind') return null;
  const source: Readonly<Record<string, unknown>> =
    step.kind === 'bind-credential'
      ? readBindingField((step as WorkspaceHostInitializationStep).input, 'input')
      : (step as unknown as Readonly<Record<string, unknown>>);

  const credentialRef = readBindingField(source.credentialRef, 'credentialRef');
  const delivery = readBindingField(source.delivery, 'delivery');
  const ref = credentialRef.ref;
  const channel = source.channel;
  const generation = delivery.generation;
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      'binding step credentialRef.ref must be a non-empty string',
      1,
    );
  }
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      'binding step channel must be a non-empty string',
      1,
    );
  }
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      'binding step delivery.generation must be a positive safe integer',
      1,
    );
  }
  return {
    channel: channel as WorkspaceHostCredentialChannel,
    credentialRef: ref,
    generation: generation as number,
  };
}

/**
 * The initialization adapter, with credential-material delivery in front of every binding step.
 *
 * WHY A DECORATOR RATHER THAN A BRANCH INSIDE THE ADAPTER. `GcpIapWorkspaceHostInitializationOperations`
 * asserts that no credential bytes cross its boundary, on every step and every encoded request.
 * Teaching it to also carry material would make that assertion conditional, and a conditional
 * assertion proves only that the condition was not met. Wrapping it instead leaves the inner
 * contract total: material travels on this object's OWN protocol, to its OWN entrypoint, and the
 * step that follows is byte-for-byte the step the bare adapter would have sent.
 *
 * ORDERING IS THE POINT. `ProductionWorkspaceHostCredentialMaterializer.bind()` is an OBSERVATION —
 * it checks that `<materialRoot>/<family>/<generation>/material` exists and refuses when it does
 * not. Delivery is what makes that observation able to succeed, so it must complete before the
 * bind step is sent, not alongside it.
 *
 * REPLAY GETS THIS RIGHT FOR FREE. The runner wraps `execute` in the durable replay store, so a
 * step that already succeeded is never re-executed and no material is resolved on a replayed pass.
 * When a step DOES re-execute, delivery is idempotent per `(family, generation)` on the host.
 */
export class GcpIapDeliveringWorkspaceHostInitializationOperations
  implements WorkspaceHostInitializationHostOperations
{
  readonly supportedStepKinds: readonly WorkspaceHostInitializationSupportedStepKind[];

  private readonly inner: WorkspaceHostInitializationHostOperations;
  private readonly profile: GcpIapWorkspaceHostCredentialDeliveryProfile;
  private readonly materialSource: WorkspaceHostCredentialMaterialSource;
  private readonly runner: GcpIapWorkspaceHostInitializationCommandRunner;

  constructor(
    inner: WorkspaceHostInitializationHostOperations,
    profile: GcpIapWorkspaceHostCredentialDeliveryProfile,
    materialSource: WorkspaceHostCredentialMaterialSource = UNCONFIGURED_WORKSPACE_HOST_CREDENTIAL_MATERIAL_SOURCE,
    runner: GcpIapWorkspaceHostInitializationCommandRunner = new NodeGcpIapWorkspaceHostInitializationCommandRunner(),
  ) {
    this.inner = inner;
    this.profile = profile;
    this.materialSource = materialSource;
    this.runner = runner;
    // Delivery adds no step kinds: it is not a step. Advertising the inner adapter's manifest
    // unchanged is what keeps that true — a wrapper that grew the manifest would be claiming the
    // executor may route a step kind to it that no host program implements.
    this.supportedStepKinds = inner.supportedStepKinds;

    // Forward the bootstrap-readiness gate, and forward it CONDITIONALLY (WI-10001677).
    //
    // `awaitBootstrapReady` is optional on the interface, so this wrapper satisfied the type
    // without it and the omission was invisible to both tsc and the adapter's own unit tests —
    // while `resolveWorkspaceHostInitializationOperations` returns THIS object, so every real
    // initialize ran with `operations.awaitBootstrapReady === undefined` and the runner's
    // `if (input.operations.awaitBootstrapReady)` skipped the gate entirely. The gate was dead on
    // the only path that has a host in front of it.
    //
    // Assigned here rather than declared as a method so PRESENCE MIRRORS THE INNER ADAPTER: a
    // wrapper that always exposed it would report a gate the inner cannot perform, which is worse
    // than no gate — the runner would wait on a promise no probe backs. Absent inner support, the
    // property stays undefined and the documented "no gate" behaviour is preserved exactly.
    if (typeof inner.awaitBootstrapReady === 'function') {
      this.awaitBootstrapReady = (options?: WorkspaceHostBootstrapReadinessOptions) =>
        inner.awaitBootstrapReady!(options);
    }
  }

  /** Present only when the wrapped adapter implements it — see the constructor. */
  readonly awaitBootstrapReady?: (
    options?: WorkspaceHostBootstrapReadinessOptions,
  ) => Promise<WorkspaceHostBootstrapReadinessResult>;

  async execute(step: WorkspaceHostInitializationStep): Promise<WorkspaceHostInitializationHostOperationResult>;
  async execute(step: WorkspaceHostCredentialLifecycleStep): Promise<WorkspaceHostInitializationHostOperationResult>;
  async execute(step: WorkspaceHostRemoteInitializerStep): Promise<WorkspaceHostInitializationHostOperationResult>;
  async execute(
    step: GcpIapWorkspaceHostInitializationStep,
  ): Promise<WorkspaceHostInitializationHostOperationResult> {
    const need = bindingNeedOf(step);
    if (need) await this.deliver(need);
    return await (this.inner as {
      execute(step: GcpIapWorkspaceHostInitializationStep): Promise<WorkspaceHostInitializationHostOperationResult>;
    }).execute(step);
  }

  private async deliver(need: WorkspaceHostCredentialBindingNeed): Promise<void> {
    // The reference is the authority on the family, and the family spec is the authority on
    // whether this binding has an on-host artifact at all (D-215 point 4). An ambient family is
    // skipped here rather than refused: it is a legitimate binding, it simply has nothing to
    // deliver, and sending it would be refused by the host as a request for a file that must
    // never exist.
    const family = parseWorkspaceHostCredentialReference(need.credentialRef, need.channel).family;
    if (!WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial) return;

    const material = await this.materialSource.resolve({
      channel: need.channel,
      credentialRef: need.credentialRef,
      family,
      generation: need.generation,
    });
    const receipt = await deliverGcpIapWorkspaceHostCredentialMaterial(
      this.profile,
      {
        channel: need.channel,
        credentialRef: need.credentialRef,
        generation: need.generation,
        material,
      },
      this.runner,
    );
    // The receipt is parsed for shape by the sender; what only the CALLER can check is that it
    // answers about the binding that was actually asked for. Without this, a host that wrote
    // generation 1 could acknowledge a request for generation 2, and bind would then fail on a
    // path that delivery reported as present.
    if (receipt.family !== family || receipt.generation !== need.generation) {
      throw new GcpIapWorkspaceHostCredentialDeliveryError(
        `credential delivery acknowledged family '${receipt.family}' generation ` +
          `${receipt.generation}, but the binding asked for family '${family}' generation ` +
          `${need.generation}`,
        1,
      );
    }
  }
}
