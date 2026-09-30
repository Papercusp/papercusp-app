/**
 * The ratified host-owned credential-reference namespace, and the typed resolver that
 * consumes it (P-046 / WI-41711, governed by D-103).
 *
 * WHY THIS FILE EXISTS. `WorkspaceHostCredentialReference` documents `ref` as "a typed
 * reference into a host-owned resolver" whose value "is never a secret value", but until now
 * nothing defined what a well-formed `ref` actually looks like and nothing resolved one. The
 * strings circulated in the planning lane were examples, not a namespace, and D-103 ruled
 * explicitly that they are NOT ratified by having been written down:
 *
 *   "Credential namespace is NOT ratified by the example strings in WI-41694:
 *    gcloud://active-user remains a controller connection selector and may not be treated as
 *    a host secret/binding; the initializer work must define explicit cloud workload-identity,
 *    short-lived Git delegation, and agent forwarded/encrypted-reference semantics with
 *    distinct refs/revocation refs and rotation tests."
 *
 * So this module defines four families across the three channels, each with its own ref
 * scheme, its own revocation-ref scheme, and a generation that the revocation ref must carry.
 *
 * THE PROPERTY THAT MATTERS MOST. `gcloud://active-user` is the CONTROLLER's connection
 * selector — it names which local gcloud identity the operator process uses to open an IAP
 * tunnel. It is not, and can never become, authorization material the host holds. Accepting it
 * in a host credential position would silently promote a controller-side selector into a host
 * binding, which is exactly the confusion D-103 forbids. `parseWorkspaceHostCredentialReference`
 * therefore refuses every known controller-selector scheme BY NAME, with an error that says why,
 * rather than failing it incidentally as "unrecognised".
 *
 * DIRECTION OF TRUST. Parsing is deliberately an allowlist over ratified schemes, not a denylist
 * over bad ones: an unrecognised scheme is refused by default, so a future controller selector
 * that nobody thought to deny still cannot be used as a host reference. The named denials exist
 * only to produce a better diagnosis for the mistakes we know people will make.
 */
import { createHash } from 'node:crypto';

import {
  WORKSPACE_HOST_CREDENTIAL_CHANNELS,
  type WorkspaceHostCredentialChannel,
  type WorkspaceHostCredentialDelivery,
  type WorkspaceHostCredentialDeliveryKind,
  type WorkspaceHostCredentialLifecyclePlan,
  type WorkspaceHostCredentialLifecycleStep,
} from './workspace-host-initialization';
import { assertWorkspaceHostSecretIsolation } from './workspace-host-test-harness';

/** Versioned so a host and a controller can disagree loudly rather than silently. */
export const WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION =
  'papercusp-workspace-host-credential-namespace-v1';

export const WORKSPACE_HOST_CREDENTIAL_FAMILIES = [
  'cloud-workload-identity',
  'git-short-lived-delegation',
  'agent-forwarded-reference',
  'agent-encrypted-reference',
] as const;
export type WorkspaceHostCredentialFamily =
  (typeof WORKSPACE_HOST_CREDENTIAL_FAMILIES)[number];

/**
 * Schemes that name a CONTROLLER connection selector. These are refused by name in any host
 * credential position. `gcloud://active-user` is the live example: it is the `credential_ref`
 * on a `workspace_host_connections` row, which selects the operator's own cloud identity.
 */
const CONTROLLER_CONNECTION_SELECTOR_SCHEMES: readonly string[] = [
  'gcloud',
  'gcp',
  'aws',
  'az',
  'azure',
];

/**
 * One path segment of a reference. Deliberately narrow: no `:`, no `%`, no whitespace, and no
 * leading punctuation. A grammar this tight is what structurally keeps opaque bearer material
 * out of a reference — most token encodings cannot survive it — which is a stronger guarantee
 * than pattern-matching for token shapes we happen to have thought of.
 */
const REFERENCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCHEME = /^[a-z][a-z0-9-]*$/;
/** Mirrors `requireReference` in the initialization contract. */
const MAX_REFERENCE_LENGTH = 1024;
const GENERATION_SEGMENT = /^g([1-9][0-9]{0,8})$/;

