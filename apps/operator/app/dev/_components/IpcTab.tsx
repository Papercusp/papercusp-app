/**
 * /dev → IPC tab. Two things:
 *
 *  1. End-to-end verification button for the endpoint-IPC transport. Calls
 *     dev:ipc_echo through dispatchEndpointStream — which picks IPC on Tauri
 *     (when PAPERCUSP_DESKTOP_IPC=1 was set at desktop boot) and falls back to
 *     HTTP+SSE everywhere else. Same event log regardless of transport.
 *
 *  2. A LIVE view of `window.__ipcInspector` (the dev IPC-traffic recorder, see
 *     lib/dev/ipc-inspector-client.ts). IPC traffic is invisible to the devtools
 *     Network panel (it rides the unix socket, not HTTP), so this is where you
 *     watch it. The `churn` view is the instrument for the SSE-over-IPC fix:
 *     a long-lived stream should show ONE construction with many internal
 *     reconnects; many constructions for one URL = a consumer recreating the
 *     source (the dev-IPC flashing). Plan: calltool-endpoint-seam (Phase C/D).
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsBoolean, parseAsStringEnum } from 'nuqs';
import {
  dispatchEndpointStream,
  type EndpointStreamEvent,
} from '@papercusp/operator-core/lib/transport-adapters';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { Checkbox } from '@/app/harness/Checkbox';
import type { IpcInspectorApi } from '@papercusp/operator-core/lib/dev/ipc-inspector-client';

interface LogEntry {
  ts: number;
  kind: EndpointStreamEvent['kind'];
  text: string;
}

type TrafficView = 'churn' | 'summary' | 'events';
type ChurnRow = ReturnType<IpcInspectorApi['churn']>[number];
type SummaryRow = ReturnType<IpcInspectorApi['summary']>[number];

function getInspector(): IpcInspectorApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __ipcInspector?: IpcInspectorApi }).__ipcInspector ?? null;
}

const cellStyle: React.CSSProperties = {
  padding: '3px 8px',
  textAlign: 'left',
  borderBottom: '1px solid rgba(0,0,0,0.06)',
  whiteSpace: 'nowrap',
};

const churnColumns: ColumnDef<ChurnRow>[] = [
  {
    key: 'path',
    header: 'EventSource URL',
    width: 2.8,
    toCopyText: (r) => r.path,
    render: ({ row }) => <span style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>{row.path}</span>,
  },
  { key: 'constructions', header: 'constr', width: 0.7, toCopyText: (r) => String(r.constructions), render: ({ row }) => <strong>{row.constructions}</strong> },
  { key: 'connects', header: 'connects', width: 0.75, toCopyText: (r) => String(r.connects), render: ({ row }) => row.connects },
  { key: 'drops', header: 'drops', width: 0.65, toCopyText: (r) => String(r.drops), render: ({ row }) => row.drops },
  {
    key: 'verdict',
    header: 'verdict',
    width: 1.6,
    toCopyText: (r) => r.verdict,
    render: ({ row }) => <span style={{ whiteSpace: 'normal' }}>{row.verdict}</span>,
  },
];

const summaryColumns: ColumnDef<SummaryRow>[] = [
  {
    key: 'key',
    header: 'tool / route',
    width: 2.4,
    toCopyText: (r) => r.key,
    render: ({ row }) => <span style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>{row.key}</span>,
  },
  { key: 'started', header: 'started', width: 0.7, toCopyText: (r) => String(r.started), render: ({ row }) => row.started },
  { key: 'done', header: 'done', width: 0.65, toCopyText: (r) => String(r.done), render: ({ row }) => row.done },
  { key: 'error', header: 'error', width: 0.65, toCopyText: (r) => String(r.error), render: ({ row }) => row.error },
  { key: 'open', header: 'open', width: 0.65, toCopyText: (r) => String(r.open), render: ({ row }) => row.open },
];

export default function IpcTab(): React.JSX.Element {
  const [transport, setTransport] = useState<'ipc' | 'http' | 'unknown'>('unknown');
  const [message, setMessage] = useState('hello from the dev page');
  const [emitBinary, setEmitBinary] = useState(false);
  const [delayMs, setDelayMs] = useState(100);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);

  // Live IPC-traffic view state. View selector + live toggle are user-meaningful
  // (deep-linkable) → nuqs, per the repo's URL-state convention. The 1s refresh
  // tick is render-only lifecycle → useState.
  const [trafficView, setTrafficView] = useQueryState(
    'ipctraffic',
    parseAsStringEnum<TrafficView>(['churn', 'summary', 'events']).withDefault('churn'),
  );
  const [live, setLive] = useQueryState('ipclive', parseAsBoolean.withDefault(true));
  const [tick, setTick] = useState(0);

  // Detect transport on mount (matches the picker's logic).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauri = Boolean((window as any).__TAURI_INTERNALS__?.invoke);
    const forceHttp =
      typeof process !== 'undefined' &&
      process.env.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT === '1';
    setTransport(tauri && !forceHttp ? 'ipc' : 'http');
  }, []);

  // Auto-refresh the inspector view while `live`. Pure UI render tick over
  // in-memory inspector state (no fetch) — the documented UI-timer exception
  // to the no-polling rule (audit P-058).
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  const inspector = getInspector();
  // tick / trafficView in deps force a re-read each refresh.
  const churn = useMemo(() => inspector?.churn() ?? [], [inspector, tick]);
  const summary = useMemo(() => inspector?.summary() ?? [], [inspector, tick]);
  const recent = useMemo(
    () => (inspector?.events() ?? []).slice(-80).reverse(),
    [inspector, tick],
  );
  const total = inspector?.count() ?? 0;

  const run = useCallback(async () => {
    setRunning(true);
    setLog([]);
    const controller = new AbortController();
    const append = (kind: EndpointStreamEvent['kind'], text: string): void => {
      setLog((prev) => [...prev, { ts: Date.now(), kind, text }]);
    };
    try {
      for await (const ev of dispatchEndpointStream(
        'dev:ipc_echo',
        { message, emitBinary, delayMs },
        { signal: controller.signal },
      )) {
        if (ev.kind === 'event') {
          append('event', `${ev.name}: ${JSON.stringify(ev.data)}`);
        } else if (ev.kind === 'binary') {
          append(
            'binary',
            `${ev.name}: Uint8Array(${ev.data.byteLength}) [${Array.from(ev.data).map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`,
          );
        } else if (ev.kind === 'done') {
          append('done', JSON.stringify(ev.result));
          break;
        } else {
          append('error', `${ev.code}: ${ev.message}`);
          break;
        }
      }
    } finally {
      setRunning(false);
    }
  }, [message, emitBinary, delayMs]);

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: 0, marginBottom: 8 }}>Endpoint IPC verification</h2>
      <p style={{ marginTop: 0, opacity: 0.7, fontSize: 13 }}>
        Selected transport:{' '}
        <strong>{transport === 'unknown' ? 'detecting…' : transport.toUpperCase()}</strong>.{' '}
        {transport === 'ipc'
          ? 'Calls go through the Tauri Channel<EndpointEvent> directly.'
          : 'Calls go through HTTP+SSE. Set PAPERCUSP_DESKTOP_IPC=1 at desktop launch to switch.'}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, maxWidth: 480, marginBottom: 12 }}>
        <label>Message:</label>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={{ font: 'inherit' }}
        />
        <label>Delay ms:</label>
        <input
          type="number"
          min={0}
          max={1000}
          value={delayMs}
          onChange={(e) => setDelayMs(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))}
          style={{ font: 'inherit' }}
        />
        <label>Emit binary:</label>
        <Checkbox checked={emitBinary} onChange={setEmitBinary} />
      </div>

      <button
        onClick={run}
        disabled={running}
        style={{ padding: '6px 14px', font: 'inherit', cursor: running ? 'wait' : 'pointer' }}
      >
        {running ? 'Running…' : 'Run dev:ipc_echo'}
      </button>

      <h3 style={{ marginTop: 16, marginBottom: 6 }}>Event log</h3>
      <pre
        style={{
          background: 'rgba(0,0,0,0.04)',
          padding: 10,
          borderRadius: 4,
          fontSize: 12,
          minHeight: 120,
          maxHeight: 360,
          overflow: 'auto',
        }}
      >
        {log.length === 0 ? '(no events yet)' : log.map((e) => `[${e.kind}] ${e.text}`).join('\n')}
      </pre>

      {/* ── Live IPC traffic (window.__ipcInspector) ───────────────────────── */}
      <div style={{ marginTop: 24, borderTop: '1px solid rgba(0,0,0,0.1)', paddingTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Live IPC traffic</h2>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {inspector ? `${total} events recorded` : 'inspector inactive'}
          </span>
          <div style={{ flex: 1 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <Checkbox checked={live} onChange={setLive} /> live (1s)
          </label>
          <button onClick={() => setTick((t) => t + 1)} style={{ font: 'inherit', padding: '4px 10px' }}>
            Refresh
          </button>
          <button
            onClick={() => {
              inspector?.clear();
              setTick((t) => t + 1);
            }}
            style={{ font: 'inherit', padding: '4px 10px' }}
          >
            Clear
          </button>
        </div>

        {!inspector ? (
          <p style={{ opacity: 0.7, fontSize: 13, marginTop: 10 }}>
            <code>window.__ipcInspector</code> is not installed. It registers at app
            boot in dev. In a <strong>release</strong> build (the only build that runs
            IPC), opt in with{' '}
            <code>localStorage[&apos;papercusp.ipcInspector&apos;]=&apos;1&apos;</code>{' '}
            then reload.
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 6, margin: '10px 0' }}>
              {(['churn', 'summary', 'events'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setTrafficView(v)}
                  style={{
                    font: 'inherit',
                    padding: '4px 12px',
                    borderRadius: 4,
                    border: '1px solid rgba(0,0,0,0.15)',
                    background: trafficView === v ? 'rgba(0,0,0,0.08)' : 'transparent',
                    fontWeight: trafficView === v ? 600 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {v}
                </button>
              ))}
            </div>

            {trafficView === 'churn' && (
              churn.length === 0 ? (
                <div style={cellStyle}>(no EventSource traffic yet)</div>
              ) : (
                <div style={{ height: Math.min(520, 32 + churn.length * 36 + 4) }}>
                  <RichGrid<ChurnRow>
                    columns={churnColumns}
                    rows={churn}
                    getRowId={(r) => r.path}
                    rowMinHeight={36}
                    headerHeight={32}
                    getRowBg={(row) => row.constructions > 1 ? 'rgba(255,80,0,0.07)' : undefined}
                  />
                </div>
              )
            )}

            {trafficView === 'summary' && (
              summary.length === 0 ? (
                <div style={cellStyle}>(no invoke traffic yet)</div>
              ) : (
                <div style={{ height: Math.min(520, 32 + summary.length * 32 + 4) }}>
                  <RichGrid<SummaryRow>
                    columns={summaryColumns}
                    rows={summary}
                    getRowId={(r) => r.key}
                    rowMinHeight={32}
                    headerHeight={32}
                    getRowBg={(row) => row.error > 0 ? 'rgba(255,80,0,0.07)' : undefined}
                  />
                </div>
              )
            )}

            {trafficView === 'events' && (
              <pre
                style={{
                  background: 'rgba(0,0,0,0.04)',
                  padding: 10,
                  borderRadius: 4,
                  fontSize: 11,
                  maxHeight: 360,
                  overflow: 'auto',
                }}
              >
                {recent.length === 0
                  ? '(no events yet)'
                  : recent
                      .map((e) => {
                        const tail = e.path ?? e.tool ?? '';
                        const extra = e.detail ? ` — ${e.detail}` : '';
                        return `#${e.id} ${e.kind.padEnd(12)} ${tail}${extra}`;
                      })
                      .join('\n')}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
