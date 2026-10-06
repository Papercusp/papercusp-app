/**
 * One host-owned connector sync driver over every registered provider
 * (generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
 * P-004 / D-006 / requirement R-3).
 *
 * A provider plugin only answers `syncPage({ source, cursor, mode })`. Everything
 * stateful is the host's, and lives on the source row (migration 1360):
 *
 *  - LEASE: a source is synced by at most one driver at a time. The lease
 *    expires, so a driver that dies mid-sync releases the source implicitly and
 *    the next fire resumes from the last COMMITTED cursor.
 *  - ADMISSION BEFORE COMMIT: every record of a page is admitted through
 *    `ingestExternalTriggerEvent` (the durable per-source/per-sink delivery
 *    ledger) BEFORE the page's cursor is committed. A crash between the two
 *    re-fetches the page on resume; the version-scoped dedupe key makes that
 *    replay a no-op, so each remote object version is delivered exactly once.
 *    A provider that dies mid-page admits nothing and commits nothing.
 *  - VERSION-SCOPED DEDUPE: the key carries the source, datatype, native id and
 *    a hash of the record's content, so a replayed page dedupes while an edit or
 *    a delete of the same object is a new delivery.
 *  - BACKOFF: a rate limit honours `retryAfterSeconds`; a transient failure
 *    backs off exponentially per source. Neither advances the cursor.
 *  - CURSOR RESET: a provider-declared `cursor-expired` restarts the source as a
 *    backfill from a null cursor, once per pass.
 *  - HEALTH: `connected` after a clean pass, `degraded` after repeated
 *    transient failures, `error` when the account must be reconnected.
 *  - PUSH-WAKE: a webhook / Pub/Sub doorbell only calls
 *    {@link wakeConnectorSource}; it is never an alternate data path.
 */
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type postgres from 'postgres';
import type {
  HostFetch,
  ProviderRecord,
  ProviderSyncError,
  ProviderSyncPage,
} from '@papercusp/plugin-sdk';
import {
  ingestExternalTriggerEvent,
  type ExternalTriggerSink,
  type IngestExternalTriggerInput,
  type IngestExternalTriggerResult,
} from '../external-triggers/ingestion';
import { providerRegistry, type ProviderRegistry, type RegisteredProvider } from '../integrations/provider-registry';
import { createSourceHostFetch } from '../integrations/source-host-fetch';
import { resolveProviderServices } from '../integrations/service-credentials';
import {
  PROVIDER_SYNC_ADOPT_CAPABILITY,
  PROVIDER_SYNC_WAKE_CAPABILITY,
  type ProviderAdoptResult,
  type ProviderServices,
  type ProviderWakeResult,
} from '@papercusp/plugin-sdk';
import { createPersonalVaultExternalSinkForSource, VAULT_DATATYPES } from '../personal-vault/live-sink';
import { createDatatypeDestinationSinks } from '../data-sources/datatype-destination-sink';
import { createRelationshipGraphSink } from '../relationship-graph/graph-sink';
import { createInteractionParticipantSink, isInteractionDatatype } from '../relationship-graph/participants';
import { graphDefaultHarness, isGraphEntityDatatype } from '../relationship-graph/resolver';
import { createAppDeliverySinkIfConfigured, reportAppSinkGateError } from '../app-data-producer/live-sink';
import { DATATYPE_FOR_APP } from '../app-data-producer/app-rows';

/** Source statuses the driver advances. `error` waits for a reconnect. */
export const CONNECTOR_SYNC_STATUSES = ['ready', 'connecting', 'connected', 'degraded'] as const;
export const DEFAULT_CONNECTOR_LEASE_SECONDS = 300;
export const DEFAULT_CONNECTOR_POLL_INTERVAL_SECONDS = 300;
export const DEFAULT_CONNECTOR_MAX_PAGES = 20;
/** Consecutive transient failures before a source reports `degraded`. */
export const CONNECTOR_DEGRADED_AFTER_FAILURES = 3;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 3_600;
const SYNC_ERROR_KINDS = new Set<ProviderSyncError['kind']>(['cursor-expired', 'rate-limited', 'auth', 'transient']);

export interface ConnectorSourceRow {
  id: string;
  workspaceId: string;
  kind: string;
  ownerUserId: string | null;
  credentialRef: string | null;
  status: string;
  config: Record<string, unknown>;
  cursor: Record<string, unknown>;
  backfillStatus: string | null;
  failureCount: number;
  wakeRequestedAt: string | null;
}

export type ConnectorSourceOutcomeKind =
  | 'synced'
  | 'leased-elsewhere'
  | 'rate-limited'
  | 'failed'
  | 'reconnect-required';

export interface ConnectorSourceOutcome {
  sourceId: string;
  providerId: string;
  outcome: ConnectorSourceOutcomeKind;
  mode: 'backfill' | 'incremental';
  pages: number;
  admitted: number;
  deduped: number;
  rejected: number;
  cursorReset: boolean;
  /** True when this pass adopted the source's pre-provider cursor state (D-020). */
  adopted?: boolean;
  hasMore: boolean;
  error?: string;
  /** The afterSourceSynced hook failed (the pass itself succeeded). */
  afterSyncError?: string;
}

