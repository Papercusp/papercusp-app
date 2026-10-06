/**
 * Scheduled sweep alerts for connected apps
 * (external-app-access-to-workspaces-2026-09-29 P-328, D-030; split from P-011 by D-028 #5).
 *
 * Every 15 minutes the durable routine `connected-app-alert-sweep` (migration 1267) runs
 * `runConnectedAppAlertSweep`, which reads every non-revoked app and service key once and raises,
 * on the same owner-attention rail as P-011's alerts (`notifyAttentionOnce`):
 *
 *   usage-spike      calls in the last hour >= max(200, 10 x the key's average hour over the prior 7 days)
 *   auth-failures    >= 10 refused uses of the key in the current and previous clock hour
 *                    (counted by `recordAppKeyAuthFailure`, called from `verifyAppKey`)
 *   key-expiring     expires_at within the next 7 days
 *   creator-removed  the key's creator has organization memberships and none of them is active (D-007);
 *                    on a machine, the portal's membership report names them (membership-report.ts)
 *
 * Every alert carries a stable dedupe key, so a sweep that re-runs (a retry, a second host) never
 * notifies twice for the same condition.
 *
 * The relay-limit alert (D-006) is also built here (`relayLimitNotification`) but is raised when a
 * relayed app call opens its channel on the machine, because the usage figure lives on the portal
 * (D-030 #6).
 */

import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import { notifyAttentionOnce, type ReplaySafeAttentionNotifyInput } from '../attention-notify';
import type { AlertedApp } from './alerts';
import { APP_PRINCIPAL_SLUG_PREFIX } from './principal';

/** A spike needs at least this many calls in the last hour, however quiet the key was before. */
export const USAGE_SPIKE_MIN_CALLS = 200;
/** A spike is this many times the key's average hour over the prior 7 days. */
export const USAGE_SPIKE_FACTOR = 10;
/** Refused uses of one key in the current and previous clock hour that raise an alert. */
export const AUTH_FAILURE_ALERT_THRESHOLD = 10;
/** How far ahead of a key's expiry the owner is warned. */
export const KEY_EXPIRY_LEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** Share of the portal relay's monthly bandwidth limit at which the owner is warned (D-006). */
export const RELAY_LIMIT_NEAR_RATIO = 0.8;

const PRIOR_WINDOW_HOURS = 7 * 24;

/**
 * Refusal reasons counted as an auth failure of a known key. `paused` and `remote_access_off` are
 * states the owner chose, and `unknown` / `malformed` name no key, so none of those count.
 */
export const COUNTED_AUTH_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'mismatch',
  'rotated',
  'revoked',
  'expired',
  'token_endpoint_only',
]);

/** What the sweep reads about one key. */
export interface SweepKey extends AlertedApp {
  user_email: string | null;
  expires_at: Date | null;
  calls_last_hour: number;
  calls_prior_7d: number;
  auth_failures: number;
  last_failure_reason: string | null;
  creator_removed: boolean;
}

export type SweepAlert =
  | { kind: 'usage-spike'; app: AlertedApp; calls: number; baselinePerHour: number; day: string }
  | { kind: 'auth-failures'; app: AlertedApp; failures: number; reason: string | null; hour: string }
  | { kind: 'key-expiring'; app: AlertedApp; expiresAt: Date }
  | { kind: 'creator-removed'; app: AlertedApp; creatorEmail: string };

function appOf(key: SweepKey): AlertedApp {
  return { id: key.id, workspace_id: key.workspace_id, kind: key.kind, label: key.label };
}

