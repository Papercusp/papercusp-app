/**
 * The per-message time stamp — MOVED here from
 * apps/operator/app/_components/chat/message-timestamp.tsx (papercup-chat-one-
 * component-one-contract-2026-09-06 P-007; parity row `op-timestamps`). The
 * operator file is now a re-export of this one, so there is ONE clock.
 *
 * Origin: session-chat-popup-timestamps-and-modes-2026-08-09 P-001. [owner
 * 2026-08-09] "In the conversation popup in the HUD tab add timestamp to the
 * user and agent messages in the gui". Papercup-chat-one-component-one-
 * contract-2026-09-06 D-011 supersedes the old absolute+relative rendering:
 * the compact stamp is now time-only today and shorthand date+time otherwise.
 *
 * The absolute stamp can be lined up against a log line, a gate verdict or a
 * journalctl window. The date is prepended once the message is not from today,
 * because `23:14` alone silently becomes a lie on a transcript you scrolled
 * back through. The full ISO instant remains in `dateTime` and the hover title.
 *
 * ── WHY THIS IS ITS OWN LEAF COMPONENT (do not inline it into the row) ────────
 *
 * The today/older boundary has to tick across local midnight, and the transcript
 * row is a typing-lag memo boundary (WI-6502) — the one that exists because
 * every keystroke in the composer re-renders the transcript. Threading a
 * `nowMs` prop down to the row would re-render every visible row's whole body
 * (markdown content, tool rows, cards) on every tick, quietly undoing that fix.
 *
 * A `useSyncExternalStore` SUBSCRIPTION does not: React re-renders the
 * subscribing component itself and skips memoized ancestors, so a tick repaints
 * only the ~20 visible stamps and nothing else. That is the entire reason this
 * is a separate module-level component, and it is why the clock must never
 * become a prop.
 *
 * ── ONE interval for the whole app, not one per message ───────────────────────
 *
 * A transcript can hold hundreds of rows. One module-level clock means N stamps
 * share ONE timer, and the timer only runs while at least one stamp is mounted.
 * The clock state is pinned through `pinModuleState` (repo shared-lib singleton
 * rule): this package is reached by three loaders (Vite, webpack, vitest) and
 * through a `file:` symlink in the portal, any of which can split the module
 * record — and a split clock is two timers ticking two sets of stamps.
 */

import { useSyncExternalStore } from 'react';
import { pinModuleState } from '@papercusp/module-singleton';

/** Match the session popup's own cadence — it already ticks at 15s for its
 *  liveness/context readings, and two clocks at different rates on one
 *  surface make the same elapsed time render two different ways. */
export const CHAT_CLOCK_TICK_MS = 15_000;

interface ChatClockState {
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  nowMs: number;
}

const clock = pinModuleState<ChatClockState>('@papercusp/operator-ui.papercup-chat.clock', () => ({
  listeners: new Set(),
  timer: null,
  nowMs: Date.now(),
}));

function subscribeToChatClock(onChange: () => void): () => void {
  const wasIdle = clock.listeners.size === 0;
  clock.listeners.add(onChange);
  if (wasIdle) {
    /* RE-READ the clock as the first stamp mounts. `nowMs` was last written
       either at module load or by the final tick before the previous stamp
       unmounted — so without this, a pane opened ten minutes into a page's life
       paints every age ten minutes too large, and stays wrong for a further 15s
       until the first tick corrects it. The stalest reading is the FIRST one the
       reader sees, which is the worst place for it. */
    clock.nowMs = Date.now();
  }
  if (clock.timer === null) {
    // A UI clock, not host scheduling: it exists only while a stamp is mounted
    // and is torn down by the last unsubscribe below.
    // timer-classification: ui-timer — relative-time re-render, no store read.
    clock.timer = setInterval(() => {
      clock.nowMs = Date.now();
      for (const l of clock.listeners) l();
    }, CHAT_CLOCK_TICK_MS);
  }
  return () => {
    clock.listeners.delete(onChange);
    // Last stamp unmounted (the pane closed) — stop the timer rather than
    // leaving it ticking against an empty listener set for the page's lifetime.
    if (clock.listeners.size === 0 && clock.timer !== null) {
      clearInterval(clock.timer);
      clock.timer = null;
    }
  };
}

const getChatClock = (): number => clock.nowMs;

/**
 * The shared ticking clock. Exported for tests (and for any future stamp that
 * needs the same "one timer, memo-safe" property) — never pass its value down as
 * a prop, per the header above.
 */
export function useChatClock(): number {
  return useSyncExternalStore(subscribeToChatClock, getChatClock, getChatClock);
}

/** Fixed English abbreviations rather than `toLocaleDateString`. The rest of
 *  this surface is terse ASCII, and a locale-dependent month makes the rendered
 *  string depend on the machine the test happens to run on. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `4s` · `12m` · `3h` · `2d` — the HUD's own age vocabulary (hud-board-model
 *  `formatAge`), restated here because this package cannot import the
 *  operator. Nine lines; the operator's stamp now renders through THIS one, so
 *  the two vocabularies cannot disagree on a chat surface. */
export function formatAge(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export interface MessageStamp {
  /** `23:14`, or `Aug 8 · 23:14` once the message is not from today. */
  absolute: string;
  /** The full instant, for the hover title + the machine-readable `dateTime`. */
  iso: string;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/**
 * Render one message's `ts` into its two halves. PURE → unit-tested.
 *
 * Accepts an ISO string OR an epoch-ms number (chat-protocol's `ChatTurn.createdAt`
 * is epoch ms; the operator's legacy `ChatMessage.ts` is ISO).
 *
 * Returns null — no stamp at all — for an absent or unparseable timestamp,
 * rather than a placeholder. A row with no stamp reads as "this feed does not
 * carry times"; a `—` would read as "this message has no time", which is a claim
 * about the message rather than about the feed.
 *
 * `nowMs` null (no clock yet) forces the date into the absolute stamp: without a
 * clock we cannot know whether "today" is true, and a bare `23:14` that turns
 * out to be from last week is the one failure mode this whole stamp exists to
 * prevent.
 */
export function formatMessageStamp(ts: string | number | null | undefined, nowMs: number | null): MessageStamp | null {
  if (ts == null || ts === '') return null;
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const clockText = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const isToday = nowMs != null && sameLocalDay(d, new Date(nowMs));
  return {
    absolute: isToday ? clockText : `${MONTHS[d.getMonth()]} ${d.getDate()} · ${clockText}`,
    iso: d.toISOString(),
  };
}

export interface MessageTimestampProps {
  ts?: string | number | null;
  /** Element class; the operator's legacy transcript passes `oracle-msg-time`. */
  className?: string;
}

/**
 * The stamp itself. Renders nothing when the message carries no usable `ts`, so
 * every chat surface that does not set one is byte-identical to before.
 */
export function MessageTimestamp({
  ts,
  className = 'pc-chat__time',
}: MessageTimestampProps) {
  const now = useChatClock();
  const stamp = formatMessageStamp(ts, now);
  if (!stamp) return null;
  return (
    <time className={className} dateTime={stamp.iso} title={stamp.iso} data-testid="chat-message-time">
      {stamp.absolute}
    </time>
  );
}