export interface WorkspaceHostCredentialFamilySpec {
  readonly family: WorkspaceHostCredentialFamily;
  readonly channel: WorkspaceHostCredentialChannel;
  readonly refScheme: string;
  readonly revocationScheme: string;
  /** Delivery kinds this family may be delivered as; a subset of the channel's allowed set. */
  readonly deliveryKinds: readonly WorkspaceHostCredentialDeliveryKind[];
  /** Names for each required segment, in order. Length fixes the segment count exactly. */
  readonly segments: readonly string[];
  /** Whether a binding in this family must carry an expiry. */
  readonly requiresExpiry: boolean;
  /**
   * Whether binding this family requires authorization material to have been WRITTEN to the host
   * filesystem first, as opposed to being answered ambiently by the environment.
   *
   * This is the single source for that fact (D-215). `materialPathFor` in the remote initializer
   * host reads it to decide whether a family has an on-host artifact at all, and the plan-time
   * capability gate reads it to decide whether a provider that cannot transfer files may carry the
   * family's channel. Both used to hard-code `family === 'cloud-workload-identity'`, which is the
   * kind of restated fact that silently stops matching when a fifth family is added.
   */
  readonly requiresDeliveredMaterial: boolean;
}

/**
 * The namespace itself.
 *
 * Every `refScheme` and every `revocationScheme` here is distinct from every other one, which is
 * what makes the initialization contract's "all three refs distinct / all three revocation refs
 * distinct" rules impossible to trip accidentally: two different channels cannot even spell the
 * same reference. The two agent families deliberately SHARE `pc-agent-revocation` because a
 * request carries at most one agent channel, so they never coexist, and a single revocation
 * surface for "the agent binding on this host" is the honest model.
 */
export const WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS: Readonly<
  Record<WorkspaceHostCredentialFamily, WorkspaceHostCredentialFamilySpec>
> = {
  'cloud-workload-identity': {
    family: 'cloud-workload-identity',
    channel: 'cloud',
    refScheme: 'pc-cloud-workload',
    revocationScheme: 'pc-cloud-workload-revocation',
    // `forwarded-agent` is absent because the initialization contract already rejects it for
    // the cloud channel; repeating that here keeps the two tables from disagreeing.
    deliveryKinds: ['provider-identity', 'encrypted-reference'],
    segments: ['provider', 'scopeId', 'workloadId'],
    requiresExpiry: false,
    // Ambient: the instance metadata server answers, and nothing is placed on disk. Inventing a
    // file for it would make bind() pass against a path we created ourselves.
    requiresDeliveredMaterial: false,
  },
  'git-short-lived-delegation': {
    family: 'git-short-lived-delegation',
    channel: 'git',
    refScheme: 'pc-git-delegation',
    revocationScheme: 'pc-git-delegation-revocation',
    deliveryKinds: ['short-lived-delegation', 'encrypted-reference'],
    segments: ['forge', 'owner', 'repository'],
    requiresExpiry: true,
    requiresDeliveredMaterial: true,
  },
  'agent-forwarded-reference': {
    family: 'agent-forwarded-reference',
    channel: 'agent',
    refScheme: 'pc-agent-forward',
    revocationScheme: 'pc-agent-revocation',
    deliveryKinds: ['forwarded-agent'],
    segments: ['hostId', 'agentSet'],
    requiresExpiry: false,
    requiresDeliveredMaterial: true,
  },
  'agent-encrypted-reference': {
    family: 'agent-encrypted-reference',
    channel: 'agent',
    refScheme: 'pc-agent-sealed',
    revocationScheme: 'pc-agent-revocation',
    deliveryKinds: ['encrypted-reference'],
    segments: ['hostId', 'agentSet'],
    requiresExpiry: false,
    requiresDeliveredMaterial: true,
  },
};

/**
 * The credential CHANNELS that cannot be carried without on-host file delivery, derived from the
 * family specs above rather than restated (D-215 point 6).
 *
 * A channel needs delivery if ANY family on it does: a provider that cannot transfer files cannot
 * carry a channel whose families require a written artifact. The initialization contract holds a
 * literal copy of this set because `workspace-host-credential-namespace` imports the contract and
 * cannot be imported back without a cycle; `workspace-host-credential-namespace.test.ts` pins the
 * two together so the copy cannot drift.
 */