export interface ConnectorSyncResult {
  providers: number;
  sources: ConnectorSourceOutcome[];
}

export interface ConnectorSyncOptions {
  workspaceId: string;
  /** Install slug whose token store holds the source credentials. */
  harness: string;
  /** Restrict the pass to these sources (push-wake path). Due-ness still applies. */
  sourceIds?: readonly string[];
  maxPagesPerSource?: number;
  leaseSeconds?: number;
  pollIntervalSeconds?: number;
}

export interface ConnectorSyncDeps {
  registry?: ProviderRegistry;
  /** Builds the provider's `host.fetch`; production binds the source account's token. */
  hostFetchFor?: (provider: RegisteredProvider, sql: postgres.Sql, opts: ConnectorSyncOptions) => HostFetch;
  ingest?: (sql: postgres.Sql, input: IngestExternalTriggerInput) => Promise<IngestExternalTriggerResult>;
  /** Extra sinks for one record of `datatype` from `source`. */
  sinksFor?: (sql: postgres.Sql, source: ConnectorSourceRow, datatype: string) => Promise<ExternalTriggerSink[]>;
  /** Parameters of the provider's configured service credentials (D-018.1). */
  servicesFor?: (provider: RegisteredProvider) => Promise<ProviderServices | undefined>;
  leaseOwner?: string;
  /**
   * Runs after a source's pass ends `synced`. Defaults to the admission lifecycle write-back pass
   * (work-admission/lifecycle.ts, linear-asana-task-sync P-003): what the source's admitted work
   * items have done since the last pass is written back once the source's own state is current.
   * A failure here is logged on the outcome and never fails the sync.
   */
  afterSourceSynced?: (sql: postgres.Sql, source: ConnectorSourceRow) => Promise<unknown>;
}

async function defaultAfterSourceSynced(sql: postgres.Sql, source: ConnectorSourceRow): Promise<unknown> {
  // Imported on use: the lifecycle module reaches back into data sources through work admission.
  const { reconcileAdmissionLifecycle } = await import('../work-admission/lifecycle');
  return reconcileAdmissionLifecycle(sql, { workspaceId: source.workspaceId, dataSourceId: source.id });
}

function defaultServicesFor(provider: RegisteredProvider): Promise<ProviderServices | undefined> {
  return resolveProviderServices(provider.descriptor.serviceCredentials);
}

/** A provider-declared sync failure, thrown by host-side code that maps one. */
export class ProviderSyncFailure extends Error {
  constructor(readonly failure: ProviderSyncError) {
    super(failure.message);
    this.name = 'ProviderSyncFailure';
  }
}

/**
 * Map anything a provider threw (a `ProviderSyncError` object, an Error with a
 * `kind`, or a daemon JSON-RPC error carrying one in `data`) to the four
 * signals the host interprets. Anything unrecognised is transient.
 */
export function classifyProviderSyncError(cause: unknown): ProviderSyncError {
  if (cause instanceof ProviderSyncFailure) return cause.failure;
  const candidates = [cause, (cause as { data?: unknown } | null)?.data];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const kind = (candidate as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !SYNC_ERROR_KINDS.has(kind as ProviderSyncError['kind'])) continue;
    const message = String((candidate as { message?: unknown }).message ?? (cause as { message?: unknown })?.message ?? kind);
    if (kind === 'rate-limited') {
      const retry = Number((candidate as { retryAfterSeconds?: unknown }).retryAfterSeconds);
      return Number.isFinite(retry) && retry >= 0
        ? { kind, retryAfterSeconds: retry, message }
        : { kind, message };
    }
    return { kind: kind as 'cursor-expired' | 'auth' | 'transient', message };
  }
  return { kind: 'transient', message: cause instanceof Error ? cause.message : String(cause) };
}

/** Exponential per-source backoff for the Nth consecutive failure (1-based). */
export function connectorBackoffSeconds(failureCount: number): number {
  const n = Math.max(1, Math.floor(failureCount));
  return Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** (n - 1));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Version-scoped delivery dedupe key: the same object version replayed dedupes;
 * an edit (new content) or a delete is a new delivery. Datatype-scoped, so one
 * source emitting two datatypes with the same native id never collides.
 *
 * A record that carries a provider-declared `version` is keyed on that version
 * instead of its content, so a provider whose payload legitimately changes
 * between fetches of the same object (Gmail labels on an immutable message)
 * does not re-deliver it. A delete is still a distinct delivery.
 */
