/**
 * stream-freshness.ts — is the conversation you are looking at LIVE, or is it a
 * corpse that still looks alive?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * [owner 2026-08-12] "I sent a message to <an agent> in the gui chat ... but the
 * gui chat didn't updat it seems like the message was never sent to them."
 *
 * The message HAD been sent. Measured afterwards: it reached that agent 250 ms
 * after the send, and the agent answered 11 s later. Delivery, the wake, the
 * reply and the display filter were each verified working. What failed is that
 * the owner's pane stopped repainting — and the pane had no way to say so, so a
 * frozen transcript and a live one were pixel-identical. With nothing on screen
 * to distinguish them, the only reading available to the owner was "my message
 * never went anywhere", which was false and cost real time to disprove.
 *
 * That is a DETECTOR failure, and it is the half worth fixing: the specific
 * repaint bug died with the webview (the app was restarted three minutes later,
 * taking its console and network state with it), but "the pane cannot tell you
 * it went deaf" is reproducible, permanent, and independent of whatever the
 * original cause turns out to have been.
 *
 * ── What the banner ladder could see BEFORE this ────────────────────────────
 *
 * `SessionChatModal` had three states: connecting-with-no-events, `status ===
 * 'error'`, and live-but-empty. `status` only becomes `'error'` via the
 * transport's `onError`, which fires after `maxConsecutiveFailures` (3)
 * consecutive failures with ZERO successful opens. So the two shapes that
 * actually produce a silently-stale pane both slipped through:
 *
 *   1. a connection that is retrying and sometimes succeeding (open → zombie →
 *      reconnect → open), which never accumulates 3 clean failures; and
 *   2. a connection the transport still considers OPEN that has simply stopped
 *      delivering.
 *
 * `createResilientEventSource` already distinguishes both — it publishes a
 * `'failing'` status the moment it schedules a backoff or trips its 45 s zombie
 * watchdog, and that signal was being dropped on the floor rather than shown.
 * This module is the reuse of it, not a new mechanism.
 *
 * ── The rule that keeps it honest ───────────────────────────────────────────
 *
 * A QUIET AGENT IS NOT A BROKEN STREAM, and conflating them would be worse than
 * the bug: most agents are idle most of the time, so a detector keyed on "no
 * transcript entries lately" would cry wolf constantly and be ignored by the
 * time it mattered. Liveness is therefore keyed on the TRANSPORT's own signal
 * (heartbeats, which the server sends every 15 s regardless of whether the agent
 * is doing anything) and never on transcript activity.
 *
 * PURE → unit-tested, no React, no clock of its own (the caller passes `nowMs`).
 */

import { DEFAULT_ZOMBIE_TIMEOUT_MS, DESKTOP_IPC_STREAM_IDLE_TIMEOUT_MS } from '@papercusp/sse';

/** The transport's own status, as `createResilientEventSource` publishes it. */
export type TransportStatus = 'idle' | 'connecting' | 'open' | 'failing' | 'closed';

/**
 * How long the pane tolerates total silence from an ostensibly-open stream
 * before it says so. The desktop endpoint-IPC watchdog is tighter than the
 * generic EventSource watchdog, so derive this from the minimum ceiling rather
 * than hand-copying one transport's default.
 *
 * ⚠ THIS MUST STAY STRICTLY BELOW EVERY TRANSPORT CEILING. The generic
 * EventSource wrapper uses `DEFAULT_ZOMBIE_TIMEOUT_MS` (45 s), while the
 * desktop endpoint-IPC writer uses `DESKTOP_IPC_STREAM_IDLE_TIMEOUT_MS`
 * (32 s). The ladder test pins both, because the ordering is the whole
 * ballgame:
 *
 * This value shipped at 60 s — deliberately "just past the watchdog", on the
 * reasoning that silence outliving BOTH timers is the strongest evidence the
 * pane is looking at something no longer being fed. That reasoning is exactly
 * backwards, and it made `'stale'` DEAD CODE from the first commit
 * (EI-20265888603098901). One `signal()` seam feeds both timers, so the
 * transport's fires FIRST: at 45 s it closes the socket and publishes
 * `'failing'`, `classifyStreamFreshness` returns `'reconnecting'` on that alone,
 * and a successful reconnect re-signals and resets the age. `transport ===
 * 'open'` together with 60 s of silence is a state the runtime cannot produce.
 *
 * So the timers are a LADDER, not a belt-and-braces pair. Leave a one-second
 * margin below the effective ceiling: at 31 s the server (15 s heartbeat) has
 * missed two in a row — enough to be real, not jitter — and we say the view may
 * be behind. At 32 s desktop IPC gives up and the banner escalates to
 * `'reconnecting'`; the generic wrapper's 45 s watchdog remains a later guard.
 * Raise this to or above either runtime's ceiling and the first rung silently
 * disappears again.
 */
