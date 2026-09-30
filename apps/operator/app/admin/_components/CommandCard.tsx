'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createResilientEventSource } from '@papercusp/sse';
import { Tooltip } from '@/app/harness/Tooltip';
import { Checkbox } from '@/app/harness/Checkbox';

export interface CommandSpec {
  id: string;
  label: string;
  section: 'building' | 'running' | 'simulators';
  description?: string;
  command: string;
  cwd?: string;
}

type RunStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

interface LogLine {
  stream: 'stdout' | 'stderr';
  line: string;
  ts: number;
}

const MAX_LINES = 5000;

export default function CommandCard({ spec }: { spec: CommandSpec }) {
  const [status, setStatus] = useState<RunStatus>('idle');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [exitSignal, setExitSignal] = useState<string | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [pid, setPid] = useState<number | null>(null);
  const [showCommand, setShowCommand] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const esRef = useRef<{ close: () => void } | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setStatus((s) => (s === 'running' ? 'cancelled' : s));
  }, []);

  const start = useCallback(() => {
    esRef.current?.close();
    setLines([]);
    setStatus('running');
    setExitCode(null);
    setExitSignal(null);
    setStartedAt(Date.now());
    setPid(null);

    const source = createResilientEventSource({
      url: `/api/admin/run?cmd=${encodeURIComponent(spec.id)}`,
      handlers: {
        meta: (data) => {
          try {
            const meta = JSON.parse(data);
            setPid(meta.pid);
            if (typeof meta.startedAt === 'number') setStartedAt(meta.startedAt);
          } catch { /* ignore */ }
        },
        log: (data) => {
          try {
            const { stream, line } = JSON.parse(data);
            setLines((prev) => {
              const next = prev.length >= MAX_LINES ? prev.slice(-(MAX_LINES - 1)) : prev.slice();
              next.push({ stream, line, ts: Date.now() });
              return next;
            });
          } catch { /* ignore */ }
        },
        exit: (data) => {
          try {
            const { code, signal } = JSON.parse(data);
            setExitCode(code);
            setExitSignal(signal);
            setStatus(code === 0 ? 'done' : 'error');
          } catch { /* ignore */ }
        },
        error: (data) => {
          if (typeof data === 'string' && data.length > 0) {
            try {
              const { message } = JSON.parse(data);
              setLines((prev) => [...prev, { stream: 'stderr', line: `[server-error] ${message}`, ts: Date.now() }]);
            } catch { /* ignore */ }
          }
        },
        done: () => {
          source.close();
          esRef.current = null;
          setStatus((s) => (s === 'running' ? 'done' : s));
        },
      },
    });
    esRef.current = source;
  }, [spec.id]);

  useEffect(() => () => {
    esRef.current?.close();
  }, []);

  useEffect(() => {
    if (!autoScroll || !logBoxRef.current) return;
    logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [lines, autoScroll]);

  const elapsedMs = startedAt && status !== 'idle' ? Date.now() - startedAt : null;
  const elapsedLabel = useElapsedLabel(startedAt, status === 'running');

  return (
    <div className={`pc-ops-card pc-ops-card-${status}`}>
      <div className="pc-ops-card-head">
        <div className="pc-ops-card-title">{spec.label}</div>
        <StatusPill status={status} exitCode={exitCode} exitSignal={exitSignal} />
      </div>

      {spec.description && <div className="pc-ops-card-desc">{spec.description}</div>}

      <div className="pc-ops-card-actions">
        {status === 'running' ? (
          <button type="button" className="pc-ops-btn pc-ops-btn-stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" className="pc-ops-btn pc-ops-btn-run" onClick={start}>
            {status === 'idle' ? 'Run' : 'Re-run'}
          </button>
        )}
        <Tooltip label="Show or hide the resolved shell command" side="top" align="start">
          <button
            type="button"
            className="pc-ops-btn pc-ops-btn-ghost"
            onClick={() => setShowCommand((v) => !v)}
          >
            {showCommand ? 'Hide cmd' : 'Show cmd'}
          </button>
        </Tooltip>
        {status === 'running' && (
          <span className="pc-ops-meta">
            pid {pid ?? '–'} · {elapsedLabel}
          </span>
        )}
        {status !== 'idle' && status !== 'running' && elapsedMs != null && (
          <span className="pc-ops-meta">{formatMs(elapsedMs)}</span>
        )}
      </div>

      {showCommand && (
        <pre className="pc-ops-card-cmd">{spec.cwd ? `cd ${spec.cwd} && ` : ''}{spec.command}</pre>
      )}

      {(lines.length > 0 || status === 'running') && (
        <div className="pc-ops-log-wrap">
          <div className="pc-ops-log-controls">
            <label className="pc-ops-checkbox">
              <Checkbox checked={autoScroll} onChange={setAutoScroll} />
              <span>auto-scroll</span>
            </label>
            <span className="pc-ops-meta">{lines.length} lines</span>
            <button type="button" className="pc-ops-btn pc-ops-btn-ghost pc-ops-btn-mini" onClick={() => setLines([])}>
              clear
            </button>
          </div>
          <div ref={logBoxRef} className="pc-ops-log-box">
            {lines.map((l, i) => (
              <div key={i} className={`pc-ops-log-line pc-ops-log-${l.stream}`}>{l.line || ' '}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({
  status,
  exitCode,
  exitSignal,
}: {
  status: RunStatus;
  exitCode: number | null;
  exitSignal: string | null;
}) {
  switch (status) {
    case 'idle':
      return <span className="pc-ops-pill pc-ops-pill-idle">idle</span>;
    case 'running':
      return <span className="pc-ops-pill pc-ops-pill-running">running</span>;
    case 'done':
      return <span className="pc-ops-pill pc-ops-pill-done">exit 0</span>;
    case 'error':
      return <span className="pc-ops-pill pc-ops-pill-error">{exitSignal ?? `exit ${exitCode ?? '?'}`}</span>;
    case 'cancelled':
      return <span className="pc-ops-pill pc-ops-pill-cancelled">stopped</span>;
  }
}

function useElapsedLabel(startedAt: number | null, isLive: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isLive]);
  if (!startedAt) return '';
  return formatMs(Date.now() - startedAt);
}

/** Pure: format an elapsed-ms span as `Ns` / `NmNNs` / `NhNNm`. Exported for tests. */
export function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm.toString().padStart(2, '0')}m`;
}