export function connectorRecordDedupeKey(sourceId: string, record: ProviderRecord): string {
  const identity =
    typeof record.version === 'string'
      ? { version: record.version, deleted: record.deleted === true }
      : { payload: record.payload, deleted: record.deleted === true, occurredAt: record.occurredAt ?? null };
  const version = createHash('sha256').update(stableJson(identity)).digest('hex').slice(0, 32);
  return `connector:${sourceId}:${record.datatype}:${record.nativeId}:${version}`;
}

function defaultLeaseOwner(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

/**
 * A scalar for `jsonb_set`, as JSON TEXT cast `::text::jsonb`. `sql.json(<bare string>)` sends
 * the string unquoted, so `::jsonb` rejects it ("invalid input syntax for type json") and every
 * cursor commit failed after its page was admitted.
 */
export function jsonText(value: string | null): string {
  return JSON.stringify(value);
}

function providerCursorOf(source: ConnectorSourceRow): string | null {
  const value = source.cursor?.provider;
  return typeof value === 'string' && value ? value : null;
}

/**
 * The source's pre-provider cursor state, for `sync.adopt` (D-020): its cursor object without
 * the host-owned `provider` and `wake` keys. Null when there is nothing to adopt, and null once
 * the `provider` key EXISTS at all. A cursor-expired reset writes `provider: null`, and
 * re-adopting the stale legacy position after that would loop on the same expired cursor.
 */
export function priorCursorStateOf(source: Pick<ConnectorSourceRow, 'cursor'>): Record<string, unknown> | null {
  const raw: unknown = source.cursor;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.prototype.hasOwnProperty.call(raw, 'provider')) return null;
  const prior: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  delete prior.wake;
  return Object.keys(prior).length > 0 ? prior : null;
}

function asAdoptResult(value: unknown, provider: RegisteredProvider): ProviderAdoptResult {
  const candidate = (value ?? {}) as { cursor?: unknown; backfillComplete?: unknown };
  if (
    !(candidate.cursor === null || (typeof candidate.cursor === 'string' && candidate.cursor))
    || typeof candidate.backfillComplete !== 'boolean'
  ) {
    throw new ProviderSyncFailure({ kind: 'transient', message: `provider ${provider.descriptor.id} returned a malformed sync.adopt result` });
  }
  return { cursor: candidate.cursor, backfillComplete: candidate.backfillComplete };
}

function assertPage(page: unknown, provider: RegisteredProvider): asserts page is ProviderSyncPage {
  const p = page as Partial<ProviderSyncPage> | null;
  if (
    !p
    || !Array.isArray(p.records)
    || typeof p.hasMore !== 'boolean'
    || !(p.nextCursor === null || typeof p.nextCursor === 'string')
  ) {
    throw new ProviderSyncFailure({ kind: 'transient', message: `provider ${provider.descriptor.id} returned a malformed sync page` });
  }
  const declared = new Set(provider.descriptor.datatypes);
  for (const record of p.records) {
    if (!record || typeof record.nativeId !== 'string' || !record.nativeId || !declared.has(record.datatype)) {
      throw new ProviderSyncFailure({
        kind: 'transient',
        message: `provider ${provider.descriptor.id} returned a record with an undeclared datatype or empty native id`,
      });
    }
  }
}

const SOURCE_COLUMNS = (sql: postgres.Sql) => sql`
  id::text,
  workspace_id AS "workspaceId",
  kind,
  owner_user_id::text AS "ownerUserId",
  credential_ref AS "credentialRef",
  status,
  config,
  cursor,
  backfill_status AS "backfillStatus",
  sync_failure_count AS "failureCount",
  sync_wake_requested_at AS "wakeRequestedAt"`;

/** Sources of the given provider kinds that are due for a sync pass now. */
export async function listDueConnectorSources(
  sql: postgres.Sql,
  workspaceId: string,
  kinds: readonly string[],
  sourceIds?: readonly string[],
): Promise<ConnectorSourceRow[]> {
  if (kinds.length === 0) return [];
  return sql<ConnectorSourceRow[]>`
    SELECT ${SOURCE_COLUMNS(sql)}
      FROM harness_shared.data_sources
     WHERE workspace_id = ${workspaceId}
       AND kind = ANY(${sql.array([...kinds])}::text[])
       AND status = ANY(${sql.array([...CONNECTOR_SYNC_STATUSES])}::text[])
       AND (sync_next_attempt_at IS NULL OR sync_next_attempt_at <= now())
       ${sourceIds ? sql`AND id::text = ANY(${sql.array([...sourceIds])}::text[])` : sql``}
     ORDER BY sync_wake_requested_at NULLS LAST, sync_next_attempt_at NULLS FIRST, id`;
}

