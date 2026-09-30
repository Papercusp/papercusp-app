/**
 * notifyAttention — the single delivery path for "ping the human now" events
 * (planning-attention-importance-2026-05-31, P-020/P-021/D-007).
 *
 * Replaces the device-intervention-watcher 60s poll (P-021): producers call
 * this at the source (the /api/internal/*-event endpoints, plans:set-status)
 * the moment a ≥high attention item appears, instead of a timer scanning PG.
 *
 * Two channels, each independently fail-safe (a delivery error is logged and
 * swallowed — it must never propagate into the producer's write path):
 *   1. mobile  — notifyWorkspace → APNs/FCM to paired devices (no-op when
 *                none are paired).
 *   2. desktop — an `attention.notify` event on the existing sync SSE bus
 *                (notifySyncInvalidate) that the webview turns into a native
 *                OS notification via tauri-plugin-notification (D-007). The
 *                event is harmless when no desktop consumer is listening.
 *
 * Callers own the importance gate: needs-human emits only at ≥high; the
 * escalation / smoke-fail producers are inherently high so they
 * always notify. The helper does not re-gate.
 *
 * WI-36644: every call is recorded durably (harness_shared.attention_notifications, migration
 * 761) BEFORE either channel is attempted, then stamped with each channel's outcome. Both
 * channels are silently no-op-safe by design (no paired device / no open webview) — before this,
 * "the call happened" was the only available evidence, and after a silent halt "was the human
 * ever told?" was unanswerable even to the agent that raised it. The audit write is itself
 * best-effort (logged + swallowed) so it can never become a new way for this helper to throw.
 */
import { notifyWorkspace, type PushKind } from './device-push-dispatcher';
import { notifySyncInvalidate } from './sync-sse';
import { activeWorkspaceId } from './workspace-registry';
import {
  claimAttentionNotifyChannel,
  ensureAttentionNotifyIntent,
  recordAttentionNotifyIntent,
  recordAttentionNotifyOutcome,
} from './attention-notify-store';

export type AttentionNotifyKind = 'needs-human' | 'intervention' | 'smoke-fail';

/** Fine-grained kind → the mobile PushKind the app's push-routing understands
 *  (needs-human has no dedicated mobile route yet → folds into intervention). */
const MOBILE_KIND: Record<AttentionNotifyKind, PushKind> = {
  'needs-human': 'intervention',
  intervention: 'intervention',
  'smoke-fail': 'smoke-fail',
};

/** SSE event name the desktop webview listens for to raise a native notification. */
export const ATTENTION_NOTIFY_EVENT = 'attention.notify';

export interface AttentionNotifyInput {
  kind: AttentionNotifyKind;
  title: string;
  body: string;
  harnessSlug?: string;
  /** urgent | high | normal | low — carried for routing/styling, not gated here. */
  importance?: string;
  /** Extra routing data merged into both channels. */
  data?: Record<string, unknown>;
  /** Override the target workspace; defaults to the active workspace. */
  workspaceId?: string;
}

export interface ReplaySafeAttentionNotifyInput extends AttentionNotifyInput {
  /** Stable producer key (for example, plan-run + delivery) used across retries. */
  dedupeKey: string;
}

export interface AttentionNotifyResult {
  recordId: number | null;
  deduped: boolean;
  mobileDelivered: boolean;
  desktopDelivered: boolean;
}

