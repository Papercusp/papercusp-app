/**
 * TestingDataSource — the injected backend surface for <DomainTestPanel>.
 *
 * Phase A / P-002 of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * The panel used to hardcode `/api/admin/testing/*` fetch paths. Those
 * are now behind this interface so the same component drives two
 * backends:
 *   - /admin/testing (operator-vite)        → `adminTestingDataSource` (default)
 *   - harness Tests tab (operator)          → a harness-scoped impl (P-024)
 *
 * Wire types live here so both the interface and the component share one
 * definition. They mirror the shapes returned by the admin testing
 * routes (apps/operator/lib/endpoint-route/routes/admin/testing-*.ts).
 */

export type ChipStatus = 'pass' | 'fail' | 'skip' | 'cancelled' | 'error' | 'running';

export interface FileHit {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export type TestRunnerWire =
  | { kind: 'vitest'; filePath: string }
  | { kind: 'playwright'; filePath: string }
  // `manifestPath` (EI-1610): a standalone crate with no root Cargo.toml workspace
  // can't be reached via `-p <crate>` from the repo root; point cargo at the crate's
  // own manifest instead. Optional — omitted preserves the workspace `-p` path.
  | { kind: 'cargo'; crate: string; test?: string; manifestPath?: string }
  | { kind: 'node'; cmd: string; args?: string[]; label?: string }
  | { kind: 'shell'; cmd: string; args?: string[]; label?: string }
  | { kind: 'k6'; script: string; vus?: number; duration?: string; category?: string }
  | { kind: 'admin-suite'; suiteId: string };

export interface ResolvedSection {
  id: string;
  label: string;
  description?: string;
  files: FileHit[];
  runners: TestRunnerWire[];
}

export interface DomainDetail {
  id: string;
  label: string;
  description: string;
  tier: string;
  sections: ResolvedSection[];
  totalFiles: number;
}

export interface FileStatusEntry {
  status: ChipStatus;
  durationMs: number | null;
  finishedAt: string | null;
  source: 'ci' | 'local' | 'admin-ui';
  branch: string | null;
  stale: boolean;
}

export interface FileStatusResponse {
  domainId: string;
  branch: string | null;
  commit: string | null;
  statuses: Record<string, FileStatusEntry>;
}

export interface HealthStripData {
  domainId: string;
  branch: string | null;
  lastSuiteDurationMs: number | null;
  lastFailureFinishedAt: string | null;
  flakyFileCount: number;
  totalFilesTracked: number;
}

export interface RunSnapshot {
  status: string;
  exitCode: number | null;
  output: string;
  finishedAt: number | null;
}

export interface HistoryRow {
  id: number;
  status: ChipStatus;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  source: 'ci' | 'local' | 'admin-ui';
  branch: string | null;
  commitSha: string | null;
  framework: string;
  outputTail: string | null;
}

/**
 * Everything the panel needs from a backend. An implementation maps each
 * method to its transport (admin REST, harness REST, or a fake in tests).
 */
export interface TestingDataSource {
  fetchDomain(domainId: string): Promise<DomainDetail>;
  fetchStatuses(domainId: string): Promise<Record<string, FileStatusEntry>>;
  fetchHealth(domainId: string): Promise<HealthStripData | null>;
  /** Start a run. `body` is the run descriptor ({ runner: ... }). Returns the runId to poll. */
  startRun(body: unknown): Promise<{ runId: string }>;
  /** Poll a run by id. Null when the run can't be read (treated as transient). */
  pollRun(runId: string): Promise<RunSnapshot | null>;
  fetchHistory(filePath: string, limit: number): Promise<HistoryRow[]>;
  /**
   * Optional live-streaming run path (P-011). When a backend implements it,
   * <DomainTestPanel> prefers it over startRun+pollRun: it POSTs the run
   * descriptor, calls `onLine` for each emitted log line, and resolves with
   * the final exit code when the stream ends (`null` = unknown). `signal`
   * aborts the in-flight run (the panel passes one for the Stop button). A
   * backend that can't stream omits this and the panel falls back to polling.
   * The `readSSEStream` helper exported from the package makes implementing it
   * a one-liner for `data: <json>` log streams (the k6 live-terminal shape).
   */
  streamRun?(
    body: unknown,
    onLine: (line: string) => void,
    signal: AbortSignal,
  ): Promise<{ exitCode: number | null }>;
}

/**
 * Default implementation: the /admin/testing REST surface. Behavior is
 * byte-identical to the fetch calls the panel hardcoded before P-002.
 */
export const adminTestingDataSource: TestingDataSource = {
  async fetchDomain(domainId) {
    const r = await fetch(`/api/admin/testing/domains/${encodeURIComponent(domainId)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as DomainDetail;
  },
  async fetchStatuses(domainId) {
    const r = await fetch(`/api/admin/testing/file-status?domainId=${encodeURIComponent(domainId)}`);
    if (!r.ok) return {};
    const d = (await r.json()) as FileStatusResponse;
    return d.statuses ?? {};
  },
  async fetchHealth(domainId) {
    const r = await fetch(`/api/admin/testing/health-strip?domainId=${encodeURIComponent(domainId)}`);
    if (!r.ok) return null;
    return (await r.json()) as HealthStripData;
  },
  async startRun(body) {
    const r = await fetch('/api/admin/testing/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as { runId: string };
  },
  async pollRun(runId) {
    const r = await fetch(`/api/admin/testing/run/${encodeURIComponent(runId)}`);
    if (!r.ok) return null;
    return (await r.json()) as RunSnapshot;
  },
  async fetchHistory(filePath, limit) {
    const r = await fetch(`/api/admin/testing/file-history?filePath=${encodeURIComponent(filePath)}&limit=${limit}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = (await r.json()) as { rows?: HistoryRow[] };
    return d.rows ?? [];
  },
};
