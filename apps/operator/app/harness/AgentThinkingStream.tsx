'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createResilientEventSource } from '@papercusp/sse';
import {
  parseAgentTimelineEntries,
  parseAgentTimelineEntry,
  type AgentTimelineEntry,
} from '@papercusp/operator-core/lib/cross-boundary-event-contracts';
import { STREAM_SILENCE_STALE_MS, type TransportStatus } from '../_components/chat/stream-freshness';
import { TONE } from './theme';

/**
 * Shared live "thinking" stream primitives for a Now-running agent — the
 * timeline hook + entry types + renderer reused by AgentInspectorModal.tsx
 * (the pinned, click-to-open live view opened from operator-vite's
 * AgentsRunningPill/AgentsRoster).
 *
 * Lifecycle (useAgentThinkingStream):
 *   - Mount: opens an EventSource on /api/harness/<slug>/agents/<runId>/stream
 *     (or an explicit `streamUrl`).
 *   - Receives 'backfill' (array) once at start, then 'event' deltas as
 *     the agent writes more lines, then 'done' when the run terminates.
 *   - Unmount: aborts the EventSource. Server side closes the watcher.
 *
 * HISTORY (WI-2346, 2026-07): this file used to also export a default
 * `AgentThinkingPopover` hover-popover component. It went ORPHANED (EI-5917,
 * 2026-07) — the "pill controls the open state via parent component" pattern
 * it was built for (HarnessDashboard, a since-removed apps/operator surface)
 * no longer exists, and operator-vite's AgentsRunningPill grew its own
 * hover-preview (a plan/work-item DetailStrip, not a live thinking stream).
 * With zero JSX callers and no surviving use case to wire it back into, the
 * component was deleted; only the shared exports below (already reused by
 * AgentInspectorModal) remain.
 */

export type TimelineEntry = AgentTimelineEntry;
export interface TimelineHistoryState {
  hasMore: boolean;
  cursor: string | null;
}

/** How long a run may produce ZERO output before the card flags it as likely
 *  stalled (an upstream gateway stall / rate-limit is the common cause). */
export const STALL_AFTER_MS = 45_000;

/** Backstop for the streamed-entry flush (WI-6502) when rAF is unavailable or
 *  paused — i.e. a hidden/backgrounded window, where rAF legitimately never fires.
 *  Well under the server's 1Hz follow poll, so it never merges two bursts into one
 *  and can't make a visible pane feel behind. */
export const FLUSH_BACKSTOP_MS = 250;

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/**
 * The message shown while the timeline is EMPTY. Pure — exported for tests.
 * Escalates a still-connected run that has produced no output for
 * STALL_AFTER_MS from a hopeful "Waiting…" to a "likely stalled" warning, so a
 * wedged agent stops reading as an eternal "live · 0 events".
 */
export function waitingMessage(
  status: 'connecting' | 'live' | 'done' | 'error',
  elapsedMs: number | null,
): { text: string; stalled: boolean } {
  if (status === 'connecting') return { text: 'Connecting…', stalled: false };
  if (status === 'error') return { text: 'Disconnected before any output — retrying…', stalled: true };
  if (status === 'done') return { text: 'Run ended without producing any output.', stalled: true };
  if (elapsedMs != null && elapsedMs >= STALL_AFTER_MS) {
    return {
      text: `⚠ No output for ${fmtElapsed(elapsedMs)} — the agent may be stalled or rate-limited`,
      stalled: true,
    };
  }
  return {
    text: `Waiting for first output from the agent…${elapsedMs != null ? ` (${fmtElapsed(elapsedMs)})` : ''}`,
    stalled: false,
  };
}

/**
 * Subscribe to a run's live thinking stream. Shared by every surface that
 * renders a run's timeline (currently AgentInspectorModal) so they all render
 * from one code path. Opens an EventSource on mount, replays `backfill` once,
 * appends `event` deltas, and flips to done/error on the terminal events.
 */
