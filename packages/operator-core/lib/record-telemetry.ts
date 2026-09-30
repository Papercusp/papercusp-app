/**
 * record-telemetry — server-side enqueue into the telemetry report ring.
 *
 * The diagnostic-telemetry pipeline is: a report is appended to the
 * operator-state `telemetry_reports` ring buffer (capped), and
 * `flushTelemetry()` (lib/telemetry-flush.ts) later drains it — archiving
 * every report locally AND forwarding it to PostHog when the user has opted
 * in (or on the maintainer-internal channel). The POST
 * /api/desktop/telemetry-report route is the CLIENT ingress for this buffer;
 * this helper is the SERVER-side ingress so operator-internal code (e.g. the
 * substrate admission path) can emit the same kinds without a round-trip
 * through HTTP.
 *
 * Local archival is unconditional (user-visible without consent); only
 * OFF-DEVICE forwarding is gated, in `flushTelemetry`. So enqueuing here
 * without an opt-in check is correct — it matches the flush worker's stance,
 * and an opted-out user simply never forwards. Callers on hot/critical paths
 * should treat this as best-effort (swallow rejections) — telemetry must never
 * gate the work it observes.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import type { TelemetryKind } from './telemetry-kinds';

const REPORTS_KEY = 'telemetry_reports';

/** Shared ring-buffer cap for both HTTP and server-side telemetry ingress. */
export const MAX_TELEMETRY_REPORTS = 100;

export interface StoredTelemetryReport {
  received_at: string;
  kind: string;
  app_version?: string;
  os?: string;
  payload: unknown;
}

interface ReportsState {
  reports: StoredTelemetryReport[];
}

/**
 * Append one diagnostic report to the telemetry ring buffer (newest-first,
 * capped at {@link MAX_TELEMETRY_REPORTS}). Returns the stored report.
 *
 * `receivedAt` is injectable for deterministic tests; production omits it and
 * stamps `new Date().toISOString()`.
 */
export async function recordTelemetryReport(report: {
  kind: TelemetryKind | string;
  payload: unknown;
  app_version?: string;
  os?: string;
  receivedAt?: string;
}): Promise<StoredTelemetryReport> {
  const stored: StoredTelemetryReport = {
    received_at: report.receivedAt ?? new Date().toISOString(),
    kind: report.kind,
    app_version: report.app_version,
    os: report.os,
    payload: report.payload ?? null,
  };
  const current = (await readOperatorState<ReportsState>(REPORTS_KEY)) ?? { reports: [] };
  const next: ReportsState = {
    reports: [stored, ...current.reports].slice(0, MAX_TELEMETRY_REPORTS),
  };
  await writeOperatorState(REPORTS_KEY, next);
  return stored;
}
