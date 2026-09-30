/**
 * Telemetry flush worker — PostHog edition.
 *
 * Moves reports out of the in-app ring buffer (operator-state-pg key
 * 'telemetry_reports') into the long-term local archive
 * (harness_shared.telemetry_reports_archive), and emits one PostHog
 * event per archive row that hasn't been forwarded yet — gated by:
 *
 *   user opted in (setup_wizard_state.telemetry_enabled === true)
 *   OR PAPERCUSP_INTERNAL_BUILD === 'true'   (maintainer channel)
 *
 * Host + projectKey resolve from (in order):
 *   1. PAPERCUSP_POSTHOG_HOST + PAPERCUSP_POSTHOG_KEY env (CI / dev)
 *   2. ~/.papercusp/posthog.json discovery file (admin override)
 *   3. POSTHOG_PUBLIC_DEFAULTS bundled with the operator
 *
 * Telemetry forwarding is independent of feature-flag fetches: the
 * `testingFeatures` switch in posthog-config.ts gates flag fetches
 * only, NOT telemetry.
 *
 * When the gate fails this worker still archives locally so the user
 * can see their own reports — it just doesn't forward.
 */
import { getOrgPg } from '@papercusp/db-org';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { activeWorkspaceId } from './workspace-registry';
import { ensureInstallId } from './setup-wizard-install-id';
import { getPosthogConfigWithSource } from './posthog-config';
import { POSTHOG_PUBLIC_DEFAULTS } from './posthog-public-defaults';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

interface BufferedReport {
  received_at: string;
  kind: string;
  app_version?: string;
  os?: string;
  payload: unknown;
}

interface ReportsState {
  reports: BufferedReport[];
}

export interface FlushResult {
  archived: number;
  forwarded: number;
  forwardFailed: number;
  retentionDeleted: number;
  posthogConfigured: boolean;
  internalBuild: boolean;
  optedIn: boolean;
}

const RETENTION_DAYS = Number(process.env.PAPERCUSP_TELEMETRY_RETENTION_DAYS ?? 30);

async function resolveTelemetryConfig(): Promise<{
  host?: string;
  projectKey?: string;
  distinctId: string;
  optedIn: boolean;
  /** True iff this build is the maintainer-internal channel — telemetry
   *  forwards regardless of user opt-in. Default: false. */
  internalBuild: boolean;
}> {
  const state = await readOperatorState<{ telemetry_enabled?: boolean }>('setup_wizard_state');
  const optedIn = Boolean(state?.telemetry_enabled);
  const internalBuild = process.env.PAPERCUSP_INTERNAL_BUILD === 'true';
  const distinctId = await ensureInstallId();

  // Host/key resolution for capture (write-side keys not required):
  //   1. PAPERCUSP_POSTHOG_HOST + PAPERCUSP_POSTHOG_KEY env override
  //   2. ~/.papercusp/posthog.json discovery file (host + projectKey)
  //   3. POSTHOG_PUBLIC_DEFAULTS bundled with the operator
  const envHost = process.env.PAPERCUSP_POSTHOG_HOST;
  const envKey = process.env.PAPERCUSP_POSTHOG_KEY;
  if (envHost && envKey) {
    return { host: envHost, projectKey: envKey, distinctId, optedIn, internalBuild };
  }
  const phResolved = getPosthogConfigWithSource();
  if (phResolved.config) {
    return {
      host: phResolved.config.host,
      projectKey: phResolved.config.projectKey,
      distinctId,
      optedIn,
      internalBuild,
    };
  }
  return {
    host: POSTHOG_PUBLIC_DEFAULTS.host,
    projectKey: POSTHOG_PUBLIC_DEFAULTS.projectKey,
    distinctId,
    optedIn,
    internalBuild,
  };
}

