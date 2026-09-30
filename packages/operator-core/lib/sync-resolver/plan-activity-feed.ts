/**
 * planActivity.list — the PlanDashboard "Recent activity" feed: merged plan
 * EDITS + work-item PROGRESS rows for ONE plan, newest first
 * (plan-visibility-revamp-2026-08-23 P-004; consumed by the option-C dashboard,
 * P-003/D-001/D-002).
 *
 * Two bounded legs, merged and re-sorted here:
 *   - EDITS: `harness_shared.plan_revisions` — one row per plan-doc revision
 *     (content, ## Now, decisions, item flips). `rationale` (when the writer
 *     supplied one) is the human-readable line; else a generic "Plan edited".
 *     `created_at` is epoch ms (bigint).
 *   - WORK: `harness_shared.work_items` where `source_plan_slug` = the plan —
 *     one row per work-item, stamped with its LATEST movement
 *     (GREATEST(updated_ts, last_progress_at), epoch ms — the same clock
 *     planWorkActivity.list aggregates). This is per-ITEM recency, not a
 *     per-event ledger: checkpoints overwrite in place, so the item's latest
 *     state is what the store can actually answer. Observation-lane rows are
 *     excluded for the reason plan-work-activity.ts documents.
 *
 * Rows carry a `ref` (work-item id / `rev:<seq>`) so the UI can deep-link, and
 * `who` (revision author / current holder) for the artboard's right-hand column.
 *
 * Invalidation: full-bust from BOTH backing tables via table-to-query-names
 * (keyed by planSlug — the plan_revisions trigger carries no plan_slug arg
 * mapping for scoping here, and work_items busts coarsely by design). Declared
 * as backingTables on the registry entry for the coverage guard.
 */
import type { Sql } from 'postgres';

/** One merged activity row. */
export interface PlanActivityRow {
  /** 'edit' = a plan-doc revision; 'work' = a work-item's latest movement. */
  kind: 'edit' | 'work';
  /** Epoch ms of the event (revision created_at / item's latest movement). */
  tsMs: number;
  /** Human-readable line (revision rationale / item id + status + title). */
  text: string;
  /** Who moved it (revision author_id / the item's current holder), if known. */
  who?: string;
  /** Deep-linkable ref: the work-item id, or `rev:<seq>` for an edit. */
  ref?: string;
}

/** Bounds: default rows returned after the merge; per-leg fetch is the same. */
export const PLAN_ACTIVITY_DEFAULT_LIMIT = 30;
export const PLAN_ACTIVITY_MAX_LIMIT = 100;

function coerceMs(v: unknown): number | null {
  if (v == null) return null;
  const n =
    typeof v === 'bigint'
      ? Number(v)
      : typeof v === 'number'
        ? v
        : typeof v === 'string' && v.trim() !== ''
          ? Number(v)
          : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanLine(v: unknown, max = 200): string {
  if (typeof v !== 'string') return '';
  const line = v.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

interface EditRowish {
  seq?: unknown;
  rationale?: unknown;
  author_id?: unknown;
  created_at?: unknown;
}

interface WorkRowish {
  feature_id?: unknown;
  title?: unknown;
  status?: unknown;
  taken_by?: unknown;
  ts_ms?: unknown;
}

/** Map raw revision rows → activity rows. Pure — unit-tested seam. */
export function mapEditRows(rows: readonly unknown[]): PlanActivityRow[] {
  const out: PlanActivityRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as EditRowish;
    const tsMs = coerceMs(r.created_at);
    if (tsMs === null) continue;
    const seq = typeof r.seq === 'number' ? r.seq : coerceMs(r.seq);
    const rationale = cleanLine(r.rationale);
    const row: PlanActivityRow = {
      kind: 'edit',
      tsMs,
      text: rationale || `Plan edited${seq != null ? ` (rev ${seq})` : ''}`,
    };
    const who = cleanLine(r.author_id, 80);
    if (who) row.who = who;
    if (seq != null) row.ref = `rev:${seq}`;
    out.push(row);
  }
  return out;
}

/** Map raw work-item rows → activity rows. Pure — unit-tested seam. */
export function mapWorkRows(rows: readonly unknown[]): PlanActivityRow[] {
  const out: PlanActivityRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as WorkRowish;
    const tsMs = coerceMs(r.ts_ms);
    const id = cleanLine(r.feature_id, 40);
    if (tsMs === null || !id) continue;
    const status = cleanLine(r.status, 30);
    const title = cleanLine(r.title, 140);
    const row: PlanActivityRow = {
      kind: 'work',
      tsMs,
      text: `${id}${status ? ` ${status}` : ''}${title ? ` — ${title}` : ''}`,
      ref: id,
    };
    const who = cleanLine(r.taken_by, 80);
    if (who) row.who = who;
    out.push(row);
  }
  return out;
}

/** Merge both legs newest-first and cap. Pure — unit-tested seam. */
export function mergeActivityRows(
  edits: readonly PlanActivityRow[],
  work: readonly PlanActivityRow[],
  limit: number,
): PlanActivityRow[] {
  return [...edits, ...work].sort((a, b) => b.tsMs - a.tsMs).slice(0, limit);
}

/** The two bounded reads + merge. */
export async function listPlanActivity(opts: {
  planSlug: string;
  workspaceId?: string | null;
  limit?: number;
  sql?: Sql;
}): Promise<PlanActivityRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? PLAN_ACTIVITY_DEFAULT_LIMIT, PLAN_ACTIVITY_MAX_LIMIT));
  let sql = opts.sql;
  let workspaceId = opts.workspaceId ?? null;
  if (!sql) {
    const { getOrgPg } = await import('@papercusp/db-org');
    sql = getOrgPg().sql;
  }
  if (workspaceId == null || workspaceId === '') {
    const { activeWorkspaceId } = await import('../workspace-registry');
    workspaceId = activeWorkspaceId();
  }
  const [editRows, workRows] = await Promise.all([
    sql.unsafe(
      `SELECT seq, rationale, author_id, created_at
         FROM harness_shared.plan_revisions
        WHERE workspace_id = $1 AND plan_slug = $2
        ORDER BY seq DESC
        LIMIT $3`,
      [workspaceId, opts.planSlug, limit],
    ) as unknown as Promise<unknown[]>,
    sql.unsafe(
      `SELECT feature_id, title, status, taken_by,
              GREATEST(updated_ts, (extract(epoch FROM last_progress_at) * 1000)::bigint) AS ts_ms
         FROM harness_shared.work_items
        WHERE workspace_id = $1 AND source_plan_slug = $2
          AND lane IS DISTINCT FROM 'observation'
        ORDER BY ts_ms DESC NULLS LAST
        LIMIT $3`,
      [workspaceId, opts.planSlug, limit],
    ) as unknown as Promise<unknown[]>,
  ]);
  return mergeActivityRows(mapEditRows(editRows), mapWorkRows(workRows), limit);
}