/** Pure: the alerts one key's state raises at `now`. */
export function sweepAlertsFor(key: SweepKey, now: Date): SweepAlert[] {
  const app = appOf(key);
  const alerts: SweepAlert[] = [];
  const baselinePerHour = key.calls_prior_7d / PRIOR_WINDOW_HOURS;
  if (key.calls_last_hour >= Math.max(USAGE_SPIKE_MIN_CALLS, USAGE_SPIKE_FACTOR * baselinePerHour)) {
    alerts.push({ kind: 'usage-spike', app, calls: key.calls_last_hour, baselinePerHour, day: now.toISOString().slice(0, 10) });
  }
  if (key.auth_failures >= AUTH_FAILURE_ALERT_THRESHOLD) {
    alerts.push({
      kind: 'auth-failures',
      app,
      failures: key.auth_failures,
      reason: key.last_failure_reason,
      hour: now.toISOString().slice(0, 13),
    });
  }
  if (key.expires_at && key.expires_at.getTime() > now.getTime() && key.expires_at.getTime() - now.getTime() <= KEY_EXPIRY_LEAD_MS) {
    alerts.push({ kind: 'key-expiring', app, expiresAt: key.expires_at });
  }
  if (key.creator_removed && key.user_email) {
    alerts.push({ kind: 'creator-removed', app, creatorEmail: key.user_email });
  }
  return alerts;
}

function appName(app: AlertedApp): string {
  const what = app.kind === 'service' ? 'Service key' : 'App';
  return app.label ? `${what} "${app.label}"` : `${what} ${app.id}`;
}

const REASON_TEXT: Record<string, string> = {
  mismatch: 'a wrong secret',
  rotated: 'a secret that was rotated out',
  revoked: 'the key after it was revoked',
  expired: 'the key after it expired',
  token_endpoint_only: 'its client secret as a bearer',
};

/** Pure: the owner-facing message and stable dedupe key for one sweep alert. */
export function sweepAlertNotification(alert: SweepAlert): ReplaySafeAttentionNotifyInput {
  const name = appName(alert.app);
  const base = {
    kind: 'intervention' as const,
    workspaceId: alert.app.workspace_id,
    data: { source: 'connected-app', alert: alert.kind, appId: alert.app.id, route: '/settings/remote-access' },
  };
  switch (alert.kind) {
    case 'usage-spike':
      return {
        ...base,
        importance: 'normal',
        title: `${name} is making far more calls than usual`,
        body: `${alert.calls} calls in the last hour, against about ${Math.round(alert.baselinePerHour)} an hour over the past week. If you did not expect this, pause or revoke it in Settings → Remote access.`,
        dedupeKey: `connected-app:usage-spike:${alert.app.id}:${alert.day}`,
      };
    case 'auth-failures':
      return {
        ...base,
        importance: 'high',
        title: `${name}: ${alert.failures} refused sign-ins in the last hour`,
        body: `Something keeps calling with ${REASON_TEXT[alert.reason ?? ''] ?? 'a credential that is refused'}. Check the app's configuration, or rotate or revoke the key in Settings → Remote access.`,
        dedupeKey: `connected-app:auth-failures:${alert.app.id}:${alert.hour}`,
      };
    case 'key-expiring':
      return {
        ...base,
        importance: 'normal',
        title: `${name} expires on ${alert.expiresAt.toISOString().slice(0, 10)}`,
        body: 'After that it can no longer call this workspace. Give it a new lifetime or create a replacement in Settings → Remote access.',
        dedupeKey: `connected-app:key-expiring:${alert.app.id}:${alert.expiresAt.getTime()}`,
      };
    case 'creator-removed':
      return {
        ...base,
        importance: 'high',
        title: `${name} was created by someone who has left the organization`,
        body: `${alert.creatorEmail} is no longer a member. The key still works because it belongs to the workspace. Review it, then rotate or revoke it in Settings → Remote access.`,
        dedupeKey: `connected-app:creator-removed:${alert.app.id}:${alert.creatorEmail.toLowerCase()}`,
      };
  }
}

/** The portal relay's measured usage for one workspace and month (D-006), sent on `relay.open`. */
export interface RelayUsageReport {
  month: string;
  bytes: number;
  limitBytes: number;
}

