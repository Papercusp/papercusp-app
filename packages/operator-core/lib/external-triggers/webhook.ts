/**
 * Signed webhook ingress for external-event triggers (plan external-app-access-to-workspaces-2026-09-29,
 * P-017 / WI-10004021, decision D-032).
 *
 * A webhook is an external-trigger source of kind `webhook`. An outside system POSTs a JSON object to
 * `/api/hooks/<source id>`, signed with the source's HMAC-SHA256 key. This module checks the signature
 * and hands the event to the shared ingestion seam (ingestion.ts), which validates it, dedupes it per
 * source and fires every armed binding (triggers:bind / triggers:arm, storm caps). So an automated
 * system can start a blueprint operation without holding a user or app token.
 *
 *   Papercusp-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(key, `${t}.${raw body}`)>
 *   Papercusp-Event:     optional, default `received`; the `ext:webhook:<event>` a binding matches
 *   Papercusp-Delivery:  optional dedupe id; default sha256 of `${t}.${raw body}`
 *
 * The timestamp must be within {@link WEBHOOK_TOLERANCE_SEC} of the machine clock, so a captured request
 * cannot be replayed later; a replay inside the window carries the same delivery id and is deduped by
 * the ingestion ledger. After a rotation the previous key keeps verifying until `previous_valid_until`
 * (the P-015 overlap shape).
 *
 * Order of checks (D-032 #3): body size and shape → source exists, is a webhook, is not disabled (else
 * 404 with no detail) → the workspace's Remote access switch is on (R-41) → signature → ingest. Nothing
 * is written for a refused request. The key is stored encrypted with pgcrypto under the operator
 * database key (harness_shared.trigger_webhook_secrets, migration 1269) and decrypted only here.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type postgres from 'postgres';
import { getDbEncryptionKey } from '../db-encryption';
import { installPublishedDatatype } from '../datatype-registry-store';
import { createExternalTriggerSource, type CreatedExternalTriggerSource } from './admin';
import { ingestExternalTriggerEvent, type IngestExternalTriggerResult } from './ingestion';
import { isWebhookSourceId, webhookPath } from './webhook-path';

export { WEBHOOK_PATH_RE, isWebhookPath, webhookPath } from './webhook-path';

export const WEBHOOK_SOURCE_KIND = 'webhook';
export const WEBHOOK_DATATYPE_ID = 'webhook-payload';
export const WEBHOOK_SIGNATURE_HEADER = 'papercusp-signature';
export const WEBHOOK_EVENT_HEADER = 'papercusp-event';
export const WEBHOOK_DELIVERY_HEADER = 'papercusp-delivery';
/** Largest accepted body (D-032 #3). */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
/** How far the signed timestamp may sit from the machine clock, either way. */
export const WEBHOOK_TOLERANCE_SEC = 300;
export const WEBHOOK_DEFAULT_EVENT = 'received';
/** How long the previous key keeps verifying after a rotation, unless the caller says otherwise. */
export const WEBHOOK_DEFAULT_OVERLAP_SEC = 24 * 60 * 60;
export const WEBHOOK_MAX_OVERLAP_SEC = 30 * 24 * 60 * 60;

const EVENT_NAME = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,200}$/;

// ─── Signature ──────────────────────────────────────────────────────────────

function hmacHex(signingKey: string, timestampSec: number, rawBody: string | Uint8Array): string {
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  return createHmac('sha256', signingKey).update(`${timestampSec}.`).update(bytes).digest('hex');
}

/** The `Papercusp-Signature` value a sender computes. Exported for the samples and the tests. */
export function signWebhook(signingKey: string, timestampSec: number, rawBody: string | Uint8Array): string {
  return `t=${timestampSec},v1=${hmacHex(signingKey, timestampSec, rawBody)}`;
}

export interface ParsedWebhookSignature {
  timestampSec: number;
  signatures: string[];
}