async function acquireLease(
  sql: postgres.Sql,
  source: ConnectorSourceRow,
  owner: string,
  leaseSeconds: number,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.data_sources
       SET sync_lease_owner = ${owner},
           sync_lease_expires_at = now() + make_interval(secs => ${leaseSeconds})
     WHERE workspace_id = ${source.workspaceId}
       AND id = ${source.id}::uuid
       AND (sync_lease_owner IS NULL
            OR sync_lease_owner = ${owner}
            OR sync_lease_expires_at IS NULL
            OR sync_lease_expires_at < now())
    RETURNING id::text`;
  return rows.length === 1;
}

/**
 * Commit one admitted page's cursor, renewing the lease. Returns false when the
 * lease was lost (another driver took the source over); the caller stops, and
 * its already-admitted records stay replay-safe.
 */
async function commitCursor(
  sql: postgres.Sql,
  source: ConnectorSourceRow,
  owner: string,
  leaseSeconds: number,
  cursor: string | null,
  backfillStatus: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.data_sources
       SET cursor = jsonb_set(COALESCE(cursor, '{}'::jsonb), '{provider}', ${jsonText(cursor)}::text::jsonb),
           backfill_status = ${backfillStatus},
           sync_lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           updated_at = now()
     WHERE workspace_id = ${source.workspaceId}
       AND id = ${source.id}::uuid
       AND sync_lease_owner = ${owner}
    RETURNING id::text`;
  return rows.length === 1;
}

async function finishPass(
  sql: postgres.Sql,
  source: ConnectorSourceRow,
  owner: string,
  input: {
    status: string;
    lastError: string | null;
    failureCount: number;
    nextAttemptSeconds: number | null;
    success: boolean;
    passStartedAt: Date;
  },
): Promise<void> {
  await sql`
    UPDATE harness_shared.data_sources
       SET status = ${input.status},
           last_error = ${input.lastError?.slice(0, 4000) ?? null},
           sync_failure_count = ${input.failureCount},
           sync_last_success_at = CASE WHEN ${input.success} THEN now() ELSE sync_last_success_at END,
           last_connected_at = CASE WHEN ${input.success} THEN now() ELSE last_connected_at END,
           -- A wake that arrived DURING the pass stays set and makes the source due again.
           sync_wake_requested_at = CASE
             WHEN sync_wake_requested_at IS NOT NULL AND sync_wake_requested_at <= ${input.passStartedAt}
               THEN NULL
             ELSE sync_wake_requested_at
           END,
           sync_next_attempt_at = CASE
             WHEN ${input.success} AND sync_wake_requested_at > ${input.passStartedAt} THEN NULL
             WHEN ${input.nextAttemptSeconds}::integer IS NULL THEN NULL
             ELSE now() + make_interval(secs => ${input.nextAttemptSeconds ?? 0})
           END,
           sync_lease_owner = NULL,
           sync_lease_expires_at = NULL,
           updated_at = now()
     WHERE workspace_id = ${source.workspaceId}
       AND id = ${source.id}::uuid
       AND sync_lease_owner = ${owner}`;
}

/**
 * Ask the driver to reconcile one source soon. Push channels call this and
 * nothing else. It never overrides a backoff: a source cooling down after a
 * rate limit or failure keeps its next attempt time.
 */
