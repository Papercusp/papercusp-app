'use client';

/**
 * StructuredStreamView — render a one-directional structured event stream as
 * STRUCTURE, not opaque terminal bytes.
 *
 * The primary view is a typed step list (per-step ✓/✗/running + duration +
 * latest-progress detail + collapsible "show only failures"); a raw-output
 * drawer (xterm) stays one click away as the escape hatch for the cases where
 * you genuinely want the raw spew of a shelled-out tool (D-002). One shared
 * component owns the SSE subscription (@papercusp/sse) + event accumulation;
 * each consumer supplies the pure projections (`deriveSteps`, `formatRawLine`,
 * `classifyTerminal`) that encode its domain.
 *
 * Plan: structured-streams-not-terminals-2026-06-05 (D-002). First consumer:
 * ProvisionStream (D-003); BranchActionRunner + harness-run viewers are the
 * P1 stretch (D-004), all sharing this component.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createResilientEventSource } from '@papercusp/sse';
import '@xterm/xterm/css/xterm.css';
import { Checkbox } from '../harness/Checkbox';
import { statusToneColor } from '../harness/theme';
import type { StreamEvent, StreamStep } from './structured-stream-types';

export type { StreamEvent, StreamStep, StepStatus } from './structured-stream-types';

export interface StructuredStreamViewProps {
  /** SSE endpoint to subscribe to. */
  url: string;
  /** SSE event names to wire as data handlers (non-control kinds). */
  eventKinds: readonly string[];
  /** Pure projection: accumulated events (arrival order) → typed step list. */
  deriveSteps: (events: StreamEvent[]) => StreamStep[];
  /** Format an event into a raw drawer line (ANSI ok). null = skip. */
  formatRawLine?: (e: StreamEvent) => string | null;
  /** Classify an event as a terminal outcome (drives onDone + status). */
  classifyTerminal?: (e: StreamEvent) => 'success' | 'failed' | null;
  /** Fired once on a terminal event (or on a server `done` control event). */
  onDone?: (o: { kind: 'success' | 'failed' | 'closed'; finalKind?: string }) => void;
  /** Control event names that just flip status (e.g. `attached`, `done`). */
  controlKinds?: { attached?: string; done?: string };
  /** One-line caption shown in the footer. */
  caption?: string;
  /** Raw drawer xterm height in rows. Default 18. */
  rawRows?: number;
  /** Controlled "show only failures" filter (uncontrolled if omitted). */
  failuresOnly?: boolean;
  onFailuresOnlyChange?: (v: boolean) => void;
  /** Controlled raw-drawer-open state (uncontrolled if omitted). */
  rawOpen?: boolean;
  onRawOpenChange?: (v: boolean) => void;
}

/* ─── duration helper ──────────────────────────────────────────────────── */

function fmtDuration(startedAt?: number, endedAt?: number): string | null {
  if (startedAt == null) return null;
  const end = endedAt ?? Date.now();
  const ms = Math.max(0, end - startedAt);
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

const STATUS_GLYPH: Record<StreamStep['status'], string> = {
  ok: '✓',
  failed: '✗',
  running: '●',
  info: '•',
};

/* ─── raw drawer (xterm), mounted only when open ───────────────────────── */

function RawLogDrawer({ lines, rows }: { lines: string[]; rows: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<{ write: (s: string) => void; dispose: () => void } | null>(null);
  const writtenRef = useRef(0);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  useEffect(() => {
    let cancelled = false;
    let term: {
      write: (s: string) => void;
      dispose: () => void;
      open: (el: HTMLElement) => void;
      loadAddon: (a: unknown) => void;
    } | null = null;
    let fit: { fit: () => void } | null = null;
    let ro: ResizeObserver | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (cancelled || !containerRef.current) return;
      term = new Terminal({
        rows,
        cols: 100,
        convertEol: true,
        scrollback: 5_000,
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        fontSize: 12,
        theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9' },
        cursorBlink: false,
        disableStdin: true,
      }) as unknown as typeof term;
      fit = new FitAddon() as unknown as typeof fit;
      term!.loadAddon(fit);
      term!.open(containerRef.current);
      fit!.fit();
      termRef.current = term as unknown as { write: (s: string) => void; dispose: () => void };
      // Flush everything received so far (the drawer may open mid-stream).
      for (const l of linesRef.current) term!.write(l);
      writtenRef.current = linesRef.current.length;
      ro = new ResizeObserver(() => {
        try {
          fit?.fit();
        } catch {
          /* ignore */
        }
      });
      ro.observe(containerRef.current);
    })();

    return () => {
      cancelled = true;
      try {
        ro?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        term?.dispose();
      } catch {
        /* ignore */
      }
      termRef.current = null;
      writtenRef.current = 0;
    };
  }, [rows]);

  // Append only the new lines since the last write.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    for (let i = writtenRef.current; i < lines.length; i++) term.write(lines[i]);
    writtenRef.current = lines.length;
  }, [lines]);

  return (
    <div
      ref={containerRef}
      style={{
        minHeight: 160,
        background: '#0d1117',
        padding: 8,
        borderRadius: 4,
        marginTop: 6,
      }}
    />
  );
}

/* ─── component ────────────────────────────────────────────────────────── */