/** `t=<int>,v1=<hex>[,v1=<hex>…]` → parts. Anything else → null. Unknown schemes are ignored. */
export function parseWebhookSignature(value: string | null | undefined): ParsedWebhookSignature | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let timestampSec: number | null = null;
  const signatures: string[] = [];
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name === 't') {
      if (!/^\d{1,12}$/.test(val) || timestampSec !== null) return null;
      timestampSec = Number(val);
    } else if (name === 'v1') {
      if (!/^[0-9a-f]{64}$/.test(val)) return null;
      signatures.push(val);
    }
  }
  if (timestampSec === null || signatures.length === 0) return null;
  return { timestampSec, signatures };
}

export type WebhookSignatureVerdict =
  | { ok: true; timestampSec: number }
  | { ok: false; reason: 'signature_missing' | 'signature_malformed' | 'signature_stale' | 'signature_invalid' };

/** Check a `Papercusp-Signature` against every currently valid key, each compare in constant time. */
export function verifyWebhookSignature(input: {
  header: string | null | undefined;
  rawBody: string | Uint8Array;
  signingKeys: ReadonlyArray<string>;
  nowSec: number;
  toleranceSec?: number;
}): WebhookSignatureVerdict {
  if (input.header === null || input.header === undefined || input.header.trim() === '') {
    return { ok: false, reason: 'signature_missing' };
  }
  const parsed = parseWebhookSignature(input.header);
  if (!parsed) return { ok: false, reason: 'signature_malformed' };
  if (Math.abs(input.nowSec - parsed.timestampSec) > (input.toleranceSec ?? WEBHOOK_TOLERANCE_SEC)) {
    return { ok: false, reason: 'signature_stale' };
  }
  for (const signingKey of input.signingKeys) {
    const expected = Buffer.from(hmacHex(signingKey, parsed.timestampSec, input.rawBody), 'hex');
    for (const given of parsed.signatures) {
      const candidate = Buffer.from(given, 'hex');
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        return { ok: true, timestampSec: parsed.timestampSec };
      }
    }
  }
  return { ok: false, reason: 'signature_invalid' };
}