export function useAgentThinkingStream(slug: string, phase: string, runId: string, streamUrl?: string) {
  const [events, setEvents] = useState<TimelineEntry[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'done' | 'error'>('connecting');
  // Whether the agent is ACTIVELY writing right now (its transcript is being
  // appended) — driven by the session stream's `thinking` status event. The
  // live-turn section + the "● thinking" header badge key off this.
  const [thinking, setThinking] = useState(false);
  // Deep-link anchor (search-hit → transcript): the server's `anchor` event —
  // `{found:true, index}` = the backfill index of the matched entry (scroll
  // target); `{found:false}` = the term wasn't found (tail backfill shown).
  const [anchor, setAnchor] = useState<{ found: boolean; index?: number } | null>(null);
  const [history, setHistory] = useState<TimelineHistoryState | null>(null);
  /**
   * Liveness, for the staleness detector (gui-chat-pane-repaint-2026-08-12 P-003).
   *
   * `status` above cannot answer "is this view current?". It only reaches
   * 'error' via the transport's `onError`, which fires after THREE consecutive
   * failures with zero successful opens — so a stream that keeps half-recovering
   * (open → zombie → reconnect → open) never trips it, and neither does one the
   * transport still considers open that has quietly stopped delivering. Both
   * leave a frozen transcript that is pixel-identical to a live one, which is
   * the reported bug.
   *
   * `createResilientEventSource` already knows: it publishes 'failing' the
   * moment it schedules a backoff or its 45s zombie watchdog trips. That signal
   * was simply being discarded. We surface it, plus the wall-clock of the last
   * inbound signal of any kind — heartbeats included, which is what keeps an
   * IDLE agent from reading as a broken stream.
   */
  const [transport, setTransport] = useState<TransportStatus>('idle');
  /**
   * Wall-clock of the last inbound signal, in a REF — read at render time, never
   * published to state.
   *
   * ⚠ This was `useState` and it made the banner FALSE-ALARM on every busy pane
   * (caught by AgentThinkingStream.staleness.test.tsx). The reasoning that broke
   * it is worth keeping: publishing on every heartbeat would re-render four
   * times a minute forever, and — worse — a `setState` per inbound `event` would
   * undo the burst coalescing above (K renders per 1Hz burst, the measured
   * 20-65ms tasks that queued behind keystrokes). So the code published only on
   * a TRANSITION and let the value go stale in between.
   *
   * But the consumer classifies freshness from this timestamp DURING RENDER
   * (SessionChatModal.tsx). A timestamp that stops advancing while the stream is
   * perfectly healthy is read as silence: 35s after connect, ANY render — most
   * often the very transcript update proving the stream is alive — showed "this
   * conversation may be behind". A banner that is usually wrong is ignored by
   * the time it is finally right, which is the one failure this detector was
   * built to avoid.
   *
   * A ref resolves it with no trade-off at all: the write costs nothing (so
   * bursts stay coalesced), and a render always reads the CURRENT value rather
   * than a snapshot of one. What state is still needed for is forcing a render
   * at the two moments the verdict actually flips — see `staleTick`.
   */
  const lastSignalRef = useRef<number | null>(null);
  /** Bumped purely to force a re-render when the freshness verdict FLIPS: the
   *  silence watchdog tripping, and the first signal after it recovers. Without
   *  the recovery bump a quiet-then-healthy stream would keep the banner up,
   *  because a heartbeat alone changes nothing this component renders. */
  const [, setStaleTick] = useState(0);
  useEffect(() => {
    setStatus('connecting');
    setEvents([]);
    setThinking(false);
    setAnchor(null);
    setHistory(null);
    setTransport('idle');
    lastSignalRef.current = null;
    // The one-shot `backfill` is sent ONCE per connection — if it arrives
    // corrupted (e.g. the stream dropped mid-event and resumed), nothing in-band
    // ever re-sends it and the pane would wedge on "connecting…" while small
    // follow events still flow. Self-heal with a bounded clean reconnect (a new
    // connection re-sends the backfill); after the cap, surface 'error' instead
    // of an eternal spinner.
    let backfillRetries = 0;

    // ── Burst coalescing (WI-6502) ──────────────────────────────────────────
    // The server follows the transcript on a 1Hz poll and emits ONE `event` per
    // appended entry (`adv-session-thinking-follow`, endpoint-route/routes/harness/
    // streams.ts), so entries do NOT trickle — they arrive as a BURST once a second.
    // Appending them one setState at a time made each burst K separate renders, and
    // every one of those re-parses the live message's markdown (its content grows per
    // entry, so the shared chat markdown memo cannot hold — see PapercupChat.tsx).
    // That is the dense series of 20-65ms tasks that keystrokes were queueing behind.
    // Buffer the burst and commit it in ONE update at the next frame instead.
    //
    // rAF is the coalescer because it is guaranteed to land after every event already
    // dispatched from the same network chunk, and it aligns the commit to a frame
    // boundary. It is also throttled/paused while the window is hidden, so a timer
    // backstop guarantees the flush still happens for a backgrounded pane.
    let pendingEntries: TimelineEntry[] = [];
    let rafId: number | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelFlush = () => {
      if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      if (flushTimer !== null) clearTimeout(flushTimer);
      rafId = null;
      flushTimer = null;
    };
    const flush = () => {
      cancelFlush();
      if (pendingEntries.length === 0) return;
      const batch = pendingEntries;
      pendingEntries = [];
      setEvents((prev) => [...prev, ...batch]);
    };
    const scheduleFlush = () => {
      if (rafId !== null || flushTimer !== null) return;
      if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(flush);
      flushTimer = setTimeout(flush, FLUSH_BACKSTOP_MS);
    };

    // ── Liveness bookkeeping for the staleness banner ────────────────────────
    // `onSignal` fires at least once per server heartbeat (15s), so it must NOT
    // setState on every call — that would re-render the whole transcript four
    // times a minute forever. Two rules make this cheap AND correct:
    //
    //  1. The timestamp goes in a REF, so recording it costs no render at all.
    //     A render always reads the current value; there is no published
    //     snapshot to go stale behind the stream's back (see `lastSignalRef`).
    //  2. State is bumped only when the VERDICT flips — the stale edge, and the
    //     first signal after it. It is a COUNTER, never the timestamp:
    //     re-publishing a timestamp can be a same-value setState, which React
    //     bails out of — no re-render, no banner, at exactly the moment the
    //     banner is the entire point. The counter always changes, so the
    //     component re-derives freshness against a current `Date.now()`.
    //
    // The timer is a re-armed WATCHDOG, not a poll: it fires once per silence
    // window and is cancelled by the next signal, so a healthy stream never
    // reaches it. (setInterval would be a bare timer and is banned here.)
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let markedStale = false;
    const clearStaleWatchdog = () => {
      if (staleTimer !== null) { clearTimeout(staleTimer); staleTimer = null; }
    };
    const armStaleWatchdog = () => {
      clearStaleWatchdog();
      staleTimer = setTimeout(() => {
        markedStale = true;
        setStaleTick((n) => n + 1);
      }, STREAM_SILENCE_STALE_MS);
    };
    const onSignal = () => {
      const wasStale = markedStale;
      markedStale = false;
      const first = lastSignalRef.current === null;
      lastSignalRef.current = Date.now();
      if (first || wasStale) setStaleTick((n) => n + 1);
      armStaleWatchdog();
    };

    const source = createResilientEventSource({
      // A caller can pass an explicit stream URL (e.g. the interactive-session
      // transcript endpoint); default is the bee run-log stream.
      url: streamUrl ?? `/api/harness/${slug}/agents/${runId}/stream?phase=${phase}`,
      onSignal,
      onStatusChange: (s) => setTransport(s),
      handlers: {
        backfill: (data) => {
          try {
            // A backfill is a whole-timeline SNAPSHOT and arrives on every
            // (re)connection, so anything still buffered belongs to the connection
            // that just went away — dropping it is what keeps a reconnect from
            // replaying stale entries on top of the fresh snapshot.
            cancelFlush();
            pendingEntries = [];
            const parsed = parseAgentTimelineEntries(JSON.parse(data));
            if (!parsed) throw new Error('invalid timeline backfill');
            setEvents(parsed);
            setStatus('live');
            backfillRetries = 0;
          } catch {
            if (backfillRetries < 3) { backfillRetries += 1; source.reconnect(); }
            else setStatus('error');
          }
        },
        event: (data) => {
          try {
            const parsed = parseAgentTimelineEntry(JSON.parse(data));
            if (parsed) {
              pendingEntries.push(parsed);
              scheduleFlush();
            }
          } catch { /* ignore */ }
        },
        // Session live-follow: the agent started/stopped writing the current turn.
        thinking: (data) => {
          try { setThinking(Boolean((JSON.parse(data) as { active?: boolean }).active)); } catch { /* ignore */ }
        },
        // Deep-link anchor: which backfill entry a search hit landed on.
        anchor: (data) => {
          try { setAnchor(JSON.parse(data) as { found: boolean; index?: number }); } catch { /* ignore */ }
        },
        // Stable-owner conversation pagination. Absent on ordinary run streams
        // and on exact-session search deep-links.
        history: (data) => {
          try {
            const parsed = JSON.parse(data) as Partial<TimelineHistoryState>;
            if (
              typeof parsed.hasMore === 'boolean'
              && (typeof parsed.cursor === 'string' || parsed.cursor === null)
              && (!parsed.hasMore || Boolean(parsed.cursor))
            ) setHistory(parsed as TimelineHistoryState);
          } catch { /* ignore */ }
        },
        // Flush first: `done` means no further entries are coming, so a buffered
        // tail would otherwise never be committed and the pane would end one
        // burst short of the real transcript.
        done: () => { flush(); setStatus('done'); setThinking(false); },
      },
      onError: () => { setStatus('error'); setThinking(false); },
    });
    return () => { cancelFlush(); clearStaleWatchdog(); source.close(); };
  }, [slug, phase, runId, streamUrl]);
  // `transport` + `lastSignalAt` are the staleness detector's inputs; callers
  // pass them to `classifyStreamFreshness` rather than re-deriving liveness.
  return { events, status, thinking, anchor, history, transport, lastSignalAt: lastSignalRef.current };
}

/** Format an entry's ISO timestamp as a compact local `HH:MM:SS`, or null when
 *  absent/unparseable. Pure — exported for tests. */
export function fmtEntryTime(ts?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** A small, right-aligned muted timestamp for an entry header. Renders nothing
 *  when the entry carries no (valid) timestamp — so timestamp-less live deltas
 *  don't get an empty chip. */
function EntryTime({ ts }: { ts?: string }) {
  const t = fmtEntryTime(ts);
  if (!t) return null;
  return (
    <time
      dateTime={ts}
      style={{ float: 'right', marginLeft: 8, fontSize: 9.5, fontWeight: 400, color: 'var(--fg-mute)', fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}
    >
      {t}
    </time>
  );
}

/** A pulsing dot — the "actively thinking" indicator, shared by the thinking pane
 *  header and the agents roster. Self-contained (ships its own keyframe). */
export function ThinkingDot({ size = 7, color = TONE.good, title = 'thinking' }: { size?: number; color?: string; title?: string }) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      style={{
        display: 'inline-block', width: size, height: size, borderRadius: '50%',
        background: color, animation: 'pcThinkPulse 1.1s ease-in-out infinite',
      }}
    >
      <style>{`@keyframes pcThinkPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.66)}}`}</style>
    </span>
  );
}

/** One TURN — a wake/prompt and the agent's activity in response to it. Entries
 *  before the first prompt form a leading partial turn (prompt: null). */
export interface Turn {
  seq: number;
  prompt: TimelineEntry | null;
  entries: TimelineEntry[];
  startTs?: string;
  endTs?: string;
}

/**
 * Group a flat timeline into TURNS on `prompt` (wake) boundaries — each real
 * user/wake message starts a new turn; the entries after it are that turn's
 * activity. Entries before the first prompt become a leading partial turn.
 * Chronological (the pane reverses it for newest-first display). Pure — for tests.
 */
export function groupEntriesIntoTurns(entries: readonly TimelineEntry[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of entries) {
    if (e.kind === 'prompt') {
      turns.push({ seq: turns.length, prompt: e, entries: [], startTs: e.ts, endTs: e.ts });
      continue;
    }
    let cur = turns[turns.length - 1];
    if (!cur) {
      cur = { seq: 0, prompt: null, entries: [], startTs: e.ts, endTs: e.ts };
      turns.push(cur);
    }
    cur.entries.push(e);
    if (e.ts) cur.endTs = e.ts;
  }
  return turns;
}

/**
 * Wrap every case-insensitive occurrence of `term` in a highlight <mark> —
 * the search-hit highlighting for the thinking pane (agents-pill-inactive-
 * search-2026-07-09 P-005). Plain-string split, never HTML injection. Pure —
 * exported for tests.
 */
export function renderHighlighted(text: string | undefined, term?: string | null): ReactNode {
  if (!text || !term) return text ?? null;
  const lc = text.toLowerCase();
  const tlc = term.toLowerCase();
  if (!tlc || !lc.includes(tlc)) return text;
  const parts: ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const at = lc.indexOf(tlc, i);
    if (at === -1) {
      if (i < text.length) parts.push(text.slice(i));
      break;
    }
    if (at > i) parts.push(text.slice(i, at));
    parts.push(
      <mark
        key={key++}
        data-testid="thinking-highlight"
        style={{
          background: 'color-mix(in srgb, var(--accent, #38bdf8), transparent 55%)',
          color: 'inherit',
          borderRadius: 2,
          padding: '0 1px',
        }}
      >
        {text.slice(at, at + tlc.length)}
      </mark>,
    );
    i = at + tlc.length;
  }
  return parts;
}

