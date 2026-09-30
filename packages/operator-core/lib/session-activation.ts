/**
 * Runtime state machine for an acknowledged session activation (D-030/P-040).
 *
 * The composition compiler owns the immutable specification revision.  This
 * module owns the small, mutable delivery record that says which revision is
 * desired, prepared, and actually applied by the host.  It is deliberately
 * pure so callers can persist each returned snapshot with their existing
 * control-anchor generation transaction.
 */
import type { SessionActivation } from '@papercusp/orchestrator/blueprint';

export type ActivationRevision = SessionActivation['desired'];
export type ActivationStatus = SessionActivation['status'];

export type ActivationDeliveryMode = 'soft' | 'fresh-context';
export type ActivationCarry = 'warm' | 'cold';
export type PrivateMemoryPolicy = 'preserve' | 'reset';

export interface ActivationContextPolicy {
  /** soft = inject at a safe point; fresh-context = relaunch/reset the prompt. */
  delivery: ActivationDeliveryMode;
  /** Work-state carry is explicit; it does not imply prompt-history carry. */
  carry: ActivationCarry;
  /** Private memory is scoped independently from public work-state carry. */
  privateMemory: PrivateMemoryPolicy;
}

export interface ActivationAttribution {
  actorId: string;
  principalId: string;
  sessionId: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function sameRevision(a: ActivationRevision | null | undefined, b: ActivationRevision): boolean {
  return Boolean(a && a.specificationRevision === b.specificationRevision && a.stateRevision === b.stateRevision);
}

function assertRevision(revision: ActivationRevision): ActivationRevision {
  if (!revision || !SHA256_RE.test(String(revision.specificationRevision ?? ''))) {
    throw new Error('session activation requires a lowercase sha256 specificationRevision');
  }
  if (!String(revision.stateRevision ?? '').trim()) {
    throw new Error('session activation requires a non-empty stateRevision');
  }
  return { specificationRevision: revision.specificationRevision, stateRevision: String(revision.stateRevision) };
}

function assertAttribution(attribution: ActivationAttribution): ActivationAttribution {
  for (const key of ['actorId', 'principalId', 'sessionId'] as const) {
    if (!String(attribution?.[key] ?? '').trim()) throw new Error(`session activation requires ${key}`);
  }
  return { actorId: attribution.actorId, principalId: attribution.principalId, sessionId: attribution.sessionId };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot(input: {
  attribution: ActivationAttribution;
  desired: ActivationRevision;
  prepared: ActivationRevision | null;
  applied: ActivationRevision | null;
  status: ActivationStatus;
  failure?: string;
}): SessionActivation {
  return freeze({
    schemaVersion: 1 as const,
    attribution: assertAttribution(input.attribution),
    desired: assertRevision(input.desired),
    prepared: input.prepared ? assertRevision(input.prepared) : null,
    applied: input.applied ? assertRevision(input.applied) : null,
    status: input.status,
    ...(input.failure?.trim() ? { failure: input.failure.trim() } : {}),
  }) as SessionActivation;
}

/** Validate and canonicalize a persisted activation envelope before projecting it. */
export function normalizeSessionActivation(value: unknown): SessionActivation | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('session activation must be an object');
  const raw = value as Record<string, unknown>;
  const status = raw.status;
  if (status !== 'desired' && status !== 'prepared' && status !== 'applied' && status !== 'failed') {
    throw new Error('session activation has an invalid status');
  }
  const attribution = raw.attribution as ActivationAttribution;
  const desired = assertRevision(raw.desired as ActivationRevision);
  const prepared = raw.prepared == null ? null : assertRevision(raw.prepared as ActivationRevision);
  const applied = raw.applied == null ? null : assertRevision(raw.applied as ActivationRevision);
  if (status === 'prepared' && !prepared) throw new Error('prepared activation requires a prepared revision');
  if (status === 'applied' && !applied) throw new Error('applied activation requires an applied revision');
  if (status === 'failed' && !String(raw.failure ?? '').trim()) throw new Error('failed activation requires a failure');
  return snapshot({ attribution, desired, prepared, applied, status, failure: typeof raw.failure === 'string' ? raw.failure : undefined });
}

/** Create the first desired record for a session. */
export function desiredActivation(
  attribution: ActivationAttribution,
  revision: ActivationRevision,
): SessionActivation {
  return snapshot({ attribution, desired: revision, prepared: null, applied: null, status: 'desired' });
}

/** Request a new revision. Repeating the same request is idempotent. */
export function requestActivation(current: SessionActivation, revision: ActivationRevision): SessionActivation {
  const desired = assertRevision(revision);
  if (sameRevision(current.desired, desired)) return current;
  return snapshot({
    attribution: current.attribution,
    desired,
    prepared: null,
    applied: current.applied,
    status: 'desired',
  });
}

/**
 * Begin a fresh host-delivery attempt, even when the immutable/state revisions
 * are unchanged (for example a carry-respawn).  The prior applied revision stays
 * truthful until the successor host acknowledges this delivery.
 */
export function restartActivation(
  current: SessionActivation,
  revision: ActivationRevision = current.desired,
): SessionActivation {
  return snapshot({
    attribution: current.attribution,
    desired: assertRevision(revision),
    prepared: null,
    applied: current.applied,
    status: 'desired',
  });
}

/** Mark a desired revision prepared only after validation/render succeeds. */
export function prepareActivation(current: SessionActivation, revision: ActivationRevision): SessionActivation {
  const prepared = assertRevision(revision);
  if (!sameRevision(current.desired, prepared)) throw new Error('stale activation revision cannot be prepared');
  if (sameRevision(current.applied, prepared)) return current;
  if (current.status === 'prepared' && sameRevision(current.prepared, prepared)) return current;
  return snapshot({ attribution: current.attribution, desired: current.desired, prepared, applied: current.applied, status: 'prepared' });
}

/**
 * Acknowledge only the revision that was prepared and accepted by the host.
 * A repeated acknowledgement is a harmless idempotent replay; a stale one is
 * rejected and cannot authorize a new side effect.
 */
export function acknowledgeActivation(current: SessionActivation, revision: ActivationRevision): SessionActivation {
  const applied = assertRevision(revision);
  if (sameRevision(current.applied, applied)) return current;
  if (!sameRevision(current.desired, applied) || !sameRevision(current.prepared, applied)) {
    throw new Error('activation acknowledgement does not match the prepared desired revision');
  }
  return snapshot({ attribution: current.attribution, desired: current.desired, prepared: null, applied, status: 'applied' });
}

/** Record a failed render/delivery while retaining the previous applied truth. */
export function failActivation(current: SessionActivation, revision: ActivationRevision, failure: string): SessionActivation {
  const failed = assertRevision(revision);
  if (sameRevision(current.applied, failed)) return current;
  if (!sameRevision(current.desired, failed)) throw new Error('stale activation failure cannot replace the desired revision');
  if (!String(failure ?? '').trim()) throw new Error('activation failure requires a reason');
  return snapshot({ attribution: current.attribution, desired: current.desired, prepared: null, applied: current.applied, status: 'failed', failure });
}

/** Only a prepared, current revision may authorize a new side effect. */
export function canApplyActivation(current: SessionActivation, revision: ActivationRevision): boolean {
  return current.status === 'prepared' && sameRevision(current.desired, revision) && sameRevision(current.prepared, revision);
}

/** Permission reductions use this applied revision immediately, independent of prompt delivery. */
export function appliedActivationRevision(current: SessionActivation | null | undefined): ActivationRevision | null {
  return current?.applied ?? null;
}

/** Explicit context policy for a stack delivery. */
export function contextPolicyForDelivery(
  delivery: 'inject-now' | 'relaunch-with-carry',
  overrides: Partial<ActivationContextPolicy> = {},
): ActivationContextPolicy {
  return {
    delivery: delivery === 'relaunch-with-carry' ? 'fresh-context' : 'soft',
    carry: 'warm',
    privateMemory: 'preserve',
    ...overrides,
  };
}

export function activationRevisionKey(revision: ActivationRevision): string {
  const checked = assertRevision(revision);
  return `${checked.specificationRevision}:${checked.stateRevision}`;
}

export function activationIdempotencyKey(sessionId: string, revision: ActivationRevision): string {
  if (!sessionId.trim()) throw new Error('activation idempotency key requires a sessionId');
  return `session-activation:${sessionId}:${activationRevisionKey(revision)}`;
}