export const WORKSPACE_HOST_CHANNELS_REQUIRING_FILE_DELIVERY: readonly WorkspaceHostCredentialChannel[] =
  Object.freeze(
    Array.from(
      new Set(
        Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS)
          .filter((spec) => spec.requiresDeliveredMaterial)
          .map((spec) => spec.channel),
      ),
    ).sort(),
  );

export class WorkspaceHostCredentialReferenceError extends Error {
  readonly reference: string;

  constructor(reference: string, message: string) {
    super(message);
    this.name = 'WorkspaceHostCredentialReferenceError';
    this.reference = reference;
  }
}

export interface ParsedWorkspaceHostCredentialReference {
  readonly namespaceVersion: typeof WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION;
  readonly family: WorkspaceHostCredentialFamily;
  readonly channel: WorkspaceHostCredentialChannel;
  readonly scheme: string;
  readonly segments: readonly string[];
  /** Segments keyed by the family's declared segment names. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface ParsedWorkspaceHostCredentialRevocationReference {
  readonly family: WorkspaceHostCredentialFamily;
  readonly scheme: string;
  readonly segments: readonly string[];
  readonly generation: number;
}

function splitReference(reference: string): { scheme: string; segments: string[] } {
  if (typeof reference !== 'string' || reference.length === 0) {
    throw new WorkspaceHostCredentialReferenceError(
      String(reference),
      'credential reference must be a non-empty string',
    );
  }
  if (reference.length > MAX_REFERENCE_LENGTH) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `credential reference must be at most ${MAX_REFERENCE_LENGTH} characters`,
    );
  }
  // Checked before the shape test so a reference carrying a newline is diagnosed as such rather
  // than as a malformed scheme; the initialization contract rejects these separately too.
  if (/[\r\n\0\s]/.test(reference)) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      'credential reference must not contain whitespace or control characters',
    );
  }
  const separator = reference.indexOf('://');
  if (separator <= 0) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      "credential reference must be '<scheme>://<segment>[/<segment>…]'",
    );
  }
  const scheme = reference.slice(0, separator);
  const rest = reference.slice(separator + 3);
  if (!SCHEME.test(scheme)) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `credential reference scheme '${scheme}' is not a lowercase scheme name`,
    );
  }
  if (rest.includes('?') || rest.includes('#') || rest.includes('@')) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      'credential reference must not contain userinfo, a query string, or a fragment',
    );
  }
  const segments = rest.split('/');
  for (const segment of segments) {
    if (!REFERENCE_SEGMENT.test(segment)) {
      throw new WorkspaceHostCredentialReferenceError(
        reference,
        `credential reference segment '${segment}' is not a safe reference segment`,
      );
    }
  }
  return { scheme, segments };
}

function refuseControllerSelector(reference: string, scheme: string): void {
  if (!CONTROLLER_CONNECTION_SELECTOR_SCHEMES.includes(scheme)) return;
  throw new WorkspaceHostCredentialReferenceError(
    reference,
    `'${reference}' is a controller connection selector, not host authorization material. ` +
      `Scheme '${scheme}' selects the identity the CONTROLLER connects with and must never be ` +
      `used as a workspace-host credential reference (D-103). Use a ratified host family: ` +
      `${WORKSPACE_HOST_CREDENTIAL_FAMILIES.join(', ')}.`,
  );
}

/**
 * Parse a host credential reference, optionally pinning the channel it must belong to.
 *
 * Passing `channel` is what turns "this is a well-formed reference" into "this is a well-formed
 * reference FOR THIS SLOT" — a git delegation ref sitting in the cloud slot is well-formed and
 * completely wrong, and only the channel-pinned call can say so.
 */
export function parseWorkspaceHostCredentialReference(
  reference: string,
  channel?: WorkspaceHostCredentialChannel,
): ParsedWorkspaceHostCredentialReference {
  const { scheme, segments } = splitReference(reference);
  refuseControllerSelector(reference, scheme);

  const spec = Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS).find(
    (candidate) => candidate.refScheme === scheme,
  );
  if (!spec) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `credential reference scheme '${scheme}' is not in the ratified host namespace ` +
        `(${WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION}). Ratified ref schemes: ` +
        `${Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS)
          .map((entry) => `${entry.refScheme}://`)
          .join(', ')}.`,
    );
  }
  if (segments.length !== spec.segments.length) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `${spec.family} reference must have exactly ${spec.segments.length} segments ` +
        `(${spec.segments.join('/')}), got ${segments.length}`,
    );
  }
  if (channel && spec.channel !== channel) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `${spec.family} reference belongs to the '${spec.channel}' channel, not '${channel}'`,
    );
  }

  const fields: Record<string, string> = {};
  spec.segments.forEach((label, index) => {
    fields[label] = segments[index] as string;
  });

  return {
    namespaceVersion: WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION,
    family: spec.family,
    channel: spec.channel,
    scheme,
    segments,
    fields,
  };
}

/**
 * Parse a revocation reference and recover the generation it revokes.
 *
 * The generation is IN the revocation reference on purpose. A revocation reference that named
 * only "the git binding" would be the same string for every rotation, so a replayed revocation
 * could not be distinguished from the current one, and a rotation test could not prove that the
 * PREVIOUS binding — rather than the new one — is what got revoked.
 */
export function parseWorkspaceHostCredentialRevocationReference(
  reference: string,
  family?: WorkspaceHostCredentialFamily,
): ParsedWorkspaceHostCredentialRevocationReference {
  const { scheme, segments } = splitReference(reference);
  refuseControllerSelector(reference, scheme);

  const candidates = Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS).filter(
    (entry) => entry.revocationScheme === scheme,
  );
  const spec = family
    ? candidates.find((entry) => entry.family === family)
    : candidates[0];
  if (!spec) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      family
        ? `revocation reference scheme '${scheme}' does not belong to family '${family}'`
        : `revocation reference scheme '${scheme}' is not in the ratified host namespace ` +
          `(${WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION})`,
    );
  }

  const generationSegment = segments[segments.length - 1] ?? '';
  const match = GENERATION_SEGMENT.exec(generationSegment);
  if (!match) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `revocation reference must end with a generation segment 'g<n>', got '${generationSegment}'`,
    );
  }
  const body = segments.slice(0, -1);
  if (body.length !== spec.segments.length) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `${spec.family} revocation reference must be ` +
        `'${spec.revocationScheme}://${spec.segments.join('/')}/g<n>'`,
    );
  }

  return {
    family: spec.family,
    scheme,
    segments: body,
    generation: Number(match[1]),
  };
}

/** Construct a reference instead of hand-formatting one at a call site. */
export function buildWorkspaceHostCredentialReference(
  family: WorkspaceHostCredentialFamily,
  fields: Readonly<Record<string, string>>,
): string {
  const spec = WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family];
  if (!spec) {
    throw new WorkspaceHostCredentialReferenceError(family, `unknown credential family '${family}'`);
  }
  const segments = spec.segments.map((label) => {
    const value = fields[label];
    if (typeof value !== 'string' || !REFERENCE_SEGMENT.test(value)) {
      throw new WorkspaceHostCredentialReferenceError(
        String(value),
        `${family} reference field '${label}' must be a safe reference segment`,
      );
    }
    return value;
  });
  const reference = `${spec.refScheme}://${segments.join('/')}`;
  // Round-trip rather than trust the construction: a builder that can emit something its own
  // parser rejects is a worse failure than a rejected input, because it fails at the far end.
  parseWorkspaceHostCredentialReference(reference, spec.channel);
  return reference;
}

