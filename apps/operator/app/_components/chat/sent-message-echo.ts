'use client';

/**
 * Sent-message echo — session-chat-popup-timestamps-and-modes-2026-08-09 P-002.
 *
 * [owner 2026-08-09] "I just sent the message 'go' to su-93019982 but nothing
 * happened it just shows 'Sent — the agent was woken and is working on it.'"
 *
 * ── The report is NOT a delivery failure, and that is the whole point ─────────
 *
 * Measured while diagnosing it: that agent was live (fresh heartbeat, its own
 * declared intent) and the send genuinely woke it. The banner was telling the
 * truth. What was wrong is that the owner's own message is nowhere in the
 * conversation, so a SUCCESSFUL send and a DROPPED one look exactly alike — and
 * the reasonable reading of "I typed something and the transcript did not
 * change" is that it went nowhere.
 *
 * It is not a race that resolves a moment later, either. The popup renders the
 * agent's transcript, and a `coord:send` to a LIVE agent is injected MID-TURN —
 * so it arrives in the transcript as a `type:'user'` record whose content array
 * also carries `tool_result` blocks, and the timeline parser deliberately
 * suppresses the prompt in exactly that case (`streams.ts`, `if (!hadToolResult
 * && promptTexts.length > 0)`). That suppression is correct for its own purpose
 * — tool results are not user turns — but it means an owner message to a working
 * agent is invisible in this popup permanently.
 *
 * So the composer has to show its own sends. This module is that: a small
 * client-side record of what was sent, merged into the rendered transcript.
 *
 * ── Scope, stated plainly ────────────────────────────────────────────────────
 *
 * These echoes live in memory for the life of the PAGE. They survive closing and
 * reopening the popup (the store is keyed by owner, not held in component
 * state), which is the case that actually bites — you send, close, reopen to
 * check, and would otherwise find no trace. They do NOT survive a reload.
 *
 * The complete fix is to merge the DURABLE coord record into the transcript, so
 * every message you ever sent an agent is in its conversation. That needs a new
 * sync query over the coord log and is filed separately rather than smuggled in
 * here. This module deliberately does not pretend to be that: it never claims
 * more than "you sent this from this tab".
 */

import { useSyncExternalStore } from 'react';
import type { ChatMessage } from './chat-types';

/** How a send turned out. A `failed` echo is REMOVED from the transcript rather
 *  than shown greyed: a message that was never delivered must not sit in the
 *  conversation looking like part of it. The composer's own error banner is what
 *  reports the failure. */
export type EchoDelivery = 'sending' | 'sent' | 'failed';

export interface SentEcho {
  id: string;
  /** Exactly what the owner typed. */
  text: string;
  /** When it was sent, by this browser's clock. */
  atMs: number;
  delivery: EchoDelivery;
}

/** Per owner, so reopening the popup on the same agent still shows what you
 *  sent it. Bounded — see PER_OWNER_CAP. */
const byOwner = new Map<string, SentEcho[]>();
const listeners = new Set<() => void>();

/** Enough to cover any real back-and-forth in one sitting; small enough that a
 *  long-lived tab cannot grow this without bound. */
export const PER_OWNER_CAP = 50;

let seq = 0;
/** Snapshot identity for useSyncExternalStore — bumped on every mutation. Using
 *  a counter rather than the array itself keeps `getSnapshot` cheap and stable
 *  between mutations (returning a fresh array each call would spin the store). */
let version = 0;

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

/**
 * ⚠ EVERY MUTATION BELOW IS COPY-ON-WRITE, AND THAT IS LOAD-BEARING — not style.
 *
 * `emit()` re-renders the subscriber, but re-rendering is only half of what the
 * consumer needs. `SessionChatModal` does:
 *
 *     const echoes   = useSentEchoes(sessionOwnerId);
 *     const messages = useMemo(() => mergeSentEchoes(mapped.messages, echoes),
 *                              [mapped.messages, echoes]);
 *
 * `useMemo` compares its deps by REFERENCE. So a store that pushed into the same
 * array handed back an identical `echoes` on the render it had just triggered,
 * the memo stayed stale, and the new message never reached the transcript — the
 * component re-rendered and displayed exactly what it displayed before.
 *
 * MEASURED before the fix: the FIRST send to an agent rendered (undefined → a new
 * array, so the reference did change), and the 2nd and every later send to that
 * same agent in one page session did not, nor did a `failed` echo un-render. It
 * self-healed only when an unrelated transcript event happened to change
 * `mapped.messages` — so the visible symptom was an intermittent "I sent it and
 * the chat didn't update", worst exactly when the agent is parked or dead and no
 * further transcript event is coming to rescue it.
 *
 * Writing a fresh array on every mutation makes the change observable to any
 * memo/effect keyed on the snapshot. `getSnapshot` is still the version COUNTER
 * (see `version` above), so this costs no extra store churn and cannot spin
 * `useSyncExternalStore`. Guarded by "hands back a NEW array reference on every
 * mutation" in sent-message-echo.test.ts — do not reintroduce an in-place `push`
 * or field assignment here.
 */

/** Record a send as it is dispatched. Returns the echo id, for `settleSentEcho`. */
export function recordSentEcho(ownerId: string, text: string): string {
  const id = `echo-${++seq}`;
  const prev = byOwner.get(ownerId) ?? EMPTY;
  // Copy-on-write (see the note above): a NEW array, never a push into `prev`.
  const next = [...prev, { id, text, atMs: Date.now(), delivery: 'sending' as const }];
  // Drop from the FRONT: the newest sends are the ones still being looked for.
  byOwner.set(ownerId, next.length > PER_OWNER_CAP ? next.slice(next.length - PER_OWNER_CAP) : next);
  emit();
  return id;
}

