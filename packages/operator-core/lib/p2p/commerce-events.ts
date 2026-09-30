/**
 * Signed P2P commerce events (P-016).
 *
 * This stream is intentionally separate from `p2p_receipts`, whose wire contract
 * is reserved for refusal/honored operational receipts. Commerce events are
 * append-only facts; consumers project them into orders, entitlements, usage and
 * settlement views.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';

export const COMMERCE_EVENT_KINDS = [
  'offer',
  'order',
  'entitlement',
  'usage-reservation',
  'usage-receipt',
  'settlement-proof',
  'refund',
  'reversal',
  'revenue-split',
] as const;
export type CommerceEventKind = (typeof COMMERCE_EVENT_KINDS)[number];

export interface CommerceEvent {
  readonly eventId: string;
  readonly streamId: string;
  readonly kind: CommerceEventKind;
  readonly version: 1;
  readonly issuer: string;
  readonly sequence: number;
  readonly occurredAtMs: number;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Base64 signature over `commerceEventSigningBytes` (added by the caller). */
  readonly signature: string;
}

export function commerceEventSigningBytes(event: Omit<CommerceEvent, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(event), 'utf8');
}

export function commerceEventDigest(event: Omit<CommerceEvent, 'signature'>): string {
  return createHash('sha256').update(commerceEventSigningBytes(event)).digest('hex');
}

/** Strip the signature so a signed event can be re-digested (TS6 rejects the `signature: undefined as never` spread). */
export function unsignedCommerceEvent(event: CommerceEvent): Omit<CommerceEvent, 'signature'> {
  const { signature: _signature, ...unsigned } = event;
  void _signature;
  return unsigned;
}

export type CommerceEventValidationCode =
  | 'invalid-shape'
  | 'invalid-kind'
  | 'invalid-sequence'
  | 'invalid-time'
  | 'missing-idempotency-key'
  | 'missing-signature';

export function validateCommerceEvent(event: unknown): { ok: true; event: CommerceEvent } | { ok: false; code: CommerceEventValidationCode; detail: string } {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, code: 'invalid-shape', detail: 'event must be an object' };
  const e = event as Partial<CommerceEvent>;
  if (typeof e.eventId !== 'string' || !e.eventId.trim() || typeof e.streamId !== 'string' || !e.streamId.trim() || typeof e.issuer !== 'string' || !e.issuer.trim() || !e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) {
    return { ok: false, code: 'invalid-shape', detail: 'eventId, streamId, issuer, and object payload are required' };
  }
  if (!COMMERCE_EVENT_KINDS.includes(e.kind as CommerceEventKind)) return { ok: false, code: 'invalid-kind', detail: `unsupported commerce event kind '${String(e.kind)}'` };
  if (e.version !== 1 || !Number.isSafeInteger(e.sequence) || (e.sequence as number) < 0) return { ok: false, code: 'invalid-sequence', detail: 'version must be 1 and sequence must be a non-negative safe integer' };
  if (!Number.isFinite(e.occurredAtMs) || (e.occurredAtMs as number) < 0) return { ok: false, code: 'invalid-time', detail: 'occurredAtMs must be a non-negative finite number' };
  if (typeof e.idempotencyKey !== 'string' || !e.idempotencyKey.trim()) return { ok: false, code: 'missing-idempotency-key', detail: 'idempotencyKey is required' };
  if (typeof e.signature !== 'string' || !e.signature.trim()) return { ok: false, code: 'missing-signature', detail: 'signature is required' };
  return { ok: true, event: e as CommerceEvent };
}

export interface CommerceConflict {
  readonly streamId: string;
  readonly sequence: number;
  readonly eventIds: string[];
  readonly reason: 'sequence-conflict' | 'idempotency-conflict';
}

export interface CommerceEventReduction {
  readonly accepted: CommerceEvent[];
  readonly duplicates: string[];
  readonly conflicts: CommerceConflict[];
  readonly invalid: Array<{ eventId: string | null; code: CommerceEventValidationCode }>;
}

/**
 * Deterministically fold an unordered batch. Exact event ids are idempotent;
 * two different facts claiming the same stream sequence or idempotency key are
 * quarantined as conflicts. Accepted facts are sorted by stream, sequence, id.
 */
export function reduceCommerceEvents(events: readonly unknown[]): CommerceEventReduction {
  const valid: CommerceEvent[] = [];
  const invalid: CommerceEventReduction['invalid'] = [];
  for (const raw of events) {
    const result = validateCommerceEvent(raw);
    if (result.ok) valid.push(result.event);
    else invalid.push({ eventId: raw && typeof raw === 'object' && 'eventId' in raw ? String((raw as { eventId?: unknown }).eventId ?? '') || null : null, code: result.code });
  }
  const byId = new Map<string, CommerceEvent>();
  const bySequence = new Map<string, CommerceEvent>();
  const byIdempotency = new Map<string, CommerceEvent>();
  const duplicates: string[] = [];
  const conflicts: CommerceConflict[] = [];
  const conflicted = new Set<string>();
  for (const event of valid) {
    const priorId = byId.get(event.eventId);
    if (priorId) {
      if (commerceEventDigest(priorId) === commerceEventDigest(event)) duplicates.push(event.eventId);
      else {
        conflicts.push({ streamId: event.streamId, sequence: event.sequence, eventIds: [priorId.eventId, event.eventId].sort(), reason: 'sequence-conflict' });
        conflicted.add(event.eventId); conflicted.add(priorId.eventId);
      }
      continue;
    }
    byId.set(event.eventId, event);
    const sequenceKey = `${event.streamId}\0${event.sequence}`;
    const priorSequence = bySequence.get(sequenceKey);
    if (priorSequence && priorSequence.eventId !== event.eventId) {
      conflicts.push({ streamId: event.streamId, sequence: event.sequence, eventIds: [priorSequence.eventId, event.eventId].sort(), reason: 'sequence-conflict' });
      conflicted.add(event.eventId); conflicted.add(priorSequence.eventId);
    } else bySequence.set(sequenceKey, event);
    const idemKey = `${event.issuer}\0${event.idempotencyKey}`;
    const priorIdem = byIdempotency.get(idemKey);
    if (priorIdem && priorIdem.eventId !== event.eventId) {
      conflicts.push({ streamId: event.streamId, sequence: event.sequence, eventIds: [priorIdem.eventId, event.eventId].sort(), reason: 'idempotency-conflict' });
      conflicted.add(event.eventId); conflicted.add(priorIdem.eventId);
    } else byIdempotency.set(idemKey, event);
  }
  const accepted = [...byId.values()].filter((event) => !conflicted.has(event.eventId)).sort((a, b) => a.streamId.localeCompare(b.streamId) || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
  return { accepted, duplicates, conflicts, invalid };
}
