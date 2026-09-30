/**
 * event-subscriptions.ts — standing INJECT subscriptions to an arbitrary event
 * key (WI-4014 Part 2, follow-up to the WI-3956 linking audit).
 *
 * Mirrors topics.ts's subscribeTopic/unsubscribeTopic shape exactly, but stores
 * `target_kind='event'` (migration 568) instead of 'topic', and `target_ref` is
 * the raw event key (e.g. `lock:grant:<ticket>`, `plan-run:finished:<id>`) rather
 * than a curated topic slug — no ensureBuiltinTopics/topic-row concept applies.
 *
 * This is the wake:false (cheap, no token cost) half of standing event-key
 * subscriptions. The wake:true half already existed before this change:
 * `watch:create({ pattern: eventKey, wake:true, once:false })` registers a
 * STANDING row on the separate events/await table (registerAwait), re-firing a
 * turn-costing wake on every match — a different table, a different primitive,
 * intentionally not unified with this one (unify-watch-primitive's own D-002:
 * inject is the cheap default, wake is the deliberate opt-in).
 *
 * Uses the shared workspace-RESOLVING subscription store singleton
 * (subscription-store.ts's getCoordSubscriptionStore, NOT topics.ts's own
 * default-workspace-pinned instance) — event keys are not workspace-local the
 * way v1 topics are (D-009 on topics.ts), so this follows the modern
 * per-operation-scoped seam every other reach path uses.
 */

import type { DeliveryMode, SubscriptionRow } from '@papercusp/coordination/capabilities';
import type { AgentIdentity } from './identity';
import { getCoordSubscriptionStore } from './subscription-store';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { coordScopeWorkspace } from './log';

export const EVENT_SUBSCRIPTION_KIND = 'event' as const;

function nowIso(): string {
  return new Date().toISOString();
}

/** Register (or update the mode/TTL of) a standing inject subscription to an
 *  event key. Idempotent on (subscriber, key) — re-subscribing updates mode/TTL. */
export async function subscribeEventKey(
  identity: AgentIdentity,
  eventKey: string,
  opts: { mode?: DeliveryMode; ttl_sec?: number } = {},
): Promise<SubscriptionRow> {
  const expires_ts = opts.ttl_sec != null ? new Date(Date.now() + opts.ttl_sec * 1000).toISOString() : null;
  return getCoordSubscriptionStore().subscribe({
    subscriber_id: identity.ownerId,
    target_kind: EVENT_SUBSCRIPTION_KIND,
    target_ref: eventKey,
    delivery_mode: opts.mode ?? 'full',
    created_ts: nowIso(),
    expires_ts,
  });
}

/** Soft-cancel a standing event-key subscription (idempotent — unsubscribing
 *  from a key you don't follow is a no-op). */
export async function unsubscribeEventKey(identity: AgentIdentity, eventKey: string): Promise<void> {
  await getCoordSubscriptionStore().unsubscribe(identity.ownerId, EVENT_SUBSCRIPTION_KIND, eventKey);
}

/** A subscriber's own active event-key subscriptions. */
export async function listMyEventKeySubscriptions(identity: AgentIdentity): Promise<SubscriptionRow[]> {
  const all = await getCoordSubscriptionStore().listSubscriptions(identity.ownerId);
  return all.filter((s) => s.target_kind === EVENT_SUBSCRIPTION_KIND);
}

/** Every active standing inject-subscriber of one event key (the emit-time
 *  fan-out's hot path — @see emitAwaitedEvent in events/await/engine.ts). */
export async function listEventKeySubscribers(eventKey: string): Promise<SubscriptionRow[]> {
  return getCoordSubscriptionStore().listTargetSubscribers(EVENT_SUBSCRIPTION_KIND, eventKey);
}

/** WI-10003631: the (workspace, kind) scope `listEventKeySubscribers` reads, so
 *  the emit can fold that read into its fire-latch statement (one round trip). */
export function eventKeySubscriberScope(): { workspaceId: string; targetKind: string } {
  // Same resolution as the store's `ws` getter (getWorkspaceId: coordScopeWorkspace).
  return { workspaceId: coordScopeWorkspace().trim() || DEFAULT_COORD_WORKSPACE, targetKind: EVENT_SUBSCRIPTION_KIND };
}
