/**
 * inbox-wake-actionability.ts — "a wake with nothing to act on costs no turn"
 * (review-system-rework-reduction-2026-09-23 P-024 clauses B and C; P-034).
 *
 * The await engine already settles an inbox-wake group without a turn when the
 * subscriber has provably SEEN every message in it (`isInboxWakeGroupRedundant`,
 * EI-18673058981655804: read cursor + reply linkage). That rule answers "was it
 * seen?". This module answers the other half, "is there anything to act on?":
 * a directed FYI nobody asked anything with, a bare ack receipt, or a plan event
 * whose before/after state is identical still spent a full model turn, even
 * though the message itself is already durable in the recipient's inbox.
 *
 * Measured before this landed (72h to 2026-09-23, papercusp-workspace): of 76
 * coord:send msg_id-bearing inbox wakes that reached a turn-burning channel, 3
 * carried `expects:'none'` and no reply linkage. The source audit
 * (docs/evidence/review-system-time-audit-2026-09-23.md, finding 4) counted 3 of
 * 7 inbox-wake turns in one session with nothing to act on.
 *
 * Clause C is the hard floor: a directed ask (`expects` action/answer, or
 * `expectsReply`), an owner directive (sent by the owner's own chat pane / the
 * human inbox, or carrying an owner-verified relay stamp), a `wake:'required'`
 * send, and any thread reply are ALWAYS actionable, and every uncertain read
 * (missing envelope, unknown shape) fails OPEN to actionable — the worst case of
 * a misclassification is today's status quo (an extra turn), never a lost ask.
 *
 * Pure and DB-free: the engine resolves envelopes and hands them in.
 */

/** Keep in lockstep with ADMIN_COORD_UI_OWNER in agent-tools/coordination/identity.ts
 *  (the owner's GUI chat pane). Duplicated rather than imported to keep this module
 *  free of the coordination runtime graph (the engine ↔ inbox-wake import cycle). */
const OWNER_CHAT_PANE_SENDER = 'pc-admin-coord-ui';
/** Keep in lockstep with RELAY_PROVENANCE_FIELD in agent-tools/coordination/relay-provenance.ts. */
const RELAY_PROVENANCE_FIELD = 'relayProvenance';
/** Keep in lockstep with COORD_INBOX_WAKE_PREFIX in agent-tools/coordination/inbox-wake.ts. */
const COORD_INBOX_WAKE_PREFIX = 'coord:inbox-wake:';

export type InboxWakeActionabilityClass =
  // Actionable (clause C floor + fail-open):
  | 'owner-directive'
  | 'directed-ask'
  | 'required-wake'
  | 'reply'
  | 'unknown'
  | 'actionable'
  // Non-actionable (clause B):
  | 'fyi'
  | 'receipt'
  | 'no-state-change';

export interface InboxWakeActionability {
  actionable: boolean;
  class: InboxWakeActionabilityClass;
  reason: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Order-insensitive structural equality for the JSON-shaped before/after
 *  snapshots a plan_event carries. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

function isOwnerDirective(env: Record<string, unknown>): boolean {
  const from = typeof env.from === 'string' ? env.from : '';
  if (from === 'human' || from === OWNER_CHAT_PANE_SENDER) return true;
  const relay = env[RELAY_PROVENANCE_FIELD];
  // Any owner-origin relay stamp counts, verified or not: an unverified owner
  // claim still costs only a turn, while misfiling a real one would hold it.
  if (isRecord(relay) && relay.origin === 'owner') return true;
  return false;
}

/**
 * Classify ONE coord envelope a wake points at. Ordered so the clause-C floor
 * wins over every non-actionable rule.
 */
export function classifyInboxWakeMessage(env: unknown): InboxWakeActionability {
  if (!isRecord(env)) {
    return { actionable: true, class: 'unknown', reason: 'message envelope unreadable — fail open' };
  }
  if (isOwnerDirective(env)) {
    return { actionable: true, class: 'owner-directive', reason: 'owner directive always wakes' };
  }
  const expects = typeof env.expects === 'string' ? env.expects : null;
  if (expects === 'action' || expects === 'answer' || env.expectsReply === true) {
    return { actionable: true, class: 'directed-ask', reason: `directed ask (expects ${expects ?? 'reply'}) always wakes` };
  }
  // coord:send persists explicit wake intent as boolean true on the message
  // envelope (`extra.wake = true`), even when the caller used the canonical
  // 'required'/'optimistic' mode. Keep recognizing the string form for older
  // envelopes and classify the persisted wire form as an explicit action too.
  if (env.wake === 'required') {
    return { actionable: true, class: 'required-wake', reason: "sender required the wake (wake:'required')" };
  }
  if (env.wake === true) {
    return { actionable: true, class: 'actionable', reason: 'sender requested a wake (persisted wake:true)' };
  }
  const kind = typeof env.kind === 'string' ? env.kind : null;
  // A bare lifecycle receipt carries no ask and no free text (coord:ack takes only msg_id).
  if (kind === 'ack') {
    return { actionable: false, class: 'receipt', reason: 'ack receipt — nothing to act on' };
  }
  if (typeof env.related_msg_id === 'string' && env.related_msg_id) {
    return { actionable: true, class: 'reply', reason: 'thread reply — may answer the recipient’s own ask' };
  }
  if (kind === 'plan_event') {
    if ('before' in env && 'after' in env && jsonEqual(env.before, env.after)) {
      return { actionable: false, class: 'no-state-change', reason: 'plan event with no state change' };
    }
    return { actionable: true, class: 'actionable', reason: 'plan event changed state' };
  }
  if (kind === 'message' && expects === 'none') {
    return { actionable: false, class: 'fyi', reason: "FYI (expects 'none') with no reply linkage" };
  }
  return { actionable: true, class: 'actionable', reason: 'default: actionable' };
}

/** Best-effort `msg_id` of a wake delivery payload (send.ts stamps `{ msg_id }`). */
export function inboxWakeDeliveryMsgId(payload: unknown): string | null {
  if (isRecord(payload) && typeof payload.msg_id === 'string' && payload.msg_id) return payload.msg_id;
  return null;
}

export interface InboxWakeGroupActionabilityInput {
  eventKey: string;
  urgent?: boolean;
  payload?: unknown;
}

/**
 * The wake gate: is EVERY delivery in this subscriber group a non-urgent
 * inbox-wake whose message was resolved and classified non-actionable?
 * `envelopes` maps msg_id → envelope (absent ⇒ unresolved ⇒ fail open).
 * Any actionable, unresolved, urgent, msg_id-less (loop fires, system alarms)
 * or non-inbox-wake member keeps the whole group's turn.
 */
export function classifyInboxWakeGroup(
  group: readonly InboxWakeGroupActionabilityInput[],
  envelopes: ReadonlyMap<string, unknown>,
): { nonActionable: boolean; classes: InboxWakeActionabilityClass[] } {
  if (group.length === 0) return { nonActionable: false, classes: [] };
  const classes: InboxWakeActionabilityClass[] = [];
  for (const d of group) {
    if (d.urgent || !d.eventKey.startsWith(COORD_INBOX_WAKE_PREFIX)) return { nonActionable: false, classes };
    const msgId = inboxWakeDeliveryMsgId(d.payload);
    if (!msgId || !envelopes.has(msgId)) return { nonActionable: false, classes };
    const verdict = classifyInboxWakeMessage(envelopes.get(msgId));
    classes.push(verdict.class);
    if (verdict.actionable) return { nonActionable: false, classes };
  }
  return { nonActionable: true, classes };
}
