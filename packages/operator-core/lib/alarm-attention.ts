/**
 * Shared delivery rail for periodic alarms that cross an explicit attention
 * threshold.
 *
 * Alarm detectors still own their policy: they decide which observations are
 * severe enough to call a human and provide a title/body. This module owns the
 * cross-alarm mechanics that must not drift: a durable cross-restart cooldown,
 * the attention-notify delivery path, and fail-open observability semantics.
 */
import { getOrgPg } from '@papercusp/db-org';

export const DEFAULT_ALARM_ESCALATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface AlarmAttentionRequest {
  /** Stable title used as the durable cooldown identity. */
  title: string;
  body: string;
  /** The alarm's explicit repeat-notification policy. */
  cooldownMs: number;
  /** Used only to make non-fatal failures attributable in logs. */
  source: string;
}

export interface AlarmAttentionDeps {
  /** Injectable for tests; production defaults to notifyAttention. */
  notify?: (input: { title: string; body: string }) => Promise<void>;
  /** Injectable for tests; production reads the durable notification rail. */
  recentlyEscalated?: () => Promise<boolean>;
}

async function defaultRecentlyEscalated(title: string, cooldownMs: number): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const cutoffIso = new Date(Date.now() - cooldownMs).toISOString();
    const rows = await sql/* sql */ `
      select 1
        from harness_shared.attention_notifications
       where title = ${title}
         and created_at > ${cutoffIso}::timestamptz
       limit 1`;
    return rows.length > 0;
  } catch {
    // Fail open: a cooldown read failure costs one extra ping, while failing
    // closed could swallow the alert that says the system is about to fail.
    return false;
  }
}

async function defaultNotify(input: { title: string; body: string }): Promise<void> {
  const { notifyAttention } = await import('./attention-notify');
  await notifyAttention({
    kind: 'intervention',
    title: input.title,
    body: input.body,
    importance: 'urgent',
  });
}

/**
 * Attempt one attention escalation.
 *
 * Returns true only when the delivery function resolved and false when the
 * durable cooldown suppressed the attempt or the best-effort rail failed.
 * Callers should continue returning their detector result in either case.
 */
export async function escalateAlarm(
  request: AlarmAttentionRequest,
  deps: AlarmAttentionDeps = {},
): Promise<boolean> {
  const recentlyEscalated =
    deps.recentlyEscalated ?? (() => defaultRecentlyEscalated(request.title, request.cooldownMs));
  const notify = deps.notify ?? defaultNotify;

  try {
    if (await recentlyEscalated()) return false;
    await notify({ title: request.title, body: request.body });
    return true;
  } catch (err) {
    console.warn(
      `[${request.source}] escalation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