/** Construct the revocation reference for a specific generation of a binding. */
export function buildWorkspaceHostCredentialRevocationReference(
  family: WorkspaceHostCredentialFamily,
  fields: Readonly<Record<string, string>>,
  generation: number,
): string {
  const spec = WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family];
  if (!spec) {
    throw new WorkspaceHostCredentialReferenceError(family, `unknown credential family '${family}'`);
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new WorkspaceHostCredentialReferenceError(
      String(generation),
      'credential generation must be a positive safe integer',
    );
  }
  const segments = spec.segments.map((label) => {
    const value = fields[label];
    if (typeof value !== 'string' || !REFERENCE_SEGMENT.test(value)) {
      throw new WorkspaceHostCredentialReferenceError(
        String(value),
        `${family} revocation field '${label}' must be a safe reference segment`,
      );
    }
    return value;
  });
  const reference = `${spec.revocationScheme}://${segments.join('/')}/g${generation}`;
  parseWorkspaceHostCredentialRevocationReference(reference, family);
  return reference;
}

/**
 * A binding validated against the namespace: the reference, the delivery, and the cross-checks
 * that only make sense with both in hand.
 */
export interface WorkspaceHostCredentialBindingDescriptor {
  readonly namespaceVersion: typeof WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION;
  readonly family: WorkspaceHostCredentialFamily;
  readonly channel: WorkspaceHostCredentialChannel;
  readonly reference: ParsedWorkspaceHostCredentialReference;
  readonly revocation: ParsedWorkspaceHostCredentialRevocationReference;
  readonly deliveryKind: WorkspaceHostCredentialDeliveryKind;
  readonly generation: number;
  readonly audience: string;
  readonly expiresAt?: string;
}

