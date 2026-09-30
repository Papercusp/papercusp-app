/**
 * Host-neutral kernel enforcement contract (identities-v1 / D-030).
 *
 * The tool framework owns the *seat* at which a decision is observed; a host
 * owns the policy that produces the decision.  Keeping this contract here is
 * intentional: direct MCP calls, in-process re-dispatch, reactions, and
 * native/shell adapters can all use one typed port without importing an
 * operator-specific policy engine.
 *
 * There are two dispatch phases with different safety properties:
 *
 *  - `preflight` runs before decorators/handler side effects and is where a
 *    host can validate ownership, the current activation, and revocation.
 *  - `enforce` runs immediately before the operation crosses its execution
 *    boundary.  A permission reduction that arrives while a handler is being
 *    prepared is therefore observed here, rather than being deferred until a
 *    prompt or acknowledgement catches up.
 *
 * `observe` is a phase for non-blocking shadow observations (and is also a
 * useful boundary label for native adapters).  The generic layer never turns
 * an unavailable optional policy into a denial; an explicit `decision:'deny'`
 * is always preserved and is fail-closed by callers.
 */

import type { PluginSpawn, PluginSpawnOptions, PluginSpawnResult } from './host-types';
import type { UnifiedToolContext } from './tool-projection';

export const KERNEL_ENFORCEMENT_SCHEMA = 'kernel-enforcement-v1' as const;

/** Where a policy check is being made. */
export type KernelEnforcementPhase = 'preflight' | 'enforce' | 'observe';

/** Reachable execution seats.  Hosts may use `custom` for an additional seat. */
export type KernelBoundary =
  | 'dispatch'
  | 'indirect-dispatch'
  | 'reaction'
  | 'native'
  | 'shell'
  | 'lifecycle'
  | 'activation'
  | 'custom';

/** The only decisions the policy port may return. */
export type KernelDecision = 'allow' | 'deny' | 'observe';

/** Whether a decision was backed by a readable policy source. */
export type KernelAvailability = 'available' | 'unavailable' | 'unknown';

/** A pair of immutable specification/state revisions. */
export interface KernelExecutionRevision {
  specificationRevision: string;
  stateRevision: string;
}

/** Alias used by callers that call the value an activation revision. */
export type KernelActivationRevision = KernelExecutionRevision;

/** Optional ownership evidence supplied by a host at the enforcement seat. */
export interface KernelOwnershipRequirement {
  /** A check is required only when this is true. */
  required?: boolean;
  /** The durable work item/resource the operation intends to mutate. */
  resourceId?: string | null;
  /** The owner the host resolved for that resource, if it has one. */
  resourceOwnerId?: string | null;
}

/**
 * Optional activation snapshot carried by a host context.  The generic layer
 * does not interpret storage or lifecycle rows; it only gives an adapter a
 * typed place to expose the already-resolved truth at the enforcement seat.
 */
export interface KernelActivationSnapshot {
  desired?: KernelExecutionRevision | null;
  prepared?: KernelExecutionRevision | null;
  applied?: KernelExecutionRevision | null;
  status?: 'desired' | 'prepared' | 'applied' | 'failed';
  failure?: string | null;
}

/**
 * Host-resolved state that can be threaded through `UnifiedToolContext`.
 * `revoked` is explicit rather than inferred from a missing row: an
 * unavailable optional store remains an unavailable allow, while a host that
 * knows a session/identity was revoked can fail closed immediately.
 */
export interface KernelContextState {
  revoked?: boolean;
  activation?: KernelActivationSnapshot | null;
  ownership?: KernelOwnershipRequirement;
  appliedRevision?: KernelExecutionRevision | null;
  requestedRevision?: KernelExecutionRevision | null;
  policyRevision?: string | null;
}

/** Input to the host policy decision point. */
export interface KernelEnforcementRequest {
  phase: KernelEnforcementPhase;
  boundary: KernelBoundary;
  toolName: string;
  capabilities: readonly string[];
  args: unknown;
  ctx: UnifiedToolContext;
  /** Stable per-dispatch correlation id, when this is a dispatcher call. */
  callId?: string;
  /** The revision the host says is currently applied, if known. */
  appliedRevision?: KernelExecutionRevision | null;
  /** The revision a caller is asking to use, if the boundary has one. */
  requestedRevision?: KernelExecutionRevision | null;
  ownership?: KernelOwnershipRequirement;
  /** Native/shell adapters may identify the concrete executable separately. */
  operation?: string;
}

