/**
 * Shared external-trigger ingestion seam.
 *
 * Provider adapters normalize exactly once, then this module validates the
 * canonical payload datatype, claims one durable delivery row per sink, and
 * fans the SAME normalized event into the event bus plus optional sinks (for
 * example Personal Vault). Replays are idempotent per source/dedupe/sink.
 */
import type postgres from 'postgres';
import { getDatatype } from '../datatype-registry-store';
import { validateDatatypePayload } from '../datatype-payload-validation';
import { buildKey } from '../events/await/catalog';
import {
  emitAwaitedEvent,
  type EmitAwaitedEventOpts,
  type EmitResult,
} from '../events/await/engine';
import type { NormalizedExternalEvent } from '../personal-vault/live-sink';
import { createTriggerBindingSink } from './binding-engine';
import { getExternalTriggerSource } from './source-store';

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const EVENT_NAME = /^[a-z0-9][a-z0-9.-]*$/;

export interface ExternalTriggerSink {
  kind: string;
  ref: string;
  deliver(event: CanonicalExternalEvent): Promise<unknown>;
}

export interface CanonicalExternalEvent extends NormalizedExternalEvent {
  workspaceId: string;
  source: string;
  event: string;
  sourceId: string;
  datatypeId: string;
  dedupeKey: string;
}

export interface IngestExternalTriggerInput {
  workspaceId: string;
  sourceId: string;
  source: string;
  event: string;
  externalId: string;
  datatypeId: string;
  adapterPayload: unknown;
  normalize(payload: unknown): Record<string, unknown> | Promise<Record<string, unknown>>;
  occurredAt?: string | null;
  dedupeKey?: string;
  additionalSinks?: ExternalTriggerSink[];
}

export interface ExternalTriggerDeliveryResult {
  sinkKind: string;
  sinkRef: string;
  deliveryId: string;
  outcome: 'pending' | 'delivered' | 'failed' | 'skipped';
  deduped: boolean;
  error?: string;
}

export interface IngestExternalTriggerResult {
  ok: boolean;
  event: CanonicalExternalEvent;
  deliveries: ExternalTriggerDeliveryResult[];
  validationErrors?: string[];
}

type Emit = (opts: EmitAwaitedEventOpts) => Promise<EmitResult>;

interface DeliveryRow {
  id: string;
  outcome: ExternalTriggerDeliveryResult['outcome'];
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`external_trigger_${field}_required`);
  return normalized;
}

function assertKeySegments(source: string, event: string): void {
  if (!SEGMENT.test(source)) throw new Error(`external_trigger_invalid_source:${source}`);
  if (!EVENT_NAME.test(event)) throw new Error(`external_trigger_invalid_event:${event}`);
}

/**
 * How long a 'pending' delivery claim is honoured before a replay may reclaim
 * it. Sink deliveries complete in seconds; a claim this old was orphaned.
 */
export const PENDING_DELIVERY_LEASE_SECONDS = 15 * 60;

/** The sink whose ledger row carries the event payload (see claimDelivery). */
export const PAYLOAD_BEARING_SINK_KIND = 'event-bus';

export function storesDeliveryPayload(sink: Pick<ExternalTriggerSink, 'kind'>): boolean {
  return sink.kind === PAYLOAD_BEARING_SINK_KIND;
}

function sinkIdentity(sink: Pick<ExternalTriggerSink, 'kind' | 'ref'>): string {
  return `${required(sink.kind, 'sink_kind')}\u0000${required(sink.ref, 'sink_ref')}`;
}

