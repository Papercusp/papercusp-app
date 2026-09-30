/** Health-status oscillation and observed time back to OK. The history writer
 * records only transitions, so each critical entry is a transition, not an
 * incident; an entry with no later OK is explicitly incomplete. */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { MetaPattern } from './types';

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CRITICAL_READ = 1000;

export interface CriticalHealthEntry {
  id: string;
  panel: string;
  at: string;
  recoveryId: string | null;
  recoveryAt: string | null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function buildSystemHealthFlapPatterns(
  entries: readonly CriticalHealthEntry[],
  opts: { limit?: number; totalCritical?: number } = {},
): MetaPattern[] {
  const limit = Math.max(1, opts.limit ?? 20);
  const byPanel = new Map<string, CriticalHealthEntry[]>();
  for (const entry of entries) {
    const group = byPanel.get(entry.panel) ?? [];
    group.push(entry);
    byPanel.set(entry.panel, group);
  }
  const ranked = [...byPanel.entries()].map(([panel, rows]) => {
    const latest = [...rows].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))[0]!;
    const durations = rows.flatMap((row) => {
      if (!row.recoveryAt) return [];
      const minutes = (new Date(row.recoveryAt).getTime() - new Date(row.at).getTime()) / 60_000;
      return Number.isFinite(minutes) && minutes >= 0 ? [minutes] : [];
    });
    return { panel, rows, latest, durations, incomplete: rows.length - durations.length };
  }).sort((a, b) => b.rows.length - a.rows.length || b.incomplete - a.incomplete || a.panel.localeCompare(b.panel));
  const shown = ranked.slice(0, limit);
  const patterns: MetaPattern[] = shown.map((group) => {
    const recovered = group.durations.length;
    const duration = recovered
      ? `median ${Math.round(median(group.durations))} min to OK; longest ${Math.round(Math.max(...group.durations))} min`
      : 'no observed return to OK';
    const latestRecovery = [...group.rows]
      .filter((row) => row.recoveryId !== null)
      .sort((a, b) => (b.recoveryAt ?? '').localeCompare(a.recoveryAt ?? ''))[0];
    return {
      category: 'system-health-flap',
      ref: `health-transition:${group.latest.id}`,
      summary: `${group.panel.slice(0, 100)} entered critical ${group.rows.length} time(s) in 14d; ${group.incomplete} return(s) to OK not observed`,
      detail: `${recovered} observed return(s) to OK; ${duration}. Latest critical system_health_transitions.id=${group.latest.id} at ${group.latest.at}${latestRecovery ? `; latest OK transition id=${latestRecovery.recoveryId} at ${latestRecovery.recoveryAt}` : ''}. Counts are critical transitions, not unique incidents; an incomplete return may still have improved to warn.`,
      weight: Math.min(1, 0.5 + group.rows.length / 100 + (group.incomplete ? 0.1 : 0)),
    };
  });
  const unseen = Math.max(0, ranked.length - shown.length);
  const unread = Math.max(0, (opts.totalCritical ?? entries.length) - entries.length);
  if (unseen || unread) {
    patterns.push({
      category: 'system-health-flap',
      ref: 'health-transition:coverage-residue',
      summary: `${unseen} panel(s) and ${unread} critical transition(s) outside this corpus view`,
      detail: `The query reads at most ${MAX_CRITICAL_READ} critical transitions and renders ${limit} panel patterns. Inspect system_health_transitions for the full history.`,
      weight: 0.4,
    });
  }
  return patterns;
}

export async function buildSystemHealthFlapLane(
  opts: { workspaceId?: string; nowMs?: number; limit?: number } = {},
): Promise<MetaPattern[]> {
  try {
    const workspaceId = opts.workspaceId ?? activeWorkspaceId();
    const nowMs = opts.nowMs ?? Date.now();
    const since = new Date(nowMs - WINDOW_MS).toISOString();
    const until = new Date(nowMs).toISOString();
    const { sql } = getOrgPg();
    const rows = await sql<Array<{
      id: string; panel: string; at: string;
      recovery_id: string | null; recovery_at: string | null;
      total_critical: number | string;
    }>>`
      WITH critical AS (
        SELECT id, panel, at, count(*) OVER()::int AS total_critical
          FROM harness_shared.system_health_transitions
         WHERE workspace_id = ${workspaceId}
           AND to_status = 'crit'
           AND at >= ${since}::timestamptz
           AND at <= ${until}::timestamptz
         ORDER BY at DESC, id DESC
         LIMIT ${MAX_CRITICAL_READ}
      )
      SELECT c.id::text AS id, c.panel, c.at::text AS at,
             recovery.id::text AS recovery_id, recovery.at::text AS recovery_at,
             c.total_critical
        FROM critical c
        LEFT JOIN LATERAL (
          SELECT id, at FROM harness_shared.system_health_transitions
           WHERE workspace_id = ${workspaceId}
             AND panel = c.panel
             AND to_status = 'ok'
             AND at > c.at
             AND at <= ${until}::timestamptz
           ORDER BY at ASC, id ASC
           LIMIT 1
        ) recovery ON TRUE
       ORDER BY c.at DESC, c.id DESC`;
    return buildSystemHealthFlapPatterns(rows.map((row) => ({
      id: row.id,
      panel: row.panel,
      at: row.at,
      recoveryId: row.recovery_id,
      recoveryAt: row.recovery_at,
    })), { limit: opts.limit, totalCritical: Number(rows[0]?.total_critical ?? 0) });
  } catch {
    return [];
  }
}