/** The typed result returned by the host policy port. */
export interface KernelEnforcementResult {
  decision: KernelDecision;
  /** Stable machine-readable reason (`revoked`, `stale-activation`, …). */
  code?: string;
  reason?: string;
  availability?: KernelAvailability;
  /** True when the host actually applied this policy, false for an exemption. */
  applied?: boolean;
  /** Only an actually applied revision may be used for execution attribution. */
  executionRevision?: KernelExecutionRevision | null;
  revisionSource?: 'applied' | 'prepared' | 'desired' | 'unknown';
  /** Host policy revision, distinct from the agent specification revision. */
  policyRevision?: string | null;
  obligations?: Readonly<Record<string, unknown>>;
  /** Host-authored identity/decision facts forwarded to telemetry; never authorize a call. */
  serverAudit?: Readonly<Record<string, unknown>>;
}

/** The host implementation of the single policy/enforcement port. */
export type KernelEnforcementPort = (
  request: KernelEnforcementRequest,
) => KernelEnforcementResult | null | undefined | Promise<KernelEnforcementResult | null | undefined>;

/** Names accepted by older host adapters while they migrate to the port name. */
export type KernelPolicyPort = KernelEnforcementPort;

const EMPTY_ALLOW: KernelEnforcementResult = Object.freeze({
  decision: 'allow',
  availability: 'unavailable',
  applied: false,
});

function validRevision(value: unknown): value is KernelExecutionRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.specificationRevision === 'string' &&
    row.specificationRevision.trim().length > 0 &&
    typeof row.stateRevision === 'string' &&
    row.stateRevision.trim().length > 0;
}

/** Compare revisions without allowing a desired/prepared value to masquerade as applied. */
export function sameKernelRevision(
  a: KernelExecutionRevision | null | undefined,
  b: KernelExecutionRevision | null | undefined,
): boolean {
  return Boolean(a && b && a.specificationRevision === b.specificationRevision && a.stateRevision === b.stateRevision);
}

export const sameExecutionRevision = sameKernelRevision;

export function kernelRevisionKey(revision: KernelExecutionRevision | null | undefined): string | null {
  return validRevision(revision)
    ? `${revision.specificationRevision}:${revision.stateRevision}`
    : null;
}

export const executionRevisionKey = kernelRevisionKey;

/**
 * Canonicalize an untrusted host result.  A malformed/absent optional result
 * becomes an unavailable allow; an explicit deny is never weakened.  A
 * prepared/desired revision is intentionally removed from an enforce result
 * so telemetry cannot claim that a revision ran before the host applied it.
 */
export function normalizeKernelEnforcementResult(
  value: KernelEnforcementResult | null | undefined,
  phase: KernelEnforcementPhase,
): KernelEnforcementResult {
  if (!value || typeof value !== 'object') return EMPTY_ALLOW;
  const decision: KernelDecision = value.decision === 'deny' || value.decision === 'observe'
    ? value.decision
    : 'allow';
  const normalized: KernelEnforcementResult = {
    decision,
    ...(typeof value.code === 'string' && value.code.trim() ? { code: value.code.trim() } : {}),
    ...(typeof value.reason === 'string' && value.reason.trim() ? { reason: value.reason.trim() } : {}),
    availability: value.availability === 'available' || value.availability === 'unknown'
      ? value.availability
      : 'unavailable',
    ...(typeof value.applied === 'boolean' ? { applied: value.applied } : {}),
    ...(typeof value.policyRevision === 'string' || value.policyRevision === null
      ? { policyRevision: value.policyRevision }
      : {}),
    ...(value.obligations && typeof value.obligations === 'object' && !Array.isArray(value.obligations)
      ? { obligations: value.obligations }
      : {}),
    ...(value.serverAudit && typeof value.serverAudit === 'object' && !Array.isArray(value.serverAudit)
      ? { serverAudit: value.serverAudit }
      : {}),
  };
  const source = value.revisionSource;
  if (source === 'applied' || source === 'prepared' || source === 'desired' || source === 'unknown') {
    normalized.revisionSource = source;
  }
  if (validRevision(value.executionRevision) &&
      (phase !== 'enforce' || normalized.revisionSource === 'applied')) {
    normalized.executionRevision = {
      specificationRevision: value.executionRevision.specificationRevision,
      stateRevision: value.executionRevision.stateRevision,
    };
  } else if (value.executionRevision === null) {
    normalized.executionRevision = null;
  }
  return normalized;
}

