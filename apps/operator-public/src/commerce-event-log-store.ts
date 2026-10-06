/**
 * Durable append-only store for signed P-016 commerce events.
 *
 * P-016 defined the event contract and `reduceCommerceEvents` folded a batch of
 * them, but nothing persisted one. P-033 needs its `settlement-proof` facts to
 * survive, so the log lands here as the GENERAL surface: P-035's ledger-to-P2P
 * bridge should append through this module rather than open a second log.
 *
 * Appends are idempotent by `idempotencyKey` and refuse a second fact claiming
 * an occupied `(streamId, sequence)` — the same two conflict rules
 * `reduceCommerceEvents` applies in memory, enforced by the unique indexes so
 * they also hold across processes and restarts.
 */
import {
  validateCommerceEvent,
  type CommerceEvent,
} from '@papercusp/operator-core/lib/p2p/commerce-events.ts';
import { witnessAfterAppend } from './ledger-chain-store.ts';

export interface StoredCommerceEvent {
  readonly event: CommerceEvent;
  readonly recordedAtMs: number;
}

interface CommerceEventRow {
  event_id: string;
  stream_id: string;
  kind: string;
  version: number;
  issuer: string;
  sequence: number;
  occurred_at_ms: number;
  idempotency_key: string;
  payload: string;
  signature: string;
  recorded_at_ms: number;
}

const COLUMNS = `event_id, stream_id, kind, version, issuer, sequence,
       occurred_at_ms, idempotency_key, payload, signature, recorded_at_ms`;

function fromRow(row: CommerceEventRow): StoredCommerceEvent {
  const payload: unknown = JSON.parse(row.payload);
  return {
    event: {
      eventId: row.event_id,
      streamId: row.stream_id,
      kind: row.kind as CommerceEvent['kind'],
      version: 1,
      issuer: row.issuer,
      sequence: Number(row.sequence),
      occurredAtMs: Number(row.occurred_at_ms),
      idempotencyKey: row.idempotency_key,
      payload:
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {},
      signature: row.signature,
    },
    recordedAtMs: Number(row.recorded_at_ms),
  };
}

export type AppendCommerceEventResult =
  | { readonly ok: true; readonly appended: boolean; readonly event: StoredCommerceEvent }
  | {
      readonly ok: false;
      readonly code: 'invalid-event' | 'sequence-conflict';
      readonly detail: string;
    };

export async function getCommerceEvent(
  db: D1Database,
  eventId: string,
): Promise<StoredCommerceEvent | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM commerce_event_log WHERE event_id = ?`)
    .bind(eventId)
    .first<CommerceEventRow>();
  return row ? fromRow(row) : null;
}

export async function listCommerceEvents(
  db: D1Database,
  streamId: string,
): Promise<readonly StoredCommerceEvent[]> {
  const rows = await db
    .prepare(`SELECT ${COLUMNS} FROM commerce_event_log WHERE stream_id = ? ORDER BY sequence ASC`)
    .bind(streamId)
    .all<CommerceEventRow>();
  return (rows.results ?? []).map(fromRow);
}

/** The next free sequence number on a stream. */
export async function nextCommerceEventSequence(
  db: D1Database,
  streamId: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT MAX(sequence) AS max_sequence FROM commerce_event_log WHERE stream_id = ?`)
    .bind(streamId)
    .first<{ max_sequence: number | null }>();
  const max = row?.max_sequence;
  return max == null ? 0 : Number(max) + 1;
}

export async function appendCommerceEvent(
  db: D1Database,
  event: CommerceEvent,
  nowMs: number,
): Promise<AppendCommerceEventResult> {
  const validated = validateCommerceEvent(event);
  if (!validated.ok) return { ok: false, code: 'invalid-event', detail: validated.detail };

  const existing = await getCommerceEvent(db, event.eventId);
  if (existing) return { ok: true, appended: false, event: existing };

  try {
    await db
      .prepare(
        `INSERT INTO commerce_event_log
           (event_id, stream_id, kind, version, issuer, sequence, occurred_at_ms,
            idempotency_key, payload, signature, recorded_at_ms)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.eventId,
        event.streamId,
        event.kind,
        event.issuer,
        event.sequence,
        event.occurredAtMs,
        event.idempotencyKey,
        JSON.stringify(event.payload),
        event.signature,
        nowMs,
      )
      .run();
    await witnessAfterAppend(db, 'commerce.event-log', nowMs);
  } catch (error) {
    // A unique-index collision here is a DIFFERENT fact claiming an occupied
    // (stream, sequence) or idempotency key — the durable half of
    // `reduceCommerceEvents`' conflict quarantine. An identical replay was
    // already answered above by event id.
    const replayed = await getCommerceEvent(db, event.eventId);
    if (replayed) return { ok: true, appended: false, event: replayed };
    return {
      ok: false,
      code: 'sequence-conflict',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const stored = await getCommerceEvent(db, event.eventId);
  if (!stored) throw new Error(`commerce event '${event.eventId}' vanished immediately after insert`);
  return { ok: true, appended: true, event: stored };
}
