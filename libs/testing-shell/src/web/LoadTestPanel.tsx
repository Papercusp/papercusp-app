/**
 * LoadTestPanel — generic k6 load-test UI (Phase 1 of
 * universal-testing-domains-generic-2026-06-03).
 *
 * Ported from Restart's apps/web/app/load-tests/LoadTestPanel.tsx. The only
 * changes vs the original: the project + endpoints are injected as PROPS
 * instead of read from `useProject()` / hardcoded `/api/load-tests/*`, and the
 * SSE reader comes from the lib's own `../sse` (readSSEStream) rather than an
 * app-local module. The host mounts a backend (e.g. createK6HonoRoutes) at the
 * paths it passes here. Category colors are token-based to match the sibling
 * panels.
 */
'use client';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { readSSEStream } from '../sse';

const alpha = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

export interface LoadTestPanelProps {
  /** GET → { scripts: Script[] }. */
  scriptsEndpoint: string;
  /** POST { project?, scriptId, vus, duration } → SSE log/done/error frames. */
  runEndpoint: string;
  /** POST → kills the active run. */
  stopEndpoint: string;
  /** GET → { results: ResultMeta[] }; GET `${resultsEndpoint}/:id` → ResultMeta. */
  resultsEndpoint: string;
  /** Optional project id appended as `?project=` to the GET endpoints + run body. */
  project?: string;
  /** Optional external k6 live-dashboard URL (the running k6 web dashboard). */
  dashboardUrl?: string;
}

interface Script {
  id: string;
  name: string;
  description: string;
  category: 'smoke' | 'load' | 'stress' | 'spike' | 'soak' | 'browser' | string;
  estimatedDuration: string;
  defaultVUs: number;
}

interface ResultMeta {
  id: string;
  scriptId: string;
  scriptName: string;
  startedAt: string;
  exitCode: number | null;
  log: string[];
}

type RunState = 'idle' | 'running' | 'done' | 'error';

const CATEGORY_COLORS: Record<string, string> = {
  smoke: 'var(--good)',
  load: 'var(--accent)',
  stress: 'var(--warn)',
  spike: 'var(--bad)',
  soak: '#a78bfa',
  browser: '#facc15',
};

const CATEGORY_LABELS: Record<string, string> = {
  smoke: 'Smoke',
  load: 'Load',
  stress: 'Stress',
  spike: 'Spike',
  soak: 'Soak',
  browser: 'Browser',
};

function categoryColor(cat: string) {
  return CATEGORY_COLORS[cat] ?? 'var(--fg-dim)';
}

