'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { Button } from '../../../harness/Button';
import DesktopPerfTrendPanel from './DesktopPerfTrendPanel';
import {
  ADMIN_TEST_SUITES,
  ADMIN_TEST_SUITE_IDS,
  type AdminTestCheckResult,
  type AdminTestRunSnapshot,
  type AdminTestStatus,
  type AdminTestSuiteDone,
  type AdminTestSuiteId,
} from '@papercusp/operator-core/lib/admin-test-suites-shared';

type RunSelection = AdminTestSuiteId | 'all-safe';

const SUITE_LABELS = new Map(ADMIN_TEST_SUITES.map((suite) => [suite.id, suite.label] as const));

export default function TestRunsTab() {
  const [selectedSuite, setSelectedSuite] = useQueryState(
    'suite',
    parseAsStringEnum<AdminTestSuiteId>(ADMIN_TEST_SUITE_IDS).withDefault('desktop-health'),
  );
  const [runId, setRunId] = useQueryState('run', parseAsString);
  const [snapshot, setSnapshot] = useState<AdminTestRunSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);

  const refreshSnapshot = useCallback(async (id: string) => {
    const res = await fetch(`/api/admin/testing/test-runs/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.status === 404) {
      setRunId(null);
      setSnapshot(null);
      return;
    }
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
    const next = (await res.json()) as AdminTestRunSnapshot;
    setSnapshot(next);
  }, [setRunId]);

  useEffect(() => {
    if (!runId) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        await refreshSnapshot(runId);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    if (!snapshot || snapshot.status === 'running') {
      interval = setInterval(() => { void tick(); }, 1000);
    }
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [refreshSnapshot, runId, snapshot]);

  useEffect(() => {
    if (snapshot?.status && snapshot.status !== 'running') {
      void refreshSnapshot(snapshot.runId).catch(() => {});
    }
  }, [refreshSnapshot, snapshot?.runId, snapshot?.status]);

  const running = snapshot?.status === 'running';

  const start = useCallback(async (selection: RunSelection) => {
    try {
      setError(null);
      setExpandedRowKey(null);
      if (selection !== 'all-safe') setSelectedSuite(selection);
      const res = await fetch('/api/admin/testing/test-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suiteId: selection, returnHref: window.location.href }),
      });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
      const started = await res.json() as { runId: string; snapshot: AdminTestRunSnapshot };
      setRunId(started.runId);
      setSnapshot(started.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [setRunId, setSelectedSuite]);

  const cancel = useCallback(async () => {
    if (!runId) return;
    try {
      const res = await fetch(`/api/admin/testing/test-runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
      const payload = await res.json() as { ok: true; snapshot: AdminTestRunSnapshot };
      setSnapshot(payload.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runId]);

  const groupedResults = useMemo(
    () => groupResultsBySuite(snapshot?.results ?? []),
    [snapshot?.results],
  );

  const suiteCards = useMemo(() => ADMIN_TEST_SUITES.map((suite) => ({
    ...suite,
    summary: snapshot?.summaries[suite.id] as AdminTestSuiteDone | undefined,
    progress: snapshot?.progressBySuite[suite.id],
    results: groupedResults[suite.id] ?? [],
  })), [groupedResults, snapshot?.progressBySuite, snapshot?.summaries]);

  const activeSelection = snapshot?.selection ?? null;
  const logs = snapshot?.logs ?? [];

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">Test Runs</h1>
          <p className="pc-test-tab-intro">
            Authoritative desktop-first suite runner. Use this tab to orchestrate the existing testing tools, capture expected-vs-actual outcomes,
            and surface missing coverage before doing performance work.
          </p>
        </div>
        <div className="pc-test-card-row">
          {!running ? (
            <>
              <Button variant="primary" onClick={() => void start(selectedSuite)}>Run selected suite</Button>
              <Button variant="ghost" onClick={() => void start('all-safe')}>Run all safe suites</Button>
            </>
          ) : (
            <Button variant="destructive" onClick={() => void cancel()}>Stop run</Button>
          )}
        </div>
      </header>

      <div className="pc-test-suite-grid">
        {suiteCards.map((suite) => {
          const isSelected = selectedSuite === suite.id;
          return (
            <div
              key={suite.id}
              role="button"
              tabIndex={0}
              className={`pc-test-suite-card${isSelected ? ' is-selected' : ''}`}
              onClick={() => setSelectedSuite(suite.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelectedSuite(suite.id);
                }
              }}
            >
              <div className="pc-test-suite-head">
                <div>
                  <div className="pc-test-suite-title">{suite.label}</div>
                  <div className="pc-test-suite-hint">{suite.hint}</div>
                </div>
                <span className={`pc-test-badge ${suite.safeDefault ? 'is-good' : 'is-needs'}`}>
                  {suite.safeDefault ? 'safe default' : 'extended'}
                </span>
              </div>
              <p className="pc-test-suite-desc">{suite.description}</p>
              <div className="pc-test-suite-meta">
                <span>{suite.runner}</span>
                <span>~{suite.estimatedSeconds}s</span>
                <span>{suite.tags.join(' · ')}</span>
              </div>
              {suite.summary ? (
                <div className="pc-test-card-row" style={{ marginTop: 8 }}>
                  <span className={`pc-test-badge ${suite.summary.status === 'fail' ? 'is-poor' : suite.summary.status === 'warn' ? 'is-needs' : suite.summary.status === 'pass' ? 'is-good' : 'is-muted'}`}>
                    {suite.summary.status}
                  </span>
                  <span className="pc-test-badge is-muted">{formatCounts(suite.summary.counts)}</span>
                  <span className="pc-test-badge is-muted">{formatMs(suite.summary.durationMs)}</span>
                </div>
              ) : null}
              {suite.progress ? (
                <div className="pc-test-suite-progress">
                  Running {suite.progress.index}/{Object.keys(snapshot?.progressBySuite ?? {}).length || suite.progress.total}: {suite.progress.label}
                </div>
              ) : null}
              <div className="pc-test-suite-actions">
                <Button variant="ghost" onClick={(event) => {
                  event.stopPropagation();
                  void start(suite.id);
                }} disabled={running}>
                  Run this suite
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="pc-test-card">
        <h2 className="pc-test-card-title">Current selection</h2>
        <p style={{ margin: '0 0 8px', color: 'var(--fg-mute)' }}>
          <strong>{SUITE_LABELS.get(selectedSuite) ?? selectedSuite}</strong>
          {activeSelection ? <> · last trigger: <code>{activeSelection}</code></> : null}
          {running ? <> · running now</> : snapshot?.finishedAt ? <> · last finished {new Date(snapshot.finishedAt).toLocaleTimeString()}</> : null}
        </p>
        <p style={{ margin: 0, color: 'var(--fg-mute)', fontSize: 12 }}>
          If a performance metric matters and it is not captured here, the fix is to add that test to a suite — not to run ad-hoc diagnostics outside the framework.
        </p>
      </div>

      {error ? <div className="pc-test-card is-bad" style={{ padding: 16 }}>Error: {error}</div> : null}

      {selectedSuite === 'desktop-performance' ? (
        // P-010: persisted per-run measures with deltas. Refetches when a run
        // finishes (finishedAt changes) so a fresh desktop-performance run's
        // measures appear without a manual refresh.
        <DesktopPerfTrendPanel refreshSignal={snapshot?.finishedAt ?? 0} />
      ) : null}

      {suiteCards.filter((suite) => suite.results.length > 0 || suite.summary).map((suite) => (
        <SuiteResultsCard
          key={suite.id}
          suite={suite}
          rows={suite.results}
          expandedRowKey={expandedRowKey}
          setExpandedRowKey={setExpandedRowKey}
        />
      ))}

      <div className="pc-test-card">
        <h2 className="pc-test-card-title">Live log</h2>
        {logs.length === 0 ? (
          <div className="pc-test-loading">No run started yet.</div>
        ) : (
          <div className="pc-test-run-log">
            {logs.map((entry) => (
              <div key={entry.id} className={`pc-test-run-log-line is-${entry.level}`}>
                <span className="pc-test-run-log-ts">{new Date(entry.ts).toLocaleTimeString()}</span>
                <span className="pc-test-run-log-suite">[{entry.suiteId === 'system' ? 'system' : SUITE_LABELS.get(entry.suiteId) ?? entry.suiteId}]</span>
                <span>{entry.line}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function SuiteResultsCard({
  suite,
  rows,
  expandedRowKey,
  setExpandedRowKey,
}: {
  suite: {
    id: AdminTestSuiteId;
    label: string;
    hint: string;
    description: string;
    runner: 'tauri' | 'host' | 'mixed';
    estimatedSeconds: number;
    safeDefault: boolean;
    tags: string[];
    summary?: AdminTestSuiteDone;
    progress?: AdminTestRunSnapshot['progressBySuite'][string];
  };
  rows: AdminTestCheckResult[];
  expandedRowKey: string | null;
  setExpandedRowKey: (key: string | null) => void;
}) {
  const columns = useMemo<ColumnDef<AdminTestCheckResult>[]>(() => [
    {
      key: 'check',
      header: 'Check',
      width: 1.4,
      render: ({ row }) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.label}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-mute)' }}><code>{row.id}</code></div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 0.7,
      render: ({ row }) => <StatusBadge status={row.status} />,
    },
    {
      key: 'expected',
      header: 'Expected',
      width: 1.6,
      render: ({ row }) => <div className="pc-test-result-copy">{row.expected}</div>,
    },
    {
      key: 'actual',
      header: 'Actual',
      width: 1.8,
      render: ({ row }) => <div className="pc-test-result-copy">{row.actual}</div>,
    },
    {
      key: 'duration',
      header: 'Duration',
      width: 0.6,
      align: 'right',
      render: ({ row }) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatMs(row.durationMs)}</span>,
    },
  ], []);

  return (
    <div className="pc-test-card">
      <div className="pc-test-card-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 className="pc-test-card-title" style={{ marginBottom: 4 }}>{suite.label}</h2>
          <p style={{ margin: 0, color: 'var(--fg-mute)', fontSize: 12 }}>{suite.description}</p>
        </div>
        {suite.summary ? (
          <div className="pc-test-card-row" style={{ justifyContent: 'flex-end' }}>
            <StatusBadge status={suite.summary.status} />
            <span className="pc-test-badge is-muted">{formatCounts(suite.summary.counts)}</span>
            <span className="pc-test-badge is-muted">{formatMs(suite.summary.durationMs)}</span>
          </div>
        ) : null}
      </div>
      <RichGrid<AdminTestCheckResult>
        rows={rows}
        columns={columns}
        getRowId={(row) => `${row.suiteId}:${row.id}`}
        onRowClick={(row) => setExpandedRowKey(expandedRowKey === `${row.suiteId}:${row.id}` ? null : `${row.suiteId}:${row.id}`)}
        expandedRowKey={expandedRowKey ?? undefined}
        renderExpandedRow={(row) => (
          <div className="pc-test-result-details">
            <strong>Actual vs expected details</strong>
            <div style={{ marginTop: 6 }}><strong>Expected:</strong> {row.expected}</div>
            <div style={{ marginTop: 6 }}><strong>Actual:</strong> {row.actual}</div>
            {row.details?.length ? (
              <ul style={{ margin: '8px 0 0 18px' }}>
                {row.details.map((detail, idx) => <li key={idx}>{detail}</li>)}
              </ul>
            ) : (
              <div style={{ marginTop: 6, color: 'var(--fg-mute)' }}>No extra details recorded.</div>
            )}
          </div>
        )}
        inline
      />
    </div>
  );
}

function StatusBadge({ status }: { status: AdminTestStatus }) {
  const cls = status === 'pass' ? 'is-good' : status === 'warn' ? 'is-needs' : status === 'fail' ? 'is-poor' : 'is-muted';
  return <span className={`pc-test-badge ${cls}`}>{status}</span>;
}

/** Pure: one-line pass/warn/fail/skip tally. Exported for tests. */
export function formatCounts(counts: Record<AdminTestStatus, number>): string {
  return `${counts.pass} pass · ${counts.warn} warn · ${counts.fail} fail · ${counts.skip} skip`;
}

/** Pure: human duration — "0ms" for non-positive, ms under a second, "N.Ns" past. Exported for tests. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Pure: group check results by suiteId, each group sorted by label
 * (localeCompare). Mirrors the component's `groupedResults` memo. Exported for
 * tests.
 */
export function groupResultsBySuite(
  results: AdminTestCheckResult[],
): Record<string, AdminTestCheckResult[]> {
  const grouped: Record<string, AdminTestCheckResult[]> = {};
  for (const result of results) {
    (grouped[result.suiteId] ??= []).push(result);
  }
  for (const suiteId of Object.keys(grouped)) {
    grouped[suiteId].sort((a, b) => a.label.localeCompare(b.label));
  }
  return grouped;
}
