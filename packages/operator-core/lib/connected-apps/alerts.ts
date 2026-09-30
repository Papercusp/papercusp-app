/**
 * Alerts about how a connected app uses its access
 * (external-app-access-to-workspaces-2026-09-29 P-011, D-028).
 *
 *   R-28  the first call from a new connected app raises an alert.
 *   R-42  the first call from a new network location for a connected app raises an alert.
 *   D-006 an alert when a key's spending cap is about to be hit (and when it is hit).
 *
 * Delivery reuses the one owner-attention rail (`notifyAttentionOnce`): mobile push, the desktop
 * native notification, and the durable `attention_notifications` audit row. Every alert carries a
 * stable dedupe key, so a retry or a second host never notifies twice for the same event.
 *
 * The network location comes from the caller-reported client address. It is DISPLAY and ALERT
 * data only and must never feed an authorization decision (see principal.ts).
 */

import { notifyAttentionOnce, type ReplaySafeAttentionNotifyInput } from '../attention-notify';
import type { AppKeyUseOutcome } from './network';

export { networkOf, type AppKeyUseOutcome } from './network';

export type ConnectedAppAlertKind = 'new-app' | 'new-location' | 'spend-cap-near' | 'spend-cap-reached';

/** The key an alert is about. Only fields safe to show the owner. */
export interface AlertedApp {
  id: string;
  workspace_id: string;
  kind: string;
  label: string | null;
}

export interface ConnectedAppAlert {
  kind: ConnectedAppAlertKind;
  app: AlertedApp;
  /** The network the call came from, when known. */
  network?: string | null;
  spentCents?: number;
  capCents?: number;
  /** Start of the cap window this alert belongs to (ms); null = the key's whole lifetime. */
  windowStartMs?: number | null;
}

/** Pure: which alerts one recorded use raises. A first use is one alert, never two. */
export function useAlerts(app: AlertedApp, use: AppKeyUseOutcome): ConnectedAppAlert[] {
  if (use.firstUse) return [{ kind: 'new-app', app, network: use.newNetwork }];
  if (use.newNetwork) return [{ kind: 'new-location', app, network: use.newNetwork }];
  return [];
}

function appName(app: AlertedApp): string {
  const what = app.kind === 'service' ? 'Service key' : 'App';
  return app.label ? `${what} "${app.label}"` : `${what} ${app.id}`;
}

function dollars(cents: number | undefined): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

/** Pure: the owner-facing message and its stable dedupe key. */
export function alertNotification(alert: ConnectedAppAlert): ReplaySafeAttentionNotifyInput {
  const name = appName(alert.app);
  const from = alert.network ? ` from ${alert.network}` : '';
  const window = alert.windowStartMs === null || alert.windowStartMs === undefined ? 'all' : String(alert.windowStartMs);
  const base = {
    kind: 'intervention' as const,
    workspaceId: alert.app.workspace_id,
    importance: alert.kind === 'spend-cap-reached' ? 'high' : 'normal',
    data: { source: 'connected-app', alert: alert.kind, appId: alert.app.id, route: '/settings/remote-access' },
  };
  switch (alert.kind) {
    case 'new-app':
      return {
        ...base,
        title: `${name} used Remote access for the first time`,
        body: `It made its first call${from}. If you did not expect this, pause or revoke it in Settings → Remote access.`,
        dedupeKey: `connected-app:new-app:${alert.app.id}`,
      };
    case 'new-location':
      return {
        ...base,
        title: `${name} called from a new network`,
        body: `First call${from}. If you did not expect this, pause or revoke it in Settings → Remote access.`,
        dedupeKey: `connected-app:new-location:${alert.app.id}:${alert.network ?? 'unknown'}`,
      };
    case 'spend-cap-near':
      return {
        ...base,
        title: `${name} is close to its spending cap`,
        body: `It has spent ${dollars(alert.spentCents)} of its ${dollars(alert.capCents)} cap. New LLM work stops at the cap.`,
        dedupeKey: `connected-app:spend-cap-near:${alert.app.id}:${window}`,
      };
    case 'spend-cap-reached':
      return {
        ...base,
        title: `${name} reached its spending cap`,
        body: `It has spent ${dollars(alert.spentCents)} of its ${dollars(alert.capCents)} cap. New LLM work is refused until you raise the cap or the window resets.`,
        dedupeKey: `connected-app:spend-cap-reached:${alert.app.id}:${window}`,
      };
  }
}

export interface RaiseAlertDeps {
  notify: (input: ReplaySafeAttentionNotifyInput) => Promise<unknown>;
}

const DEFAULT_RAISE_DEPS: RaiseAlertDeps = { notify: notifyAttentionOnce };

/** Deliver one alert. Best-effort: a delivery failure is logged, never thrown into a request. */
export async function raiseConnectedAppAlert(alert: ConnectedAppAlert, deps: RaiseAlertDeps = DEFAULT_RAISE_DEPS): Promise<void> {
  try {
    await deps.notify(alertNotification(alert));
  } catch (err) {
    console.warn(`[connected-apps] ${alert.kind} alert for ${alert.app.id} failed:`, err instanceof Error ? err.message : err);
  }
}

export interface AppKeyUseDeps extends RaiseAlertDeps {
  recordUse: (appId: string, address: string | null) => Promise<AppKeyUseOutcome>;
}

/**
 * Record one authenticated use of a key and raise the alerts it implies. Called for every request
 * that presented a valid key; never throws.
 */
export async function onAppKeyUsed(app: AlertedApp, address: string | null, deps: AppKeyUseDeps): Promise<ConnectedAppAlert[]> {
  let use: AppKeyUseOutcome;
  try {
    use = await deps.recordUse(app.id, address);
  } catch {
    return [];
  }
  const alerts = useAlerts(app, use);
  for (const alert of alerts) await raiseConnectedAppAlert(alert, deps);
  return alerts;
}