export interface DescribeWorkspaceHostCredentialBindingInput {
  channel: WorkspaceHostCredentialChannel;
  credentialRef: { kind: string; ref: string };
  delivery: WorkspaceHostCredentialDelivery;
  /** The instant the request was accepted; expiry is judged against it, never against `now`. */
  requestedAt: string;
}

/**
 * Validate one channel's reference + delivery pair against the namespace.
 *
 * Expiry is compared to `requestedAt`, not to wall-clock now, because that is the instant the
 * initialization contract itself compares against. A resolver that used its own clock would
 * accept or reject bindings the planner had already ruled on, and the two verdicts would diverge
 * exactly when a request sat in a queue.
 */
export function describeWorkspaceHostCredentialBinding(
  input: DescribeWorkspaceHostCredentialBindingInput,
): WorkspaceHostCredentialBindingDescriptor {
  const { channel, credentialRef, delivery, requestedAt } = input;
  if (!WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(channel)) {
    throw new WorkspaceHostCredentialReferenceError(
      String(channel),
      `unknown credential channel '${channel}'`,
    );
  }
  if (credentialRef?.kind !== channel) {
    throw new WorkspaceHostCredentialReferenceError(
      String(credentialRef?.ref),
      `credential reference kind '${credentialRef?.kind}' does not match channel '${channel}'`,
    );
  }

  const reference = parseWorkspaceHostCredentialReference(credentialRef.ref, channel);
  const spec = WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[reference.family];

  if (!spec.deliveryKinds.includes(delivery?.kind as WorkspaceHostCredentialDeliveryKind)) {
    throw new WorkspaceHostCredentialReferenceError(
      credentialRef.ref,
      `${reference.family} may not be delivered as '${delivery?.kind}'; allowed: ` +
        `${spec.deliveryKinds.join(', ')}`,
    );
  }
  if (!Number.isSafeInteger(delivery.generation) || delivery.generation < 1) {
    throw new WorkspaceHostCredentialReferenceError(
      credentialRef.ref,
      'credentialDelivery.generation must be a positive safe integer',
    );
  }

  const revocation = parseWorkspaceHostCredentialRevocationReference(
    delivery.revocationRef,
    reference.family,
  );
  if (revocation.generation !== delivery.generation) {
    throw new WorkspaceHostCredentialReferenceError(
      delivery.revocationRef,
      `revocation reference names generation ${revocation.generation} but the delivery is ` +
        `generation ${delivery.generation}; a rotation must revoke the generation it replaces`,
    );
  }
  if (revocation.segments.join('/') !== reference.segments.join('/')) {
    throw new WorkspaceHostCredentialReferenceError(
      delivery.revocationRef,
      `revocation reference does not identify the same subject as '${credentialRef.ref}'`,
    );
  }

  const requestedAtMs = Date.parse(requestedAt);
  if (!Number.isFinite(requestedAtMs)) {
    throw new WorkspaceHostCredentialReferenceError(
      String(requestedAt),
      'requestedAt must be an ISO timestamp',
    );
  }

  const needsExpiry = spec.requiresExpiry || delivery.kind === 'short-lived-delegation';
  if (needsExpiry) {
    const expiresAtMs = Date.parse(delivery.expiresAt ?? '');
    if (!Number.isFinite(expiresAtMs)) {
      throw new WorkspaceHostCredentialReferenceError(
        credentialRef.ref,
        `${reference.family} requires credentialDelivery.expiresAt`,
      );
    }
    if (expiresAtMs <= requestedAtMs) {
      throw new WorkspaceHostCredentialReferenceError(
        credentialRef.ref,
        `${reference.family} expiresAt must be after requestedAt`,
      );
    }
  }

  return {
    namespaceVersion: WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION,
    family: reference.family,
    channel,
    reference,
    revocation,
    deliveryKind: delivery.kind,
    generation: delivery.generation,
    audience: delivery.audience,
    ...(delivery.expiresAt ? { expiresAt: delivery.expiresAt } : {}),
  };
}