/** Pure: parse a portal-authored `relayUsage` field; null when absent or malformed. */
export function parseRelayUsageReport(value: unknown): RelayUsageReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { month, bytes, limitBytes } = value as Record<string, unknown>;
  if (typeof month !== 'string' || !/^\d{4}-\d{2}-01$/.test(month)) return null;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (typeof limitBytes !== 'number' || !Number.isFinite(limitBytes) || limitBytes <= 0) return null;
  return { month, bytes, limitBytes };
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Pure: the relay-limit-near alert for a workspace, or null while usage is under the ratio. */
export function relayLimitNotification(workspaceId: string, usage: RelayUsageReport): ReplaySafeAttentionNotifyInput | null {
  if (usage.bytes < usage.limitBytes * RELAY_LIMIT_NEAR_RATIO) return null;
  const reached = usage.bytes >= usage.limitBytes;
  return {
    kind: 'intervention',
    workspaceId,
    importance: reached ? 'high' : 'normal',
    title: reached ? 'Remote access relay limit reached for this month' : 'Remote access relay is close to its monthly limit',
    body: `Apps have used ${gib(usage.bytes)} of the ${gib(usage.limitBytes)} relay allowance for ${usage.month.slice(0, 7)}. At the limit, relayed app calls are refused until the month ends; apps using your own tunnel are not affected.`,
    dedupeKey: `connected-app:relay-limit-${reached ? 'reached' : 'near'}:${workspaceId}:${usage.month}`,
    data: { source: 'connected-app', alert: reached ? 'relay-limit-reached' : 'relay-limit-near', route: '/settings/remote-access' },
  };
}

/**
 * Relay-limit dedupe keys this process has already raised. Every relayed call past the ratio
 * reports usage; without this each one would re-attempt the (already deduped) durable write.
 */
const relayAlertState = pinModuleState('@papercusp/operator-core.connected-apps.relay-alerts', () => ({
  raised: new Set<string>(),
}));

