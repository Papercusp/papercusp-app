/**
 * P-007 — per-app producer health, so a producer that is idle, misconfigured,
 * unreachable or falling behind cannot look like a producer that is working.
 *
 * WHY THIS IS A DERIVED READ AND NOT A NEW STATUS TABLE. Almost everything it
 * reports is already recorded by something that owns it: the push path's
 * outcomes and errors are in `harness_shared.trigger_deliveries` (one row per
 * sink per event, written by the ingestion loop), the app's watermark is held
 * by the APP (D-002), and whether delivery is configured at all is the
 * `app_owner_mappings` row (P-003). A status table would be a second copy of
 * all three and would drift from each. So this joins them instead.
 *
 * THE FAILURE IT EXISTS TO END. The producer's OFF state and its BROKEN state
 * look identical from outside — both deliver nothing, quietly:
 *   - no mapping row     → no sink is registered, no delivery row is written;
 *   - `<APP>_APP_URL` unset → `readAppBaseUrl` throws inside a delivery;
 *   - the registration gate throwing → `createAppDeliverySinkIfConfigured`
 *     swallows it to protect the sync (D-013), so there is no ledger row at all;
 *   - the app being down → reconcile skips the run and changes nothing.
 * Only the second and third are faults. Reporting them as distinct CODES, with
 * `fault` stated rather than left to the reader, is the whole point — the same
 * discipline the state-cell registry uses, for the same reason: a bare boolean
 * that means two opposite things cannot be acted on.
 *
 * ⚠ ENUMERATION IS OVER THE APPS, NOT OVER THE MAPPINGS. Iterating mappings
 * would report NOTHING for a workspace that has none — which is precisely the
 * silently-idle state this item exists to make loud. Every known app gets a
 * row whether or not anyone configured it.
 */
import type { Sql } from 'postgres';
import { fetchAppCursor, parseReconcileCursor } from './reconcile';
import { appBaseUrlEnvVar, type AppDeliveryOptions } from './live-sink';
import { listAppOwnerMappings, PRODUCER_APPS, type ProducerApp } from './owner-mapping';

/** The platform `source` each app consumes, as stored on personal_documents. */
const SOURCE_FOR_APP: Record<ProducerApp, string> = {
  email: 'gmail',
  calendar: 'calendar',
};

export type AppProducerHealth =
  /** Configured, reachable, and the app holds everything the platform has. */
  | 'ok'
  /** Configured and reachable, but canonical rows sit after the app's cursor. */
  | 'behind'
  /** No owner mapping. Delivery is deliberately OFF — not a fault. */
  | 'not-configured'
  /** Mapping present but `<APP>_APP_URL` unset: delivery is on and cannot work. */
  | 'misconfigured'
  /** Configured, but the app did not answer its cursor probe. */
  | 'unreachable'
  /** Reachable, but the push path is recording failed deliveries. */
  | 'failing';

/** Codes that mean something is WRONG, as opposed to switched off or caught up. */
const FAULT_CODES: ReadonlySet<AppProducerHealth> = new Set<AppProducerHealth>([
  'misconfigured',
  'unreachable',
  'failing',
]);

export interface AppProducerPushRollup {
  delivered: number;
  failed: number;
  pending: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastDeliveredAt: string | null;
}

export interface AppProducerStatus {
  app: ProducerApp;
  /** Platform user, or null on the `not-configured` row for an app nobody mapped. */
  userId: string | null;
  ownerId: string | null;
  health: AppProducerHealth;
  /**
   * Whether `health` is a FAULT. Stated rather than derived by each reader,
   * because `not-configured` and `misconfigured` are one character apart and
   * mean opposite things — one is the off switch, one is a broken deployment.
   */
  fault: boolean;
  configured: boolean;
  /** Whether `<APP>_APP_URL` is set. The URL itself is deliberately not returned. */
  baseUrlConfigured: boolean;
  /** null when not probed (nothing to probe against). */
  appReachable: boolean | null;
  /** The app's OWN watermark, as it reported it. */
  cursor: string | null;
  /** Canonical rows sitting after `cursor`. null when it could not be measured. */
  pendingRows: number | null;
  push: AppProducerPushRollup;
  /** Human-readable reason, always present on a fault. */
  detail: string | null;
}

