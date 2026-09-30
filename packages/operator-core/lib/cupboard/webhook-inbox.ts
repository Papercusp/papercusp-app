/**
 * Signed webhook inbox + the payment-provider adapter seam (P-010; D-025).
 *
 * A provider (Stripe first — `payment-adapters/stripe.ts`) is ONE adapter behind
 * `PaymentProviderAdapter`; the ledger and the Cupboard never learn which one is
 * in use. The inbox is fail-closed and idempotent:
 *
 *   1. the signature is verified BEFORE the body is parsed — an unauthenticated
 *      request is refused and never recorded, so it cannot fill the inbox;
 *   2. the authenticated body is normalized into provider-neutral ledger events;
 *   3. delivery is idempotent by (provider, providerEventId): an exact replay is
 *      `duplicate`, and a replay whose bytes differ is `rejected` (`replay-mismatch`)
 *      — a provider never legitimately re-sends an event id with a different body.
 *
 * Like `artifact-store.ts`, there is no module-scoped registry: callers pass the
 * adapter and the store explicitly, and `memoryWebhookInboxStore()` is the
 * in-memory implementation the Cupboard D1 store mirrors.
 */
import { createHash } from 'node:crypto';
import type { LedgerEvent } from './commerce-ledger';

export type WebhookSignatureRefusal = 'missing-secret' | 'missing-signature' | 'malformed-signature' | 'bad-signature' | 'stale-timestamp';
export type WebhookNormalizeRefusal = 'malformed-body' | 'missing-order-ref' | 'invalid-amount';

export interface WebhookRequest {
  /** The exact bytes the provider sent, as a string — signatures cover the raw body. */
  readonly rawBody: string;
  /** Header names are matched case-insensitively. */
  readonly headers: Readonly<Record<string, string>>;
  readonly nowMs: number;
}

export interface NormalizedWebhook {
  readonly providerEventId: string;
  readonly providerEventType: string;
  readonly occurredAtMs: number;
  /** Zero events means the provider event is authenticated but irrelevant to the ledger. */
  readonly events: readonly LedgerEvent[];
}

export type SignatureVerdict = { ok: true } | { ok: false; code: WebhookSignatureRefusal; detail: string };
export type NormalizeVerdict = { ok: true; webhook: NormalizedWebhook } | { ok: false; code: WebhookNormalizeRefusal; detail: string; providerEventId: string | null };

export interface PaymentProviderAdapter {
  readonly provider: string;
  verifySignature(request: WebhookRequest): SignatureVerdict;
  normalize(rawBody: string, receivedAtMs: number): NormalizeVerdict;
}

export type WebhookInboxOutcome = 'accepted' | 'ignored' | 'rejected';

export interface WebhookInboxRecord {
  readonly provider: string;
  readonly providerEventId: string;
  readonly providerEventType: string | null;
  readonly bodyDigest: string;
  readonly receivedAtMs: number;
  readonly outcome: WebhookInboxOutcome;
  readonly rejectionCode: string | null;
  readonly ledgerEventIds: readonly string[];
}

export interface WebhookInboxStore {
  get(provider: string, providerEventId: string): Promise<WebhookInboxRecord | null>;
  put(record: WebhookInboxRecord): Promise<void>;
}

export function memoryWebhookInboxStore(): WebhookInboxStore & { records(): WebhookInboxRecord[] } {
  const rows = new Map<string, WebhookInboxRecord>();
  const key = (provider: string, id: string) => `${provider}\0${id}`;
  return {
    async get(provider, providerEventId) {
      return rows.get(key(provider, providerEventId)) ?? null;
    },
    async put(record) {
      rows.set(key(record.provider, record.providerEventId), record);
    },
    records() {
      return [...rows.values()];
    },
  };
}

export function webhookBodyDigest(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

export function headerLookup(headers: Readonly<Record<string, string>>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return null;
}

export type IngestResult =
  | { readonly outcome: 'accepted'; readonly providerEventId: string; readonly events: readonly LedgerEvent[]; readonly record: WebhookInboxRecord }
  | { readonly outcome: 'ignored'; readonly providerEventId: string; readonly record: WebhookInboxRecord }
  | { readonly outcome: 'duplicate'; readonly providerEventId: string; readonly record: WebhookInboxRecord }
  | { readonly outcome: 'rejected'; readonly code: WebhookSignatureRefusal | WebhookNormalizeRefusal | 'replay-mismatch'; readonly detail: string; readonly providerEventId: string | null };

/**
 * Ingest one provider delivery. Signature → normalize → idempotency → record.
 * Only authenticated deliveries with a provider event id reach the store.
 */
export async function ingestWebhook(input: { adapter: PaymentProviderAdapter; store: WebhookInboxStore; request: WebhookRequest }): Promise<IngestResult> {
  const { adapter, store, request } = input;
  const sig = adapter.verifySignature(request);
  if (!sig.ok) return { outcome: 'rejected', code: sig.code, detail: sig.detail, providerEventId: null };
  const bodyDigest = webhookBodyDigest(request.rawBody);
  const normalized = adapter.normalize(request.rawBody, request.nowMs);
  if (!normalized.ok) {
    if (normalized.providerEventId) {
      const prior = await store.get(adapter.provider, normalized.providerEventId);
      if (!prior) await store.put({ provider: adapter.provider, providerEventId: normalized.providerEventId, providerEventType: null, bodyDigest, receivedAtMs: request.nowMs, outcome: 'rejected', rejectionCode: normalized.code, ledgerEventIds: [] });
    }
    return { outcome: 'rejected', code: normalized.code, detail: normalized.detail, providerEventId: normalized.providerEventId };
  }
  const { webhook } = normalized;
  const prior = await store.get(adapter.provider, webhook.providerEventId);
  if (prior) {
    if (prior.bodyDigest === bodyDigest) return { outcome: 'duplicate', providerEventId: webhook.providerEventId, record: prior };
    return { outcome: 'rejected', code: 'replay-mismatch', detail: `event ${webhook.providerEventId} was already recorded with different bytes`, providerEventId: webhook.providerEventId };
  }
  const outcome: WebhookInboxOutcome = webhook.events.length ? 'accepted' : 'ignored';
  const record: WebhookInboxRecord = { provider: adapter.provider, providerEventId: webhook.providerEventId, providerEventType: webhook.providerEventType, bodyDigest, receivedAtMs: request.nowMs, outcome, rejectionCode: null, ledgerEventIds: webhook.events.map((e) => e.ledgerEventId) };
  await store.put(record);
  if (outcome === 'ignored') return { outcome: 'ignored', providerEventId: webhook.providerEventId, record };
  return { outcome: 'accepted', providerEventId: webhook.providerEventId, events: webhook.events, record };
}