/** Raise the relay-limit alert a relayed call's usage implies. Best-effort; never throws. */
export async function onRelayUsageReported(
  workspaceId: string,
  value: unknown,
  notify: (input: ReplaySafeAttentionNotifyInput) => Promise<unknown> = notifyAttentionOnce,
): Promise<boolean> {
  const usage = parseRelayUsageReport(value);
  if (!usage) return false;
  const input = relayLimitNotification(workspaceId, usage);
  if (!input) return false;
  if (relayAlertState.raised.has(input.dedupeKey)) return false;
  relayAlertState.raised.add(input.dedupeKey);
  try {
    await notify(input);
    return true;
  } catch (err) {
    relayAlertState.raised.delete(input.dedupeKey);
    console.warn('[connected-apps] relay-limit alert failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Test seam: forget which relay-limit alerts this process has raised. */
export function __resetRelayAlertMemo(): void {
  relayAlertState.raised.clear();
}

type SqlClient = ReturnType<typeof getOrgPg>['sql'];

/**
 * Every non-revoked app and service key, with what the sweep needs, in one query. Admin connection:
 * the sweep serves every workspace. The call counts use migration 1265's partial activity index.
 */
export async function loadSweepKeys(sql: SqlClient = getOrgPg().sql): Promise<SweepKey[]> {
  const rows = await sql<Array<Omit<SweepKey, 'calls_last_hour' | 'calls_prior_7d' | 'auth_failures'> & {
    calls_last_hour: number | string; calls_prior_7d: number | string; auth_failures: number | string;
  }>>`
    SELECT a.id, a.workspace_id, a.kind, a.label, a.user_email, a.expires_at,
           (SELECT count(*) FROM harness_shared.tool_invocations t
             WHERE t.workspace_id = a.workspace_id
               AND t.coord_owner_id LIKE 'app:%'
               AND split_part(t.coord_owner_id, '/', 1) = ${APP_PRINCIPAL_SLUG_PREFIX} || a.id
               AND t.invoked_at >= now() - interval '1 hour') AS calls_last_hour,
           (SELECT count(*) FROM harness_shared.tool_invocations t
             WHERE t.workspace_id = a.workspace_id
               AND t.coord_owner_id LIKE 'app:%'
               AND split_part(t.coord_owner_id, '/', 1) = ${APP_PRINCIPAL_SLUG_PREFIX} || a.id
               AND t.invoked_at >= now() - interval '1 hour' - make_interval(hours => ${PRIOR_WINDOW_HOURS})
               AND t.invoked_at < now() - interval '1 hour') AS calls_prior_7d,
           COALESCE((SELECT sum(f.failures) FROM harness_shared.connected_app_auth_failures f
                      WHERE f.app_id = a.id AND f.hour >= date_trunc('hour', now() - interval '1 hour')), 0) AS auth_failures,
           (SELECT f.last_reason FROM harness_shared.connected_app_auth_failures f
             WHERE f.app_id = a.id ORDER BY f.last_at DESC LIMIT 1) AS last_failure_reason,
           (EXISTS (
             SELECT 1 FROM papercusp_auth.hosted_users u
              WHERE a.user_email IS NOT NULL AND lower(u.primary_email) = lower(a.user_email)
                AND EXISTS (SELECT 1 FROM papercusp_auth.organization_memberships m WHERE m.user_id = u.id)
                AND NOT EXISTS (SELECT 1 FROM papercusp_auth.organization_memberships m
                                 WHERE m.user_id = u.id AND m.status = 'active')
           ) OR EXISTS (
             -- On a machine: the portal's latest membership report (WI-10004257, membership-report.ts).
             SELECT 1 FROM harness_shared.connected_app_removed_creators r
              WHERE a.user_email IS NOT NULL AND r.email = lower(a.user_email)
           )) AS creator_removed
      FROM harness_shared.connected_apps a
     WHERE a.kind IN ('app', 'service') AND a.revoked_at IS NULL
     ORDER BY a.workspace_id, a.id
  `;
  return rows.map((r) => ({
    ...r,
    calls_last_hour: Number(r.calls_last_hour),
    calls_prior_7d: Number(r.calls_prior_7d),
    auth_failures: Number(r.auth_failures),
  }));
}

export interface ConnectedAppAlertSweepDeps {
  load: () => Promise<SweepKey[]>;
  notify: (input: ReplaySafeAttentionNotifyInput) => Promise<unknown>;
  now: () => Date;
}

const DEFAULT_SWEEP_DEPS: ConnectedAppAlertSweepDeps = {
  load: () => loadSweepKeys(),
  notify: notifyAttentionOnce,
  now: () => new Date(),
};

export interface ConnectedAppAlertSweepResult {
  keys: number;
  alerts: SweepAlert[];
  failed: number;
}

/** One sweep. A failed delivery is counted and logged; the rest of the sweep continues. */
export async function runConnectedAppAlertSweep(
  deps: Partial<ConnectedAppAlertSweepDeps> = {},
): Promise<ConnectedAppAlertSweepResult> {
  const { load, notify, now } = { ...DEFAULT_SWEEP_DEPS, ...deps };
  const at = now();
  const keys = await load();
  const alerts: SweepAlert[] = [];
  let failed = 0;
  for (const key of keys) {
    for (const alert of sweepAlertsFor(key, at)) {
      try {
        await notify(sweepAlertNotification(alert));
        alerts.push(alert);
      } catch (err) {
        failed += 1;
        console.warn(`[connected-apps] ${alert.kind} alert for ${alert.app.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return { keys: keys.length, alerts, failed };
}

/**
 * Count one refused use of a known key (D-030 #3). Best-effort: an auth path must never fail
 * because this did. Only reasons in `COUNTED_AUTH_FAILURE_REASONS` are counted.
 */
export async function recordAppKeyAuthFailure(appId: string, reason: string, sql: SqlClient = getOrgPg().sql): Promise<void> {
  if (!COUNTED_AUTH_FAILURE_REASONS.has(reason)) return;
  try {
    await sql`
      INSERT INTO harness_shared.connected_app_auth_failures (app_id, workspace_id, hour, failures, last_reason, last_at)
      SELECT a.id, a.workspace_id, date_trunc('hour', now()), 1, ${reason}, now()
        FROM harness_shared.connected_apps a
       WHERE a.id = ${appId} AND a.kind IN ('app', 'service')
      ON CONFLICT (app_id, hour) DO UPDATE
        SET failures = harness_shared.connected_app_auth_failures.failures + 1,
            last_reason = EXCLUDED.last_reason,
            last_at = EXCLUDED.last_at
    `;
  } catch (err) {
    console.warn('[connected-apps] recording an auth failure failed:', err instanceof Error ? err.message : err);
  }
}
