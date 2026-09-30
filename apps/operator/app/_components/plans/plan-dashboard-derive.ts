/**
 * plan-dashboard-derive — pure derivations behind PlanDashboard's direction-A
 * ("mission control") layout (plan-dashboard-mission-control-2026-08-31 P-001).
 *
 * Everything here is presentation-shaping over data the surface ALREADY
 * fetches (plans.get full mode / planActivity.list) — no fetching, no React.
 * Kept out of PlanDashboard.tsx so the collapse/grouping rules are unit-testable
 * without the component's heavy import graph (launchAgent, css, modals).
 */
import type { PlanDecision, PlanItem } from '@/app/admin/plans/plans-api';

/** One planActivity.list wire row (P-004 — PlanActivityRow). Declared here so
 *  both the component and these derivations share one shape. */
export interface PlanActivityFeedRow {
  kind?: 'edit' | 'work';
  tsMs?: number;
  text?: string;
  who?: string;
  ref?: string;
}

/* ── Item status counts (the segmented progress band) ──────────────────── */

export interface ItemStatusCounts {
  done: number;
  wip: number;
  todo: number;
  /** blocked + needs-human — the "someone must look" bucket. */
  attention: number;
  dropped: number;
  total: number;
}

/** Counts by `effectiveStatus`, same field progressOfItems reads (P-003 of the
 *  2026-08-30 windowing fix): every item counts toward total, done means
 *  `effectiveStatus === 'done'` — the band cannot disagree with the header. */
export function statusCountsOf(
  items: Array<Pick<PlanItem, 'effectiveStatus'>> | undefined,
): ItemStatusCounts | null {
  if (!items || items.length === 0) return null;
  const c: ItemStatusCounts = { done: 0, wip: 0, todo: 0, attention: 0, dropped: 0, total: items.length };
  for (const it of items) {
    switch (it.effectiveStatus) {
      case 'done': c.done += 1; break;
      case 'wip': c.wip += 1; break;
      case 'blocked':
      case 'needs-human': c.attention += 1; break;
      case 'dropped': c.dropped += 1; break;
      default: c.todo += 1; break;
    }
  }
  return c;
}

/* ── Item grouping (the left substance column) ─────────────────────────── */

export type PlanItemGroupKey = 'attention' | 'wip' | 'todo' | 'doneish';

export interface PlanItemGroup {
  key: PlanItemGroupKey;
  label: string;
  items: PlanItem[];
}

/** Direction-A grouping, most-actionable first: needs-attention (blocked /
 *  needs-human), in progress, up next, then done+dropped. Empty groups are
 *  omitted; within a group the plan's own document order is preserved. */
export function groupPlanItems(items: PlanItem[] | undefined): PlanItemGroup[] {
  const buckets: Record<PlanItemGroupKey, PlanItem[]> = {
    attention: [], wip: [], todo: [], doneish: [],
  };
  for (const it of items ?? []) {
    switch (it.effectiveStatus) {
      case 'blocked':
      case 'needs-human': buckets.attention.push(it); break;
      case 'wip': buckets.wip.push(it); break;
      case 'done':
      case 'dropped': buckets.doneish.push(it); break;
      default: buckets.todo.push(it); break;
    }
  }
  const labels: Record<PlanItemGroupKey, string> = {
    attention: 'Needs attention',
    wip: 'In progress',
    todo: 'Up next',
    doneish: 'Done',
  };
  const out: PlanItemGroup[] = [];
  for (const key of ['attention', 'wip', 'todo', 'doneish'] as const) {
    if (buckets[key].length > 0) out.push({ key, label: labels[key], items: buckets[key] });
  }
  return out;
}

/* ── Decisions (the rail card) ─────────────────────────────────────────── */

/** Newest-N decisions by numeric D-id (document order is oldest-first; the
 *  rail wants the latest rulings). Non-numeric ids sort last, stably. */
export function newestDecisions(
  decisions: PlanDecision[] | undefined,
  n: number,
): PlanDecision[] {
  const numOf = (id: string): number => {
    const m = /^D-(\d+)$/.exec(id);
    return m ? Number(m[1]) : -1;
  };
  return [...(decisions ?? [])]
    .sort((a, b) => numOf(b.id) - numOf(a.id))
    .slice(0, Math.max(0, n));
}

/* ── Activity collapse (the rail feed) ─────────────────────────────────── */

/**
 * The rendered shape of one feed slot after noise collapse:
 *  - `row`  — a work row, or a SINGLETON generic edit (kept verbatim);
 *  - `note` — an edit row whose text is a substantive rationale (a checkpoint
 *    note / handoff note), promoted to a card;
 *  - `run`  — ≥2 CONSECUTIVE generic "Plan edited (rev N)" rows by the SAME
 *    author, folded into one line with the rev + time range.
 */
export type PlanActivityEntry =
  | { type: 'row'; row: PlanActivityFeedRow }
  | { type: 'note'; row: PlanActivityFeedRow }
  | {
      type: 'run';
      count: number;
      who?: string;
      /** rev range, when the refs parsed (`rev:<seq>`); null otherwise. */
      revLo: number | null;
      revHi: number | null;
      /** Feed is newest-first: newest = the run's first row, oldest = its last. */
      tsNewestMs: number | null;
      tsOldestMs: number | null;
    };

/** The resolver's own generic-edit line (plan-activity-feed.ts mapEditRows:
 *  `rationale || "Plan edited (rev N)"`) — a rationale is free text, so ONLY
 *  the exact generated shape counts as noise. */
const GENERIC_EDIT_RE = /^Plan edited(?: \(rev \d+\))?$/;

function revOf(ref: string | undefined): number | null {
  const m = /^rev:(\d+)$/.exec(ref ?? '');
  return m ? Number(m[1]) : null;
}

interface Run {
  who: string;
  rows: PlanActivityFeedRow[];
}

export function collapsePlanActivity(
  rows: readonly PlanActivityFeedRow[] | undefined,
): PlanActivityEntry[] {
  const out: PlanActivityEntry[] = [];
  let run: Run | null = null;

  const flush = () => {
    if (!run) return;
    if (run.rows.length === 1) {
      out.push({ type: 'row', row: run.rows[0]! });
    } else {
      const revs = run.rows.map((r) => revOf(r.ref)).filter((v): v is number => v !== null);
      const times = run.rows
        .map((r) => (typeof r.tsMs === 'number' ? r.tsMs : null))
        .filter((v): v is number => v !== null);
      out.push({
        type: 'run',
        count: run.rows.length,
        ...(run.who ? { who: run.who } : {}),
        revLo: revs.length ? Math.min(...revs) : null,
        revHi: revs.length ? Math.max(...revs) : null,
        tsNewestMs: times.length ? Math.max(...times) : null,
        tsOldestMs: times.length ? Math.min(...times) : null,
      });
    }
    run = null;
  };

  for (const row of rows ?? []) {
    const generic = row?.kind === 'edit' && GENERIC_EDIT_RE.test(row.text ?? '');
    if (generic) {
      const who = row.who ?? '';
      if (run && run.who === who) {
        run.rows.push(row);
      } else {
        flush();
        run = { who, rows: [row] };
      }
      continue;
    }
    flush();
    if (row?.kind === 'edit') out.push({ type: 'note', row });
    else out.push({ type: 'row', row });
  }
  flush();
  return out;
}