export function Entry({ entry, highlightTerm }: { entry: TimelineEntry; highlightTerm?: string }) {
  if (entry.kind === 'prompt') {
    return (
      <div style={{ margin: '0 0 8px', padding: '4px 8px', background: 'color-mix(in srgb, var(--accent), transparent 88%)', borderLeft: '2px solid var(--accent, #38bdf8)', borderRadius: 3 }}>
        <div style={{ color: 'var(--accent-strong, #7dd3fc)', fontSize: 10, marginBottom: 2 }}>
          <EntryTime ts={entry.ts} />
          ⟩ prompt
        </div>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', color: 'var(--fg)' }}>
          {renderHighlighted(entry.text, highlightTerm)}
        </pre>
      </div>
    );
  }
  if (entry.kind === 'text') {
    return (
      <div style={{ margin: '0 0 8px' }}>
        <EntryTime ts={entry.ts} />
        <pre style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'inherit',
        }}>
          {renderHighlighted(entry.text, highlightTerm)}
        </pre>
      </div>
    );
  }
  if (entry.kind === 'tool_use') {
    return (
      <div style={{ margin: '0 0 8px', padding: '4px 6px', background: 'color-mix(in srgb, var(--accent), transparent 92%)', border: '1px solid color-mix(in srgb, var(--accent), transparent 82%)', borderRadius: 3 }}>
        <div style={{ color: 'var(--accent-strong, #7dd3fc)', fontSize: 10.5, marginBottom: 2 }}>
          <EntryTime ts={entry.ts} />
          ▸ tool_use: <strong>{entry.toolName}</strong>
        </div>
        <pre style={{ margin: 0, fontSize: 10.5, color: 'var(--fg-mute)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {renderHighlighted(compactJson(entry.toolInput), highlightTerm)}
        </pre>
      </div>
    );
  }
  if (entry.kind === 'tool_result') {
    return (
      <div style={{ margin: '0 0 8px', padding: '4px 6px', background: 'color-mix(in srgb, var(--good), transparent 94%)', border: '1px solid color-mix(in srgb, var(--good), transparent 84%)', borderRadius: 3 }}>
        <div style={{ color: TONE.good, fontSize: 10.5, marginBottom: 2 }}>
          <EntryTime ts={entry.ts} />
          ◂ tool_result
        </div>
        <pre style={{ margin: 0, fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'auto' }}>
          {renderHighlighted(entry.text, highlightTerm)}
        </pre>
      </div>
    );
  }
  if (entry.kind === 'status') {
    return (
      <div style={{ margin: '0 0 8px', fontSize: 10.5, color: 'var(--fg-mute)', fontStyle: 'italic' }}>
        <EntryTime ts={entry.ts} />
        ⌘ {renderHighlighted(entry.text, highlightTerm)}
      </div>
    );
  }
  if (entry.kind === 'result') {
    const cost = entry.costUsd ? `$${entry.costUsd.toFixed(4)}` : '';
    const tokens = entry.inputTokens || entry.outputTokens
      ? `${entry.inputTokens ?? 0}/${entry.outputTokens ?? 0} tok`
      : '';
    const dur = entry.durationMs ? `${(entry.durationMs / 1000).toFixed(1)}s` : '';
    const time = fmtEntryTime(entry.ts);
    // The time + cost/tokens/duration share the right side of the header.
    const right = [time, cost, tokens, dur].filter(Boolean).join(' · ');
    return (
      <div style={{ margin: '0 0 4px', padding: '4px 6px', background: 'var(--bg-2)', borderTop: '1px solid var(--border)' }}>
        <div style={{ color: TONE.neutral, fontSize: 10.5, marginBottom: 2 }}>
          ✓ result {right && <span style={{ float: 'right' }}>{right}</span>}
        </div>
        {entry.text && (
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' }}>
            {renderHighlighted(entry.text, highlightTerm)}
          </pre>
        )}
      </div>
    );
  }
  return null;
}

function compactJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (!s) return '';
    return s.length > 400 ? s.slice(0, 400) + '…' : s;
  } catch {
    return String(v);
  }
}