/** Report what happened to a recorded send. A `failed` echo stops rendering. */
export function settleSentEcho(ownerId: string, id: string, delivery: EchoDelivery): void {
  const list = byOwner.get(ownerId);
  if (!list) return;
  const found = list.find((e) => e.id === id);
  if (!found || found.delivery === delivery) return;
  // Copy-on-write, for the same reason as above: replacing the one changed entry
  // in a NEW array, rather than assigning `found.delivery` in place. An in-place
  // assignment left a `failed` send sitting in the conversation looking delivered.
  byOwner.set(
    ownerId,
    list.map((e) => (e.id === id ? { ...e, delivery } : e)),
  );
  emit();
}

/** Test seam — the store is module-level, so a suite must be able to reset it. */
export function __resetSentEchoes(): void {
  byOwner.clear();
  seq = 0;
  emit();
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const getVersion = (): number => version;

const EMPTY: SentEcho[] = [];

/** This owner's echoes, oldest first. Plain read — no React. */
export function getSentEchoes(ownerId: string | null): SentEcho[] {
  return (ownerId ? byOwner.get(ownerId) : undefined) ?? EMPTY;
}

/** Subscribe to this owner's echoes. */
export function useSentEchoes(ownerId: string | null): SentEcho[] {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getSentEchoes(ownerId);
}

/**
 * How far BEFORE an echo a matching transcript turn may sit and still be treated
 * as that same message arriving.
 *
 * Non-zero because the two timestamps come from different machines: the echo is
 * stamped by this browser, the transcript entry by the agent's host. A strict
 * `>=` would fail to absorb a real match whenever the agent's clock runs a
 * second or two behind, leaving the message rendered twice.
 */
export const ECHO_ABSORB_SLACK_MS = 30_000;

/**
 * Merge echoes into a mapped transcript. PURE → unit-tested.
 *
 * Two jobs, and the second is the one that is easy to get wrong:
 *
 *  1. Append what this tab sent but the transcript does not show.
 *  2. ABSORB an echo once the real turn appears. A `coord:send` to an IDLE agent
 *     DOES land as a plain prompt (no tool_result blocks alongside it), so for
 *     that path the transcript catches up on its own — and without absorption
 *     the owner would then see their message twice, which is a worse bug than
 *     the one being fixed.
 *
 * Absorption is by identical trimmed text AND plausible time, and each
 * transcript turn absorbs at most ONE echo — so sending "go" twice still shows
 * two messages once both have landed.
 */
export function mergeSentEchoes(messages: ChatMessage[], echoes: readonly SentEcho[]): ChatMessage[] {
  const live = echoes.filter((e) => e.delivery !== 'failed');
  if (live.length === 0) return messages;

  // Transcript user turns still available to absorb an echo, newest last.
  const unclaimed = messages
    .filter((m) => m.role === 'user')
    .map((m) => ({ text: m.content.trim(), tsMs: m.ts ? Date.parse(m.ts) : Number.NaN, taken: false }));

  const pending: SentEcho[] = [];
  for (const echo of live) {
    const want = echo.text.trim();
    const absorber = unclaimed.find(
      (u) =>
        !u.taken &&
        u.text === want &&
        // An undated turn cannot be disproved, so allow it; a dated one must be
        // at-or-after the send (minus cross-machine slack) to be THIS send
        // rather than an identical message from earlier in the session.
        (Number.isNaN(u.tsMs) || u.tsMs >= echo.atMs - ECHO_ABSORB_SLACK_MS),
    );
    if (absorber) absorber.taken = true;
    else pending.push(echo);
  }
  if (pending.length === 0) return messages;

  const rendered = pending
    .slice()
    .sort((a, b) => a.atMs - b.atMs)
    .map(
      (e): ChatMessage => ({
        role: 'user',
        content: e.text,
        id: e.id,
        // Stamped like any other message (P-001), so a send you are waiting on
        // carries the same "23:14 · just now" the rest of the transcript does.
        ts: new Date(e.atMs).toISOString(),
      }),
    );

  // EI-20130618357432548: place an unabsorbed echo at its OWN INSTANT rather than
  // at the end. Appending assumed an unabsorbed echo is always the newest thing in
  // the conversation, and it is not:
  //
  //  - a coord:send to a LIVE agent is injected MID-TURN and never becomes a
  //    transcript user turn at all (the suppression this module's header explains),
  //    so its echo stays unabsorbed FOREVER while replies keep arriving after it;
  //  - and any change to the injected turn's text defeats the exact-match absorb.
  //
  // Reported live: a message sent at 04:37:17 rendered BELOW the reply stamped
  // 04:38:05 — 48s later. Inserting by timestamp makes a missed absorption degrade
  // to a correctly-ordered duplicate instead of an out-of-order one.
  //
  // Deliberately NO clock slack here, unlike ECHO_ABSORB_SLACK_MS above. Slack is
  // right for absorption (it only risks a duplicate); applying it to ORDERING would
  // hoist the echo above messages that genuinely preceded it — trading a rare
  // skew-window misplacement for a common one.
  const out = messages.slice();
  for (const echo of rendered) {
    const atMs = Date.parse(echo.ts as string);
    // First message that is demonstrably LATER. Undated messages are never an
    // insertion point (an unknown instant cannot prove it comes after), which keeps
    // an undated transcript byte-identical to the previous append behavior.
    let at = out.length;
    for (let i = 0; i < out.length; i += 1) {
      const ts = out[i].ts ? Date.parse(out[i].ts as string) : Number.NaN;
      if (!Number.isNaN(ts) && ts > atMs) {
        at = i;
        break;
      }
    }
    out.splice(at, 0, echo);
  }
  return out;
}
