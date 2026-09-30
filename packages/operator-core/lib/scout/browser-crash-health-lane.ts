/** Redacted browser render-boundary crashes from the existing local telemetry
 * archive. The hourly telemetry flush populates this table independent of
 * off-device consent; PostHog forwarding keeps its own opt-in gate. */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { MetaPattern } from './types';

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_GROUPS_READ = 100;

export interface BrowserCrashAggregate {
  fingerprint: string;
  boundary: string;
  errorType: string;
  component: string;
  tab: string;
  rows: number;
  latestId: string;
  latestAt: string;
}

function valid(row: BrowserCrashAggregate): boolean {
  return (
    (row.boundary === 'route' || row.boundary === 'adv-tab') &&
    ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError'].includes(row.errorType) &&
    /^(?:unknown|[A-Za-z][A-Za-z0-9_.$-]{0,79})$/.test(row.component) &&
    /^[a-z][a-z0-9-]{0,39}$/.test(row.tab) &&
    row.fingerprint === `${row.boundary}:${row.errorType}:${row.component}:${row.tab}`
  );
}

export function buildBrowserCrashHealthPatterns(
  aggregates: readonly BrowserCrashAggregate[],
  opts: { limit?: number; totalGroups?: number } = {},
): MetaPattern[] {
  const limit = Math.max(1, opts.limit ?? 20);
  const ranked = aggregates.filter(valid).sort((a, b) => b.rows - a.rows || a.fingerprint.localeCompare(b.fingerprint));
  const shown = ranked.slice(0, limit);
  const patterns: MetaPattern[] = shown.map((row) => ({
    category: 'browser-crash-health',
    ref: `telemetry-report:${row.latestId}`,
    summary: `${row.rows} redacted ${row.errorType} render crash report(s) at ${row.boundary}${row.boundary === 'adv-tab' ? `/${row.tab}` : ''} (${row.component}) in 14d`,
    detail: `Latest local telemetry_reports_archive.id=${row.latestId} at ${row.latestAt}; fingerprint ${row.fingerprint}. Counts are deduplicated report rows, not all failed renders. No raw message, stack, props, or URL is stored in this signal.`,
    weight: Math.min(1, 0.55 + row.rows / 50),
  }));
  const unseen = Math.max(0, ranked.length - shown.length);
  const unread = Math.max(0, (opts.totalGroups ?? aggregates.length) - aggregates.length);
  if (unseen || unread) {
    patterns.push({
      category: 'browser-crash-health',
      ref: 'browser-crash:coverage-residue',
      summary: `${unseen + unread} browser crash fingerprint(s) outside this corpus view`,
      detail: `${unseen} below the ${limit}-pattern cap; ${unread} outside the ${MAX_GROUPS_READ}-group database read cap.`,
      weight: 0.4,
    });
  }
  return patterns;
}

export async function buildBrowserCrashHealthLane(
  opts: { workspaceId?: string; nowMs?: number; limit?: number } = {},
): Promise<MetaPattern[]> {
  try {
    const workspaceId = opts.workspaceId ?? activeWorkspaceId();
    const nowMs = opts.nowMs ?? Date.now();
    const since = new Date(nowMs - WINDOW_MS).toISOString();
    const until = new Date(nowMs).toISOString();
    const { sql } = getOrgPg();
    const rows = await sql<Array<{
      fingerprint: string; boundary: string; error_type: string;
      component: string; tab: string; rows: number | string;
      latest_id: string; latest_at: string; total_groups: number | string;
    }>>`
      WITH grouped AS (
        SELECT payload->>'fingerprint' AS fingerprint,
               payload->>'boundary' AS boundary,
               payload->>'errorType' AS error_type,
               payload->>'component' AS component,
               payload->>'tab' AS tab,
               count(*)::int AS rows,
               ((array_agg(id ORDER BY received_at DESC, id DESC))[1])::text AS latest_id,
               max(received_at)::text AS latest_at
          FROM harness_shared.telemetry_reports_archive
         WHERE workspace_id = ${workspaceId}
           AND kind = 'crash'
           AND payload->>'source' = 'render-boundary'
           AND received_at >= ${since}::timestamptz
           AND received_at <= ${until}::timestamptz
         GROUP BY 1,2,3,4,5
      )
      SELECT *, count(*) OVER()::int AS total_groups FROM grouped
       ORDER BY rows DESC, fingerprint ASC
       LIMIT ${MAX_GROUPS_READ}`;
    return buildBrowserCrashHealthPatterns(rows.map((row) => ({
      fingerprint: row.fingerprint,
      boundary: row.boundary,
      errorType: row.error_type,
      component: row.component,
      tab: row.tab,
      rows: Number(row.rows),
      latestId: row.latest_id,
      latestAt: row.latest_at,
    })), { limit: opts.limit, totalGroups: Number(rows[0]?.total_groups ?? 0) });
  } catch {
    return [];
  }
}