function formatDate(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function exitBadge(code: number | null) {
  if (code === null) return { label: 'Running', color: 'var(--accent)' };
  if (code === 0) return { label: 'Passed', color: 'var(--good)' };
  return { label: 'Failed', color: 'var(--bad)' };
}

export default function LoadTestPanel({
  scriptsEndpoint,
  runEndpoint,
  stopEndpoint,
  resultsEndpoint,
  project,
  dashboardUrl,
}: LoadTestPanelProps): ReactElement {
  const q = project ? `?project=${encodeURIComponent(project)}` : '';
  const [scripts, setScripts] = useState<Script[]>([]);
  const [selected, setSelected] = useState<Script | null>(null);
  const [vus, setVus] = useState(0);
  const [duration, setDuration] = useState('');
  const [runState, setRunState] = useState<RunState>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [resultId, setResultId] = useState<string | null>(null);
  const [results, setResults] = useState<ResultMeta[]>([]);
  const [viewResult, setViewResult] = useState<ResultMeta | null>(null);
  const [tab, setTab] = useState<'run' | 'history'>('run');
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setScripts([]);
    setSelected(null);
    const ac = new AbortController();
    fetch(`${scriptsEndpoint}${q}`, { signal: ac.signal })
      .then((r) => r.json())
      .then((d) => {
        if (ac.signal.aborted) return;
        const list: Script[] = d.scripts ?? [];
        setScripts(list);
        if (list.length > 0) {
          setSelected(list[0]);
          setVus(list[0].defaultVUs);
        } else {
          setSelected(null);
        }
      })
      .catch(() => {});
    return () => ac.abort();
  }, [scriptsEndpoint, q]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const loadHistory = useCallback(() => {
    fetch(`${resultsEndpoint}${q}`)
      .then((r) => r.json())
      .then((d) => setResults(d.results ?? []))
      .catch(() => {});
  }, [resultsEndpoint, q]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const handleSelect = (s: Script) => {
    setSelected(s);
    setVus(s.defaultVUs);
    setDuration('');
    setLogs([]);
    setRunState('idle');
    setResultId(null);
  };

  const handleRun = async () => {
    if (!selected || runState === 'running') return;
    setLogs([]);
    setRunState('running');
    setResultId(null);
    setTab('run');
    const body = { project, scriptId: selected.id, vus: vus || selected.defaultVUs, duration: duration || '' };
    abortRef.current = new AbortController();
    try {
      const res = await fetch(runEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortRef.current.signal,
      });
      if (!res.ok) {
        const err = await res.text();
        setLogs((prev) => [...prev, `ERROR: ${err}`]);
        setRunState('error');
        return;
      }
      await readSSEStream(res, (evt) => {
        if (evt.type === 'log' && evt.message) {
          setLogs((prev) => [...prev, evt.message!]);
        } else if (evt.type === 'done') {
          const code = (evt.code as number | undefined) ?? null;
          setRunState(code === 0 ? 'done' : 'error');
          setResultId((evt.resultId as string | undefined) ?? null);
          loadHistory();
        } else if (evt.type === 'error') {
          setLogs((prev) => [...prev, `ERROR: ${evt.message}`]);
          setRunState('error');
        }
      });
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') {
        setLogs((prev) => [...prev, `Fetch error: ${String(e)}`]);
        setRunState('error');
      }
    }
  };

  const handleStop = async () => {
    abortRef.current?.abort();
    await fetch(stopEndpoint, { method: 'POST' }).catch(() => {});
    setRunState('idle');
  };

  const handleViewResult = async (id: string) => {
    const res = await fetch(`${resultsEndpoint}/${id}${q}`);
    setViewResult(await res.json());
  };

  const runBtnLabel = runState === 'running' ? 'Running…' : 'Run Test';
  const runBtnColor = runState === 'running' ? 'var(--warn)' : 'var(--accent)';
  const statusBanner = runState === 'running' ? { text: 'Test in progress', color: 'var(--warn)' }
    : runState === 'done' ? { text: 'Test passed', color: 'var(--good)' }
    : runState === 'error' ? { text: 'Test finished with errors', color: 'var(--bad)' }
    : null;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', gap: 0 }}>
      <aside style={{ width: 240, flexShrink: 0, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '16px 0', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ padding: '0 16px 10px', fontSize: 11, color: 'var(--fg-mute)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Test Scripts</div>
        {scripts.length === 0 ? (
          <div style={{ padding: '0 16px', fontSize: 12, color: 'var(--fg-mute)' }}>No k6 scripts found.</div>
        ) : scripts.map((s) => {
          const active = selected?.id === s.id;
          return (
            <button key={s.id} onClick={() => handleSelect(s)} style={{ background: active ? 'var(--bg-3)' : 'transparent', border: 'none', borderLeft: `3px solid ${active ? categoryColor(s.category) : 'transparent'}`, padding: '10px 16px 10px 13px', cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 13, color: active ? 'var(--fg)' : 'var(--fg-dim)', fontWeight: active ? 600 : 400 }}>{s.name}</span>
              <span style={{ display: 'inline-block', fontSize: 10, padding: '1px 6px', borderRadius: 4, background: alpha(categoryColor(s.category), 13), color: categoryColor(s.category), fontWeight: 600, letterSpacing: '0.06em' }}>{CATEGORY_LABELS[s.category] ?? s.category}</span>
            </button>
          );
        })}
      </aside>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 0, padding: '0 20px', flexShrink: 0 }}>
          {(['run', 'history'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '14px 16px 12px', borderBottom: `2px solid ${tab === t ? 'var(--accent)' : 'transparent'}`, color: tab === t ? 'var(--fg)' : 'var(--fg-mute)', fontSize: 13, fontWeight: tab === t ? 600 : 400, textTransform: 'capitalize' }}>
              {t === 'history' ? `History (${results.length})` : 'Run'}
            </button>
          ))}
          {dashboardUrl ? (
            <a href={dashboardUrl} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--accent)', textDecoration: 'none', padding: '14px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: runState === 'running' ? 'var(--good)' : 'var(--fg-mute)' }} />
              k6 Live Dashboard
            </a>
          ) : null}
        </div>

        {tab === 'run' && (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <div style={{ width: 280, flexShrink: 0, borderRight: '1px solid var(--border)', padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
              {selected ? (
                <>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)', marginBottom: 6 }}>{selected.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-mute)', lineHeight: 1.6 }}>{selected.description}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                      <div style={{ marginBottom: 2 }}>Est. Duration</div>
                      <div style={{ color: 'var(--fg-dim)', fontWeight: 600 }}>{selected.estimatedDuration}</div>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                      <div style={{ marginBottom: 2 }}>Default VUs</div>
                      <div style={{ color: 'var(--fg-dim)', fontWeight: 600 }}>{selected.defaultVUs}</div>
                    </div>
                  </div>
                  <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--fg-mute)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Override VUs</label>
                    <input type="number" min={1} max={500} value={vus || ''} onChange={(e) => setVus(Number(e.target.value))} placeholder={String(selected.defaultVUs)} disabled={runState === 'running'} style={{ width: '100%', padding: '8px 10px', borderRadius: 6, background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--fg)', fontSize: 13, boxSizing: 'border-box', outline: 'none' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--fg-mute)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Override Duration</label>
                    <input type="text" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="e.g. 30s, 2m, 10m" disabled={runState === 'running'} style={{ width: '100%', padding: '8px 10px', borderRadius: 6, background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--fg)', fontSize: 13, boxSizing: 'border-box', outline: 'none' }} />
                  </div>
                  {(selected.category === 'soak' || selected.category === 'stress') && (
                    <div style={{ padding: '10px 12px', borderRadius: 6, background: alpha('var(--warn)', 8), border: `1px solid ${alpha('var(--warn)', 25)}`, fontSize: 11, color: 'var(--warn)', lineHeight: 1.6 }}>
                      ⚠️ This test runs for a long time. Make sure you are targeting a non-production environment.
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={handleRun} disabled={runState === 'running'} style={{ flex: 1, padding: '10px', borderRadius: 6, background: alpha(runBtnColor, 13), border: `1px solid ${alpha(runBtnColor, 40)}`, color: runBtnColor, fontSize: 13, fontWeight: 600, cursor: runState === 'running' ? 'not-allowed' : 'pointer', opacity: runState === 'running' ? 0.6 : 1 }}>{runBtnLabel}</button>
                    {runState === 'running' && (
                      <button onClick={handleStop} style={{ padding: '10px 14px', borderRadius: 6, background: alpha('var(--bad)', 13), border: `1px solid ${alpha('var(--bad)', 40)}`, color: 'var(--bad)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Stop</button>
                    )}
                  </div>
                  {statusBanner && (
                    <div style={{ padding: '8px 12px', borderRadius: 6, background: alpha(statusBanner.color, 8), border: `1px solid ${alpha(statusBanner.color, 25)}`, fontSize: 12, color: statusBanner.color, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {runState === 'running' && <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: statusBanner.color }} />}
                      {statusBanner.text}
                    </div>
                  )}
                  {resultId && runState !== 'running' && (
                    <button onClick={() => { setTab('history'); loadHistory(); }} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', color: 'var(--accent)', fontSize: 12, cursor: 'pointer' }}>View result in History →</button>
                  )}
                </>
              ) : (
                <div style={{ color: 'var(--fg-mute)', fontSize: 13 }}>Select a test script to continue.</div>
              )}
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--fg-mute)', textTransform: 'uppercase', letterSpacing: '0.08em', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Output</span>
                {logs.length > 0 && <button onClick={() => setLogs([])} style={{ background: 'transparent', border: 'none', color: 'var(--fg-mute)', fontSize: 11, cursor: 'pointer' }}>Clear</button>}
              </div>
              <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: '16px', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7, color: 'var(--fg-dim)', background: 'var(--bg-2)' }}>
                {logs.length === 0 ? (
                  <span style={{ color: 'var(--fg-mute)' }}>No output yet. Select a script and click Run Test.</span>
                ) : logs.map((line, i) => {
                  const isError = /error|fail|ERRO/i.test(line);
                  const isWarning = /warn|WARN/i.test(line);
                  const isPass = /✓|passed|default.*VUs/i.test(line);
                  const color = isError ? 'var(--bad)' : isWarning ? 'var(--warn)' : isPass ? 'var(--good)' : 'var(--fg-dim)';
                  return <div key={i} style={{ color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line}</div>;
                })}
              </div>
            </div>
          </div>
        )}

        {tab === 'history' && (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <div style={{ width: 340, flexShrink: 0, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '12px 0' }}>
              {results.length === 0 ? (
                <div style={{ padding: '20px 16px', color: 'var(--fg-mute)', fontSize: 13 }}>No results yet. Run a test to see history here.</div>
              ) : results.map((r) => {
                const badge = exitBadge(r.exitCode);
                const active = viewResult?.id === r.id;
                return (
                  <button key={r.id} onClick={() => handleViewResult(r.id)} style={{ width: '100%', background: active ? 'var(--bg-3)' : 'transparent', border: 'none', borderLeft: `3px solid ${active ? badge.color : 'transparent'}`, padding: '12px 16px 12px 13px', cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{r.scriptName}</span>
                      <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: alpha(badge.color, 13), color: badge.color, fontWeight: 700 }}>{badge.label}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-mute)' }}>{formatDate(r.startedAt)}</div>
                  </button>
                );
              })}
            </div>
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {viewResult ? (
                <>
                  <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)' }}>{viewResult.scriptName}</div>
                      <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 2 }}>{formatDate(viewResult.startedAt)}</div>
                    </div>
                    {(() => {
                      const b = exitBadge(viewResult.exitCode);
                      return <span style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 10px', borderRadius: 6, background: alpha(b.color, 13), color: b.color, fontWeight: 700 }}>{b.label}</span>;
                    })()}
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', padding: '16px', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7, color: 'var(--fg-dim)', background: 'var(--bg-2)' }}>
                    {(viewResult.log ?? []).map((line, i) => {
                      const isError = /error|fail|ERRO/i.test(line);
                      const isWarning = /warn|WARN/i.test(line);
                      const isPass = /✓|passed/i.test(line);
                      const color = isError ? 'var(--bad)' : isWarning ? 'var(--warn)' : isPass ? 'var(--good)' : 'var(--fg-dim)';
                      return <div key={i} style={{ color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line}</div>;
                    })}
                  </div>
                </>
              ) : (
                <div style={{ padding: '30px 20px', color: 'var(--fg-mute)', fontSize: 13 }}>Select a result from the list to view its output.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