/**
 * Ask the host port, preserving the fail-soft rule for unavailable optional
 * state.  A host that needs fail-closed behavior returns an explicit deny (and
 * may use `code:'revoked'` / `code:'stale-activation'`); it must not throw and
 * rely on callers to guess whether the throw was policy or infrastructure.
 */
export async function evaluateKernelEnforcement(
  port: KernelEnforcementPort | undefined,
  request: KernelEnforcementRequest,
): Promise<KernelEnforcementResult> {
  if (!port) return EMPTY_ALLOW;
  try {
    return normalizeKernelEnforcementResult(await port(request), request.phase);
  } catch {
    return EMPTY_ALLOW;
  }
}

export const evaluateKernelDecision = evaluateKernelEnforcement;

/** True only for an explicit policy denial. */
export function isKernelDenied(result: KernelEnforcementResult | null | undefined): boolean {
  return result?.decision === 'deny';
}

/**
 * Return a revision suitable for execution telemetry.  Desired/prepared
 * values, and revisions from a preflight-only result, are deliberately not
 * accepted.  This is the small guard that keeps "what was requested" from
 * being reported as "what actually ran".
 */
export function appliedExecutionRevision(
  result: KernelEnforcementResult | null | undefined,
  phase: KernelEnforcementPhase = 'enforce',
): KernelExecutionRevision | null {
  if (!result || phase !== 'enforce' || result.revisionSource !== 'applied' || !validRevision(result.executionRevision)) {
    return null;
  }
  return {
    specificationRevision: result.executionRevision.specificationRevision,
    stateRevision: result.executionRevision.stateRevision,
  };
}

export const actualExecutionRevision = appliedExecutionRevision;

/** Stable error used by native/shell wrappers when the boundary is revoked. */
export class KernelEnforcementDeniedError extends Error {
  override readonly name = 'KernelEnforcementDeniedError';
  readonly result: KernelEnforcementResult;

  constructor(result: KernelEnforcementResult) {
    super(result.reason || result.code || 'kernel enforcement denied this operation');
    this.result = result;
  }
}

/**
 * Run an operation at a non-dispatch boundary (native tool or shell).  The
 * operation is never called after an explicit denial.  The resolved result is
 * handed to the callback so a caller can stamp its own completion record.
 */
export async function enforceKernelBoundary<T>(
  port: KernelEnforcementPort | undefined,
  request: Omit<KernelEnforcementRequest, 'phase'> & { phase?: KernelEnforcementPhase },
  operation: (decision: KernelEnforcementResult) => T | Promise<T>,
): Promise<T> {
  const phase = request.phase ?? 'enforce';
  const decision = await evaluateKernelEnforcement(port, { ...request, phase });
  if (isKernelDenied(decision)) throw new KernelEnforcementDeniedError(decision);
  return operation(decision);
}

export const runAtKernelBoundary = enforceKernelBoundary;

/**
 * Wrap a host subprocess executor.  This is deliberately opt-in: a generic
 * host that has no policy port keeps the exact old spawn behavior, while an
 * operator can install the same enforcement decision used by dispatch.
 */
export function wrapKernelSpawn(
  spawn: PluginSpawn,
  port: KernelEnforcementPort | undefined,
  request: (bin: string, args: readonly string[], opts?: PluginSpawnOptions) => Omit<KernelEnforcementRequest, 'phase' | 'operation' | 'boundary'>,
): PluginSpawn {
  return async (bin, args, opts): Promise<PluginSpawnResult> =>
    enforceKernelBoundary(
      port,
      {
        ...request(bin, args, opts),
        phase: 'enforce',
        boundary: 'shell',
        operation: `${bin} ${args.join(' ')}`.trim(),
      },
      () => spawn(bin, args, opts),
    );
}

export const wrapNativeSpawn = wrapKernelSpawn;

/**
 * Build a small adapter from a resolver.  It is useful for hosts whose policy
 * is synchronous (cached activation/revocation state) and keeps the generic
 * dispatcher independent from that store.  Returning null means optional
 * state is unavailable and therefore does not block the operation.
 */
export function createKernelEnforcementPort(
  resolver: (request: KernelEnforcementRequest) => KernelEnforcementResult | null | undefined | Promise<KernelEnforcementResult | null | undefined>,
): KernelEnforcementPort {
  return async (request) => resolver(request);
}

export const createKernelPolicyPort = createKernelEnforcementPort;

/** A reusable no-op port for standalone hosts and tests. */
export function allowKernelEnforcement(): KernelEnforcementResult {
  return EMPTY_ALLOW;
}