export async function flushTelemetry(): Promise<FlushResult> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const result: FlushResult = {
    archived: 0,
    forwarded: 0,
    forwardFailed: 0,
    retentionDeleted: 0,
    posthogConfigured: false,
    internalBuild: false,
    optedIn: false,
  };

  // 1. Drain ring buffer into local archive (regardless of opt-in —
  //    local visibility is fine without consent; we only stop short of
  //    *forwarding* off-device).
  const buffer = await readOperatorState<ReportsState>('telemetry_reports');
  const reports = buffer?.reports ?? [];
  for (const r of reports) {
    await sql`
      INSERT INTO harness_shared.telemetry_reports_archive
        (workspace_id, received_at, kind, app_version, os, payload)
      VALUES (
        ${workspaceId},
        ${r.received_at}::timestamptz,
        ${r.kind},
        ${r.app_version ?? null},
        ${r.os ?? null},
        ${r.payload ? JSON.stringify(r.payload) : null}::text::jsonb
      )
    `;
    result.archived++;
  }
  if (reports.length > 0) {
    await writeOperatorState('telemetry_reports', { reports: [] });
  }

  // 2. Forward to PostHog. Gates — ALL must hold:
  //      - NODE_ENV === 'production'. Never ship dev events to the
  //        production PostHog. Mirrors the dev-mode bail in
  //        /api/desktop/telemetry-config so the browser SDK and this
  //        server-side worker agree (dev-mode is absolute — it overrides
  //        even PAPERCUSP_INTERNAL_BUILD, same as telemetry-config).
  //      - user opted in (telemetry_enabled === true) OR
  //        PAPERCUSP_INTERNAL_BUILD=true (maintainer channel).
  const config = await resolveTelemetryConfig();
  result.optedIn = config.optedIn;
  result.internalBuild = config.internalBuild;
  const isProd = process.env.NODE_ENV === 'production';
  if (
    isProd &&
    (config.optedIn || config.internalBuild) &&
    config.host &&
    config.projectKey
  ) {
    result.posthogConfigured = true;
    const pending = await sql<
      Array<{
        id: string;
        received_at: Date;
        kind: string;
        app_version: string | null;
        os: string | null;
        payload: unknown;
      }>
    >`
      SELECT id, received_at, kind, app_version, os, payload
        FROM harness_shared.telemetry_reports_archive
       WHERE forwarded_at IS NULL AND workspace_id = ${workspaceId}
       ORDER BY received_at ASC
       LIMIT 100
    `;
    if (pending.length > 0) {
      // Forward as ONE batch via PostHog's /batch/ HTTP endpoint. Unlike
      // posthog-node's fire-and-forget capture() — which never surfaces a
      // delivery failure — a direct POST gives a real signal: rows are
      // marked forwarded ONLY on an HTTP 2xx. On any failure they keep
      // forwarded_at = NULL and are retried on the next flush, so a
      // PostHog outage degrades to delay, not silent data loss.
      const batch = pending.map((row) => ({
        event: `papercusp_${row.kind}`,
        distinct_id: config.distinctId,
        // `received_at: Date` is the TS shape but the postgres driver
        // hands it back as an ISO string at runtime — wrap in Date()
        // so we accept both forms.
        timestamp: new Date(row.received_at).toISOString(),
        properties: {
          app_version: row.app_version,
          os: row.os,
          payload: row.payload,
          $set: { app_version: row.app_version, os: row.os },
          source: 'desktop',
        },
      }));
      try {
        const res = await fetch(`${config.host.replace(/\/+$/, '')}/batch/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ api_key: config.projectKey, batch }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          for (const row of pending) {
            await sql`
              UPDATE harness_shared.telemetry_reports_archive
                 SET forwarded_at = now()
               WHERE id = ${row.id}
            `;
          }
          result.forwarded = pending.length;
        } else {
          result.forwardFailed = pending.length;
          console.error(`[telemetry-flush] posthog /batch/ rejected: HTTP ${res.status}`);
        }
      } catch (e) {
        result.forwardFailed = pending.length;
        console.error('[telemetry-flush] posthog /batch/ failed:', (e as Error)?.message ?? e);
      }
    }
  }

  // 3. Enforce retention on the local archive — UNLESS the owner disabled it on
  // the Storage page (storage-settings-page-2026-06-15 P-006: keep telemetry
  // forever). Fail-safe: getFlag returns the default (true) on a read error, and
  // we keep retention on if the check throws, so this never silently stops a flush.
  let retainTelemetry = true;
  try {
    retainTelemetry = await getFlag(FLAGS.STORAGE_RETAIN_TELEMETRY, 'system:retention');
  } catch {
    /* keep retention enabled */
  }
  if (retainTelemetry && Number.isFinite(RETENTION_DAYS) && RETENTION_DAYS > 0) {
    const deleted = await sql<{ count: number }[]>`
      WITH d AS (
        DELETE FROM harness_shared.telemetry_reports_archive
         WHERE received_at < now() - (${RETENTION_DAYS} || ' days')::interval
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count FROM d
    `;
    result.retentionDeleted = deleted[0]?.count ?? 0;
  }

  return result;
}

// Legacy startTelemetryFlushWorker removed (consolidation P-005): DBOS owns the
// hourly flush (periodic-workflows.ts `telemetryFlush`). `flushTelemetry` above is
// the single-run tick that workflow calls.
