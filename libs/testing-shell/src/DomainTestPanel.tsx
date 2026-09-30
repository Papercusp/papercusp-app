/**
 * <DomainTestPanel> — shared shell for every testing-domain subtab.
 *
 * Moved to @papercusp/testing-shell as Phase A / P-002 of
 * harness-tests-tab-and-tester-promotion-2026-05-26 so the harness Tests
 * tab consumes the same shell as /admin/testing. The only behavioral
 * change vs. the operator-vite original: backend access goes through an
 * injected `dataSource: TestingDataSource` instead of hardcoded
 * `/api/admin/testing/*` fetches. The admin call site passes
 * `adminTestingDataSource`, preserving exact prior behavior.
 *
 * Original provenance: admin-testing-tab-restructure-2026-05-24
 * (P-004 shell, P-013 status chips, P-016/P-017 run drawer, P-018 history).
 *
 * Three regions: header (label + count + run-all), health strip
 * (test-related signals), and the per-section file list. When
 * `customNode` is passed, the sections region is replaced wholesale —
 * existing bespoke tabs mount their UI inside the same shell.
 */

import { useEffect, useState, useRef, type ReactNode, type ReactElement } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import './domain-panel.css';
import {
  type TestingDataSource,
  type DomainDetail,
  type FileStatusEntry,
  type HealthStripData,
  type HistoryRow,
  type ChipStatus,
  type TestRunnerWire,
} from './data-source';
import {
  k6CategoriesPresent,
  k6CategoryColor,
  k6CategoryLabel,
  visibleByCategory,
} from './k6';

/** The k6 member of the runner union — the only runner with interactive controls. */
type K6Runner = Extract<TestRunnerWire, { kind: 'k6' }>;

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

const CHIP_LABEL: Record<ChipStatus, string> = {
  pass: '✓',
  fail: '✗',
  skip: '·',
  cancelled: '⊘',
  error: '!',
  running: '…',
};

function chipClass(s: ChipStatus, stale: boolean): string {
  return `pc-dtp-chip pc-dtp-chip-${s}${stale ? ' is-stale' : ''}`;
}

function runnerLabel(r: TestRunnerWire): string {
  if (r.kind === 'node' || r.kind === 'shell') {
    return r.label ?? `${r.kind} ${r.cmd}`;
  }
  if (r.kind === 'vitest' || r.kind === 'playwright') {
    return `${r.kind} ${r.filePath}`;
  }
  if (r.kind === 'cargo') {
    return r.test ? `cargo ${r.crate}::${r.test}` : `cargo ${r.crate}`;
  }
  if (r.kind === 'k6') {
    const opts = [r.vus ? `${r.vus} VUs` : null, r.duration].filter(Boolean).join(', ');
    return opts ? `k6 ${r.script} (${opts})` : `k6 ${r.script}`;
  }
  return `suite ${r.suiteId}`;
}

function formatMtime(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const ageMs = now - ms;
  const day = 24 * 60 * 60 * 1000;
  if (ageMs < day) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (ageMs < 7 * day) {
    return `${Math.floor(ageMs / day)}d ago`;
  }
  return d.toISOString().slice(0, 10);
}

interface DomainTestPanelProps {
  domainId: string;
  /** Backend surface. Defaults to the /admin/testing REST implementation. */
  dataSource: TestingDataSource;
  /**
   * If passed, replaces the sections region with the caller-provided
   * React. Used by existing bespoke tabs (P-006a) to mount their UI
   * inside the same header/health-strip shell.
   */
  customNode?: ReactNode;
}

