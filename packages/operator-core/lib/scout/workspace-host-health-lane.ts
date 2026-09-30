/** Managed workspace-host failures from its operation event ledger. PTY-host
 * delivery events are a different population and never enter this query. */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { MetaPattern } from './types';

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_FAILURES_READ = 500;

export interface WorkspaceHostFailureEvent {
  id: string;
  hostId: string;
  operationId: string;
  phase: string;
  occurredAt: string;
  /** A later terminal success on the same host, possibly in a new operation. */
  recoveryId: string | null;
  recoveryAt: string | null;
}

export function buildWorkspaceHostHealthPatterns(
  failures: readonly WorkspaceHostFailureEvent[],
  opts: { limit?: number; totalFailures?: number } = {},
): MetaPattern[] {
  const limit = Math.max(1, opts.limit ?? 20);
  const byPhase = new Map<string, WorkspaceHostFailureEvent[]>();
  for (const failure of failures) {
    const group = byPhase.get(failure.phase) ?? [];
    group.push(failure);
    byPhase.set(failure.phase, group);
  }
  const ranked = [...byPhase.entries()].map(([phase, rows]) => {
    const latest = [...rows].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))[0]!;
    const recovered = rows.filter((row) => row.recoveryId !== null);
    return {
      phase, rows, latest,
      operations: new Set(rows.map((row) => row.operationId)).size,
      hosts: new Set(rows.map((row) => row.hostId)).size,
      recoveredOperations: new Set(recovered.map((row) => row.operationId)).size,
      latestRecovery: [...recovered].sort((a, b) => (b.recoveryAt ?? '').localeCompare(a.recoveryAt ?? ''))[0],
    };
  }).sort((a, b) => b.operations - a.operations || b.rows.length - a.rows.length || a.phase.localeCompare(b.phase));
  const shown = ranked.slice(0, limit);
  const patterns: MetaPattern[] = shown.map((group) => ({
    category: 'workspace-host-health',
    ref: `workspace-host:event:${group.latest.id}`,
    summary: `${group.phase.slice(0, 120)}: ${group.operations} failed managed workspace-host operation(s) across ${group.hosts} host(s) in 14d`,
    detail: `${group.rows.length} failed event row(s); ${group.recoveredOperations} operation(s) had a later terminal success on the same host${group.latestRecovery ? ` (latest recovery workspace_host_events.id=${group.latestRecovery.recoveryId} at ${group.latestRecovery.recoveryAt})` : ''}. Latest failure workspace_host_events.id=${group.latest.id} at ${group.latest.occurredAt}. Later host success may be a separate operation and is not proof the failed operation itself succeeded.`,
    weight: Math.min(1, 0.55 + group.operations / 50),
  }));
  const unseen = Math.max(0, ranked.length - shown.length);
  const unreadRows = Math.max(0, (opts.totalFailures ?? failures.length) - failures.length);
  if (unseen || unreadRows) {
    patterns.push({
      category: 'workspace-host-health',
      ref: 'workspace-host:coverage-residue',
      summary: `${unseen} failure phase(s) and ${unreadRows} failure row(s) outside this corpus view`,
      detail: `The read caps at ${MAX_FAILURES_READ} event rows and renders at most ${limit} phase patterns. Query workspace_host_events for complete evidence.`,
      weight: 0.4,
    });
  }
  return patterns;
}

export async function buildWorkspaceHostHealthLane(
  opts: { workspaceId?: string; nowMs?: number; limit?: number } = {},
): Promise<MetaPattern[]> {
  try {
    const workspaceId = opts.workspaceId ?? activeWorkspaceId();
    const nowMs = opts.nowMs ?? Date.now();
    const since = new Date(nowMs - WINDOW_MS).toISOString();
    const until = new Date(nowMs).toISOString();
    const { sql } = getOrgPg();
    const rows = await sql<Array<{
      id: string; host_id: string; operation_id: string; phase: string;
      occurred_at: string; recovery_id: string | null; recovery_at: string | null;
      total_failures: number | string;
    }>>`
      WITH failures AS (
        SELECT id, host_id, operation_id, phase, occurred_at,
               count(*) OVER()::int AS total_failures
          FROM harness_shared.workspace_host_events
         WHERE workspace_id = ${workspaceId}
           AND status = 'failed'
           AND occurred_at >= ${since}::timestamptz
           AND occurred_at <= ${until}::timestamptz
         ORDER BY occurred_at DESC, id DESC
         LIMIT ${MAX_FAILURES_READ}
      )
      SELECT f.id, f.host_id, f.operation_id, f.phase,
             f.occurred_at::text AS occurred_at,
             success.id AS recovery_id, success.occurred_at::text AS recovery_at,
             f.total_failures
        FROM failures f
        LEFT JOIN LATERAL (
          SELECT e.id, e.occurred_at
            FROM harness_shared.workspace_host_events e
           WHERE e.workspace_id = ${workspaceId}
             AND e.host_id = f.host_id
             AND e.status = 'succeeded'
             AND e.phase IN ('complete', 'initialize:complete', 'destroy:complete')
             AND e.occurred_at > f.occurred_at
           ORDER BY e.occurred_at ASC, e.id ASC
           LIMIT 1
        ) success ON TRUE
       ORDER BY f.occurred_at DESC, f.id DESC`;
    return buildWorkspaceHostHealthPatterns(rows.map((row) => ({
      id: row.id,
      hostId: row.host_id,
      operationId: row.operation_id,
      phase: row.phase,
      occurredAt: row.occurred_at,
      recoveryId: row.recovery_id,
      recoveryAt: row.recovery_at,
    })), { limit: opts.limit, totalFailures: Number(rows[0]?.total_failures ?? 0) });
  } catch {
    return [];
  }
}