export function StructuredStreamView({
  url,
  eventKinds,
  deriveSteps,
  formatRawLine,
  classifyTerminal,
  onDone,
  controlKinds,
  caption,
  rawRows = 18,
  failuresOnly,
  onFailuresOnlyChange,
  rawOpen,
  onRawOpenChange,
}: StructuredStreamViewProps) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [rawLines, setRawLines] = useState<string[]>([]);
  const [status, setStatus] = useState<'connecting' | 'streaming' | 'done' | 'error'>('connecting');

  // Controlled/uncontrolled toggles.
  const [failuresOnlyInner, setFailuresOnlyInner] = useState(false);
  const [rawOpenInner, setRawOpenInner] = useState(false);
  const showFailuresOnly = failuresOnly ?? failuresOnlyInner;
  const setShowFailuresOnly = onFailuresOnlyChange ?? setFailuresOnlyInner;
  const isRawOpen = rawOpen ?? rawOpenInner;
  const setRawOpen = onRawOpenChange ?? setRawOpenInner;

  const seqRef = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!url) return;
    setEvents([]);
    setRawLines([]);
    seqRef.current = 0;
    setStatus('connecting');

    const handleData = (kind: string) => (data: string) => {
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        payload = { line: data };
      }
      const ts =
        (payload as { ts?: string } | undefined)?.ts ?? new Date().toISOString();
      const ev: StreamEvent = { kind, data: payload, ts, seq: seqRef.current++ };
      setEvents((prev) => [...prev, ev]);
      const raw = formatRawLine?.(ev);
      if (raw) setRawLines((prev) => [...prev, raw]);
      if (statusRef.current === 'connecting') setStatus('streaming');
      const terminal = classifyTerminal?.(ev);
      if (terminal) {
        setStatus('done');
        onDone?.({ kind: terminal, finalKind: kind });
      }
    };

    const handlers: Record<string, (data: string) => void> = {};
    for (const k of eventKinds) handlers[k] = handleData(k);
    if (controlKinds?.attached) handlers[controlKinds.attached] = () => setStatus('streaming');
    if (controlKinds?.done) {
      handlers[controlKinds.done] = () => {
        setStatus((s) => (s === 'done' ? s : 'done'));
      };
    }

    const source = createResilientEventSource({
      url,
      handlers,
      onStatusChange: (s) => {
        if (s === 'failing' && statusRef.current === 'connecting') setStatus('error');
      },
    });
    return () => source.close();
    // deriveSteps/formatRawLine/classifyTerminal are stable module fns; url is
    // the real dependency. eventKinds is a stable const per consumer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const steps = useMemo(() => deriveSteps(events), [events, deriveSteps]);
  const failureCount = steps.filter((s) => s.status === 'failed').length;
  const visibleSteps = showFailuresOnly ? steps.filter((s) => s.status === 'failed') : steps;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 11,
          color: 'var(--fg-mute)',
          fontFamily: 'ui-monospace, monospace',
          marginBottom: 6,
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <Checkbox
            checked={showFailuresOnly}
            onChange={setShowFailuresOnly}
            ariaLabel="Show only failures"
          />
          show only failures{failureCount > 0 ? ` (${failureCount})` : ''}
        </label>
        <button
          type="button"
          onClick={() => setRawOpen(!isRawOpen)}
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            borderRadius: 4,
            color: 'var(--fg-dim)',
            cursor: 'pointer',
            fontSize: 11,
            padding: '1px 6px',
            fontFamily: 'inherit',
          }}
        >
          {isRawOpen ? '▾ raw output' : '▸ raw output'}
        </button>
      </div>

      {/* typed step list */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {visibleSteps.length === 0 ? (
          <div style={{ color: 'var(--fg-mute)', fontSize: 12, padding: '8px 2px' }}>
            {status === 'connecting'
              ? 'connecting…'
              : showFailuresOnly
                ? 'no failures'
                : 'waiting for output…'}
          </div>
        ) : (
          visibleSteps.map((s) => {
            const dur = fmtDuration(s.startedAt, s.endedAt);
            return (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  padding: '4px 2px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
                  <span
                    style={{
                      color: statusToneColor(s.status),
                      width: 14,
                      display: 'inline-block',
                      textAlign: 'center',
                    }}
                    aria-label={s.status}
                  >
                    {STATUS_GLYPH[s.status]}
                  </span>
                  <span style={{ color: 'var(--fg)', fontWeight: 500 }}>{s.label}</span>
                  {s.detail && (
                    <span
                      style={{
                        color: 'var(--fg-dim)',
                        fontSize: 12,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                    >
                      {s.detail}
                    </span>
                  )}
                  {dur && (
                    <span style={{ color: 'var(--fg-mute)', fontSize: 11, marginLeft: 'auto' }}>
                      {dur}
                    </span>
                  )}
                </div>
                {s.notes.length > 0 && (
                  <div style={{ paddingLeft: 22 }}>
                    {s.notes.map((n, i) => (
                      <div
                        key={i}
                        style={{
                          color: 'var(--fg-mute)',
                          fontSize: 11,
                          fontFamily: 'ui-monospace, monospace',
                        }}
                      >
                        {n}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* raw drawer (escape hatch) */}
      {isRawOpen && <RawLogDrawer lines={rawLines} rows={rawRows} />}

      {/* footer */}
      <div
        style={{
          fontSize: 11,
          color: 'var(--fg-mute)',
          marginTop: 4,
          display: 'flex',
          gap: 12,
          fontFamily: 'ui-monospace, monospace',
        }}
      >
        {caption && <span>{caption}</span>}
        <span>
          status:{' '}
          <span
            style={{
              color:
                status === 'error'
                  ? 'var(--bad)'
                  : status === 'done'
                    ? 'var(--good)'
                    : 'var(--accent)',
            }}
          >
            {status}
          </span>
        </span>
      </div>
    </div>
  );
}
