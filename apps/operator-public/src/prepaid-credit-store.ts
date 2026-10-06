/**
 * D1 event store + rebuildable projections for Stripe-funded prepaid credits.
 *
 * The commerce ledger is the authority for grants and reversals. This store
 * persists only explicit reservation lifecycle facts, then rebuilds balances
 * and reservations from both logs through the shared reducer.
 */
import {
  reducePrepaidCredits,
  serializePrepaidCreditState,
  type PrepaidCreditEvent,
  type PrepaidCreditLedgerState,
  type PrepaidCreditRejectionCode,
} from '@papercusp/operator-core/lib/cupboard/prepaid-credits.ts';
import { loadLedgerEvents } from './commerce-store.ts';
import { witnessAfterAppend } from './ledger-chain-store.ts';

interface PrepaidCreditEventRow {
  credit_event_id: string;
  kind: string;
  occurred_at_ms: number;
  principal_id: string;
  payload_json: string;
}

export interface AppendPrepaidCreditEventInput {
  readonly creditEventId: string;
  readonly kind: PrepaidCreditEvent['kind'];
  readonly principalId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly nowMs?: number;
}

export type AppendPrepaidCreditEventResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly event: PrepaidCreditEvent;
      readonly state: PrepaidCreditLedgerState;
    }
  | {
      readonly ok: false;
      readonly code: PrepaidCreditRejectionCode;
      readonly detail: string;
    };

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function eventFromRow(row: PrepaidCreditEventRow): PrepaidCreditEvent {
  return {
    creditEventId: row.credit_event_id,
    kind: row.kind as PrepaidCreditEvent['kind'],
    occurredAtMs: Number(row.occurred_at_ms),
    principalId: row.principal_id,
    payload: parsePayload(row.payload_json),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sameSemanticEvent(
  event: PrepaidCreditEvent,
  input: AppendPrepaidCreditEventInput,
): boolean {
  return (
    event.creditEventId === input.creditEventId &&
    event.kind === input.kind &&
    event.principalId === input.principalId &&
    canonicalJson(event.payload) === canonicalJson(input.payload)
  );
}

async function getPrepaidCreditEvent(
  db: D1Database,
  creditEventId: string,
): Promise<PrepaidCreditEvent | null> {
  const row = await db
    .prepare(
      `SELECT credit_event_id, kind, occurred_at_ms, principal_id, payload_json
       FROM prepaid_credit_events
       WHERE credit_event_id = ?`,
    )
    .bind(creditEventId)
    .first<PrepaidCreditEventRow>();
  return row ? eventFromRow(row) : null;
}

export async function loadPrepaidCreditEvents(
  db: D1Database,
): Promise<PrepaidCreditEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT credit_event_id, kind, occurred_at_ms, principal_id, payload_json
       FROM prepaid_credit_events
       ORDER BY occurred_at_ms ASC, credit_event_id ASC`,
    )
    .all<PrepaidCreditEventRow>();
  return (results ?? []).map(eventFromRow);
}

export async function loadPrepaidCreditState(
  db: D1Database,
): Promise<PrepaidCreditLedgerState> {
  const [commerceEvents, creditEvents] = await Promise.all([
    loadLedgerEvents(db),
    loadPrepaidCreditEvents(db),
  ]);
  return reducePrepaidCredits(commerceEvents, creditEvents);
}

async function replacePrepaidCreditProjection(
  db: D1Database,
  state: PrepaidCreditLedgerState,
): Promise<void> {
  const serialized = serializePrepaidCreditState(state);
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM prepaid_credit_reservations'),
    db.prepare('DELETE FROM prepaid_credit_balances'),
  ];

  for (const balance of serialized.balances) {
    statements.push(
      db
        .prepare(
          `INSERT INTO prepaid_credit_balances
           (principal_id, available_micros, reserved_micros, spent_micros, debt_micros,
            granted_micros, reversed_micros, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          balance.principalId,
          balance.availableMicros,
          balance.reservedMicros,
          balance.spentMicros,
          balance.debtMicros,
          balance.grantedMicros,
          balance.reversedMicros,
          balance.updatedAtMs,
        ),
    );
  }

  for (const reservation of serialized.reservations) {
    statements.push(
      db
        .prepare(
          `INSERT INTO prepaid_credit_reservations
           (reservation_id, principal_id, channel_id, reserved_micros, committed_micros,
            state, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          reservation.reservationId,
          reservation.principalId,
          reservation.channelId,
          reservation.reservedMicros,
          reservation.committedMicros,
          reservation.state,
          reservation.createdAtMs,
          reservation.updatedAtMs,
        ),
    );
  }

  await db.batch(statements);
}

export async function projectPrepaidCredits(
  db: D1Database,
): Promise<PrepaidCreditLedgerState> {
  const state = await loadPrepaidCreditState(db);
  await replacePrepaidCreditProjection(db, state);
  return state;
}

function rejectionFor(
  state: PrepaidCreditLedgerState,
  creditEventId: string,
): { code: PrepaidCreditRejectionCode; detail: string } | null {
  const rejection = state.rejected.find((row) => row.eventId === creditEventId);
  return rejection ? { code: rejection.code, detail: rejection.detail } : null;
}

/**
 * Append one authenticated reservation fact.
 *
 * The event id is the idempotency key. A retry with the same semantic event is
 * a replay even though the server would otherwise assign a new timestamp; a
 * different event under that id is a conflict. New timestamps advance past the
 * current event log so reserve -> settle/release ordering cannot depend on two
 * requests landing in the same millisecond.
 */
export async function appendPrepaidCreditEvent(
  db: D1Database,
  input: AppendPrepaidCreditEventInput,
): Promise<AppendPrepaidCreditEventResult> {
  const [commerceEvents, creditEvents] = await Promise.all([
    loadLedgerEvents(db),
    loadPrepaidCreditEvents(db),
  ]);
  const existing = creditEvents.find((event) => event.creditEventId === input.creditEventId);
  if (existing) {
    if (!sameSemanticEvent(existing, input)) {
      return {
        ok: false,
        code: 'duplicate-conflict',
        detail: 'a different credit fact already carries this creditEventId',
      };
    }
    const state = reducePrepaidCredits(commerceEvents, creditEvents);
    const rejection = rejectionFor(state, existing.creditEventId);
    if (rejection) return { ok: false, ...rejection };
    await replacePrepaidCreditProjection(db, state);
    return { ok: true, replayed: true, event: existing, state };
  }

  const currentState = reducePrepaidCredits(commerceEvents, creditEvents);
  if (input.kind === 'credit.reserved') {
    const channelId = input.payload.channelId;
    const reservationId = input.payload.reservationId;
    if (typeof channelId === 'string' && typeof reservationId === 'string') {
      const channelConflict = [...currentState.reservations.values()].find(
        (reservation) =>
          reservation.channelId === channelId &&
          reservation.reservationId !== reservationId,
      );
      if (channelConflict) {
        return {
          ok: false,
          code: 'reservation-conflict',
          detail: `channel ${channelId} already funds reservation ${channelConflict.reservationId}`,
        };
      }
    }
  }

  const latestCreditAtMs = creditEvents.reduce(
    (latest, event) => Math.max(latest, event.occurredAtMs),
    -1,
  );
  const latestCommerceAtMs = commerceEvents.reduce(
    (latest, event) => Math.max(latest, event.occurredAtMs),
    -1,
  );
  const requestedAtMs = input.nowMs ?? Date.now();
  const event: PrepaidCreditEvent = {
    creditEventId: input.creditEventId,
    kind: input.kind,
    occurredAtMs: Math.max(
      requestedAtMs,
      latestCreditAtMs + 1,
      latestCommerceAtMs + 1,
    ),
    principalId: input.principalId,
    payload: input.payload,
  };
  const candidateState = reducePrepaidCredits(commerceEvents, [...creditEvents, event]);
  const candidateRejection = rejectionFor(candidateState, event.creditEventId);
  if (candidateRejection) return { ok: false, ...candidateRejection };

  await db
    .prepare(
      `INSERT INTO prepaid_credit_events
       (credit_event_id, kind, occurred_at_ms, principal_id, payload_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(credit_event_id) DO NOTHING`,
    )
    .bind(
      event.creditEventId,
      event.kind,
      event.occurredAtMs,
      event.principalId,
      JSON.stringify(event.payload),
    )
    .run();
  await witnessAfterAppend(db, 'commerce.prepaid-credits', requestedAtMs);

  const stored = await getPrepaidCreditEvent(db, event.creditEventId);
  if (!stored) {
    throw new Error(`prepaid credit event ${event.creditEventId} was not persisted`);
  }
  if (!sameSemanticEvent(stored, input)) {
    return {
      ok: false,
      code: 'duplicate-conflict',
      detail: 'a concurrent request persisted different terms under this creditEventId',
    };
  }

  const [finalCommerceEvents, finalCreditEvents] = await Promise.all([
    loadLedgerEvents(db),
    loadPrepaidCreditEvents(db),
  ]);
  const state = reducePrepaidCredits(finalCommerceEvents, finalCreditEvents);
  await replacePrepaidCreditProjection(db, state);
  const finalRejection = rejectionFor(state, stored.creditEventId);
  if (finalRejection) return { ok: false, ...finalRejection };
  return { ok: true, replayed: false, event: stored, state };
}