export default function DomainTestPanel({
  domainId,
  dataSource,
  customNode,
}: DomainTestPanelProps): ReactElement {
  const [detail, setDetail] = useState<DomainDetail | null>(null);
  const [statuses, setStatuses] = useState<Record<string, FileStatusEntry>>({});
  const [health, setHealth] = useState<HealthStripData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // P-016/P-017: per-file active run + output drawer. Drawer-open state
  // is URL-backed (?runFile=<path>) so reload preserves the visible
  // drawer and the URL is shareable. The transient runId/output stays in
  // useState — generated server-side per click, not useful in URL.
  const [runFile, setRunFile] = useQueryState('runFile');
  // P-018: clicking a status chip opens a per-file run-history sheet.
  // URL-backed for the same reasons.
  const [historyFile, setHistoryFile] = useQueryState('historyFile');
  // P-010: active k6 category filter chip. URL-backed (filter state) so it
  // deep-links + is agent-driveable; default 'all'.
  const [k6cat, setK6cat] = useQueryState('k6cat', parseAsString.withDefault('all'));
  const [activeRun, setActiveRun] = useState<{
    runId: string;
    filePath: string;
    status: string;
    exitCode: number | null;
    output: string;
    finishedAt: number | null;
  } | null>(null);
  const [runLoading, setRunLoading] = useState<string | null>(null);
  // P-011: aborts an in-flight streamRun (Stop button / drawer close).
  const streamAbortRef = useRef<AbortController | null>(null);

  async function runVitestMulti(filePaths: string[], label: string): Promise<void> {
    const key = `__multi__:${label}`;
    setRunLoading(key);
    setActiveRun({ runId: '', filePath: label, status: 'starting', exitCode: null, output: '', finishedAt: null });
    void setRunFile(label);
    await runImpl({ runner: { kind: 'vitest-multi', filePaths, label } }, label);
  }

  async function runVitestFile(filePath: string): Promise<void> {
    setRunLoading(filePath);
    setActiveRun({ runId: '', filePath, status: 'starting', exitCode: null, output: '', finishedAt: null });
    void setRunFile(filePath);
    await runImpl({ runner: { kind: 'vitest', filePath } }, filePath);
  }

  // P-010: dispatch a k6 runner with the user's VUs/duration overrides.
  async function runK6(runner: K6Runner, vusOverride?: number, durationOverride?: string): Promise<void> {
    const label = `k6 ${runner.script}`;
    setRunLoading(label);
    setActiveRun({ runId: '', filePath: label, status: 'starting', exitCode: null, output: '', finishedAt: null });
    void setRunFile(label);
    await runImpl(
      {
        runner: {
          kind: 'k6',
          script: runner.script,
          vus: vusOverride ?? runner.vus,
          duration: durationOverride ?? runner.duration,
          category: runner.category,
        },
      },
      label,
    );
  }

  // P-011: when the backend implements streamRun, prefer it — live-append the
  // log lines (abortable via Stop) instead of polling. Falls through to the
  // startRun+pollRun path below when streamRun is undefined.
  async function streamImpl(body: unknown, displayPath: string): Promise<void> {
    const ac = new AbortController();
    streamAbortRef.current = ac;
    setActiveRun({ runId: 'stream', filePath: displayPath, status: 'running', exitCode: null, output: '', finishedAt: null });
    try {
      const { exitCode } = await dataSource.streamRun!(
        body,
        (line) =>
          setActiveRun((prev) =>
            prev ? { ...prev, output: prev.output ? `${prev.output}\n${line}` : line } : prev,
          ),
        ac.signal,
      );
      setActiveRun((prev) =>
        prev ? { ...prev, status: exitCode === 0 ? 'pass' : 'fail', exitCode, finishedAt: Date.now() } : prev,
      );
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        setActiveRun((prev) => (prev ? { ...prev, status: 'cancelled', finishedAt: Date.now() } : prev));
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setActiveRun((prev) =>
          prev
            ? { ...prev, status: 'error', output: prev.output ? `${prev.output}\n${msg}` : msg, finishedAt: Date.now() }
            : prev,
        );
      }
    } finally {
      streamAbortRef.current = null;
      setRunLoading(null);
      void dataSource.fetchStatuses(domainId).then((s) => setStatuses(s)).catch(() => { /* keep stale */ });
    }
  }

  async function runImpl(body: unknown, displayPath: string): Promise<void> {
    if (dataSource.streamRun) {
      await streamImpl(body, displayPath);
      return;
    }
    try {
      let runId: string;
      try {
        ({ runId } = await dataSource.startRun(body));
      } catch (e) {
        setActiveRun({ runId: '', filePath: displayPath, status: 'error', exitCode: null, output: e instanceof Error ? e.message : String(e), finishedAt: Date.now() });
        setRunLoading(null);
        return;
      }
      setActiveRun((prev) => prev ? { ...prev, runId, status: 'running' } : prev);
      const poll = async (): Promise<void> => {
        const snap = await dataSource.pollRun(runId);
        if (!snap) return;
        setActiveRun({ runId, filePath: displayPath, status: snap.status, exitCode: snap.exitCode, output: snap.output, finishedAt: snap.finishedAt });
        if (snap.finishedAt === null) {
          setTimeout(poll, 750);
        } else {
          setRunLoading(null);
          void dataSource.fetchStatuses(domainId)
            .then((s) => setStatuses(s))
            .catch(() => { /* keep stale */ });
        }
      };
      void poll();
    } catch (e) {
      setActiveRun({ runId: '', filePath: displayPath, status: 'error', exitCode: null, output: e instanceof Error ? e.message : String(e), finishedAt: Date.now() });
      setRunLoading(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setStatuses({});

    void Promise.all([
      dataSource.fetchDomain(domainId),
      dataSource.fetchStatuses(domainId).catch(() => ({})),
      dataSource.fetchHealth(domainId).catch(() => null),
    ])
      .then(([d, s, h]) => {
        if (cancelled) return;
        setDetail(d);
        setStatuses(s);
        setHealth(h);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // Refetch on tab focus — no SWR/TanStack-Query in operator-vite per D-013.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void Promise.all([
        dataSource.fetchDomain(domainId).catch(() => null),
        dataSource.fetchStatuses(domainId).catch(() => ({})),
      ])
        .then(([d, s]) => {
          if (cancelled) return;
          if (d) setDetail(d);
          setStatuses(s);
        });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [domainId, dataSource]);

  if (loading && !detail) {
    return <div className="pc-dtp-loading">Loading {domainId}…</div>;
  }

  if (error) {
    return (
      <div className="pc-dtp-error">
        <h3>Could not load {domainId}</h3>
        <pre>{error}</pre>
      </div>
    );
  }

  if (!detail) {
    return <div className="pc-dtp-loading">No data for {domainId}.</div>;
  }

  return (
    <div className="pc-dtp">
      <header className="pc-dtp-header">
        <div className="pc-dtp-header-row">
          <h2 className="pc-dtp-title">{detail.label}</h2>
          <span className="pc-dtp-count">{detail.totalFiles} files</span>
          {detail.totalFiles > 0 && (
            <button
              type="button"
              className="pc-dtp-run-btn"
              disabled={runLoading !== null}
              onClick={() => {
                const all = detail.sections.flatMap((s) => s.files.map((f) => f.path));
                void runVitestMulti(all, `${detail.id}/all`);
              }}
              title={`Run all ${detail.totalFiles} files in this domain`}
            >
              ▶ Run all
            </button>
          )}
        </div>
        <p className="pc-dtp-description">{detail.description}</p>
      </header>

      {/* P-033: test-related health strip (last-suite duration, last failure, flaky-rate). */}
      {health && (health.totalFilesTracked > 0 || health.lastSuiteDurationMs !== null) && (
        <div className="pc-dtp-health-strip pc-dtp-health-strip-live">
          {health.lastSuiteDurationMs !== null && (
            <span className="pc-dtp-health-pill" title="Sum of latest-per-file durations on current branch">
              <strong>last:</strong> {formatMs(health.lastSuiteDurationMs)}
            </span>
          )}
          <span className="pc-dtp-health-pill" title="Files with at least one row on current branch">
            <strong>tracked:</strong> {health.totalFilesTracked}/{detail.totalFiles}
          </span>
          {health.flakyFileCount > 0 && (
            <span className="pc-dtp-health-pill pc-dtp-health-pill-flaky" title="Files with >1 distinct status in last 10 runs">
              <strong>flaky:</strong> {health.flakyFileCount}
            </span>
          )}
          {health.lastFailureFinishedAt && (
            <span className="pc-dtp-health-pill pc-dtp-health-pill-fail" title={health.lastFailureFinishedAt}>
              <strong>last fail:</strong> {new Date(health.lastFailureFinishedAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {runFile && activeRun && (
        <div className={`pc-dtp-drawer pc-dtp-drawer-${activeRun.status}`}>
          <header className="pc-dtp-drawer-header">
            <span className="pc-dtp-drawer-title">
              {activeRun.status === 'running' || activeRun.status === 'starting' ? '⟳' : activeRun.status === 'pass' ? '✓' : '✗'} {activeRun.filePath}
            </span>
            <span className="pc-dtp-drawer-meta">
              status: {activeRun.status}{activeRun.exitCode !== null ? ` · exit ${activeRun.exitCode}` : ''}
            </span>
            {activeRun.status === 'running' && streamAbortRef.current && (
              <button
                type="button"
                className="pc-dtp-drawer-stop"
                onClick={() => streamAbortRef.current?.abort()}
                title="Stop the running stream"
              >■ Stop</button>
            )}
            <button
              type="button"
              className="pc-dtp-drawer-close"
              onClick={() => { streamAbortRef.current?.abort(); setActiveRun(null); void setRunFile(null); }}
              title="Close"
            >×</button>
          </header>
          <pre className="pc-dtp-drawer-output">{activeRun.output || '(no output yet)'}</pre>
        </div>
      )}

      {historyFile && (
        <FileHistorySheet
          filePath={historyFile}
          dataSource={dataSource}
          onClose={() => void setHistoryFile(null)}
        />
      )}

      {customNode ? (
        <div className="pc-dtp-custom">{customNode}</div>
      ) : (
        <div className="pc-dtp-sections">
          {detail.sections.map((s) => (
            <section key={s.id} className="pc-dtp-section">
              <header className="pc-dtp-section-header">
                <h3 className="pc-dtp-section-title">{s.label}</h3>
                <span className="pc-dtp-section-count">
                  {s.files.length} file{s.files.length === 1 ? '' : 's'}
                  {s.runners.length > 0 && `, ${s.runners.length} runner${s.runners.length === 1 ? '' : 's'}`}
                </span>
                {s.files.length > 0 && (
                  <button
                    type="button"
                    className="pc-dtp-run-btn"
                    disabled={runLoading !== null}
                    onClick={() => void runVitestMulti(s.files.map((f) => f.path), `${detail.id}/${s.id}`)}
                    title={`Run all ${s.files.length} files in this section`}
                  >
                    ▶ Run section
                  </button>
                )}
              </header>
              {s.description && <p className="pc-dtp-section-description">{s.description}</p>}

              {/* P-010: category filter chips — only when this section has k6 runners. */}
              {(() => {
                const cats = k6CategoriesPresent(s.runners);
                if (cats.length === 0) return null;
                return (
                  <div className="pc-dtp-k6-chips" role="group" aria-label="Filter k6 runners by category">
                    <button
                      type="button"
                      className={`pc-dtp-k6-chip${k6cat === 'all' ? ' is-active' : ''}`}
                      onClick={() => void setK6cat('all')}
                    >all</button>
                    {cats.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`pc-dtp-k6-chip${k6cat === c ? ' is-active' : ''}`}
                        style={k6cat === c ? { color: k6CategoryColor(c), borderColor: k6CategoryColor(c) } : undefined}
                        onClick={() => void setK6cat(c)}
                      >{k6CategoryLabel(c)}</button>
                    ))}
                  </div>
                );
              })()}

              {s.files.length === 0 && s.runners.length === 0 ? (
                <p className="pc-dtp-empty">No matching files.</p>
              ) : (
                <ul className="pc-dtp-files">
                  {s.files.map((f) => {
                    const st = statuses[f.path];
                    return (
                      <li key={f.path} className="pc-dtp-file">
                        {st ? (
                          <button
                            type="button"
                            className={`${chipClass(st.status, st.stale)} pc-dtp-chip-button`}
                            title={
                              `${st.status} · ${st.durationMs ?? '?'}ms · ` +
                              `source=${st.source} · branch=${st.branch ?? 'none'}` +
                              (st.stale ? ' · STALE (no row on current branch)' : '') +
                              ' — click for history'
                            }
                            onClick={() => void setHistoryFile(f.path)}
                          >
                            {CHIP_LABEL[st.status]}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="pc-dtp-chip pc-dtp-chip-none pc-dtp-chip-button"
                            title="never run — click for history"
                            onClick={() => void setHistoryFile(f.path)}
                          >?</button>
                        )}
                        <code className="pc-dtp-file-path">{f.path}</code>
                        <span className="pc-dtp-file-meta">
                          {(f.sizeBytes / 1024).toFixed(1)} KB · {formatMtime(f.mtimeMs)}
                        </span>
                        <button
                          type="button"
                          className="pc-dtp-run-btn"
                          disabled={runLoading !== null}
                          onClick={() => void runVitestFile(f.path)}
                          title="Run via vitest"
                        >
                          {runLoading === f.path ? '…' : '▶'}
                        </button>
                      </li>
                    );
                  })}
                  {visibleByCategory(s.runners, k6cat).map((r, i) =>
                    r.kind === 'k6' ? (
                      <K6RunnerRow
                        key={`k6-${r.script}-${r.category ?? 'load'}`}
                        runner={r}
                        disabled={runLoading !== null}
                        onRun={(vus, duration) => void runK6(r, vus, duration)}
                      />
                    ) : (
                      <li key={`runner-${r.kind}-${i}`} className="pc-dtp-file pc-dtp-runner">
                        <code className="pc-dtp-file-path">⚙ {runnerLabel(r)}</code>
                        <span className="pc-dtp-file-meta">{r.kind}</span>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * P-010 — interactive row for a k6 runner: category badge + VUs/duration
 * overrides + Run. The VUs/duration fields are mid-edit form drafts, so they
 * live in local `useState` (per the nuqs convention — not shareable URL state);
 * empty fields fall back to the runner's declared defaults on dispatch.
 */
function K6RunnerRow({
  runner,
  disabled,
  onRun,
}: {
  runner: K6Runner;
  disabled: boolean;
  onRun: (vus: number | undefined, duration: string | undefined) => void;
}): ReactElement {
  const [vus, setVus] = useState<string>(runner.vus != null ? String(runner.vus) : '');
  const [duration, setDuration] = useState<string>(runner.duration ?? '');
  const cat = runner.category ?? 'load';
  const color = k6CategoryColor(cat);
  return (
    <li className="pc-dtp-file pc-dtp-runner pc-dtp-k6">
      <span
        className="pc-dtp-k6-cat"
        style={{ color, background: `color-mix(in srgb, ${color} 18%, transparent)` }}
      >
        {k6CategoryLabel(cat)}
      </span>
      <code className="pc-dtp-file-path">⚙ k6 {runner.script}</code>
      <label className="pc-dtp-k6-field">
        VUs
        <input
          type="number"
          min={1}
          max={500}
          className="pc-dtp-k6-input"
          aria-label={`VUs for ${runner.script}`}
          value={vus}
          placeholder={runner.vus != null ? String(runner.vus) : 'default'}
          disabled={disabled}
          onChange={(e) => setVus(e.target.value)}
        />
      </label>
      <label className="pc-dtp-k6-field">
        dur
        <input
          type="text"
          className="pc-dtp-k6-input pc-dtp-k6-input-dur"
          aria-label={`Duration for ${runner.script}`}
          value={duration}
          placeholder={runner.duration ?? 'default'}
          disabled={disabled}
          onChange={(e) => setDuration(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="pc-dtp-run-btn"
        disabled={disabled}
        onClick={() => onRun(vus ? Number(vus) : undefined, duration || undefined)}
        title={`Run k6 ${runner.script}`}
      >▶ Run</button>
    </li>
  );
}

/**
 * P-018 — per-file history sheet. Opens when a status chip is clicked;
 * reads run history via `dataSource.fetchHistory`. URL-backed via
 * `?historyFile=<path>` so reload preserves visibility.
 */
function FileHistorySheet({
  filePath,
  dataSource,
  onClose,
}: { filePath: string; dataSource: TestingDataSource; onClose: () => void }): ReactElement {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr(null);
    dataSource.fetchHistory(filePath, 20)
      .then((rs) => { if (!cancelled) setRows(rs); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [filePath, dataSource]);

  return (
    <div className="pc-dtp-sheet-backdrop" onClick={onClose}>
      <aside className="pc-dtp-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="pc-dtp-sheet-header">
          <h3>Run history</h3>
          <code className="pc-dtp-sheet-path">{filePath}</code>
          <button type="button" className="pc-dtp-sheet-close" onClick={onClose} title="Close">×</button>
        </header>
        {err && <p className="pc-dtp-sheet-error">Error: {err}</p>}
        {rows === null && !err && <p className="pc-dtp-sheet-loading">Loading…</p>}
        {rows && rows.length === 0 && <p className="pc-dtp-sheet-empty">No runs recorded for this file yet.</p>}
        {rows && rows.length > 0 && (
          <table className="pc-dtp-sheet-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Finished</th>
                <th>Duration</th>
                <th>Source</th>
                <th>Branch</th>
                <th>Framework</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`pc-dtp-sheet-row pc-dtp-sheet-row-${r.status}`}>
                  <td><span className={`pc-dtp-chip pc-dtp-chip-${r.status}`}>{CHIP_LABEL[r.status] ?? r.status}</span></td>
                  <td title={r.finishedAt ?? ''}>{r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '—'}</td>
                  <td>{r.durationMs !== null ? `${r.durationMs} ms` : '—'}</td>
                  <td>{r.source}</td>
                  <td title={r.commitSha ?? ''}>{r.branch ?? '—'}</td>
                  <td>{r.framework}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </aside>
    </div>
  );
}