const STREAM_SILENCE_STALE_MARGIN_MS = 1_000;
export const STREAM_SILENCE_STALE_MS =
  Math.min(DEFAULT_ZOMBIE_TIMEOUT_MS, DESKTOP_IPC_STREAM_IDLE_TIMEOUT_MS) -
  STREAM_SILENCE_STALE_MARGIN_MS;

export interface StreamFreshnessInput {
  /** The transport's status. `undefined` when the caller has not wired it. */
  transport?: TransportStatus;
  /** Epoch ms of the last inbound signal of ANY kind (heartbeat included). */
  lastSignalAtMs: number | null;
  /** Now, injected so this stays pure and testable. */
  nowMs: number;
}

export type StreamFreshness =
  /** Signals are arriving on schedule — what the pane shows is current. */
  | 'fresh'
  /** The transport is retrying: dropped, or its zombie watchdog tripped. */
  | 'reconnecting'
  /** Nominally open, but nothing has arrived for STREAM_SILENCE_STALE_MS. */
  | 'stale'
  /**
   * Not enough information to judge — no transport status wired AND no signal
   * recorded yet. Deliberately NOT folded into 'stale': claiming a connection
   * is dead because we never looked is the same false-confidence failure in the
   * opposite direction, and it would fire on every pane during its first frames.
   */
  | 'unknown';

/**
 * Classify what the viewer is actually looking at.
 *
 * Order matters. The transport's own verdict OUTRANKS the silence timer,
 * because `'failing'` is a positive observation ("I tried and could not") while
 * silence is an absence of evidence — and a reconnecting stream is legitimately
 * silent while it backs off, so checking silence first would report the vaguer
 * of two available answers.
 */
export function classifyStreamFreshness(input: StreamFreshnessInput): StreamFreshness {
  const { transport, lastSignalAtMs, nowMs } = input;

  if (transport === 'failing' || transport === 'connecting') return 'reconnecting';
  // A closed stream is not stale, it is over — the pane's `done`/composer state
  // already speaks for that, and a second alarm would be noise.
  if (transport === 'closed' || transport === 'idle') return 'unknown';

  if (lastSignalAtMs === null) return 'unknown';
  // Guard a clock that jumped backwards (NTP step, suspend/resume): a negative
  // age is not evidence of freshness OR staleness, so do not invent either.
  const age = nowMs - lastSignalAtMs;
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  return age >= STREAM_SILENCE_STALE_MS ? 'stale' : 'fresh';
}

/**
 * What to tell the owner. `null` for every state that needs no banner, so the
 * caller can render it directly without re-deciding.
 *
 * The wording commits to the distinction the owner actually needed: it says the
 * CONVERSATION MAY BE BEHIND, never that their message failed — that inference
 * is exactly the one that was wrong, and a banner that implied it would be
 * automating the original mistake.
 *
 * ⚠ EVERY banner here MUST carry the delivery reassurance, on every rung — not
 * just the one whose timing analysis says it should win (WI-38270). Driving this
 * live proved the rung analysis wrong twice over: `'stale'` is preempted in the
 * canonical deaf-producer case because the transport publishes `'failing'` at
 * ~20 s — BEFORE the 35 s silence timer, and while its socket is still
 * ESTABLISHED, so neither documented timer explains it. What the owner actually
 * sees is `'reconnecting'`, and that rung used to say only "new messages may not
 * appear", which answers the wrong question: the owner's fear was never that the
 * VIEW was behind, it was that THEIR MESSAGE never sent. It had sent — in 250 ms.
 *
 * A retrying READ stream is no evidence at all about a WRITE: sends go over a
 * separate POST path. So the reassurance is equally TRUE and equally NEEDED on
 * both rungs, and putting it on both is what makes this robust to the timing
 * question being unresolved — whichever rung wins the race, the sentence that
 * prevents the false inference is on screen. Do not "tidy" it back onto one rung.
 */
export function streamFreshnessMessage(freshness: StreamFreshness): string | null {
  switch (freshness) {
    case 'reconnecting':
      return "Reconnecting to this session — new messages may not appear until it recovers. Anything you've sent was still delivered.";
    case 'stale':
      return "No update from this session in a while — it may be behind. Anything you've sent was still delivered.";
    default:
      return null;
  }
}