async function claimDelivery(
  sql: postgres.Sql,
  event: CanonicalExternalEvent,
  sink: Pick<ExternalTriggerSink, 'kind' | 'ref'>,
): Promise<{ row: DeliveryRow; shouldDeliver: boolean }> {
  // The payload is stored ONCE per event, on the event-bus row (WI-10004921): that is
  // the row trigger_runs.delivery_id points at and the only one anything reads back.
  // Every other sink row is pure dedupe/outcome ledger — a retry re-delivers the
  // in-memory event, never a stored copy — so storing it there quadrupled the table.
  const payload = storesDeliveryPayload(sink) ? JSON.stringify(event.payload) : null;
  const inserted = await sql<DeliveryRow[]>`
    INSERT INTO harness_shared.trigger_deliveries
      (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
       sink_kind, sink_ref, outcome, attempts, updated_at)
    VALUES (
      ${event.workspaceId}, ${event.sourceId}, ${event.dedupeKey}, ${event.datatypeId},
      ${event.key}, ${payload}::text::jsonb, ${sink.kind}, ${sink.ref}, 'pending', 1, now()
    )
    ON CONFLICT (workspace_id, source_id, dedupe_key, sink_kind, sink_ref)
      DO NOTHING
    RETURNING id, outcome`;
  if (inserted[0]) return { row: inserted[0], shouldDeliver: true };

  // A prior failed/skipped attempt is retryable, and so is a 'pending' claim
  // whose lease expired: the claimant died between claim and finishDelivery
  // (process kill, restart, lost connection), so nobody will ever finish it.
  // Without the lease that row is a permanent dedupe hit, and for the event-bus
  // sink it head-of-line blocks the whole source — the binding sink refuses to
  // queue until the event-bus row is 'delivered', ingest returns ok:false, and
  // the provider poll stops advancing (WI-10003159: a Gmail source frozen for
  // 11 days behind one orphaned row). Every sink is replay-safe: the event bus
  // is at-least-once and trigger_runs dedupe on (binding_id, dedupe_key).
  // The conditional UPDATE is the atomic claimant: concurrent replayers cannot
  // both move the same row to pending.
  const retried = await sql<DeliveryRow[]>`
    UPDATE harness_shared.trigger_deliveries
       SET outcome = 'pending', attempts = attempts + 1, error = NULL,
           completed_at = NULL, updated_at = now()
     WHERE workspace_id = ${event.workspaceId}
       AND source_id = ${event.sourceId}
       AND dedupe_key = ${event.dedupeKey}
       AND sink_kind = ${sink.kind}
       AND sink_ref = ${sink.ref}
       AND (outcome IN ('failed', 'skipped')
            OR (outcome = 'pending'
                AND updated_at < now() - (${PENDING_DELIVERY_LEASE_SECONDS} * interval '1 second')))
    RETURNING id, outcome`;
  if (retried[0]) return { row: retried[0], shouldDeliver: true };

  const existing = await sql<DeliveryRow[]>`
    SELECT id, outcome
      FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${event.workspaceId}
       AND source_id = ${event.sourceId}
       AND dedupe_key = ${event.dedupeKey}
       AND sink_kind = ${sink.kind}
       AND sink_ref = ${sink.ref}
     LIMIT 1`;
  if (!existing[0]) throw new Error('external_trigger_delivery_claim_lost');
  return { row: existing[0], shouldDeliver: false };
}

async function finishDelivery(
  sql: postgres.Sql,
  event: CanonicalExternalEvent,
  row: DeliveryRow,
  outcome: 'delivered' | 'failed',
  error: string | null,
): Promise<void> {
  await sql`
    UPDATE harness_shared.trigger_deliveries
       SET outcome = ${outcome}, error = ${error},
           emitted_event_key = CASE WHEN ${outcome} = 'delivered'
                                     AND sink_kind = 'event-bus'
                                    THEN ${event.key}
                                    ELSE emitted_event_key END,
           completed_at = now(), updated_at = now()
     WHERE workspace_id = ${event.workspaceId} AND id = ${row.id}`;
}

async function recordValidationFailure(
  sql: postgres.Sql,
  event: CanonicalExternalEvent,
  sink: Pick<ExternalTriggerSink, 'kind' | 'ref'>,
  error: string,
): Promise<DeliveryRow> {
  const payload = JSON.stringify(event.payload);
  const inserted = await sql<DeliveryRow[]>`
    INSERT INTO harness_shared.trigger_deliveries
      (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
       sink_kind, sink_ref, outcome, attempts, error, completed_at, updated_at)
    VALUES (
      ${event.workspaceId}, ${event.sourceId}, ${event.dedupeKey}, ${event.datatypeId},
      ${event.key}, ${payload}::text::jsonb, ${sink.kind}, ${sink.ref},
      'failed', 1, ${error}, now(), now()
    )
    ON CONFLICT (workspace_id, source_id, dedupe_key, sink_kind, sink_ref)
      DO NOTHING
    RETURNING id, outcome`;
  if (inserted[0]) return inserted[0];
  const existing = await sql<DeliveryRow[]>`
    SELECT id, outcome FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${event.workspaceId}
       AND source_id = ${event.sourceId}
       AND dedupe_key = ${event.dedupeKey}
       AND sink_kind = ${sink.kind} AND sink_ref = ${sink.ref}`;
  if (!existing[0]) throw new Error('external_trigger_validation_ledger_lost');
  return existing[0];
}

