/**
 * Authenticated, durable intake for WorkOS lifecycle webhooks.
 *
 * The signed payload is an upstream identity fact, never local authority. This
 * module therefore records only provider-scoped references. Tenant, workspace,
 * role, or entitlement selection remains the reconciliation worker's job.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';

export const WORKOS_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const WORKOS_WEBHOOK_SIGNATURE_TOLERANCE_MS = 5 * 60_000;
export const WORKOS_WEBHOOK_RETENTION_MS = 90 * 24 * 60 * 60_000;

type SqlClient = ReturnType<typeof getOrgPg>['sql'];

export type WorkOsWebhookIntakeErrorCode =
  | 'configuration_error'
  | 'unsupported_content_type'
  | 'unsupported_content_encoding'
  | 'invalid_content_length'
  | 'payload_too_large'
  | 'body_read_failed'
  | 'invalid_utf8'
  | 'missing_signature'
  | 'malformed_signature'
  | 'stale_signature'
  | 'invalid_signature'
  | 'invalid_json'
  | 'invalid_event'
  | 'receipt_collision'
  | 'enqueue_failed';

export class WorkOsWebhookIntakeError extends Error {
  constructor(
    readonly code: WorkOsWebhookIntakeErrorCode,
    readonly status: number,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'WorkOsWebhookIntakeError';
  }
}

export interface WorkOsWebhookEvent {
  id: string;
  event: string;
  data: Record<string, unknown>;
  created_at: string | number;
  [key: string]: unknown;
}

export interface VerifiedWorkOsWebhookEvent {
  eventId: string;
  eventType: string;
  eventCreatedAt: Date;
  providerAccountId: string | null;
  subjectRef: string | null;
  eventVersion: string | null;
  payload: WorkOsWebhookEvent;
  payloadSha256: string;
}

export interface WorkOsWebhookReceiptResult extends VerifiedWorkOsWebhookEvent {
  deduplicated: boolean;
  /** Original durable receipt time, preserved across duplicate delivery. */
  receivedAt: Date;
}

export interface WorkOsWebhookReceiptSink {
  enqueue(
    event: VerifiedWorkOsWebhookEvent,
    options?: { signatureKeyRef?: string | null },
  ): Promise<{ deduplicated: boolean; receivedAt: Date }>;
}

interface ReceiptDigestRow {
  payload_sha256: string;
  received_at: Date | string;
}

function intakeError(
  code: WorkOsWebhookIntakeErrorCode,
  status: number,
  retryable: boolean,
  message: string,
): WorkOsWebhookIntakeError {
  return new WorkOsWebhookIntakeError(code, status, retryable, message);
}

function safeExternalRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 512 ? normalized : null;
}

function safeExternalVersion(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return safeExternalRef(value);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function workOsReferences(payload: WorkOsWebhookEvent): {
  providerAccountId: string | null;
  subjectRef: string | null;
  eventVersion: string | null;
} {
  const data = payload.data;
  const context = objectRecord(payload.context);
  const organization = objectRecord(data.organization);

  // These are explicitly upstream references. Never inspect tenant_id,
  // workspace_id, roles, capabilities, or similar caller-supplied authority.
  const providerAccountId =
    safeExternalRef(context?.organization_id) ??
    safeExternalRef(data.organization_id) ??
    safeExternalRef(organization?.id);
  const subjectRef = safeExternalRef(data.id);
  const eventVersion = safeExternalVersion(data.version) ?? safeExternalVersion(payload.version);

  return { providerAccountId, subjectRef, eventVersion };
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(value.trim())) {
    throw intakeError('invalid_content_length', 400, false, 'Content-Length is invalid.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw intakeError('invalid_content_length', 400, false, 'Content-Length is invalid.');
  }
  return parsed;
}

export async function readWorkOsWebhookBody(
  request: Request,
  maxBodyBytes = WORKOS_WEBHOOK_MAX_BODY_BYTES,
): Promise<{ bytes: Uint8Array; text: string }> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw intakeError('unsupported_content_type', 415, false, 'Content-Type must be application/json.');
  }
  if ((request.headers.get('content-encoding') ?? '').trim() !== '') {
    throw intakeError('unsupported_content_encoding', 415, false, 'Encoded webhook bodies are not accepted.');
  }

  const contentLength = parseContentLength(request.headers.get('content-length'));
  if (contentLength !== null && contentLength > maxBodyBytes) {
    throw intakeError('payload_too_large', 413, false, 'Webhook payload is too large.');
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBodyBytes) {
          await reader.cancel().catch(() => undefined);
          throw intakeError('payload_too_large', 413, false, 'Webhook payload is too large.');
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    if (error instanceof WorkOsWebhookIntakeError) throw error;
    throw intakeError('body_read_failed', 400, false, 'Webhook body could not be read.');
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    throw intakeError('invalid_utf8', 400, false, 'Webhook body must be valid UTF-8.');
  }
}

