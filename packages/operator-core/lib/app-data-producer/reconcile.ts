/**
 * P-005 — the reconcile sweep: the producer proper.
 *
 * For each configured (owner, app) pair it asks the APP where its cursor is
 * (D-002), selects canonical `documents` rows after that point (D-004),
 * maps them with the SAME mapper the push sink uses (app-rows.ts), POSTs the
 * batch, and reports the outcome. Idempotent by construction: both apps upsert
 * by row id, so a replayed batch is safe and a partially-applied run self-heals
 * on the next pass.
 *
 * WHY THIS EXISTS EVEN THOUGH P-011 PUSHES LIVE. Push gives freshness; this
 * gives COMPLETENESS, and the two failure sets are different:
 *   - rows that predate push entirely (the backfill corpus — P-006 rides this
 *     exact path rather than inventing a second one);
 *   - a delivery that failed because the app was down;
 *   - a sync where the app-delivery sink was never REGISTERED, because the gate
 *     declined (D-013). That case is invisible in the delivery ledger — no sink
 *     means no row — so reconcile is its ONLY repair path, not merely a faster
 *     one.
 *
 * D-002 IS LOAD-BEARING AND ASYMMETRIC — do not "simplify" the two skip cases
 * into one. An UNREACHABLE app means skip this run and change nothing; an app
 * that answers with an EMPTY cursor means start from the beginning. They look
 * similar in code and are opposites in effect: conflating them either refills a
 * healthy app from zero every run, or leaves a wiped app permanently short with
 * nothing failing loudly.
 */
import type { Sql } from 'postgres';
import { appRowFromSourceRecord, buildAppSyncBatch, type ProducerSourceRecord } from './app-rows';
import {
  deliverAppSyncBatch,
  readAppBaseUrl,
  APP_DELIVERY_TIMEOUT_MS,
  type AppDeliveryOptions,
} from './live-sink';
import { appServiceAuthHeader } from './app-auth';
import { listAppOwnerMappings, type ProducerApp } from './owner-mapping';
import { APP_SYNC_SOURCE_REF, DATATYPE_FOR_APP } from './app-rows';

/** Rows per POST. Bounded so one pathological user cannot build an unsendable body. */
export const RECONCILE_BATCH_SIZE = 200;

/**
 * Rows per (owner, app) per run. The sweep PAGES within a run up to this, so a
 * cold corpus drains in a few passes instead of one row-batch per interval —
 * which is what lets P-006's backfill be "run the sweep" rather than a separate
 * program.
 */
export const RECONCILE_MAX_ROWS_PER_RUN = 2_000;

export interface ReconcileCursor {
  /** ISO time of the last delivered row, from COALESCE(occurred_at, imported_at). */
  at: string;
  /** Row id, breaking ties when several rows share a timestamp. */
  id: string;
}

/**
 * Cursor wire format: `<iso>|<uuid>`.
 *
 * The app stores and returns this opaquely, so the producer owns the format.
 * The id tiebreak is not decoration — Gmail delivers bursts that land on the
 * same `occurred_at`, and a timestamp-only cursor either re-sends or skips the
 * rest of a tied group depending on which comparison you pick.
 */
export function encodeReconcileCursor(cursor: ReconcileCursor): string {
  return `${cursor.at}|${cursor.id}`;
}

/**
 * Parse a cursor, or null if it is absent//unusable.
 *
 * A cursor we cannot parse is treated as ABSENT (start from the beginning),
 * never as an error that stops the run: the app is the cursor's owner, and an
 * unreadable one means re-deliver — which is safe, because delivery is an
 * idempotent upsert. Failing the run instead would leave the app permanently
 * stuck on the bad value with no way to heal.
 */
export function parseReconcileCursor(raw: string | null | undefined): ReconcileCursor | null {
  const value = raw?.trim();
  if (!value) return null;
  const sep = value.lastIndexOf('|');
  if (sep <= 0 || sep === value.length - 1) return null;
  const at = value.slice(0, sep).trim();
  const id = value.slice(sep + 1).trim();
  if (!at || !id) return null;
  if (Number.isNaN(new Date(at).getTime())) return null;
  return { at, id };
}