/** Normalize, validate, dedupe, ledger, and fan out one provider event. */
export async function ingestExternalTriggerEvent(
  sql: postgres.Sql,
  input: IngestExternalTriggerInput,
  deps: { emit?: Emit } = {},
): Promise<IngestExternalTriggerResult> {
  const workspaceId = required(input.workspaceId, 'workspace_id');
  const sourceId = required(input.sourceId, 'source_id');
  const source = required(input.source, 'source');
  const eventName = required(input.event, 'event');
  const externalId = required(input.externalId, 'external_id');
  const datatypeId = required(input.datatypeId, 'datatype_id');
  assertKeySegments(source, eventName);

  const sourceRow = await getExternalTriggerSource(sql, workspaceId, sourceId);
  if (!sourceRow) throw new Error(`external_trigger_unknown_source:${sourceId}`);
  if (sourceRow.kind !== source) {
    throw new Error(`external_trigger_source_kind_mismatch:${sourceRow.kind}:${source}`);
  }

  const payload = await input.normalize(input.adapterPayload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('external_trigger_normalizer_must_return_object');
  }

  const datatype = await getDatatype(sql, workspaceId, datatypeId);
  if (!datatype) throw new Error(`external_trigger_unknown_datatype:${datatypeId}`);

  const key = buildKey('external-trigger', { source, event: eventName });
  const canonical: CanonicalExternalEvent = {
    key,
    source,
    event: eventName,
    sourceId,
    datatypeId,
    externalId,
    occurredAt: input.occurredAt ?? null,
    dedupeKey: required(input.dedupeKey ?? `${source}:${externalId}`, 'dedupe_key'),
    payload,
    workspaceId,
  };

  const emit = deps.emit ?? emitAwaitedEvent;
  const eventBusSink: ExternalTriggerSink = {
    kind: 'event-bus',
    ref: 'workspace',
    async deliver(normalized) {
      await emit({
        key: normalized.key,
        source: `external-trigger:${normalized.source}`,
        workspaceId,
        summary: `External ${normalized.source} event: ${normalized.event}`,
        payload: {
          sourceId: normalized.sourceId,
          source: normalized.source,
          event: normalized.event,
          externalId: normalized.externalId,
          occurredAt: normalized.occurredAt ?? null,
          datatypeId: normalized.datatypeId,
          dedupeKey: normalized.dedupeKey,
          payload: normalized.payload,
        },
      });
    },
  };
  // The binding engine is a first-class sink, ordered after the event bus so it
  // can attach trigger_runs to the already-delivered event-bus ledger row. Its
  // own delivery row makes enqueue replay/dedupe independent of other sinks.
  const sinks = [eventBusSink, createTriggerBindingSink(sql), ...(input.additionalSinks ?? [])];
  const identities = new Set<string>();
  for (const sink of sinks) {
    const identity = sinkIdentity(sink);
    if (identities.has(identity)) throw new Error(`external_trigger_duplicate_sink:${sink.kind}:${sink.ref}`);
    identities.add(identity);
  }

  const validation = validateDatatypePayload(datatype.payloadSchema, payload);
  if (!validation.ok) {
    const error = `invalid_${datatypeId}_payload: ${validation.errors.join('; ')}`;
    const deliveries: ExternalTriggerDeliveryResult[] = [];
    for (const sink of sinks) {
      const row = await recordValidationFailure(sql, canonical, sink, error);
      deliveries.push({
        sinkKind: sink.kind,
        sinkRef: sink.ref,
        deliveryId: row.id,
        outcome: row.outcome,
        deduped: row.outcome !== 'failed',
        error,
      });
    }
    return { ok: false, event: canonical, deliveries, validationErrors: validation.errors };
  }

  const deliveries: ExternalTriggerDeliveryResult[] = [];
  for (const sink of sinks) {
    const claim = await claimDelivery(sql, canonical, sink);
    if (!claim.shouldDeliver) {
      deliveries.push({
        sinkKind: sink.kind,
        sinkRef: sink.ref,
        deliveryId: claim.row.id,
        outcome: claim.row.outcome,
        deduped: true,
      });
      continue;
    }
    try {
      await sink.deliver(canonical);
      await finishDelivery(sql, canonical, claim.row, 'delivered', null);
      deliveries.push({
        sinkKind: sink.kind,
        sinkRef: sink.ref,
        deliveryId: claim.row.id,
        outcome: 'delivered',
        deduped: false,
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      await finishDelivery(sql, canonical, claim.row, 'failed', error);
      deliveries.push({
        sinkKind: sink.kind,
        sinkRef: sink.ref,
        deliveryId: claim.row.id,
        outcome: 'failed',
        deduped: false,
        error,
      });
    }
  }

  return { ok: deliveries.every((delivery) => delivery.outcome !== 'failed'), event: canonical, deliveries };
}