export interface AppProducerStatusDeps extends AppDeliveryOptions {
  listMappings?: typeof listAppOwnerMappings;
  fetchCursor?: typeof fetchAppCursor;
  /** Env lookup, injectable so a test need not mutate process.env. */
  readEnv?: (name: string) => string | undefined;
  /** Skip the network probe; report configuration and ledger state only. */
  probeApps?: boolean;
  /**
   * The two data edges, injectable for orchestration tests.
   *
   * ⚠ Stubbing these leaves their SQL at ZERO coverage while the suite stays
   * green — the exact hazard P-005 hit. status.test.ts stubs BOTH in every
   * case, so it covers this function's orchestration and none of the SQL.
   * The SQL is covered instead by status.integration.test.ts, which calls
   * readPushRollup and countPendingRows against a real database. Do not read a
   * green status.test.ts as covering them.
   */
  readRollup?: typeof readPushRollup;
  countPending?: typeof countPendingRows;
}

const EMPTY_PUSH: AppProducerPushRollup = {
  delivered: 0,
  failed: 0,
  pending: 0,
  lastError: null,
  lastErrorAt: null,
  lastDeliveredAt: null,
};

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Roll up the push path's own ledger for one platform user.
 *
 * `sink_ref` is `user:<uuid>` or `user:<uuid>:source:<uuid>` depending on which
 * construction door was used (live-sink.ts), so the match is a prefix on the
 * user segment rather than an equality — and it is anchored with the trailing
 * delimiter so `user:<a>` cannot also match a different uuid that starts with it.
 */