export interface CanonicalRow extends ProducerSourceRecord {
  id: string;
  /** COALESCE(occurred_at, imported_at) — the ordering key, never null. */
  cursorAt: string;
}

/**
 * Select the next page of canonical rows for one user+source, after `cursor`.
 *
 * Ordering is on COALESCE(occurred_at, imported_at) rather than occurred_at
 * alone. `occurred_at` is NULLABLE in the schema, and a null sorts unpredictably
 * against a cursor comparison — so a single null-dated row could either stall
 * the sweep or be skipped forever. `imported_at` is NOT NULL, which makes the
 * ordering key total by construction rather than by luck about current data.
 */
export async function selectCanonicalRowsAfter(
  sql: Sql,
  workspaceId: string,
  userId: string,
  datatypeId: string,
  cursor: ReconcileCursor | null,
  limit: number,
): Promise<CanonicalRow[]> {
  const rows = cursor
    ? await sql<Record<string, unknown>[]>`
        SELECT id, source, datatype_id, source_id::text, provider_account_id, kind, external_id, occurred_at, title, text, metadata,
               COALESCE(occurred_at, imported_at) AS cursor_at
          FROM harness_shared.documents
         WHERE workspace_id = ${workspaceId}
           AND user_id = ${userId}
           AND datatype_id = ${datatypeId}
           AND (COALESCE(occurred_at, imported_at), id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)
         ORDER BY COALESCE(occurred_at, imported_at) ASC, id ASC
         LIMIT ${limit}
      `
    : await sql<Record<string, unknown>[]>`
        SELECT id, source, datatype_id, source_id::text, provider_account_id, kind, external_id, occurred_at, title, text, metadata,
               COALESCE(occurred_at, imported_at) AS cursor_at
          FROM harness_shared.documents
         WHERE workspace_id = ${workspaceId}
           AND user_id = ${userId}
           AND datatype_id = ${datatypeId}
         ORDER BY COALESCE(occurred_at, imported_at) ASC, id ASC
         LIMIT ${limit}
      `;

  return rows.map((row) => ({
    id: String(row.id),
    source: String(row.source),
    datatypeId: row.datatype_id === null || row.datatype_id === undefined ? null : String(row.datatype_id),
    sourceId: row.source_id === null || row.source_id === undefined ? null : String(row.source_id),
    providerAccountId: row.provider_account_id === null || row.provider_account_id === undefined ? null : String(row.provider_account_id),
    kind: String(row.kind),
    externalId: row.external_id === null || row.external_id === undefined ? null : String(row.external_id),
    occurredAt: (row.occurred_at as string | Date | null) ?? null,
    title: row.title === null || row.title === undefined ? null : String(row.title),
    text: row.text === null || row.text === undefined ? null : String(row.text),
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    cursorAt: new Date(row.cursor_at as string | Date).toISOString(),
  }));
}

export interface FetchAppCursorResult {
  reachable: boolean;
  cursor: string | null;
  error?: string;
}

/**
 * Ask the app where its cursor is (D-002).
 *
 * `reachable` is reported SEPARATELY from `cursor` precisely because the two
 * skip cases must not collapse: `{reachable:false}` means skip the run, while
 * `{reachable:true, cursor:null}` means the app genuinely has nothing and wants
 * a full refill. A single nullable return could not tell those apart.
 */