interface ParsedSignature {
  timestampRaw: string;
  timestampMs: number;
  signatures: Buffer[];
}

function parseSignatureHeader(header: string | null): ParsedSignature {
  if (!header) {
    throw intakeError('missing_signature', 401, false, 'WorkOS signature is required.');
  }
  if (header.length > 8_192) {
    throw intakeError('malformed_signature', 401, false, 'WorkOS signature is malformed.');
  }

  let timestampRaw: string | null = null;
  const signatures: Buffer[] = [];
  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      if (timestampRaw !== null && timestampRaw !== value) {
        throw intakeError('malformed_signature', 401, false, 'WorkOS signature is malformed.');
      }
      timestampRaw = value;
    } else if (key === 'v1' && /^[0-9a-fA-F]{64}$/.test(value)) {
      signatures.push(Buffer.from(value, 'hex'));
    }
  }

  if (!timestampRaw || !/^\d+$/.test(timestampRaw) || signatures.length === 0) {
    throw intakeError('malformed_signature', 401, false, 'WorkOS signature is malformed.');
  }
  const timestampMs = Number(timestampRaw);
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
    throw intakeError('malformed_signature', 401, false, 'WorkOS signature is malformed.');
  }
  return { timestampRaw, timestampMs, signatures };
}

export function verifyWorkOsWebhookSignature(input: {
  rawBody: string;
  /** Exact request bytes. Prefer these over a decode/re-encode round trip. */
  rawBodyBytes?: Uint8Array;
  signatureHeader: string | null;
  secret: string | undefined;
  nowMs?: number;
  toleranceMs?: number;
}): void {
  const secret = input.secret?.trim();
  if (!secret) {
    throw intakeError('configuration_error', 503, true, 'WorkOS webhook verification is not configured.');
  }
  const parsed = parseSignatureHeader(input.signatureHeader);
  const nowMs = input.nowMs ?? Date.now();
  const toleranceMs = input.toleranceMs ?? WORKOS_WEBHOOK_SIGNATURE_TOLERANCE_MS;
  if (Math.abs(nowMs - parsed.timestampMs) > toleranceMs) {
    throw intakeError('stale_signature', 401, false, 'WorkOS signature is outside the allowed window.');
  }

  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestampRaw}.`, 'utf8')
    .update(input.rawBodyBytes ?? Buffer.from(input.rawBody, 'utf8'))
    .digest();
  if (!parsed.signatures.some((provided) => timingSafeEqual(expected, provided))) {
    throw intakeError('invalid_signature', 401, false, 'WorkOS signature is invalid.');
  }
}

export function parseWorkOsWebhookEvent(rawBody: string, rawBytes?: Uint8Array): VerifiedWorkOsWebhookEvent {
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody);
  } catch {
    throw intakeError('invalid_json', 400, false, 'Webhook body is not valid JSON.');
  }
  const payload = objectRecord(candidate);
  const data = objectRecord(payload?.data);
  const eventId = safeExternalRef(payload?.id);
  const eventType = safeExternalRef(payload?.event);
  const createdAtRaw = payload?.created_at;
  const eventCreatedAt =
    typeof createdAtRaw === 'string' || typeof createdAtRaw === 'number'
      ? new Date(createdAtRaw)
      : new Date(Number.NaN);
  if (!payload || !data || !eventId || !eventType || !Number.isFinite(eventCreatedAt.getTime())) {
    throw intakeError('invalid_event', 400, false, 'Webhook event shape is invalid.');
  }

  const normalizedPayload = payload as WorkOsWebhookEvent;
  const refs = workOsReferences(normalizedPayload);
  return {
    eventId,
    eventType,
    eventCreatedAt,
    ...refs,
    payload: normalizedPayload,
    payloadSha256: createHash('sha256')
      .update(rawBytes ?? Buffer.from(rawBody, 'utf8'))
      .digest('hex'),
  };
}

export class WorkOsWebhookReceiptStore implements WorkOsWebhookReceiptSink {
  constructor(
    private readonly sql: SqlClient = getOrgPg().sql,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async enqueue(
    event: VerifiedWorkOsWebhookEvent,
    options: { signatureKeyRef?: string | null } = {},
  ): Promise<{ deduplicated: boolean; receivedAt: Date }> {
    const now = this.clock();
    const nowIso = now.toISOString();
    const retentionUntil = new Date(now.getTime() + WORKOS_WEBHOOK_RETENTION_MS).toISOString();
    const payloadJson = JSON.stringify(event.payload);
    const signatureKeyRef = safeExternalRef(options.signatureKeyRef);

    const inserted = await this.sql<ReceiptDigestRow[]>`
      INSERT INTO papercusp_auth.webhook_event_receipts
        (provider, event_id, event_type, provider_account_id, subject_ref, event_version,
         event_created_at, payload, payload_sha256, signature_key_ref,
         received_at, verified_at, enqueued_at, retention_until)
      VALUES
        ('workos', ${event.eventId}, ${event.eventType}, ${event.providerAccountId},
         ${event.subjectRef}, ${event.eventVersion}, ${event.eventCreatedAt.toISOString()},
         ${payloadJson}::text::jsonb, ${event.payloadSha256}, ${signatureKeyRef},
         ${nowIso}, ${nowIso}, ${nowIso}, ${retentionUntil})
      ON CONFLICT (provider, event_id) DO NOTHING
      RETURNING payload_sha256, received_at
    `;
    if (inserted.length > 0) {
      return { deduplicated: false, receivedAt: receiptDate(inserted[0].received_at) };
    }

    const existing = await this.sql<ReceiptDigestRow[]>`
      SELECT payload_sha256, received_at
        FROM papercusp_auth.webhook_event_receipts
       WHERE provider = 'workos'
         AND event_id = ${event.eventId}
       LIMIT 1
    `;
    if (existing[0]?.payload_sha256 === event.payloadSha256) {
      return { deduplicated: true, receivedAt: receiptDate(existing[0].received_at) };
    }
    if (existing.length > 0) {
      throw intakeError(
        'receipt_collision',
        409,
        false,
        'A different payload already exists for this WorkOS event id.',
      );
    }
    throw intakeError('enqueue_failed', 503, true, 'Webhook receipt could not be confirmed.');
  }
}

function receiptDate(value: Date | string): Date {
  const receivedAt = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(receivedAt.getTime())) {
    throw intakeError('enqueue_failed', 503, true, 'Webhook receipt has an invalid received_at timestamp.');
  }
  return receivedAt;
}

export async function intakeWorkOsWebhook(input: {
  request: Request;
  secret: string | undefined;
  receiptSink?: WorkOsWebhookReceiptSink;
  signatureKeyRef?: string | null;
  now?: Date;
  maxBodyBytes?: number;
  signatureToleranceMs?: number;
}): Promise<WorkOsWebhookReceiptResult> {
  const now = input.now ?? new Date();
  const { bytes, text } = await readWorkOsWebhookBody(
    input.request,
    input.maxBodyBytes ?? WORKOS_WEBHOOK_MAX_BODY_BYTES,
  );
  verifyWorkOsWebhookSignature({
    rawBody: text,
    rawBodyBytes: bytes,
    signatureHeader: input.request.headers.get('workos-signature'),
    secret: input.secret,
    nowMs: now.getTime(),
    toleranceMs: input.signatureToleranceMs,
  });
  const event = parseWorkOsWebhookEvent(text, bytes);
  try {
    const receipt = await (input.receiptSink ?? new WorkOsWebhookReceiptStore()).enqueue(event, {
      signatureKeyRef: input.signatureKeyRef,
    });
    return { ...event, ...receipt };
  } catch (error) {
    if (error instanceof WorkOsWebhookIntakeError) throw error;
    throw intakeError('enqueue_failed', 503, true, 'Webhook receipt could not be enqueued.');
  }
}