/** A fresh signing key: 32 random bytes, shown to the user once. */
export function mintWebhookSigningKey(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export interface WebhookStoreOptions {
  /** Test seam: the operator database key. Defaults to the machine's key. */
  encryptionKey?: string;
}

export interface CreatedWebhook {
  source: CreatedExternalTriggerSource;
  /** Machine path; reachable through the user's own tunnel or the Papercusp relay (D-032 #4). */
  path: string;
  /** Shown once. Never stored in the clear and never returned again. */
  signingKey: string;
}

/**
 * Create a webhook source and its signing key. Installs the `webhook-payload` datatype into the
 * workspace from the platform catalog first (migration 1269 seeds it), so ingestion can validate.
 */
export async function createWebhookSource(
  sql: postgres.Sql,
  input: { workspaceId: string; label?: string | null; createdBy?: string | null },
  options: WebhookStoreOptions = {},
): Promise<CreatedWebhook> {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) throw new Error('webhook_workspace_required');
  const label = input.label?.trim().slice(0, 120) || null;
  const installed = await installPublishedDatatype(sql, WEBHOOK_DATATYPE_ID, workspaceId);
  if (!installed.ok && installed.reason === 'not_found') throw new Error('webhook_datatype_missing');

  const dbKey = options.encryptionKey ?? getDbEncryptionKey();
  const fresh = mintWebhookSigningKey();
  const source = await createExternalTriggerSource(sql, workspaceId, {
    kind: WEBHOOK_SOURCE_KIND,
    config: label ? { label } : {},
    status: 'ready',
    createdBy: input.createdBy ?? null,
  });
  try {
    await sql`
      INSERT INTO harness_shared.trigger_webhook_secrets (workspace_id, source_id, secret_ct)
      VALUES (${workspaceId}, ${source.id}::uuid, pgp_sym_encrypt(${fresh}, ${dbKey}))`;
  } catch (error) {
    // A source with no key could never verify a delivery; do not leave one behind.
    await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${workspaceId} AND id = ${source.id}::uuid`;
    throw error;
  }
  return { source, path: webhookPath(source.id), signingKey: fresh };
}

export interface RotatedWebhookKey {
  sourceId: string;
  signingKey: string;
  /** Until when the previous key still verifies. Null when the overlap was 0. */
  previousValidUntil: string | null;
}

/** Replace a webhook's key. The previous one keeps verifying for `overlapSec` (0 = invalid at once). */
export async function rotateWebhookSigningKey(
  sql: postgres.Sql,
  input: { workspaceId: string; sourceId: string; overlapSec?: number },
  options: WebhookStoreOptions = {},
): Promise<RotatedWebhookKey> {
  const overlap = Math.max(0, Math.min(WEBHOOK_MAX_OVERLAP_SEC, Math.floor(input.overlapSec ?? WEBHOOK_DEFAULT_OVERLAP_SEC)));
  const dbKey = options.encryptionKey ?? getDbEncryptionKey();
  const fresh = mintWebhookSigningKey();
  const rows = await sql<Array<{ previousValidUntil: Date | null }>>`
    UPDATE harness_shared.trigger_webhook_secrets AS w
       SET previous_secret_ct = CASE WHEN ${overlap}::int > 0 THEN w.secret_ct ELSE NULL END,
           previous_valid_until = CASE WHEN ${overlap}::int > 0 THEN now() + (${overlap}::int * interval '1 second') ELSE NULL END,
           secret_ct = pgp_sym_encrypt(${fresh}, ${dbKey}),
           rotated_at = now(),
           updated_at = now()
      FROM harness_shared.data_sources AS s
     WHERE w.workspace_id = ${input.workspaceId}
       AND w.source_id = ${input.sourceId}::uuid
       AND s.workspace_id = w.workspace_id
       AND s.id = w.source_id
       AND s.kind = ${WEBHOOK_SOURCE_KIND}
    RETURNING w.previous_valid_until AS "previousValidUntil"`;
  if (!rows[0]) throw new Error(`webhook_not_found:${input.sourceId}`);
  const until = rows[0].previousValidUntil;
  return { sourceId: input.sourceId, signingKey: fresh, previousValidUntil: until ? new Date(until).toISOString() : null };
}

interface DeliveryTarget {
  workspaceId: string;
  status: string;
  signingKeys: string[];
}

/** Resolve a webhook by id alone (the request names no workspace; a source id is unique). */
async function loadDeliveryTarget(sql: postgres.Sql, sourceId: string, dbKey: string): Promise<DeliveryTarget | null> {
  const rows = await sql<Array<{ workspaceId: string; status: string; current: string; previous: string | null }>>`
    SELECT s.workspace_id AS "workspaceId",
           s.status,
           pgp_sym_decrypt(w.secret_ct, ${dbKey}) AS current,
           CASE WHEN w.previous_secret_ct IS NOT NULL AND w.previous_valid_until > now()
                THEN pgp_sym_decrypt(w.previous_secret_ct, ${dbKey}) END AS previous
      FROM harness_shared.data_sources s
      JOIN harness_shared.trigger_webhook_secrets w
        ON w.workspace_id = s.workspace_id AND w.source_id = s.id
     WHERE s.id = ${sourceId}::uuid
       AND s.kind = ${WEBHOOK_SOURCE_KIND}
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  return { workspaceId: row.workspaceId, status: row.status, signingKeys: row.previous ? [row.current, row.previous] : [row.current] };
}

// ─── Delivery ───────────────────────────────────────────────────────────────

export interface WebhookDeliveryRequest {
  sourceId: string;
  headers: Headers;
  rawBody: Uint8Array;
}

export interface WebhookDeliveryResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface WebhookDeliveryDependencies {
  sql: postgres.Sql;
  /** The workspace's Remote access switch (connected-apps/remote-access.ts). Off refuses (R-41). */
  remoteAccessEnabled(workspaceId: string): Promise<boolean>;
  encryptionKey?: string;
  now?: () => Date;
  ingest?: typeof ingestExternalTriggerEvent;
}

function refuse(status: number, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): WebhookDeliveryResponse {
  return { status, body: { ok: false, error, ...extra }, ...(headers ? { headers } : {}) };
}

function parseJsonObject(raw: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Check and ingest one webhook POST. Refusals write nothing. */
export async function handleWebhookDelivery(
  request: WebhookDeliveryRequest,
  deps: WebhookDeliveryDependencies,
): Promise<WebhookDeliveryResponse> {
  if (request.rawBody.byteLength > WEBHOOK_MAX_BODY_BYTES) {
    return refuse(413, 'body_too_large', { limitBytes: WEBHOOK_MAX_BODY_BYTES });
  }
  const body = parseJsonObject(request.rawBody);
  if (!body) return refuse(400, 'invalid_body', { message: 'the body must be a JSON object' });

  const sourceId = request.sourceId.toLowerCase();
  if (!isWebhookSourceId(sourceId)) return refuse(404, 'not_found');
  const target = await loadDeliveryTarget(deps.sql, sourceId, deps.encryptionKey ?? getDbEncryptionKey());
  if (!target || target.status === 'disabled') return refuse(404, 'not_found');

  if (!(await deps.remoteAccessEnabled(target.workspaceId))) return refuse(403, 'remote_access_off');

  const now = deps.now?.() ?? new Date();
  const verdict = verifyWebhookSignature({
    header: request.headers.get(WEBHOOK_SIGNATURE_HEADER),
    rawBody: request.rawBody,
    signingKeys: target.signingKeys,
    nowSec: Math.floor(now.getTime() / 1000),
  });
  if (!verdict.ok) return refuse(401, 'signature_invalid', { reason: verdict.reason });

  const event = (request.headers.get(WEBHOOK_EVENT_HEADER) ?? WEBHOOK_DEFAULT_EVENT).trim().toLowerCase();
  if (!EVENT_NAME.test(event)) return refuse(400, 'invalid_event', { message: 'Papercusp-Event must match [a-z0-9][a-z0-9.-]*' });
  const givenDelivery = request.headers.get(WEBHOOK_DELIVERY_HEADER)?.trim();
  if (givenDelivery && !DELIVERY_ID.test(givenDelivery)) return refuse(400, 'invalid_delivery_id');
  const deliveryId = givenDelivery || createHash('sha256').update(`${verdict.timestampSec}.`).update(Buffer.from(request.rawBody)).digest('hex');

  let result: IngestExternalTriggerResult;
  try {
    result = await (deps.ingest ?? ingestExternalTriggerEvent)(deps.sql, {
      workspaceId: target.workspaceId,
      sourceId,
      source: WEBHOOK_SOURCE_KIND,
      event,
      externalId: deliveryId,
      datatypeId: WEBHOOK_DATATYPE_ID,
      adapterPayload: body,
      normalize: (payload) => ({ id: deliveryId, event, receivedAt: now.toISOString(), body: payload as Record<string, unknown> }),
      occurredAt: new Date(verdict.timestampSec * 1000).toISOString(),
      dedupeKey: `webhook:${deliveryId}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refuse(500, 'ingest_failed', { message: message.slice(0, 300) });
  }
  if (result.validationErrors?.length) return refuse(422, 'invalid_payload', { errors: result.validationErrors.slice(0, 10) });
  if (!result.ok) {
    // A sink failed. Its ledger row is retryable, so the sender's own retry re-runs it (D-008).
    return refuse(503, 'delivery_failed', { deliveryId }, { 'retry-after': '30' });
  }
  const deduped = result.deliveries.length > 0 && result.deliveries.every((delivery) => delivery.deduped);
  return { status: 202, body: { ok: true, deliveryId, event, deduped, deliveries: result.deliveries.length } };
}
