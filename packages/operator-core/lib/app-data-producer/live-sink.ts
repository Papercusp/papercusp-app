/**
 * P-011 — push delivery of canonical rows into the apps, as they land.
 *
 * Registered through the existing `additionalSinks` extension point
 * (external-triggers/ingestion.ts:255), exactly as the Personal Vault sink is.
 * Nothing new is introduced at the ingestion seam: normalization already
 * happened once, and this is simply a third consumer of the same event.
 *
 * WHY PUSH RATHER THAN AN INTERVAL. Steady-state freshness becomes ingestion
 * latency instead of a poll period — the owner's "instantly fresh" requirement.
 * The P-005 reconcile sweep still exists, but as a SAFETY NET for gaps (an app
 * that was down, a delivery that failed), not as the primary path.
 *
 * FAILURE CONTRACT — this sink THROWS on failure, deliberately. The ingestion
 * loop wraps every `sink.deliver` in its own try/catch, marks THAT sink's
 * delivery row `failed` with the error text, and continues to the next sink
 * (ingestion.ts:293-310). So throwing is what records the failure; swallowing
 * would report a delivery that never happened. Because each sink holds its own
 * delivery row, an unreachable app can never block the personal-vault write or
 * the event bus — which is the isolation P-011 requires, already guaranteed by
 * the seam rather than re-implemented here.
 */
import type { Sql } from 'postgres';
import { getExternalTriggerSource } from '../external-triggers/source-store';
import {
  personalDocumentFromExternalEvent,
  type NormalizedExternalEvent,
} from '../personal-vault/live-sink';
import { appServiceAuthHeader } from './app-auth';
import { appRowFromSourceRecord, buildAppSyncBatch, type AppSyncBatch } from './app-rows';
import { requireAppOwnerId, resolveAppOwnerId, type ProducerApp } from './owner-mapping';

/** Default per-delivery timeout. A hung app must not stall the ingest loop. */
export const APP_DELIVERY_TIMEOUT_MS = 10_000;

/** The env var holding an app's base URL, derived from the slug like its secret. */
export function appBaseUrlEnvVar(app: ProducerApp): string {
  return `${app.toUpperCase()}_APP_URL`;
}

export function readAppBaseUrl(app: ProducerApp): string {
  const envVar = appBaseUrlEnvVar(app);
  const url = process.env[envVar]?.trim() ?? '';
  if (!url) {
    throw new Error(`app_base_url_missing:${app} — set ${envVar} to the ${app} app's base URL`);
  }
  return url.replace(/\/+$/, '');
}