export async function wakeConnectorSource(
  sql: postgres.Sql,
  input: { workspaceId: string; sourceId: string },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.data_sources
       SET sync_wake_requested_at = now(),
           sync_next_attempt_at = CASE WHEN sync_failure_count = 0 THEN NULL ELSE sync_next_attempt_at END,
           updated_at = now()
     WHERE workspace_id = ${input.workspaceId}
       AND id = ${input.sourceId}::uuid
    RETURNING id::text`;
  return rows.length === 1;
}

/** Construction seams for {@link connectorSinksFor}; production passes none. */
export interface ConnectorSinkSeams {
  createPersonalSink?: (sql: postgres.Sql, workspaceId: string, sourceId: string) => Promise<ExternalTriggerSink>;
  createDatatypeSinks?: typeof createDatatypeDestinationSinks;
  /** The relationship-graph resolve sink appended after a stored person/organization record. */
  createGraphSink?: typeof createRelationshipGraphSink;
  /** The relationship-graph sink that projects a stored interaction's participants as persons. */
  createParticipantSink?: typeof createInteractionParticipantSink;
  createAppSink?: (
    sql: postgres.Sql,
    workspaceId: string,
    sourceId: string,
    app: keyof typeof DATATYPE_FOR_APP,
  ) => Promise<ExternalTriggerSink | null>;
}

/**
 * The production app-sink gate. It never throws (live-sink.ts), and it REPORTS a
 * swallowed gate fault through the shared `reportAppSinkGateError` (P-007), so a
 * database fault is distinguishable from "no app mapping configured".
 */
function defaultAppSink(
  sql: postgres.Sql,
  workspaceId: string,
  sourceId: string,
  app: keyof typeof DATATYPE_FOR_APP,
): Promise<ExternalTriggerSink | null> {
  return createAppDeliverySinkIfConfigured(sql, workspaceId, sourceId, app, { onGateError: reportAppSinkGateError });
}

/**
 * Where one record goes, by DATATYPE only (D-010, D-015): a datatype the personal Vault routes
 * goes to the owner's Vault; every other datatype goes where the datatype registry's nature and
 * the source's destination policy put it (record / event / document). Apps subscribe by datatype:
 * an owned source also registers the app-delivery sink for each app consuming this datatype
 * (P-011). Registration never throws, so an app fault cannot cost the Vault write.
 */
export async function connectorSinksFor(
  sql: postgres.Sql,
  source: ConnectorSourceRow,
  datatype: string,
  seams: ConnectorSinkSeams = {},
): Promise<ExternalTriggerSink[]> {
  const createPersonalSink = seams.createPersonalSink ?? createPersonalVaultExternalSinkForSource;
  const createDatatypeSinks = seams.createDatatypeSinks ?? createDatatypeDestinationSinks;
  const createAppSink = seams.createAppSink ?? defaultAppSink;
  const createGraphSink = seams.createGraphSink ?? createRelationshipGraphSink;
  const createParticipantSink = seams.createParticipantSink ?? createInteractionParticipantSink;
  const sinks: ExternalTriggerSink[] = [];
  if (VAULT_DATATYPES.includes(datatype)) {
    if (source.ownerUserId) sinks.push(await createPersonalSink(sql, source.workspaceId, source.id));
  } else {
    // A graph record from a personal source (no harness of its own) lands in the graph's home
    // harness (D-019); every other datatype still fails closed without a source harness.
    const datatypeSinks = await createDatatypeSinks(sql, {
      workspaceId: source.workspaceId,
      sourceId: source.id,
      datatype,
      ...(isGraphEntityDatatype(datatype) ? { defaultHarness: graphDefaultHarness() } : {}),
    });
    sinks.push(...datatypeSinks);
    // A stored person/organization record re-resolves its identity cluster in the platform
    // relationship graph (crm-agent-sales-onboarding-apps-2026-10-06 P-002). Only when the
    // record sink actually stores it: a source not routing the datatype to `record` adds nothing.
    if (isGraphEntityDatatype(datatype) && datatypeSinks.some((s) => s.kind === 'data-source-record')) {
      sinks.push(createGraphSink(sql, { workspaceId: source.workspaceId, sourceId: source.id, datatype }));
    }
  }
  // A stored interaction (Vault mail/calendar, corpus call) projects its participants into the graph
  // as persons (P-002, D-013): identity only, and only from a source that routes person to record.
  if (isInteractionDatatype(datatype) && sinks.length > 0) {
    const participantSink = await createParticipantSink(sql, { workspaceId: source.workspaceId, sourceId: source.id, datatype });
    if (participantSink) sinks.push(participantSink);
  }
  if (!source.ownerUserId) return sinks;
  for (const [app, appDatatype] of Object.entries(DATATYPE_FOR_APP) as [keyof typeof DATATYPE_FOR_APP, string][]) {
    if (appDatatype !== datatype) continue;
    const appSink = await createAppSink(sql, source.workspaceId, source.id, app);
    if (appSink) sinks.push(appSink);
  }
  return sinks;
}

function defaultSinksFor(sql: postgres.Sql, source: ConnectorSourceRow, datatype: string): Promise<ExternalTriggerSink[]> {
  return connectorSinksFor(sql, source, datatype);
}

/**
 * Production `host.fetch`: the source must belong to this provider; the token is
 * that source's account's. Shared with outbound dispatch (D-014.4) so there is
 * one token path; a reconnect is a provider-declared `auth` failure here.
 */
function defaultHostFetchFor(provider: RegisteredProvider, sql: postgres.Sql, opts: ConnectorSyncOptions): HostFetch {
  return createSourceHostFetch(sql, {
    providerId: provider.descriptor.id,
    workspaceId: opts.workspaceId,
    harness: opts.harness,
    registry: providerRegistry(),
    reconnectRequired: (reason) => new ProviderSyncFailure({ kind: 'auth', message: reason }),
  });
}

async function syncSource(
  sql: postgres.Sql,
  provider: RegisteredProvider,
  source: ConnectorSourceRow,
  opts: Required<Pick<ConnectorSyncOptions, 'maxPagesPerSource' | 'leaseSeconds' | 'pollIntervalSeconds'>> & ConnectorSyncOptions,
  deps: {
    hostFetch: HostFetch;
    ingest: NonNullable<ConnectorSyncDeps['ingest']>;
    sinksFor: NonNullable<ConnectorSyncDeps['sinksFor']>;
    owner: string;
    services?: ProviderServices;
  },
): Promise<ConnectorSourceOutcome> {
  let mode: 'backfill' | 'incremental' = source.backfillStatus === 'complete' ? 'incremental' : 'backfill';
  const outcome: ConnectorSourceOutcome = {
    sourceId: source.id,
    providerId: provider.descriptor.id,
    outcome: 'synced',
    mode,
    pages: 0,
    admitted: 0,
    deduped: 0,
    rejected: 0,
    cursorReset: false,
    hasMore: false,
  };
  const passStartedAt = new Date();
  if (!(await acquireLease(sql, source, deps.owner, opts.leaseSeconds))) {
    return { ...outcome, outcome: 'leased-elsewhere' };
  }
  let cursor = providerCursorOf(source);
  let working = source;
  const sinkCache = new Map<string, ExternalTriggerSink[]>();
  try {
    // D-020: a source a retired host path used to drive starts from that path's freshest
    // position, not from null (which would re-walk the whole history). A failure here fails
    // the pass and is retried; it never falls back to a null start.
    const prior = cursor === null && provider.descriptor.capabilities.includes(PROVIDER_SYNC_ADOPT_CAPABILITY)
      ? priorCursorStateOf(source)
      : null;
    if (prior) {
      const adopted = asAdoptResult(
        await provider.adapter.invoke(
          {
            source: source.id,
            capability: PROVIDER_SYNC_ADOPT_CAPABILITY,
            args: { prior },
            ...(deps.services ? { services: deps.services } : {}),
          },
          { fetch: deps.hostFetch },
        ),
        provider,
      );
      if (adopted.cursor !== null) {
        const backfillStatus = adopted.backfillComplete ? 'complete' : 'pending';
        if (!(await commitCursor(sql, working, deps.owner, opts.leaseSeconds, adopted.cursor, backfillStatus))) {
          return { ...outcome, outcome: 'leased-elsewhere' };
        }
        cursor = adopted.cursor;
        working = { ...working, cursor: { ...working.cursor, provider: cursor }, backfillStatus };
        mode = adopted.backfillComplete ? 'incremental' : 'backfill';
        outcome.mode = mode;
        outcome.adopted = true;
      }
    }
    while (outcome.pages < opts.maxPagesPerSource) {
      let page: ProviderSyncPage;
      try {
        page = await provider.adapter.syncPage(
          {
            source: source.id,
            cursor,
            mode,
            ...(source.config ? { config: source.config } : {}),
            ...(deps.services ? { services: deps.services } : {}),
          },
          { fetch: deps.hostFetch },
        );
        assertPage(page, provider);
      } catch (cause) {
        const failure = classifyProviderSyncError(cause);
        if (failure.kind === 'cursor-expired' && !outcome.cursorReset) {
          outcome.cursorReset = true;
          cursor = null;
          mode = 'backfill';
          outcome.mode = mode;
          if (!(await commitCursor(sql, working, deps.owner, opts.leaseSeconds, null, 'pending'))) {
            return { ...outcome, outcome: 'leased-elsewhere' };
          }
          working = { ...working, cursor: { ...working.cursor, provider: null }, backfillStatus: 'pending' };
          continue;
        }
        throw new ProviderSyncFailure(failure.kind === 'cursor-expired' ? { kind: 'transient', message: failure.message } : failure);
      }
      outcome.pages += 1;
      // Admit every record durably BEFORE the cursor that covers it is committed.
      for (const record of page.records) {
        let sinks = sinkCache.get(record.datatype);
        if (!sinks) {
          sinks = await deps.sinksFor(sql, working, record.datatype);
          sinkCache.set(record.datatype, sinks);
        }
        const result = await deps.ingest(sql, {
          workspaceId: source.workspaceId,
          sourceId: source.id,
          source: provider.descriptor.id,
          event: record.event,
          externalId: record.nativeId,
          datatypeId: record.datatype,
          adapterPayload: record.payload,
          normalize: (payload) => payload as Record<string, unknown>,
          occurredAt: record.occurredAt ?? null,
          dedupeKey: connectorRecordDedupeKey(source.id, record),
          additionalSinks: sinks,
        });
        if (result.validationErrors?.length) outcome.rejected += 1;
        else if (result.deliveries.length > 0 && result.deliveries.every((d) => d.deduped)) outcome.deduped += 1;
        else outcome.admitted += 1;
      }
      const backfillStatus = mode === 'backfill' ? (page.hasMore ? 'running' : 'complete') : 'complete';
      if (!(await commitCursor(sql, working, deps.owner, opts.leaseSeconds, page.nextCursor, backfillStatus))) {
        return { ...outcome, outcome: 'leased-elsewhere' };
      }
      cursor = page.nextCursor;
      working = { ...working, cursor: { ...working.cursor, provider: cursor }, backfillStatus };
      outcome.hasMore = page.hasMore;
      if (!page.hasMore) break;
    }
    await finishPass(sql, working, deps.owner, {
      status: 'connected',
      lastError: outcome.rejected > 0 ? `connector_records_rejected:${outcome.rejected}` : null,
      failureCount: 0,
      // More pages pending → due again immediately; otherwise the poll cadence.
      nextAttemptSeconds: outcome.hasMore ? null : opts.pollIntervalSeconds,
      success: true,
      passStartedAt,
    });
    return outcome;
  } catch (cause) {
    const failure = classifyProviderSyncError(cause);
    const failureCount = working.failureCount + 1;
    if (failure.kind === 'auth') {
      await finishPass(sql, working, deps.owner, {
        status: 'error',
        lastError: `reconnect_required: ${failure.message}`,
        failureCount,
        nextAttemptSeconds: null,
        success: false,
        passStartedAt,
      });
      return { ...outcome, outcome: 'reconnect-required', error: failure.message };
    }
    if (failure.kind === 'rate-limited') {
      await finishPass(sql, working, deps.owner, {
        // A rate limit is the provider pacing us, not an unhealthy source.
        status: working.status === 'degraded' ? 'degraded' : 'connected',
        lastError: `rate_limited: ${failure.message}`,
        failureCount,
        nextAttemptSeconds: Math.ceil(failure.retryAfterSeconds ?? connectorBackoffSeconds(failureCount)),
        success: false,
        passStartedAt,
      });
      return { ...outcome, outcome: 'rate-limited', error: failure.message };
    }
    await finishPass(sql, working, deps.owner, {
      status: failureCount >= CONNECTOR_DEGRADED_AFTER_FAILURES ? 'degraded' : working.status,
      lastError: failure.message,
      failureCount,
      nextAttemptSeconds: connectorBackoffSeconds(failureCount),
      success: false,
      passStartedAt,
    });
    return { ...outcome, outcome: 'failed', error: failure.message };
  }
}

/**
 * One driver pass: every due source of every registered provider, each under
 * its own lease, bounded to `maxPagesPerSource` pages. Sources are independent;
 * one failing source never stops the others.
 */
export async function runConnectorSync(
  sql: postgres.Sql,
  opts: ConnectorSyncOptions,
  deps: ConnectorSyncDeps = {},
): Promise<ConnectorSyncResult> {
  const registry = deps.registry ?? providerRegistry();
  const providers = registry.list();
  const byKind = new Map(providers.map((provider) => [provider.descriptor.id, provider]));
  const resolved = {
    ...opts,
    maxPagesPerSource: opts.maxPagesPerSource ?? DEFAULT_CONNECTOR_MAX_PAGES,
    leaseSeconds: opts.leaseSeconds ?? DEFAULT_CONNECTOR_LEASE_SECONDS,
    pollIntervalSeconds: opts.pollIntervalSeconds ?? DEFAULT_CONNECTOR_POLL_INTERVAL_SECONDS,
  };
  const owner = deps.leaseOwner ?? defaultLeaseOwner();
  const ingest = deps.ingest ?? ((db, input) => ingestExternalTriggerEvent(db, input));
  const sinksFor = deps.sinksFor ?? defaultSinksFor;
  const hostFetchFor = deps.hostFetchFor ?? defaultHostFetchFor;
  const sources = await listDueConnectorSources(sql, opts.workspaceId, [...byKind.keys()], opts.sourceIds);
  const servicesFor = deps.servicesFor ?? defaultServicesFor;
  const afterSourceSynced = deps.afterSourceSynced ?? defaultAfterSourceSynced;
  const fetchers = new Map<string, HostFetch>();
  const servicesByProvider = new Map<string, ProviderServices | undefined>();
  const outcomes: ConnectorSourceOutcome[] = [];
  for (const source of sources) {
    const provider = byKind.get(source.kind);
    if (!provider) continue;
    let hostFetch = fetchers.get(provider.descriptor.id);
    if (!hostFetch) {
      hostFetch = hostFetchFor(provider, sql, opts);
      fetchers.set(provider.descriptor.id, hostFetch);
    }
    if (!servicesByProvider.has(provider.descriptor.id)) {
      servicesByProvider.set(provider.descriptor.id, await servicesFor(provider));
    }
    const services = servicesByProvider.get(provider.descriptor.id);
    const outcome = await syncSource(sql, provider, source, resolved, { hostFetch, ingest, sinksFor, owner, services });
    if (outcome.outcome === 'synced') {
      try {
        await afterSourceSynced(sql, source);
      } catch (cause) {
        outcome.afterSyncError = cause instanceof Error ? cause.message : String(cause);
      }
    }
    outcomes.push(outcome);
  }
  return { providers: providers.length, sources: outcomes };
}

/* ─── Push wake (D-018.2) ─── */

export interface ConnectorWakeOutcome {
  sourceId: string;
  providerId: string;
  outcome: 'woken' | 'quiet' | 'failed';
  error?: string;
}

export interface ConnectorWakeResult {
  sources: ConnectorWakeOutcome[];
}

export interface ConnectorWakeDeps {
  registry?: ProviderRegistry;
  hostFetchFor?: ConnectorSyncDeps['hostFetchFor'];
  servicesFor?: ConnectorSyncDeps['servicesFor'];
}

function wakeStateOf(source: ConnectorSourceRow): string | null {
  const value = source.cursor?.wake;
  return typeof value === 'string' && value ? value : null;
}

function asWakeResult(value: unknown): ProviderWakeResult {
  const candidate = (value ?? {}) as { wake?: unknown; state?: unknown };
  if (typeof candidate.wake !== 'boolean') throw new Error('sync.wake returned no boolean `wake`');
  if (candidate.state !== undefined && candidate.state !== null && typeof candidate.state !== 'string') {
    throw new Error('sync.wake returned a non-string `state`');
  }
  return { wake: candidate.wake, state: candidate.state as string | null | undefined };
}

/**
 * Ask every provider that declares `sync.wake` whether each of its syncable
 * sources has remote changes, before the sync pass. Wake is only a doorbell:
 * a `wake: true` answer calls {@link wakeConnectorSource} and nothing else, and
 * the provider's opaque wake state is stored at `cursor.wake`. A failure is
 * reported per source and never fails the sync pass.
 */
export async function runConnectorWakes(
  sql: postgres.Sql,
  opts: Pick<ConnectorSyncOptions, 'workspaceId' | 'harness' | 'sourceIds'>,
  deps: ConnectorWakeDeps = {},
): Promise<ConnectorWakeResult> {
  const registry = deps.registry ?? providerRegistry();
  const wakers = registry
    .list()
    .filter((provider) => provider.descriptor.capabilities.includes(PROVIDER_SYNC_WAKE_CAPABILITY) && provider.adapter.invoke);
  if (wakers.length === 0) return { sources: [] };
  const byKind = new Map(wakers.map((provider) => [provider.descriptor.id, provider]));
  const hostFetchFor = deps.hostFetchFor ?? defaultHostFetchFor;
  const servicesFor = deps.servicesFor ?? defaultServicesFor;
  const sources = await sql<ConnectorSourceRow[]>`
    SELECT ${SOURCE_COLUMNS(sql)}
      FROM harness_shared.data_sources
     WHERE workspace_id = ${opts.workspaceId}
       AND kind = ANY(${sql.array([...byKind.keys()])}::text[])
       AND status = ANY(${sql.array([...CONNECTOR_SYNC_STATUSES])}::text[])
       ${opts.sourceIds ? sql`AND id::text = ANY(${sql.array([...opts.sourceIds])}::text[])` : sql``}
     ORDER BY id`;
  const outcomes: ConnectorWakeOutcome[] = [];
  const perProvider = new Map<string, { fetch: HostFetch; services: ProviderServices | undefined }>();
  for (const source of sources) {
    const provider = byKind.get(source.kind);
    if (!provider?.adapter.invoke) continue;
    let bound = perProvider.get(provider.descriptor.id);
    if (!bound) {
      bound = { fetch: hostFetchFor(provider, sql, opts as ConnectorSyncOptions), services: await servicesFor(provider) };
      perProvider.set(provider.descriptor.id, bound);
    }
    try {
      const result = asWakeResult(
        await provider.adapter.invoke(
          {
            source: source.id,
            capability: PROVIDER_SYNC_WAKE_CAPABILITY,
            args: { state: wakeStateOf(source) },
            ...(bound.services ? { services: bound.services } : {}),
          },
          { fetch: bound.fetch },
        ),
      );
      if (result.state !== undefined && result.state !== wakeStateOf(source)) {
        await sql`
          UPDATE harness_shared.data_sources
             SET cursor = jsonb_set(COALESCE(cursor, '{}'::jsonb), '{wake}', ${jsonText(result.state ?? null)}::text::jsonb),
                 updated_at = now()
           WHERE workspace_id = ${source.workspaceId}
             AND id = ${source.id}::uuid`;
      }
      if (result.wake) await wakeConnectorSource(sql, { workspaceId: source.workspaceId, sourceId: source.id });
      outcomes.push({ sourceId: source.id, providerId: provider.descriptor.id, outcome: result.wake ? 'woken' : 'quiet' });
    } catch (cause) {
      outcomes.push({
        sourceId: source.id,
        providerId: provider.descriptor.id,
        outcome: 'failed',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { sources: outcomes };
}

export function formatConnectorWakeLog(result: ConnectorWakeResult): string {
  const count = (kind: ConnectorWakeOutcome['outcome']) => result.sources.filter((s) => s.outcome === kind).length;
  const failures = result.sources
    .filter((s) => s.outcome === 'failed')
    .map((s) => `${s.sourceId}: ${s.error}`)
    .join('; ');
  return `[connector-wake] sources=${result.sources.length} woken=${count('woken')} quiet=${count('quiet')} failed=${count('failed')}${failures ? ` errors=${failures}` : ''}`;
}

export function formatConnectorSyncLog(result: ConnectorSyncResult): string {
  const count = (kind: ConnectorSourceOutcomeKind) => result.sources.filter((s) => s.outcome === kind).length;
  const admitted = result.sources.reduce((n, s) => n + s.admitted, 0);
  return (
    `[connector-sync] providers=${result.providers} sources=${result.sources.length} synced=${count('synced')} `
    + `rate_limited=${count('rate-limited')} failed=${count('failed')} reconnect=${count('reconnect-required')} `
    + `leased_elsewhere=${count('leased-elsewhere')} admitted=${admitted}`
  );
}