/**
 * Keys a materializer must never return. `assertWorkspaceHostSecretIsolation` already rejects
 * the classic secret-shaped names; this adds the words a credential materializer specifically
 * is tempted to use for the thing it just resolved, which that regex does not cover.
 */
const FORBIDDEN_EVIDENCE_KEYS: readonly string[] = [
  'material',
  'authorization',
  'credential',
  'credentials',
  'bearer',
  'assertion',
  'cookie',
  'jwt',
  'refresh',
];

export function assertNoResolvedAuthorizationMaterial(value: unknown, path: string): void {
  assertWorkspaceHostSecretIsolation(value, path);
  const visit = (candidate: unknown, currentPath: string): void => {
    if (candidate === null || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${currentPath}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
      const normalized = key.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
      if (FORBIDDEN_EVIDENCE_KEYS.some((forbidden) => normalized.split(/[_-]/).includes(forbidden))) {
        throw new Error(
          `Resolved authorization material is forbidden in credential evidence at ` +
            `${currentPath}.${key}`,
        );
      }
      visit(entry, `${currentPath}.${key}`);
    }
  };
  visit(value, path);
}

/**
 * The host-owned side of a credential family.
 *
 * This is where authorization material actually exists. Every method returns only PUBLIC
 * evidence; the resolved material never crosses this boundary, and the resolver asserts that on
 * the way out rather than trusting each implementation to have remembered.
 */
