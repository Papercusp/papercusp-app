'use client';

/**
 * AdvSyncHealthPanel — the first UI that renders what the sync layer is actually
 * doing (plan no-http-anywhere-2026-07-28, P-003(b)).
 *
 * WHY IT EXISTS. `inFlight` / `queued` have been on the concurrency gate's
 * interface since it was written and NOTHING outside tests ever read them — which
 * is exactly how a saturated gate stayed invisible while users waited (WI-6559).
 * P-003(b) added the live gate probe + the queue-wait-vs-request timing split to
 * `syncMetrics`; this panel is the consumer, so the numbers stop being a thing you
 * have to reverse-engineer from outside the app (P-002 had to walk 22,065 React
 * fibers to answer "what did first paint fetch").
 *
 * ABSENCE IS NEVER RENDERED AS ZERO. That is the whole design constraint, and it
 * is a repeat of the bug this plan keeps finding: the perf suite reported
 * `web-vitals: {}` and PASSED for months because "no data" and "idle" were the
 * same value (EI-18895065570073000). So here:
 *   - no gate probe registered  → "unknown", not 0 in flight
 *   - no queries recorded yet   → "nothing recorded yet", not a table of zeros
 *   - not the desktop shell     → "browser mode — no IPC bridge", not a dead bridge
 *   - the IPC command refusing  → the error text, not a blank
 * A reader must always be able to tell "healthy" from "not measured".
 *
 * The metrics singleton is imported directly rather than read off
 * `window.__sync_metrics__`: same module instance in this bundle, but typed, and
 * it cannot silently observe a DIFFERENT copy of the library.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  syncMetrics,
  type SyncMetricsSnapshot,
  type SyncQueryEvent,
  type SyncQueryStat,
} from '@papercusp/sync';
import { readIpcStatus, type IpcStatusRead } from '@/lib/ipc-status-tauri';
import { Checkbox } from '@/app/harness/Checkbox';
import { Table, type TableColumn } from '@/app/harness/Table';

const REFRESH_MS = 1000;

/* ---------------------------------------------------------------- formatting */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatMs(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${(n / 60_000).toFixed(1)}m`;
}

/** A count that may be genuinely unknown — the point of the whole panel. */
export function formatMaybe(n: number | null): string {
  return n === null ? 'unknown' : String(n);
}

/* ------------------------------------------------------------- derived views */

export interface QueryRow extends SyncQueryStat {
  name: string;
  waitAvgMs: number;
  requestAvgMs: number;
}

/** Per-query rollup, heaviest by bytes first — "which query costs what". */
export function topQueries(byQuery: Record<string, SyncQueryStat>, limit = 12): QueryRow[] {
  return Object.entries(byQuery)
    .map(([name, s]) => ({
      ...s,
      name,
      waitAvgMs: s.requests > 0 ? s.waitMsTotal / s.requests : 0,
      requestAvgMs: s.requests > 0 ? s.requestMsTotal / s.requests : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

/**
 * The gate line, as text.
 *
 * `inFlight === null` means no transport registered a probe — the gate's depth is
 * NOT zero, it is unmeasured, and saying "0 in flight" there would recreate the
 * exact false-clean reading this panel exists to prevent.
 */
export function describeGate(t: SyncMetricsSnapshot['transport']): {
  measured: boolean;
  text: string;
} {
  if (t.inFlight === null && t.queued === null) {
    return {
      measured: false,
      text: 'unknown — no gate probe registered (is a polling transport mounted?)',
    };
  }
  const limit = t.limit === null ? '?' : String(t.limit);
  return {
    measured: true,
    text: `${formatMaybe(t.inFlight)} in flight of ${limit} · ${formatMaybe(t.queued)} queued`,
  };
}

/** Worst recent offenders by total time (queue wait + request), for the wave view. */
export function slowestRecent(events: SyncQueryEvent[], limit = 6): SyncQueryEvent[] {
  return [...events].sort((a, b) => b.waitMs + b.requestMs - (a.waitMs + a.requestMs)).slice(0, limit);
}

/* --------------------------------------------------------------------- style */

const wrap: React.CSSProperties = {
  padding: 12,
  fontSize: 12,
  lineHeight: 1.5,
  overflow: 'auto',
  height: '100%',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
};
const h: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  color: 'var(--fg-mute)',
  marginTop: 14,
  marginBottom: 4,
};
const mute: React.CSSProperties = { color: 'var(--fg-mute)' };
const warn: React.CSSProperties = { color: 'var(--warn)' };
/** Column alignment only — the shared Table primitive owns padding/borders. */
const cell: React.CSSProperties = { textAlign: 'right' };
const cellL: React.CSSProperties = { textAlign: 'left' };

/* ------------------------------------------------------------------- columns */

/** A recent-query row carrying a collision-proof React key (the ring can repeat a name+start). */
type SlowRow = SyncQueryEvent & { rowKey: string };

const QUERY_COLUMNS: TableColumn<QueryRow>[] = [
  { key: 'query', header: 'query', headerStyle: cellL, cellStyle: cellL, render: (r) => r.name },
  { key: 'reqs', header: 'reqs', headerStyle: cell, cellStyle: cell, render: (r) => r.requests },
  { key: 'bytes', header: 'bytes', headerStyle: cell, cellStyle: cell, render: (r) => formatBytes(r.bytes) },
  { key: 'wait', header: 'wait avg', headerStyle: cell, cellStyle: cell, render: (r) => formatMs(r.waitAvgMs) },
  { key: 'reqAvg', header: 'req avg', headerStyle: cell, cellStyle: cell, render: (r) => formatMs(r.requestAvgMs) },
  { key: 'reqMax', header: 'req max', headerStyle: cell, cellStyle: cell, render: (r) => formatMs(r.requestMsMax) },
  {
    key: 'fail',
    header: 'fail',
    headerStyle: cell,
    cellStyle: cell,
    render: (r) => (r.failures > 0 ? <span style={warn}>{r.failures}</span> : r.failures),
  },
];

const SLOW_COLUMNS: TableColumn<SlowRow>[] = [
  { key: 'query', header: 'query', headerStyle: cellL, cellStyle: cellL, render: (e) => e.name },
  { key: 'at', header: 'at', headerStyle: cell, cellStyle: cell, render: (e) => formatMs(e.startedAtMs) },
  {
    key: 'queued',
    header: 'queued',
    headerStyle: cell,
    cellStyle: cell,
    // Over the 250ms queue-wait threshold the panel already counts above.
    render: (e) =>
      e.waitMs > 250 ? <span style={warn}>{formatMs(e.waitMs)}</span> : formatMs(e.waitMs),
  },
  { key: 'request', header: 'request', headerStyle: cell, cellStyle: cell, render: (e) => formatMs(e.requestMs) },
  {
    key: 'bytes',
    header: 'bytes',
    headerStyle: cell,
    cellStyle: cell,
    render: (e) => (e.bytes < 0 ? '—' : formatBytes(e.bytes)),
  },
  {
    key: 'outcome',
    header: 'outcome',
    headerStyle: cellL,
    cellStyle: cellL,
    render: (e) => (e.outcome === 'ok' ? e.outcome : <span style={warn}>{e.outcome}</span>),
  },
];

/* ----------------------------------------------------------------- component */

export default function AdvSyncHealthPanel() {
  const [snap, setSnap] = useState<SyncMetricsSnapshot | null>(null);
  const [recent, setRecent] = useState<SyncQueryEvent[]>([]);
  const [ipc, setIpc] = useState<IpcStatusRead | null>(null);
  // Panel-local view toggle, not navigational state: the dock is multi-instance,
  // so a URL param would be shared by every open copy of this panel. Panel-scoped
  // state belongs in panel params; a pause button is neither.
  const [paused, setPaused] = useState(false);

  const sample = useCallback(() => {
    setSnap(syncMetrics.snapshot());
    setRecent(syncMetrics.recentQueries());
    void readIpcStatus().then(setIpc);
  }, []);

  useEffect(() => {
    sample();
    if (paused) return;
    // A renderer-side display timer (this file is .tsx — it runs in the webview,
    // not the operator host, so it is outside the managedSetInterval registry).
    const id = setInterval(sample, REFRESH_MS);
    return () => clearInterval(id);
  }, [paused, sample]);

  const rows = useMemo(() => (snap ? topQueries(snap.byQuery) : []), [snap]);
  // The ring can hold two events with the same name AND start ms, so the index
  // is folded into the key — duplicate React keys are a known perf trap here.
  const slow = useMemo<SlowRow[]>(
    () => slowestRecent(recent).map((e, i) => ({ ...e, rowKey: `${e.name}-${e.startedAtMs}-${i}` })),
    [recent],
  );

  if (!snap) return <div style={wrap}>Reading sync metrics…</div>;

  const t = snap.transport;
  const gate = describeGate(t);

  return (
    <div style={wrap} data-testid="sync-health-panel">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <strong>Sync health</strong>
        <span style={mute}>uptime {formatMs(snap.takenAtMs)}</span>
        <label
          style={{
            ...mute,
            marginLeft: 'auto',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Checkbox checked={paused} onChange={setPaused} ariaLabel="pause sampling" />
          pause
        </label>
      </div>

      <div style={h}>Concurrency gate</div>
      <div style={gate.measured ? undefined : warn} data-testid="gate-line">
        {gate.text}
      </div>
      <div style={mute}>
        queue wait: total {formatMs(t.queueWaitMsTotal)} · max {formatMs(t.queueWaitMsMax)} ·{' '}
        {t.queueWaitOver250} over 250ms · {t.queueWaitOver1000} over 1s
      </div>

      <div style={h}>Requests</div>
      <div>
        {t.requests} requests · {t.failures} failed · {t.timeouts} timed out ·{' '}
        {formatBytes(t.bytesReceived)} received
      </div>

      <div style={h}>SSE stream</div>
      <div>
        {snap.sse.connectedSinceMs === null ? (
          <span style={warn}>disconnected</span>
        ) : (
          <>connected {formatMs(snap.sse.connectedSinceMs)}</>
        )}{' '}
        · {snap.sse.reconnectCount} reconnects · {snap.sse.eventsReceived} events ·{' '}
        {formatBytes(snap.sse.bytesReceived)}
      </div>

      <div style={h}>Cache &amp; invalidations</div>
      <div>
        {snap.cache.hits} cache hits · {snap.cache.misses} misses
      </div>
      <div style={mute}>
        invalidated by: {snap.invalidations.fromSse} sse · {snap.invalidations.fromTimer} timer ·{' '}
        {snap.invalidations.fromManual} manual
      </div>

      <div style={h}>Heaviest queries (by bytes)</div>
      {rows.length === 0 ? (
        <div style={mute} data-testid="no-queries">
          nothing recorded yet — no query has completed since this page loaded
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table columns={QUERY_COLUMNS} rows={rows} getRowKey={(r) => r.name} />
        </div>
      )}

      <div style={h}>Slowest recent requests</div>
      {slow.length === 0 ? (
        <div style={mute}>nothing in the recent-query ring yet</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table columns={SLOW_COLUMNS} rows={slow} getRowKey={(e) => e.rowKey} />
        </div>
      )}

      <div style={h}>IPC bridge (/api transport)</div>
      <IpcSection read={ipc} />
    </div>
  );
}

/**
 * The desktop IPC bridge readout. Deliberately three-branched, matching
 * readIpcStatus's three-valued contract — "no bridge here" and "the bridge is
 * broken" must not look alike.
 */
export function IpcSection({ read }: { read: IpcStatusRead | null }) {
  if (read === null) return <div style={mute}>reading…</div>;
  if (read.kind === 'unavailable') {
    return (
      <div style={mute} data-testid="ipc-unavailable">
        browser mode — there is no IPC bridge to report on (desktop shell only)
      </div>
    );
  }
  if (read.kind === 'error') {
    return (
      <div style={warn} data-testid="ipc-error">
        endpoint_ipc_status failed: {read.error}
      </div>
    );
  }

  const s = read.status;
  const bad = s.client !== 'connected';
  return (
    <div data-testid="ipc-ok">
      <div style={bad ? warn : undefined}>
        client <strong>{s.client}</strong>
        {s.client === 'dial-in-flight' ? ' — a dial is hung; every /api call queues behind it' : ''}
      </div>
      <div style={mute}>
        {s.invokes} invokes · {s.connects} connects · {s.reuses} reuses · {s.attempts} attempts ·{' '}
        {s.connectErrors} connect errors · {s.resolveMisses} resolve misses
      </div>
      <div style={mute}>
        last attempt {formatMs(s.msSinceLastAttempt)} ago · last connect{' '}
        {formatMs(s.msSinceLastConnect)} ago
      </div>
      <div style={mute}>
        owner is content origin: {s.ownerIsContentOrigin ? 'yes' : 'no'}
        {s.ownerIsContentOrigin ? '' : ' — /api/desktop/* cannot ride IPC'}
      </div>
      <div style={mute}>
        socket {s.connectedPath ?? s.resolvedPath ?? '—'} ({s.resolutionDetail})
      </div>
      {s.lastError ? <div style={warn}>last error: {s.lastError}</div> : null}
    </div>
  );
}