async function deliverAttention(
  input: AttentionNotifyInput & { dedupeKey?: string },
): Promise<AttentionNotifyResult> {
  const ws = input.workspaceId ?? activeWorkspaceId();
  const channelData = input.dedupeKey
    ? { ...(input.data ?? {}), dedupeKey: input.dedupeKey }
    : input.data;

  // WI-36644: record intent BEFORE attempting either channel — this row is the only surviving
  // evidence if the process dies mid-delivery, and it exists regardless of what happens below.
  const recordInput = {
    workspaceId: ws,
    harnessSlug: input.harnessSlug,
    kind: input.kind,
    title: input.title,
    body: input.body,
    importance: input.importance,
    data: channelData,
  };
  const reservation = input.dedupeKey
    ? await ensureAttentionNotifyIntent(recordInput, input.dedupeKey)
    : null;
  const recordId = input.dedupeKey
    ? reservation?.id ?? null
    : await recordAttentionNotifyIntent(recordInput);
  const mobileClaimed = recordId == null
    ? true
    : await claimAttentionNotifyChannel(recordId, ws, 'mobile');
  let mobileDelivered = false;

  // 1. Mobile (APNs/FCM) — no-op when no device is paired. `data` must be
  // string-valued (APNs/FCM constraint); coerce extras and drop nullish.
  const mobileData: Record<string, string> & { kind?: PushKind } = { kind: MOBILE_KIND[input.kind] };
  if (input.harnessSlug) mobileData.harness = input.harnessSlug;
  if (input.importance) mobileData.importance = input.importance;
  for (const [k, val] of Object.entries(channelData ?? {})) {
    if (val != null) mobileData[k] = String(val);
  }
  if (mobileClaimed) {
    try {
      const results = await notifyWorkspace(ws, {
        title: input.title,
        body: input.body,
        data: mobileData,
        category: MOBILE_KIND[input.kind],
      });
      // A resolved call is NOT itself evidence of delivery: notifyWorkspace resolves to `[]`
      // when no device is paired (the documented no-op case), and dispatchPush never throws
      // per-target — it settles each send into a PushSendResult, ok:false included. Derive the
      // outcome from those results, not from "didn't throw", or this audit trail would just
      // relocate the original "reads as covered" bug one file down.
      const succeeded = results.some((r) => r.ok);
      mobileDelivered = succeeded;
      const error = succeeded
        ? undefined
        : results.length === 0
          ? 'no push targets registered for this workspace'
          : results.map((r) => `${r.platform}:${r.status}${r.detail ? ` (${r.detail})` : ''}`).join('; ');
      await recordAttentionNotifyOutcome(recordId, ws, 'mobile', { attempted: true, succeeded, error });
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      console.warn('[attention-notify] mobile push failed:', message);
      mobileDelivered = false;
      await recordAttentionNotifyOutcome(recordId, ws, 'mobile', { attempted: true, succeeded: false, error: message });
    }
  }

  // 2. Desktop-native (D-007) — SSE event the webview renders via Tauri.
  const desktopClaimed = recordId == null
    ? true
    : await claimAttentionNotifyChannel(recordId, ws, 'desktop');
  let desktopDelivered = false;
  if (desktopClaimed) {
    try {
      await notifySyncInvalidate(ATTENTION_NOTIFY_EVENT, {
        kind: input.kind,
        title: input.title,
        body: input.body,
        harnessSlug: input.harnessSlug ?? null,
        importance: input.importance ?? null,
        ...channelData,
      });
      desktopDelivered = true;
      await recordAttentionNotifyOutcome(recordId, ws, 'desktop', { attempted: true, succeeded: true });
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      console.warn('[attention-notify] desktop notify failed:', message);
      desktopDelivered = false;
      await recordAttentionNotifyOutcome(recordId, ws, 'desktop', { attempted: true, succeeded: false, error: message });
    }
  }

  return {
    recordId,
    deduped: Boolean(input.dedupeKey && !reservation?.created && !mobileClaimed && !desktopClaimed),
    mobileDelivered,
    desktopDelivered,
  };
}

export async function notifyAttention(input: AttentionNotifyInput): Promise<void> {
  await deliverAttention(input);
}

/** Replay-safe variant for plan/event consumers with a stable delivery key. */
export async function notifyAttentionOnce(
  input: ReplaySafeAttentionNotifyInput,
): Promise<AttentionNotifyResult> {
  return deliverAttention(input);
}