export interface WorkspaceHostCredentialMaterializer {
  readonly family: WorkspaceHostCredentialFamily;
  bind(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>>;
  verifyBound(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>>;
  revoke(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>>;
  verifyRevoked(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export type WorkspaceHostCredentialOperation =
  | 'bind'
  | 'verify-bound'
  | 'revoke'
  | 'verify-revoked';

export interface WorkspaceHostCredentialEvidence {
  readonly namespaceVersion: typeof WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION;
  readonly channel: WorkspaceHostCredentialChannel;
  readonly family: WorkspaceHostCredentialFamily;
  readonly operation: WorkspaceHostCredentialOperation;
  readonly deliveryKind: WorkspaceHostCredentialDeliveryKind;
  readonly generation: number;
  readonly audience: string;
  readonly revocationRef: string;
  /**
   * Stable, non-reversible discriminator for the reference. Two runs of the same binding produce
   * the same digest and a rotation produces a different one, so evidence can prove "the binding
   * changed" without republishing the reference into every receipt.
   */
  readonly referenceDigest: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export class UnknownWorkspaceHostCredentialFamilyError extends Error {
  readonly family: WorkspaceHostCredentialFamily;

  constructor(family: WorkspaceHostCredentialFamily) {
    super(
      `No host materializer is registered for credential family '${family}'. ` +
        `A host that cannot resolve a family must refuse the binding, not proceed unbound.`,
    );
    this.name = 'UnknownWorkspaceHostCredentialFamilyError';
    this.family = family;
  }
}

export function workspaceHostCredentialReferenceDigest(reference: string): string {
  return createHash('sha256').update(reference).digest('hex').slice(0, 32);
}

/**
 * The typed host-owned credential resolver.
 *
 * It owns validation and evidence discipline; the per-family materializers own the actual
 * binding. Splitting it this way is what lets the rotation, revocation and reconnect tests run
 * against real resolver logic with a fake materializer, instead of the tests only ever exercising
 * a mock of the whole resolver — which would prove nothing about the rules above.
 */
export class WorkspaceHostCredentialResolver {
  private readonly materializers: Map<
    WorkspaceHostCredentialFamily,
    WorkspaceHostCredentialMaterializer
  >;

  constructor(materializers: readonly WorkspaceHostCredentialMaterializer[]) {
    this.materializers = new Map();
    for (const materializer of materializers) {
      if (this.materializers.has(materializer.family)) {
        throw new Error(
          `Duplicate host materializer registered for credential family '${materializer.family}'`,
        );
      }
      this.materializers.set(materializer.family, materializer);
    }
  }

  get families(): readonly WorkspaceHostCredentialFamily[] {
    return [...this.materializers.keys()];
  }

  describe(
    input: DescribeWorkspaceHostCredentialBindingInput,
  ): WorkspaceHostCredentialBindingDescriptor {
    return describeWorkspaceHostCredentialBinding(input);
  }

  async run(
    operation: WorkspaceHostCredentialOperation,
    input: DescribeWorkspaceHostCredentialBindingInput,
  ): Promise<WorkspaceHostCredentialEvidence> {
    const binding = this.describe(input);
    const materializer = this.materializers.get(binding.family);
    if (!materializer) throw new UnknownWorkspaceHostCredentialFamilyError(binding.family);

    const detail =
      operation === 'bind'
        ? await materializer.bind(binding)
        : operation === 'verify-bound'
          ? await materializer.verifyBound(binding)
          : operation === 'revoke'
            ? await materializer.revoke(binding)
            : await materializer.verifyRevoked(binding);

    assertNoResolvedAuthorizationMaterial(
      detail ?? {},
      `workspaceHost.credential.${binding.channel}.${operation}`,
    );

    const evidence: WorkspaceHostCredentialEvidence = {
      namespaceVersion: WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION,
      channel: binding.channel,
      family: binding.family,
      operation,
      deliveryKind: binding.deliveryKind,
      generation: binding.generation,
      audience: binding.audience,
      revocationRef: input.delivery.revocationRef,
      referenceDigest: workspaceHostCredentialReferenceDigest(input.credentialRef.ref),
      detail: detail ?? {},
    };
    assertNoResolvedAuthorizationMaterial(
      evidence,
      `workspaceHost.credential.${binding.channel}.evidence`,
    );
    return evidence;
  }

  /** Execute one step of an already-planned credential lifecycle. */
  async executeLifecycleStep(
    step: WorkspaceHostCredentialLifecycleStep,
    requestedAt: string,
  ): Promise<WorkspaceHostCredentialEvidence> {
    return this.run(step.kind, {
      channel: step.channel,
      credentialRef: step.credentialRef,
      delivery: step.delivery,
      requestedAt,
    });
  }
}

export interface WorkspaceHostCredentialLifecycleReceipt {
  readonly stepId: string;
  readonly evidence: WorkspaceHostCredentialEvidence;
}

/**
 * Execute a lifecycle plan produced by `planWorkspaceHostCredentialLifecycle`.
 *
 * Dependency edges are ENFORCED rather than assumed from array order: the whole point of a
 * rotate plan is that the new binding is proven bound before the old one is revoked, and a
 * runner that merely iterated the array would still "pass" if the planner ever emitted them the
 * other way round.
 */
export async function executeWorkspaceHostCredentialLifecycle(
  plan: WorkspaceHostCredentialLifecyclePlan,
  resolver: WorkspaceHostCredentialResolver,
): Promise<readonly WorkspaceHostCredentialLifecycleReceipt[]> {
  const completed = new Set<string>();
  const receipts: WorkspaceHostCredentialLifecycleReceipt[] = [];
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!completed.has(dependency)) {
        throw new Error(
          `Credential lifecycle step '${step.id}' depends on '${dependency}', which has not completed`,
        );
      }
    }
    const evidence = await resolver.executeLifecycleStep(step, plan.requestedAt);
    receipts.push({ stepId: step.id, evidence });
    completed.add(step.id);
  }
  return receipts;
}
