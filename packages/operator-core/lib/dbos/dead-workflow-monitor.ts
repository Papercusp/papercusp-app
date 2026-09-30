/**
 * dead-workflow-monitor — visibility into silently-dead DBOS workflows
 * (infra-perf-reliability-audit-2026-06-19 F4).
 *
 * The audit found 185 workflows in MAX_RECOVERY_ATTEMPTS_EXCEEDED + 229 in ERROR in
 * dbos.workflow_status with ZERO alerting — e.g. embedBackfill (the mem0 cosine leg,
 * F1) and systemHealth (the health sweep itself) had been dying repeatedly and nobody
 * knew. Scheduled workflows fire fresh each tick, so a dead INSTANCE doesn't stop the
 * workflow — but a name that keeps producing dead/errored instances and few successes
 * is effectively down, and that signal was invisible.
 *
 * This sweep is READ-ONLY (it only SELECTs dbos.workflow_status) and never throws —
 * it can't affect the workflows it watches. It logs a WARN summary when recent dead/
 * errored instances exist, making the silent failures visible to the logs/curator.
 * Deliberately NOT a per-instance human escalation (the placement-watchdog flood,
 * round-1 D-005, taught us not to dump operational noise into the human channel).
 */
import { getOrgPg } from '@papercusp/db-org';

export interface DeadWorkflowRow {
  name: string | null;
  status: string;
  updated_at: number | string;
}

export interface DeadWorkflowSummary {
  /** Workflow name with the scheduled-instance suffix stripped (sched-.X-<ts> → X). */
  name: string;
  status: string;
  count: number;
  latestMs: number;
}

/**
 * Pure: roll dead-workflow rows up by (name, status). Scheduled workflows get a
 * fresh uuid + a `sched-.<name>-<ISO-timestamp>` name each fire, so we strip the
 * `sched-.` prefix and the trailing `-<timestamp>` so all instances of one workflow
 * collapse to a single row (otherwise 171 systemHealth fires look like 171 names).
 */
export function summarizeDeadWorkflows(rows: readonly DeadWorkflowRow[]): DeadWorkflowSummary[] {
  const map = new Map<string, DeadWorkflowSummary>();
  for (const r of rows) {
    const raw = r.name ?? 'unknown';
    const name = raw.replace(/^sched-\./, '').replace(/-20\d{2}-[0-9T:.\-Z]+$/, '');
    const key = `${name}\x00${r.status}`;
    const ms = Number(r.updated_at) || 0;
    const cur = map.get(key);
    if (cur) {
      cur.count += 1;
      if (ms > cur.latestMs) cur.latestMs = ms;
    } else {
      map.set(key, { name, status: r.status, count: 1, latestMs: ms });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * Read-only sweep over recently-dead workflows. Logs a WARN summary; never throws.
 * Returns the summary (also for tests / a future curator surface).
 */
export async function runDeadWorkflowMonitorOnce(opts: { sinceMs?: number; nowMs?: number } = {}): Promise<
  DeadWorkflowSummary[]
> {
  try {
    const { sql } = getOrgPg();
    const now = opts.nowMs ?? Date.now();
    const since = opts.sinceMs ?? now - 60 * 60 * 1000; // last hour
    const rows = await sql<DeadWorkflowRow[]>`
      SELECT name, status, updated_at
        FROM dbos.workflow_status
       WHERE status IN ('MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'ERROR')
         AND updated_at > ${since}
    `;
    const summary = summarizeDeadWorkflows(rows);
    if (summary.length > 0) {
      const total = summary.reduce((a, s) => a + s.count, 0);
      const top = summary
        .slice(0, 8)
        .map((s) => `${s.name}:${s.status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED' ? 'dead' : 'err'}×${s.count}`)
        .join(', ');
      console.warn(
        `[dead-workflow-monitor] ${total} dead/errored DBOS workflow instance(s) in the last hour — ${top}`,
      );
    }
    return summary;
  } catch (err) {
    console.warn(`[dead-workflow-monitor] sweep failed (non-fatal): ${(err as Error).message}`);
    return [];
  }
}
