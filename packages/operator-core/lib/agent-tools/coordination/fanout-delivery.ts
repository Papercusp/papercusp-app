/**
 * fanout-delivery.ts — the subscribe→inject delivery primitive, shared by the
 * topics:create new_topic emission (Phase 1) and the CDC local fan-out (Phase 2).
 *
 * A subscribe→inject notify lands on the SAME `coordLog` 'messages' surface that
 * `readInbox` reads (exactly like the retired fireNotifications), so the mature
 * inbox-injection hook surfaces it with NO change beyond delivery-mode rendering.
 * The delivery mode (full | digest | mention — D-006) is honored here:
 *
 *   full    — deliver the event as its own notify row.
 *   digest  — deliver a notify flagged `digest:true`; the inbox hook coalesces
 *             same-subject digests into a count + one-line. (Phase 2 adds the
 *             cross-event coalescing; a lone digest event still renders as one
 *             terse line.)
 *   mention — deliver ONLY when the event is an @-mention of the subscriber or a
 *             lifecycle resolution; otherwise drop (the noise floor).
 *
 * Pure over an injected CoordEventLog-like sink, so the new_topic + fan-out logic
 * is unit-testable with an in-memory double.
 */

import { newMsgId, type CoordEnvelope } from '@papercusp/coordination/core';
import type { DeliveryMode, ResolvedSubscriber } from '@papercusp/coordination/capabilities';
import { coordLog } from './log';

/** A coordination-object change to inject into subscribers' inboxes. */
export interface InjectEvent {
  /** Stable owner id of whoever/whatever produced the change. */
  from: string;
  /** The object/topic this is about, for rendering + digest grouping
   *  (e.g. 'topic:new_topic', 'issue:ISS-1'). */
  subject: string;
  /** One-line summary (always rendered). */
  summary: string;
  /** Sub-type for rendering (e.g. 'topic_created', 'issue_updated', 'resolved'). */
  notify_kind: string;
  /** Optional fuller body (full-mode only). */
  body?: string;
  /** owner ids explicitly @-mentioned — used by the mention-mode gate. */
  mentions?: string[];
  /** True if this event is a lifecycle resolution (mention-mode also receives these). */
  isResolution?: boolean;
  /** Extra envelope fields (merged in). */
  extra?: Record<string, unknown>;
}

/** The minimal sink the delivery primitive needs (coordLog satisfies it).
 *
 *  The result is `unknown` because this primitive genuinely ignores it: the real
 *  log now resolves to the append's sequence number (P-009 — `intent_event_id`
 *  points at it), while a test double resolving to void must keep satisfying the
 *  sink. Narrowing this to either concrete type would reject the other for no
 *  gain to a caller that never reads it. */
export interface InjectSink {
  appendLine(surface: 'messages', writerKey: string, line: CoordEnvelope): Promise<unknown>;
}

/** Decide whether a subscriber in `mode` should receive `ev`. Only the mention
 *  gate can drop an event; full + digest always pass (digest changes RENDERING,
 *  not delivery). */
export function shouldDeliver(mode: DeliveryMode, ev: InjectEvent, subscriberId: string): boolean {
  if (mode !== 'mention') return true;
  if (ev.isResolution) return true;
  return (ev.mentions ?? []).includes(subscriberId);
}

/**
 * Build the notify envelope for one subscriber + event. Shared by the
 * best-effort sink delivery (deliverInject) and the idempotent at-least-once
 * fan-out insert (fanout-projection.ts), so an injected notice renders the same
 * however it was delivered. Pass a deterministic `msgId` for idempotent paths.
 */
export function buildInjectEnvelope(
  sub: ResolvedSubscriber,
  ev: InjectEvent,
  msgId: string = newMsgId(),
): CoordEnvelope {
  return {
    ts: new Date().toISOString(),
    msg_id: msgId,
    from: ev.from,
    to: [sub.subscriber_id],
    kind: 'notify',
    summary: ev.summary,
    ...(ev.body != null ? { body: ev.body } : {}),
    subject: ev.subject,
    notify_kind: ev.notify_kind,
    delivery_mode: sub.delivery_mode,
    digest: sub.delivery_mode === 'digest',
    via: sub.via,
    ...ev.extra,
  };
}

/**
 * Deliver one inject event to one resolved subscriber, honoring delivery mode.
 * Returns true if a row was written, false if gated-out or the write failed
 * (best-effort — one failure must not drop the rest of a fan-out). Used by the
 * synchronous, exactly-once paths (new_topic emission, thread-post fan-out).
 */
export async function deliverInject(
  sub: ResolvedSubscriber,
  ev: InjectEvent,
  sink: InjectSink = coordLog,
): Promise<boolean> {
  if (!shouldDeliver(sub.delivery_mode, ev, sub.subscriber_id)) return false;
  try {
    await sink.appendLine('messages', sub.subscriber_id, buildInjectEnvelope(sub, ev));
    return true;
  } catch {
    return false;
  }
}

/** Fan one event out to many resolved subscribers. Returns the count delivered. */
export async function deliverInjectMany(
  subscribers: ResolvedSubscriber[],
  ev: InjectEvent,
  sink: InjectSink = coordLog,
): Promise<number> {
  let n = 0;
  for (const sub of subscribers) {
    if (await deliverInject(sub, ev, sink)) n += 1;
  }
  return n;
}
