/**
 * makeHarnessTestingDataSource — the TestingDataSource the harness Tests
 * tab (<AdvTestsPanel>) injects into <TestingShell> / <DomainTestPanel>.
 *
 * Phase C / P-024 of harness-tests-tab-and-tester-promotion-2026-05-26.
 * Mirror of `adminTestingDataSource` but pointed at
 * /api/harness/:slug/testing/* and scoped to a phase.
 *
 * The harness run route is SYNCHRONOUS (one execFileSync, returns the full
 * result), whereas the DomainTestPanel contract is async (startRun → runId,
 * pollRun → snapshot). We bridge that here, client-side: startRun POSTs,
 * receives the finished result, stashes it under its runId, and pollRun
 * reads the stash. No server-side run daemon, no module-global state.
 */

import type {
  TestingDataSource,
  DomainDetail,
  FileStatusEntry,
  HealthStripData,
  HistoryRow,
  RunSnapshot,
} from '@papercusp/testing-shell';

export function makeHarnessTestingDataSource(slug: string, phase: string): TestingDataSource {
  const base = `/api/harness/${encodeURIComponent(slug)}/testing`;
  const q = `phase=${encodeURIComponent(phase)}`;
  // Closure-local run results (this dataSource instance only). Ephemeral —
  // a finished synchronous run waiting for the panel's first poll.
  const runResults = new Map<string, RunSnapshot>();

  return {
    async fetchDomain(domainId) {
      const r = await fetch(`${base}/domain-detail?domainId=${encodeURIComponent(domainId)}&${q}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as DomainDetail;
    },
    async fetchStatuses(domainId) {
      const r = await fetch(`${base}/file-status?domainId=${encodeURIComponent(domainId)}&${q}`);
      if (!r.ok) return {};
      const d = (await r.json()) as { statuses?: Record<string, FileStatusEntry> };
      return d.statuses ?? {};
    },
    async fetchHealth(domainId) {
      const r = await fetch(`${base}/health-strip?domainId=${encodeURIComponent(domainId)}&${q}`);
      if (!r.ok) return null;
      return (await r.json()) as HealthStripData;
    },
    async startRun(body) {
      const r = await fetch(`${base}/run?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const res = (await r.json()) as {
        runId: string;
        status: string;
        exitCode: number | null;
        output: string;
        finishedAt: number | null;
      };
      runResults.set(res.runId, {
        status: res.status,
        exitCode: res.exitCode,
        output: res.output,
        finishedAt: res.finishedAt,
      });
      return { runId: res.runId };
    },
    async pollRun(runId) {
      return runResults.get(runId) ?? null;
    },
    // Per-file run history for THIS hive's Tests tab (P-007/P-020). The harness
    // `run` route ingests one harness_shared.test_runs row per test file (scoped
    // by harness_slug + workspace_id); this fetches it back. Empty is a valid
    // "no runs yet" — fail-soft, never throws into the panel.
    async fetchHistory(filePath, limit) {
      const r = await fetch(
        `${base}/file-history?filePath=${encodeURIComponent(filePath)}&limit=${limit}&${q}`,
      );
      if (!r.ok) return [];
      const d = (await r.json()) as { rows?: HistoryRow[] };
      return d.rows ?? [];
    },
  };
}