export async function fetchAppCursor(
  app: ProducerApp,
  ownerId: string,
  options: AppDeliveryOptions = {},
): Promise<FetchAppCursorResult> {
  const baseUrl = options.baseUrl?.replace(/\/+$/, '') || readAppBaseUrl(app);
  const doFetch = options.fetchImpl ?? fetch;
  const sourceRef = APP_SYNC_SOURCE_REF;
  try {
    const authorization = await appServiceAuthHeader(app, ownerId, { secret: options.secret });
    const response = await doFetch(
      `${baseUrl}/api/sync/cursor?sourceRef=${encodeURIComponent(sourceRef)}`,
      {
        method: 'GET',
        headers: { authorization },
        signal: AbortSignal.timeout(options.timeoutMs ?? APP_DELIVERY_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return { reachable: false, cursor: null, error: `cursor_http_${response.status}` };
    }
    const parsed = (await response.json()) as { ok?: unknown; cursor?: unknown };
    if (parsed && parsed.ok === false) {
      return { reachable: false, cursor: null, error: 'cursor_not_ok' };
    }
    const cursor = typeof parsed?.cursor === 'string' ? parsed.cursor : null;
    return { reachable: true, cursor };
  } catch (cause) {
    return {
      reachable: false,
      cursor: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export type ReconcileOutcome = 'delivered' | 'up-to-date' | 'skipped' | 'error';

export interface ReconcileResult {
  app: ProducerApp;
  userId: string;
  ownerId: string;
  outcome: ReconcileOutcome;
  rowsDelivered: number;
  /** Rows SELECTED this run, including ones skipped as unmappable. Bounds the run. */
  rowsRead: number;
  batches: number;
  /** True when the run hit its per-run cap and more rows remain. */
  more: boolean;
  /**
   * The watermark the APP now holds — not the sweep's local position.
   *
   * Only a delivered batch moves the app's cursor, so on an errored run this
   * reports where the app actually is, which is what the next run resumes from.
   */
  cursor: string | null;
  reason?: string;
}

function sameCursor(a: ReconcileCursor | null, b: ReconcileCursor | null): boolean {
  if (a === null || b === null) return a === b;
  return a.at === b.at && a.id === b.id;
}

export interface ReconcileDeps extends AppDeliveryOptions {
  batchSize?: number;
  maxRowsPerRun?: number;
  listMappings?: typeof listAppOwnerMappings;
  fetchCursor?: typeof fetchAppCursor;
  selectRows?: typeof selectCanonicalRowsAfter;
  deliver?: typeof deliverAppSyncBatch;
}

/**
 * Reconcile ONE (owner, app) pair. Never throws — every failure becomes a
 * result row, so one unreachable app cannot abort the others' catch-up.
 */
export async function reconcileOnePair(
  sql: Sql,
  workspaceId: string,
  mapping: { userId: string; app: ProducerApp; ownerId: string },
  deps: ReconcileDeps = {},
): Promise<ReconcileResult> {
  const { app, userId, ownerId } = mapping;
  const base: ReconcileResult = {
    app, userId, ownerId, outcome: 'skipped',
    rowsDelivered: 0, rowsRead: 0, batches: 0, more: false, cursor: null,
  };

  const fetchCursor = deps.fetchCursor ?? fetchAppCursor;
  const selectRows = deps.selectRows ?? selectCanonicalRowsAfter;
  const deliver = deps.deliver ?? deliverAppSyncBatch;
  const batchSize = deps.batchSize ?? RECONCILE_BATCH_SIZE;
  const maxRows = deps.maxRowsPerRun ?? RECONCILE_MAX_ROWS_PER_RUN;

  let cursorRaw: string | null;
  try {
    const probe = await fetchCursor(app, ownerId, deps);
    // D-002: unreachable means SKIP, never restart from zero.
    if (!probe.reachable) {
      return { ...base, outcome: 'skipped', reason: `app_unreachable: ${probe.error ?? 'unknown'}` };
    }
    cursorRaw = probe.cursor;
  } catch (cause) {
    return {
      ...base,
      outcome: 'skipped',
      reason: `app_unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  // Reachable + empty cursor is the self-healing refill case, NOT a skip.
  let cursor = parseReconcileCursor(cursorRaw);
  const datatypeId = DATATYPE_FOR_APP[app];
  let rowsDelivered = 0;
  let rowsRead = 0;
  let batches = 0;
  /**
   * The cursor the app has actually been TOLD about. Only a delivered batch
   * carries one, so skipping rows moves `cursor` and leaves this behind — the
   * gap the end-of-run flush closes.
   */
  let ackedCursor = cursor;

  try {
    // P-006: the bound is on rows READ, not rows DELIVERED. A page whose rows
    // all fail to map delivers nothing, so a delivered-row bound would not
    // advance at all and one routinesTick step could read the entire corpus.
    // Steady-state never exposes that (pages are tiny); backfill is exactly
    // the regime where a long unmappable span is plausible.
    while (rowsRead < maxRows) {
      const take = Math.min(batchSize, maxRows - rowsRead);
      const rows = await selectRows(sql, workspaceId, userId, datatypeId, cursor, take);
      if (rows.length === 0) break;

      const mapped: Record<string, unknown>[] = [];
      for (const row of rows) {
        // A row that cannot be mapped is SKIPPED, not fatal: it must not wedge
        // the cursor and block every later row behind it forever.
        try {
          const result = appRowFromSourceRecord(row);
          if (result) mapped.push(result.row);
        } catch {
          // Structurally unusable (no external id). Advancing past it is
          // deliberate — see the cursor advance below.
        }
      }

      const last = rows[rows.length - 1];
      const nextCursor: ReconcileCursor = { at: last.cursorAt, id: last.id };

      if (mapped.length > 0) {
        const batch = buildAppSyncBatch(app, mapped, { cursor: encodeReconcileCursor(nextCursor) });
        await deliver(batch, ownerId, deps);
        batches += 1;
        ackedCursor = nextCursor;
      }

      // Advance past the whole page even when nothing in it mapped, so an
      // unmappable row is stepped over rather than re-read every run.
      cursor = nextCursor;
      rowsDelivered += mapped.length;
      rowsRead += rows.length;
      if (rows.length < take) break;
    }

    // FLUSH A SKIPPED-ONLY ADVANCE. Stepping over an unmappable row moves the
    // sweep's local cursor but tells the app nothing, so the next RUN re-reads
    // those rows — merely wasteful under the old unbounded loop, but a hard
    // wedge now that the run is bounded: a contiguous unmappable span longer
    // than the cap would be re-read forever and backfill would never
    // terminate. A rows-empty batch closes that. It is the apps' own supported
    // shape, not a new contract — both ingress schemas default their row
    // arrays to [] and `recordSyncStatus` persists `batch.cursor` regardless of
    // row count, because the app owns the watermark (D-002) and a row we
    // deliberately skipped IS processed.
    if (cursor && !sameCursor(cursor, ackedCursor)) {
      const batch = buildAppSyncBatch(app, [], { cursor: encodeReconcileCursor(cursor) });
      await deliver(batch, ownerId, deps);
      batches += 1;
      ackedCursor = cursor;
    }
  } catch (cause) {
    return {
      ...base,
      outcome: 'error',
      rowsDelivered,
      rowsRead,
      batches,
      cursor: ackedCursor ? encodeReconcileCursor(ackedCursor) : null,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }

  // `more` is only meaningful when we stopped because of the cap. Note the
  // pairing `up-to-date` + `more:true`: this window held nothing deliverable,
  // but the scan is not finished — read `more`, never `outcome` alone.
  const more = rowsRead >= maxRows;
  return {
    ...base,
    outcome: rowsDelivered > 0 ? 'delivered' : 'up-to-date',
    rowsDelivered,
    rowsRead,
    batches,
    more,
    cursor: ackedCursor ? encodeReconcileCursor(ackedCursor) : null,
  };
}

/**
 * The routine entry point: reconcile every configured (owner, app) pair.
 *
 * Fail-soft throughout, like every other routinesTick sweep — a thrown error
 * here would abort the tick and take unrelated sweeps down with it.
 */
export async function appDataProducerReconcileSweep(
  sql: Sql,
  workspaceId: string,
  deps: ReconcileDeps = {},
): Promise<ReconcileResult[]> {
  const listMappings = deps.listMappings ?? listAppOwnerMappings;
  let mappings: Awaited<ReturnType<typeof listAppOwnerMappings>>;
  try {
    mappings = await listMappings(sql, workspaceId);
  } catch {
    // No work list, no work. An unconfigured or unreachable mapping table is
    // silence, not an exception thrown into the shared tick.
    return [];
  }

  const results: ReconcileResult[] = [];
  for (const mapping of mappings) {
    results.push(
      await reconcileOnePair(
        sql,
        workspaceId,
        { userId: mapping.userId, app: mapping.app, ownerId: mapping.ownerId },
        deps,
      ),
    );
  }
  return results;
}