export interface AppDeliveryOptions {
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface AppDeliveryResult {
  app: ProducerApp;
  ownerId: string;
  status: number;
  rowCount: number;
  response: unknown;
}

/**
 * POST one batch to an app's `/api/sync`.
 *
 * The endpoint is the SAME one the reconcile path uses, with the same body
 * shape — see app-rows.ts. A non-2xx, or an `ok:false` envelope, throws with
 * the app's own error text so the delivery ledger records why.
 */
export async function deliverAppSyncBatch(
  batch: AppSyncBatch,
  ownerId: string,
  options: AppDeliveryOptions = {},
): Promise<AppDeliveryResult> {
  const baseUrl = options.baseUrl?.replace(/\/+$/, '') || readAppBaseUrl(batch.app);
  const authorization = await appServiceAuthHeader(batch.app, ownerId, { secret: options.secret });
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/api/sync`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(batch.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? APP_DELIVERY_TIMEOUT_MS),
    });
  } catch (cause) {
    // Unreachable app, DNS failure, timeout. Name the app and the cause; the
    // ingestion loop turns this into a failed delivery row.
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`app_delivery_unreachable:${batch.app}: ${reason}`);
  }

  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

  if (!response.ok) {
    throw new Error(`app_delivery_rejected:${batch.app}:${response.status}: ${text.slice(0, 500)}`);
  }
  // Both apps answer 200 with `{ ok:false, error }` on a bad batch rather than
  // a non-2xx, so an ok:false body is a REJECTION, not a success.
  if (parsed && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === false) {
    const error = String((parsed as { error?: unknown }).error ?? 'unknown_error');
    throw new Error(`app_delivery_rejected:${batch.app}: ${error}`);
  }

  return { app: batch.app, ownerId, status: response.status, rowCount: batch.rowCount, response: parsed };
}

/**
 * Structural match for external-triggers/ingestion.ts's ExternalTriggerSink,
 * kept local for the same reason personal-vault/live-sink.ts keeps its own:
 * so ingestion can go on importing NormalizedExternalEvent from that module
 * without forming an import cycle.
 */
export interface AppDeliveryExternalSink {
  kind: 'app-delivery';
  ref: string;
  deliver(event: NormalizedExternalEvent): Promise<unknown>;
}

export interface AppDeliverySinkOptions extends AppDeliveryOptions {
  /** Server-owned source/account identity carried into Gmail app rows. */
  provenance?: { sourceId?: string | null; providerAccountId?: string | null };
  /** Delivery cursor to report to the app alongside the row. */
  cursor?: string | null;
  /**
   * Called when `createAppDeliverySinkIfConfigured` declines because the gate
   * itself failed, rather than because no mapping is configured. The gate
   * swallows the error to protect the sync, so this is the only place that
   * fault is observable until P-007 lands.
   */
  onGateError?: (cause: unknown, context: { app: ProducerApp; sourceId: string }) => void;
}

/**
 * P-007 — the default `onGateError`, so a swallowed registration fault leaves a
 * trace instead of nothing.
 *
 * Shared by both adapters rather than spelled out at each call site: the prefix
 * IS the interface (it is what `logs:read { grep }` matches), so two adapters
 * writing it independently is two chances for it to drift apart.
 *
 * This is deliberately NOT a `trigger_deliveries` row. That ledger is keyed by
 * (source, dedupe_key, sink_kind, sink_ref) — one row per EVENT per sink — and
 * this fault happens at REGISTRATION, before any event exists. Forcing it in
 * would need a fabricated dedupe key and would report a delivery that was never
 * attempted. The durable, queryable answer to "is the producer healthy" is
 * `readAppProducerStatus` in status.ts, which re-reads the same configuration
 * this gate tripped over; this line is the timestamped breadcrumb saying a
 * specific sync was affected.
 */
export function reportAppSinkGateError(
  cause: unknown,
  context: { app: ProducerApp; sourceId: string },
): void {
  const reason = cause instanceof Error ? cause.message : String(cause);
  console.error(
    `[app-data-producer] SINK REGISTRATION DECLINED (gate error) app=${context.app} source=${context.sourceId} — ${reason}. ` +
      'This sync delivered nothing to the app and wrote NO delivery row; the reconcile sweep is the repair path. ' +
      'Run status.ts readAppProducerStatus for the current configuration verdict.',
  );
}

/**
 * Ready-to-pass sink for one locally authenticated human.
 *
 * The target user is a SERVER-OWNED argument, never anything from the provider
 * payload — the same rule `createPersonalVaultExternalSink` states, and the
 * reason P-003's mapping is consulted here rather than any id inside the event.
 * The user id is part of the sink ref, so two users connected to the same
 * provider event get independent delivery rows and never dedupe each other out.
 */
export function createAppDeliveryExternalSink(
  sql: Sql,
  workspaceId: string,
  userId: string,
  options: AppDeliverySinkOptions = {},
): AppDeliveryExternalSink {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error('app_delivery_user_required');

  return {
    kind: 'app-delivery',
    ref: `user:${normalizedUserId}`,
    deliver: async (event) => {
      // Reduce to the same record shape the reconcile path reads back, so both
      // produce an identical app row (app-rows.ts). Reusing the vault's mapper
      // is what makes that identity structural instead of coincidental.
      const record = personalDocumentFromExternalEvent(event, options.provenance ?? {});
      const mapped = appRowFromSourceRecord(record);
      // Not an app-backed source (e.g. facebook → vault only). Skipping is
      // correct and is reported as a delivered no-op, not an error.
      if (!mapped) return { skipped: true, reason: `no_app_for_source:${record.source}` };

      const ownerId = await requireAppOwnerId(sql, workspaceId, normalizedUserId, mapped.app);
      const batch = buildAppSyncBatch(mapped.app, [mapped.row], { cursor: options.cursor });
      return deliverAppSyncBatch(batch, ownerId, options);
    },
  };
}

/**
 * Resolve a source's server-owned principal and build its app-delivery sink.
 *
 * Mirrors `createPersonalVaultExternalSinkForSource` exactly, including the
 * refusal to proceed without an owning user: no provider payload field may
 * nominate or widen the target user, and by extension the target app owner.
 */
export async function createAppDeliveryExternalSinkForSource(
  sql: Sql,
  workspaceId: string,
  sourceId: string,
  options: AppDeliverySinkOptions = {},
): Promise<AppDeliveryExternalSink> {
  const source = await getExternalTriggerSource(sql, workspaceId, sourceId);
  if (!source?.ownerUserId) throw new Error(`external_trigger_source_owner_required:${sourceId}`);
  const sink = createAppDeliveryExternalSink(sql, workspaceId, source.ownerUserId, {
    ...options,
    provenance: { sourceId: source.id, providerAccountId: source.providerAccountId },
  });
  return { ...sink, ref: `user:${source.ownerUserId}:source:${source.id}` };
}

/**
 * The adapter-facing registration door: build this source's app-delivery sink
 * ONLY when the deployment is configured to deliver, else null.
 *
 * SELF-GATING ON THE P-003 MAPPING, NOT A FEATURE FLAG. Writing a mapping is
 * already the deliberate operator act that says "this platform user's <app>
 * data belongs to that app owner" — so it is also the only honest signal that
 * delivery should happen at all. A deployment with no mapping therefore
 * registers no sink: it creates no delivery rows, fails nothing, and costs one
 * indexed lookup per SYNC (not per event). Configuring the mapping is what
 * turns delivery on; there is no second switch to forget.
 *
 * ⚠ DELIBERATELY NOT ALSO GATED ON THE APP'S BASE URL. A mapping present with
 * `<APP>_APP_URL` unset is a MISCONFIGURATION, not an opt-out, and the delivery
 * ledger recording `app_base_url_missing:<app> — set <APP>_APP_URL` is how an
 * operator discovers it. Skipping silently there would convert a loud, curable
 * fault into data that never arrives and nothing that says why.
 *
 * `app` is passed by the adapter rather than derived from its event `source`,
 * because those differ on purpose: the calendar adapter ingests `source:'gcal'`
 * while the personal document it becomes carries `source:'calendar'`, and only
 * the latter is what `appForSource` maps. Taking the app explicitly keeps this
 * gate from having to know which side of that translation it is standing on.
 */
export async function createAppDeliverySinkIfConfigured(
  sql: Sql,
  workspaceId: string,
  sourceId: string,
  app: ProducerApp,
  options: AppDeliverySinkOptions = {},
): Promise<AppDeliveryExternalSink | null> {
  // ⚠ NEVER THROWS, AND THAT IS THE WHOLE POINT OF THIS WRAPPER.
  //
  // P-011 requires that app delivery can never block the personal-vault or
  // event-bus sinks. At DELIVER time the ingestion loop guarantees that for
  // free: it wraps each sink in its own try/catch and marks only THAT sink's
  // row failed (ingestion.ts:293-310). REGISTRATION runs OUTSIDE that loop —
  // so a throw here does what no delivery failure can, and aborts the entire
  // sync including the vault write. A malformed mapping row for one user must
  // not cost that user their Gmail ingestion.
  //
  // Declining therefore degrades to "delivered nothing this sync", which is
  // precisely the gap the P-005 reconcile sweep exists to close.
  try {
    const source = await getExternalTriggerSource(sql, workspaceId, sourceId);
    // No owning user: the personal-vault sink construction that runs first on
    // every adapter path already throws on this, so reaching here means the
    // caller opted out of that ordering. Decline rather than invent an owner.
    if (!source?.ownerUserId) return null;
    const ownerId = await resolveAppOwnerId(sql, workspaceId, source.ownerUserId, app);
    if (!ownerId) return null;
    // One construction path, so the sink ref can never drift between the gated
    // and ungated doors.
    return await createAppDeliveryExternalSinkForSource(sql, workspaceId, sourceId, options);
  } catch (cause) {
    // A declined registration is currently INVISIBLE — no sink means no
    // delivery row, so nothing in the ledger records that we skipped. Reconcile
    // still repairs the data; P-007 owns making the skip observable.
    options.onGateError?.(cause, { app, sourceId });
    return null;
  }
}