export async function readPushRollup(
  sql: Sql,
  workspaceId: string,
  userId: string,
): Promise<AppProducerPushRollup> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT
      count(*) FILTER (WHERE outcome = 'delivered') AS delivered,
      count(*) FILTER (WHERE outcome = 'failed')    AS failed,
      count(*) FILTER (WHERE outcome = 'pending')   AS pending,
      max(completed_at) FILTER (WHERE outcome = 'delivered') AS last_delivered_at,
      max(updated_at)   FILTER (WHERE outcome = 'failed')    AS last_error_at,
      (ARRAY_AGG(error ORDER BY updated_at DESC)
         FILTER (WHERE outcome = 'failed' AND error IS NOT NULL))[1] AS last_error
      FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${workspaceId}
       AND sink_kind = 'app-delivery'
       AND (sink_ref = ${`user:${userId}`} OR sink_ref LIKE ${`user:${userId}:%`})
  `;
  const row = rows[0];
  if (!row) return { ...EMPTY_PUSH };
  return {
    delivered: Number(row.delivered ?? 0),
    failed: Number(row.failed ?? 0),
    pending: Number(row.pending ?? 0),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    lastErrorAt: iso(row.last_error_at),
    lastDeliveredAt: iso(row.last_delivered_at),
  };
}

/** Canonical rows still sitting after the app's reported cursor. */
export async function countPendingRows(
  sql: Sql,
  workspaceId: string,
  userId: string,
  source: string,
  cursor: string | null,
): Promise<number> {
  const parsed = parseReconcileCursor(cursor);
  const rows = parsed
    ? await sql<{ n: string }[]>`
        SELECT count(*) AS n
          FROM harness_shared.personal_documents
         WHERE workspace_id = ${workspaceId}
           AND user_id = ${userId}
           AND source = ${source}
           AND (COALESCE(occurred_at, imported_at), id) > (${parsed.at}::timestamptz, ${parsed.id}::uuid)
      `
    : await sql<{ n: string }[]>`
        SELECT count(*) AS n
          FROM harness_shared.personal_documents
         WHERE workspace_id = ${workspaceId}
           AND user_id = ${userId}
           AND source = ${source}
      `;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Health for every (app, user) pair, plus a `not-configured` row for any app
 * nobody has mapped.
 *
 * Fail-soft like the sweep it reports on: a probe or query that throws becomes
 * a row saying so, never an exception into whatever is rendering this.
 */
export async function readAppProducerStatus(
  sql: Sql,
  workspaceId: string,
  deps: AppProducerStatusDeps = {},
): Promise<AppProducerStatus[]> {
  const listMappings = deps.listMappings ?? listAppOwnerMappings;
  const fetchCursor = deps.fetchCursor ?? fetchAppCursor;
  const readEnv = deps.readEnv ?? ((name: string) => process.env[name]);
  const probe = deps.probeApps !== false;

  let mappings: Awaited<ReturnType<typeof listAppOwnerMappings>> = [];
  let mappingError: string | null = null;
  try {
    mappings = await listMappings(sql, workspaceId);
  } catch (cause) {
    // The mapping table being unreadable (or absent — migration 1029 unapplied)
    // is itself a fault worth naming, not an empty producer.
    mappingError = cause instanceof Error ? cause.message : String(cause);
  }

  const out: AppProducerStatus[] = [];

  for (const app of PRODUCER_APPS) {
    const baseUrlConfigured = Boolean(readEnv(appBaseUrlEnvVar(app))?.trim());
    const forApp = mappings.filter((m) => m.app === app);

    if (forApp.length === 0) {
      out.push({
        app,
        userId: null,
        ownerId: null,
        health: mappingError ? 'misconfigured' : 'not-configured',
        fault: Boolean(mappingError),
        configured: false,
        baseUrlConfigured,
        appReachable: null,
        cursor: null,
        pendingRows: null,
        push: { ...EMPTY_PUSH },
        detail: mappingError
          ? `owner mappings unreadable: ${mappingError}`
          : `no owner mapping for ${app} — delivery is OFF; write one to turn it on`,
      });
      continue;
    }

    for (const mapping of forApp) {
      out.push(await statusForMapping(sql, workspaceId, app, mapping, {
        baseUrlConfigured,
        probe,
        fetchCursor,
        deps,
      }));
    }
  }

  return out;
}

async function statusForMapping(
  sql: Sql,
  workspaceId: string,
  app: ProducerApp,
  mapping: { userId: string; ownerId: string },
  ctx: {
    baseUrlConfigured: boolean;
    probe: boolean;
    fetchCursor: typeof fetchAppCursor;
    deps: AppProducerStatusDeps;
  },
): Promise<AppProducerStatus> {
  const { userId, ownerId } = mapping;
  const base: AppProducerStatus = {
    app,
    userId,
    ownerId,
    health: 'ok',
    fault: false,
    configured: true,
    baseUrlConfigured: ctx.baseUrlConfigured,
    appReachable: null,
    cursor: null,
    pendingRows: null,
    push: { ...EMPTY_PUSH },
    detail: null,
  };

  try {
    base.push = await (ctx.deps.readRollup ?? readPushRollup)(sql, workspaceId, userId);
  } catch {
    // A ledger read failure must not mask the configuration answer below, which
    // is the more actionable one.
  }

  // A mapping present with no base URL is a MISCONFIGURATION, not an opt-out
  // (live-sink.ts says so at the gate): delivery is switched on and cannot
  // work. Report it before probing, because the probe would fail for this
  // reason and `unreachable` would name the wrong cause.
  if (!ctx.baseUrlConfigured) {
    return finish(base, 'misconfigured', `${appBaseUrlEnvVar(app)} is unset — delivery is configured but has nowhere to send`);
  }

  // `failing` is a LEDGER fact — it needs no network, so it must be reported
  // whether or not the caller opted into probing. The production wiring IS the
  // no-probe path (routines-workflow.ts passes probeApps:false), so gating this
  // behind the probe made the fault code unreachable in exactly the wiring
  // P-007 exists to serve: a mapping with N failed push deliveries reported
  // health 'ok', fault false, and the caller's fault loop printed nothing.
  // `behind` is different and stays probe-only below — it needs the app's own
  // cursor, which only the probe can supply.
  // Precedence is preserved on both paths: with a probe, `unreachable` still
  // outranks `failing` because the failures are usually its consequence; with
  // no probe there is no cause available to name, only the symptom.
  if (!ctx.probe) {
    if (base.push.failed > 0) return finish(base, 'failing', failingDetail(base.push));
    return finish(base, 'ok', null);
  }

  const probe = await ctx.fetchCursor(app, ownerId, ctx.deps);
  base.appReachable = probe.reachable;
  if (!probe.reachable) {
    return finish(base, 'unreachable', `app did not answer its cursor probe: ${probe.error ?? 'unknown'}`);
  }
  base.cursor = probe.cursor;

  try {
    base.pendingRows = await (ctx.deps.countPending ?? countPendingRows)(
      sql, workspaceId, userId, SOURCE_FOR_APP[app], probe.cursor,
    );
  } catch {
    base.pendingRows = null;
  }

  // A failing push path outranks a backlog: the backlog is usually its
  // CONSEQUENCE, and reporting `behind` would name the symptom over the cause.
  if (base.push.failed > 0) {
    return finish(base, 'failing', failingDetail(base.push));
  }
  if ((base.pendingRows ?? 0) > 0) {
    return finish(base, 'behind', `${base.pendingRows} canonical row(s) after the app's cursor — the reconcile sweep should drain these`);
  }
  return finish(base, 'ok', null);
}

/** The `failing` detail line, shared by the probe and no-probe paths so they cannot drift. */
function failingDetail(push: AppProducerPushRollup): string {
  return `${push.failed} failed push deliver${push.failed === 1 ? 'y' : 'ies'}: ${push.lastError ?? 'no error text recorded'}`;
}

function finish(status: AppProducerStatus, health: AppProducerHealth, detail: string | null): AppProducerStatus {
  return { ...status, health, fault: FAULT_CODES.has(health), detail };
}

/** True when any row is a fault — the one-line answer for a caller that only needs a verdict. */
export function hasProducerFault(rows: readonly AppProducerStatus[]): boolean {
  return rows.some((r) => r.fault);
}
