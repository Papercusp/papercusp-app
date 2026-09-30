'use client';

import { useMemo, type CSSProperties, type ReactElement } from 'react';
import { useQueryState, parseAsBoolean, parseAsString, parseAsStringEnum } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { fmtCpuPct, resourceTitle, useResourceTotals } from './use-resource-totals';
import type {
  LiveProcessRow,
  ScheduleTaskRow,
  ScheduleTaskSummary,
  TaskResourceTotals,
} from '@papercusp/operator-core/lib/task-manager/inventory';

// `@/app/...` (not a relative path): this component is rendered from BOTH trees —
// apps/operator's own /admin/tasks page and operator-vite's route + left-rail tab —
// and the alias is the form both resolve, matching every sibling admin pane.
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { Table, type TableColumn } from '@/app/harness/Table';
// The SHARED kill control — the same component the dropdown mounts (P-023/P-024).
import KillTaskControl, { KillOutcomeProvider, useKillOutcomeHoist } from './KillTaskControl';

/**
 * /admin/tasks — the Task Manager pane
 * (task-manager-no-escape-2026-07-27, P-018).
 *
 * Deliberately modelled on /admin/schedules, because they are the same idea one
 * axis apart: that page is the inventory of everything RECURRING, this is the
 * inventory of everything RUNNING. Same posture too — nuqs-backed filters so agents
 * and deep links work.
 *
 * ⚠ As of P-019 that one-axis split no longer describes this pane, and the difference
 * is worth stating because the sentence above is still true of /admin/schedules. This
 * pane now carries BOTH kinds behind a `kind` filter — it renders the SAME
 * `collectScheduleInventory()` collection /admin/schedules does, projected through
 * `projectScheduleRows`, never re-derived. That is what makes it a task manager rather
 * than a process manager: a recurring sweep is invisible to a process view for the 99%
 * of the time it sits between fires, which is exactly how `dbos-executor-reaper` failed
 * every pass for six days unnoticed (EI-19445595198254637). /admin/schedules remains the
 * richer surface for arming/disarming; this is the one place both kinds sit side by side.
 *
 * ⚠ NO LONGER READ-ONLY (owner ask 2026-08-08, P-023/P-024): each row carries a kill
 * control. This file used to argue "a dashboard read must not be able to end someone's
 * work" — but a pane that shows a runaway and cannot stop it sends the reader to a
 * shell, and the shell is where `pkill -f` lives. `KillTaskControl` is the safe form of
 * the same capability, SHARED with the dropdown so the two cannot diverge: it posts a
 * taskId only, confirms before firing, and shows the server's refusal verbatim.
 * freeze/limit stay tool-only for now.
 *
 * Data comes from the `taskManager.inventory` SYNC query, not a bare fetch — see the
 * comment on the hook below (WI-6475). Rendered from BOTH trees: apps/operator's own
 * /admin/tasks page and operator-vite's route + left-rail Tasks tab.
 *
 * What this shows that no process table can: WHO launched each task, for which
 * work-item, under what budget, and what it is costing right now. The `unaccounted`
 * bucket at the top is the no-escape signal — processes with no live ledger row.
 * Its cgroup provenance is preserved so the pane never invents registration history.
 */

type Row = {
  taskId: string;
  parentTaskId: string | null;
  rootTaskId: string;
  class: string;
  title: string;
  state: string;
  launchedBy: string;
  workItemId: string | null;
  planSlug: string | null;
  startedAt: string;
  endedAt: string | null;
  confined: boolean;
  scopeUnit: string | null;
  rssBytes: number | null;
  peakRssBytes: number | null;
  cpuUsec: number | null;
  pids: number | null;
  memoryMaxBytes: number | null;
  deadlineAt: string | null;
  exitCode: number | null;
  exitReason: string | null;
  logPath: string | null;
};

type Live = {
  alive?: number;
  stranded?: number;
  unaccounted?: number;
  unaccountedPids?: number;
  foreign?: number;
  overdue?: number;
  degraded?: boolean;
  degradedReason?: string;
  scan?: { ownedRootExists: boolean; ownedTruncated: boolean; foreignTruncated: boolean; processes: number };
  unaccounted_?: never;
  unaccountedGroups?: { cgroupPath: string; pids: number[]; sample: string }[];
  error?: string;
};

/** Optional discriminants keep an older operator payload fail-loud: absent scope is
 * treated as unaccounted, never silently flattened into an exemption. */
type LiveProcess = Omit<LiveProcessRow, 'scope' | 'exemptReason'> & {
  scope?: LiveProcessRow['scope'];
  exemptReason?: LiveProcessRow['exemptReason'];
};

type Payload = {
  enabled: boolean;
  summary: {
    total: number;
    byState: Record<string, number>;
    byClass: Record<string, number>;
    /**
     * WI-7371 — folded over the server's OWN unfiltered fetch of the running set, so it
     * is independent of the `state`/`cls`/`includeEnded` args this component sends.
     * Optional because an older operator on `:3070` can still be serving a payload
     * without it; the header renders nothing rather than a zero in that window.
     */
    resources?: TaskResourceTotals;
  };
  live: (Live & { unaccounted?: number | { cgroupPath: string; pids: number[]; sample: string }[] }) | null;
  rows: Row[];
  liveProcesses?: LiveProcess[];
  /**
   * P-019 — the RECURRING kind. Optional for the same reason as `resources` above: an
   * older operator on `:3070` serves a payload without the key, and the section must
   * then render NOTHING rather than an empty table that asserts "nothing is scheduled".
   */
  schedules?: ScheduleTaskRow[];
  scheduleSummary?: ScheduleTaskSummary;
  scheduleError?: string | null;
};

/** Which KIND of task the pane is inventorying. `all` is the default — the pane's
 *  whole claim is that it is a task manager, not a process manager. */
export const TASK_KINDS = ['all', 'running', 'recurring'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export type ProcessBucket = 'managed' | 'unaccounted' | 'abandoned-window' | 'exempt';

/** The scan's provenance rendered as four non-overlapping public states. */
export function processBucket(p: Pick<LiveProcess, 'owned' | 'scope'>): ProcessBucket {
  if (p.owned) return 'managed';
  if (p.scope === 'abandoned-window') return 'abandoned-window';
  if (p.scope === 'exempt') return 'exempt';
  // Explicit `unaccounted` and an older payload with no discriminant both fail
  // toward visibility. Unknown must never be presented as deliberately exempt.
  return 'unaccounted';
}

export function countProcessBuckets(rows: readonly LiveProcess[]): Record<ProcessBucket, number> {
  const counts: Record<ProcessBucket, number> = {
    managed: 0,
    unaccounted: 0,
    'abandoned-window': 0,
    exempt: 0,
  };
  for (const row of rows) counts[processBucket(row)] += 1;
  return counts;
}

function processProvenance(p: LiveProcess): {
  glyph: string;
  label: string;
  detail: string;
  color: string;
} {
  switch (processBucket(p)) {
    case 'managed':
      return {
        glyph: '●',
        label: 'managed lineage',
        detail: 'inside the managed cgroup slice',
        color: 'var(--good, #4ade80)',
      };
    case 'abandoned-window':
      return {
        glyph: '◍',
        label: 'window closed',
        detail: 'started from a terminal window that is no longer present',
        color: 'var(--warn)',
      };
    case 'exempt':
      return {
        glyph: '◌',
        label: 'out of scope',
        detail: 'an allowed external lifetime; not a confirmed task escape',
        color: 'var(--muted, #888)',
      };
    case 'unaccounted':
      return {
        glyph: '○',
        label: 'unaccounted',
        detail: 'no managed task scope and no allowed external lifetime',
        color: 'var(--bad)',
      };
  }
}

// ── pure formatters (exported for tests) ────────────────────────────────────

/** Bytes → a human size. `null` renders as an em-dash, NEVER as 0 — a fabricated
 *  zero reads as a real measurement in a pane whose job is finding what eats RAM. */
export const fmtBytes = (b: number | null): string => {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

export const fmtCpu = (usec: number | null): string =>
  usec == null ? '—' : usec < 1_000_000 ? `${Math.round(usec / 1000)} ms` : `${Math.round(usec / 1_000_000)} s`;

/** ISO → a compact age. The pane cares about "how long has this been running",
 *  not the wall-clock instant it started. */
export const fmtAge = (iso: string): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
};

/**
 * A recurring row's fire-state, as three outcomes rather than two (P-019).
 *
 * ⚠ `armed` is `true | false | null` and the null is NOT a synonym for off — it means
 * NOT APPLICABLE OR UNREACHABLE. Collapsing it with `armed !== false` is a filed defect
 * (WI-6447): it renders a timer whose state could not be read as a confidently armed
 * one. On this pane that is the expensive direction, because the reader's next move
 * after "armed" is to stop looking.
 *
 * `federated` carries the same distinction one level up, per the repo convention that
 * it must be read BEFORE trusting a row's fire-state: an unfederated row's armed flag
 * came from a static manifest, not from asking the process that owns the timer. So a
 * `true` there is a DECLARATION, and is labelled as one.
 */
export const fmtArmed = (armed: boolean | null, federated: boolean): string => {
  if (armed === null) return 'unknown';
  if (!armed) return 'disarmed';
  return federated ? 'armed' : 'armed (declared)';
};

/** Colour for the three fire-states. `unknown` is deliberately NOT the good colour. */
export const armedColor = (armed: boolean | null): string => {
  if (armed === null) return 'var(--muted, #888)';
  return armed ? 'var(--good, #4ade80)' : 'var(--warn)';
};

export const stateColor = (state: string): string => {
  switch (state) {
    case 'running':
      return 'var(--accent)';
    case 'pending':
      return 'var(--warn)';
    case 'unaccounted':
      return 'var(--bad)';
    case 'stranded':
    case 'timed_out':
      return 'var(--warn)';
    case 'ended_unobserved':
      // Routine shutdown nobody watched, but systemd confirmed the scope was
      // released cleanly (D-018) — NOT an escape/anomaly, so it does not share
      // 'stranded''s warn colour. Muted, like 'foreign': informational, not alarming.
      return 'var(--muted, #888)';
    case 'foreign':
      return 'var(--muted, #888)';
    default:
      return 'var(--fg)';
  }
};

const mono: CSSProperties = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 };
const cell: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border, #2a2a2a)', ...mono };
/** Header cells stay pinned while a long task list scrolls under them. */
const head: CSSProperties = { textAlign: 'left', position: 'sticky', top: 0, background: 'var(--bg, #111)' };

/** WI-7371 — the live totals strip.
 *
 *  ⚠ A FALLBACK DOES NOT SATISFY THE css-tokens LINT (WI-7486). This comment used to
 *  read "Tokens carry fallbacks per the css-tokens lint", which is the misconception
 *  that red-pinned the gate: app/_lints/css-tokens.test.ts asserts the token is
 *  DEFINED in the operator's CSS sources, and never looks at the fallback. So the old
 *  `var(--bg-subtle, #171717)` reference failed the lint even though it rendered fine —
 *  and rendering "fine" was itself the bug the lint exists to catch, since an undefined
 *  token silently pins the strip to a non-themeable hex in every theme.
 *
 *  Use a token from the real vocabulary: --bg, --bg-2, --bg-3, --fg, --fg-dim,
 *  --fg-mute, --border, --accent, --good, --warn, --bad. This strip is a surface
 *  raised over the page, which is tier 2. */
const resourceBar: CSSProperties = {
  display: 'flex',
  gap: 18,
  alignItems: 'baseline',
  padding: '8px 12px',
  marginBottom: 12,
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 6,
  background: 'var(--bg-2, #171717)',
  ...mono,
};

/** The task table's columns. Declared once at module scope (not rebuilt per render)
 *  because every cell renderer here is a pure function of its row. */
const TASK_COLUMNS: TableColumn<Row>[] = [
  {
    key: 'state',
    header: 'state',
    headerStyle: head,
    // Colour is per-ROW (it encodes the state), so it lives in render, not cellStyle.
    render: (r) => <span style={{ color: stateColor(r.state) }}>{r.state}</span>,
    cellStyle: cell,
    // The taskId + scope unit are what you need to act on a row via `processes:*`,
    // so keep them reachable on hover rather than widening the table for them.
    cellTitle: (r) => `${r.taskId}${r.scopeUnit ? ` · ${r.scopeUnit}` : ''}`,
  },
  { key: 'class', header: 'class', headerStyle: head, render: (r) => r.class, cellStyle: cell },
  {
    key: 'title',
    header: 'title',
    headerStyle: head,
    render: (r) => r.title,
    cellStyle: { ...cell, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' },
    cellTitle: (r) => r.title,
  },
  { key: 'launchedBy', header: 'launched by', headerStyle: head, render: (r) => r.launchedBy, cellStyle: cell },
  { key: 'workItem', header: 'work-item', headerStyle: head, render: (r) => r.workItemId ?? '—', cellStyle: cell },
  { key: 'age', header: 'age', headerStyle: head, render: (r) => fmtAge(r.startedAt), cellStyle: cell },
  { key: 'rss', header: 'rss', headerStyle: head, render: (r) => fmtBytes(r.rssBytes), cellStyle: cell },
  { key: 'peak', header: 'peak', headerStyle: head, render: (r) => fmtBytes(r.peakRssBytes), cellStyle: cell },
  { key: 'cpu', header: 'cpu', headerStyle: head, render: (r) => fmtCpu(r.cpuUsec), cellStyle: cell },
  { key: 'pids', header: 'pids', headerStyle: head, render: (r) => r.pids ?? '—', cellStyle: cell },
  {
    key: 'conf',
    header: 'conf',
    headerStyle: head,
    // Dimmed when unconfined: a pid-only row is tracked but NOT cgroup-bounded.
    render: (r) => <span style={{ opacity: r.confined ? 1 : 0.5 }}>{r.confined ? 'cgroup' : 'pid'}</span>,
    cellStyle: cell,
  },
  {
    // LAST column on purpose: a destructive control does not belong under the pointer
    // on the way to reading a row, and the eye reaches it only after the provenance
    // that justifies pressing it.
    key: 'act',
    header: '',
    headerStyle: head,
    render: (r) => <KillTaskControl row={r} />,
    cellStyle: cell,
  },
];

const PROC_COLUMNS: TableColumn<LiveProcess>[] = [
  {
    key: 'owned',
    header: '',
    headerStyle: head,
    // A glyph, not a repeated word; its accessible name carries the exact state.
    render: (p) => {
      const provenance = processProvenance(p);
      return (
        <span
          aria-label={provenance.label}
          title={`${provenance.label} — ${provenance.detail}`}
          style={{ color: provenance.color }}
        >
          {provenance.glyph}
        </span>
      );
    },
    cellStyle: cell,
  },
  { key: 'pid', header: 'pid', headerStyle: head, render: (p) => p.pid, cellStyle: cell },
  {
    key: 'executable',
    header: 'executable',
    headerStyle: head,
    render: (p) => p.executable ?? '—',
    cellStyle: cell,
  },
  {
    key: 'role',
    header: 'role',
    headerStyle: head,
    render: (p) => p.role ?? '—',
    cellStyle: cell,
  },
  {
    key: 'build',
    header: 'build',
    headerStyle: head,
    render: (p) => p.build ?? '—',
    cellStyle: cell,
  },
  {
    key: 'started',
    header: 'started',
    headerStyle: head,
    render: (p) => (p.startedAt ? <span title={p.startedAt}>{fmtAge(p.startedAt)}</span> : '—'),
    cellStyle: cell,
  },
  {
    key: 'cgroup',
    header: 'cgroup',
    headerStyle: head,
    render: (p) => (
      <span title={p.cgroupPath} style={{ opacity: 0.7 }}>
        {p.cgroupPath.split('/').pop() || p.cgroupPath}
      </span>
    ),
    cellStyle: cell,
  },
];

/** P-019 — the RECURRING kind's columns. No kill control: you disarm a schedule, you
 *  do not kill it, and the disarm surface is /admin/schedules + `routines:set`. */
const SCHEDULE_COLUMNS: TableColumn<ScheduleTaskRow>[] = [
  {
    key: 'armed',
    header: '',
    headerStyle: head,
    render: (s) => (
      <span title={fmtArmed(s.armed, s.federated)} style={{ color: armedColor(s.armed) }}>
        {s.armed === null ? '○' : s.armed ? '●' : '◍'}
      </span>
    ),
    cellStyle: cell,
  },
  {
    key: 'name',
    header: 'schedule',
    headerStyle: head,
    render: (s) => (
      <span title={s.installSlug ? `${s.name} · ${s.installSlug}` : s.name}>{s.name}</span>
    ),
    cellStyle: cell,
  },
  {
    key: 'source',
    header: 'source',
    headerStyle: head,
    // The provenance column, and the reason this pane is worth reading over a bare
    // timer list: WHICH mechanism owns this — DBOS, the routines table, an in-process
    // interval, or another process entirely.
    render: (s) => (
      <span title={`${s.category} · ${s.scope}`}>
        {s.source}
        {s.process ? <span style={{ opacity: 0.6 }}> · {s.process}</span> : null}
      </span>
    ),
    cellStyle: cell,
  },
  {
    key: 'tier',
    header: 'tier',
    headerStyle: head,
    render: (s) => <span style={{ opacity: 0.75 }}>{s.tier}</span>,
    cellStyle: cell,
  },
  { key: 'cadence', header: 'cadence', headerStyle: head, render: (s) => s.cadence, cellStyle: cell },
  {
    key: 'last',
    header: 'last fire',
    headerStyle: head,
    // An em-dash, never "never" — a row we could not reach has no last-fire to report,
    // and "never" is a claim about the timer rather than about our reach.
    render: (s) => (s.lastFire ? <span title={s.lastFire}>{fmtAge(s.lastFire)} ago</span> : '—'),
    cellStyle: cell,
  },
  {
    key: 'next',
    header: 'next fire',
    headerStyle: head,
    render: (s) => (s.nextFire ? <span title={s.nextFire}>{s.nextFire.slice(11, 19)}Z</span> : '—'),
    cellStyle: cell,
  },
  {
    key: 'err',
    header: 'last error',
    headerStyle: head,
    render: (s) =>
      s.lastError ? (
        <span title={s.lastError} style={{ color: 'var(--bad)' }}>
          {s.lastError.slice(0, 40)}
        </span>
      ) : (
        <span style={{ opacity: 0.4 }}>—</span>
      ),
    cellStyle: cell,
  },
];

export default function TasksClient(): ReactElement {
  const [stateFilter, setStateFilter] = useQueryState('state', parseAsString);
  const [classFilter, setClassFilter] = useQueryState('class', parseAsString);
  const [includeEnded, setIncludeEnded] = useQueryState('ended', parseAsBoolean.withDefault(false));
  const [liveView, setLiveView] = useQueryState('live', parseAsBoolean.withDefault(true));
  // P-019. `parseAsStringEnum` per the repo's nuqs preference order, so a hand-typed
  // ?kind=nonsense falls back to the default instead of blanking both sections.
  const [kind, setKind] = useQueryState('kind', parseAsStringEnum<TaskKind>([...TASK_KINDS]).withDefault('all'));
  const showRunning = kind !== 'recurring';
  const showRecurring = kind !== 'running';

  // Reads through the sync layer, NOT a bare fetch (WI-6475). Two reasons, and the
  // first is a hard bug rather than a style point: a native webview fetch does not
  // ride the sys:http IPC bridge that injects the loopback-superuser bearer, so it
  // resolves `unverified-loopback` and the VT-gated /api/admin/tasks/inventory route
  // refuses it — the pane rendered "Load failed: HTTP 403" for the owner on every
  // desktop shell (EI-338; see endpoint-route/__tests__/auth-posture.test.ts). The
  // sync transport is `auth:'loopback'` and is admitted. Second, `fetch +
  // setInterval` is the exact hand-rolled pattern the repo bans — @papercusp/sync is
  // the one audited path, and it is what every sibling rail tab already uses.
  //
  // `staleTime` carries the old 5s poll cadence: fast enough to feel live, close
  // enough to the reconciler's 30s tick, and it does NOT scan while unmounted.
  const q = useSyncQuery<Payload>({
    queryName: 'taskManager.inventory',
    args: {
      ...(stateFilter ? { state: stateFilter } : {}),
      ...(classFilter ? { cls: classFilter } : {}),
      ...(includeEnded ? { includeEnded: true } : {}),
      ...(liveView ? { live: true } : {}),
      // P-019 — asked for only when the reader is actually looking at the recurring
      // kind. The server memoises this arm on its OWN 30s TTL (schedules are a
      // REGISTRY: they change on deploy and arm/disarm, not second to second), so the
      // 5s process cadence below does not drag two DB reads and a sibling probe along
      // with it however many panes are open.
      ...(showRecurring ? { includeSchedules: true } : {}),
    },
    staleTime: 5_000,
  });

  const data = q.data[0] ?? null;
  // A kill's answer has to outlive the row it was fired from — the row is exactly what
  // disappears when the kill lands. `notice` renders only once that row is gone.
  const { outcomeContext: killOutcomeContext, notice: killNotice } = useKillOutcomeHoist(data?.rows ?? []);
  // WI-7371 — same hook the popover uses, so the two surfaces cannot disagree (WI-6844).
  const resources = useResourceTotals(data?.summary?.resources);
  const error = q.error?.message ?? null;

  const live = data?.live ?? null;
  const liveProcs = useMemo(() => data?.liveProcesses ?? [], [data]);
  const liveProcessBuckets = useMemo(() => countProcessBuckets(liveProcs), [liveProcs]);
  // `undefined` (server did not ship the key) and `[]` (it did, and there are none) are
  // different answers — see the Payload comment. Only the second may render an empty
  // table; the first renders nothing at all.
  const schedules = data && 'schedules' in data ? (data.schedules ?? []) : null;
  const scheduleError = data?.scheduleError ?? null;
  const unaccountedGroups = useMemo(() => {
    const u = live && 'unaccounted' in live ? (live as { unaccounted?: unknown }).unaccounted : undefined;
    return Array.isArray(u) ? (u as { cgroupPath: string; pids: number[]; sample: string }[]) : [];
  }, [live]);

  // The task manager ships ON as of WI-6844 (owner-directed: "we'll make it part of
  // our standard release"), so this is no longer the "not ready yet" state it was
  // under WI-6499 — it is the kill-switch having been pulled deliberately. The flag
  // survives precisely because this subsystem intercepts every spawn seam on the box,
  // so the copy says what is CURRENTLY not happening rather than what is unfinished.
  if (data && !data.enabled) {
    return (
      <div style={{ padding: 24, ...mono, maxWidth: 620, lineHeight: 1.5 }}>
        <strong>Task manager is switched off.</strong> Someone flipped{' '}
        <code>papercusp-task-manager</code> off at <a href="/admin/features">/admin/features</a>; it ships on by
        default.
        <br />
        <br />
        While it is off nothing is being confined or ledgered — spawns run exactly as they did before the feature
        existed, and the 30s reconciler is not running. Processes started while it is off can never be adopted
        retroactively, because enrolment binds at spawn.
      </div>
    );
  }

  return (
    <div style={{ padding: 16, ...mono }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Task Manager</h1>
      <p style={{ opacity: 0.7, marginBottom: 12, maxWidth: 780 }}>
        Every task this operator launched, with the provenance a process table cannot give: who started it, for which
        work-item, under what budget, and what it costs. <strong>kill</strong> ends the whole cgroup subtree, so no
        grandchild is orphaned — freeze / limit are still the <code>processes:*</code> tools. Two kinds:{' '}
        <strong>running</strong> (what is executing now) and <strong>recurring</strong> (what is scheduled to run at
        all) — a sweep between fires is invisible to the first and only ever shows up in the second.
      </p>

      {/* WI-7371 — live totals across the RUNNING tracked set. Deliberately above the
          filters: they do NOT narrow with the class/state selectors below, because the
          server folds them over its own unfiltered fetch rather than over the rows this
          pane asked for. Both halves of that matter — a client-side sum over `rows`
          reports the filtered subset under a whole-system label, and so does a
          server-side fold over the same filtered query. */}
      {resources && (
        <div style={resourceBar} data-testid="tasks-resource-totals">
          <span title={resourceTitle(resources).mem}>
            <span style={{ opacity: 0.7 }}>memory </span>
            <strong data-testid="tasks-total-mem">{fmtBytes(resources.rssBytesTotal)}</strong>
          </span>
          <span title={resourceTitle(resources).cpu}>
            <span style={{ opacity: 0.7 }}>cpu </span>
            <strong data-testid="tasks-total-cpu">
              {resources.hasRate ? fmtCpuPct(resources.cpuBusyPct) : 'measuring…'}
            </strong>
          </span>
          <span style={{ opacity: 0.55 }}>
            {resources.rssBytesKnown}/{resources.rowsConsidered} running tasks reporting
          </span>
          {resources.truncated && (
            <span style={{ color: 'var(--warn, #d08700)' }} data-testid="tasks-total-truncated">
              ⚠ capped — lower bound
            </span>
          )}
        </div>
      )}

      {error && <div style={{ color: 'var(--bad)', marginBottom: 12 }}>Load failed: {error}</div>}

      {/* The no-escape signal, first, because it is the one thing here that means
          something is wrong rather than merely busy. */}
      {live?.degraded && (
        <div style={{ ...cell, border: '1px solid var(--warn)', marginBottom: 12 }}>
          ⚠ Live scan degraded — {live.degradedReason}. The ledger below is still shown, but nothing is being closed
          out while the scan cannot be trusted.
        </div>
      )}
      {unaccountedGroups.length > 0 && (
        <div style={{ marginBottom: 16, border: '1px solid var(--bad)', borderRadius: 4 }}>
          <div style={{ ...cell, fontWeight: 600, color: 'var(--bad)', borderBottom: 'none' }}>
            {unaccountedGroups.length} unaccounted cgroup(s) — running with no live ledger row
          </div>
          <div style={{ ...cell, opacity: 0.8 }}>
            The cgroup path shows whether a managed scope exists. This can be a lost enrolment write or descendants
            that outlived their row; the scan does not prove which.
          </div>
          {unaccountedGroups.slice(0, 8).map((g) => (
            <div key={g.cgroupPath} style={{ ...cell, opacity: 0.85 }}>
              <div>{g.cgroupPath}</div>
              <div style={{ opacity: 0.7 }}>
                {g.pids.length} pid(s) · executable {g.sample}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        {/* P-019 — FIRST control, because it selects which kind of task the rest of the
            filters even apply to. state/class narrow the RUNNING kind only. */}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          kind{' '}
          <Select
            ariaLabel="filter by task kind"
            value={kind}
            onChange={(v) => void setKind((v as TaskKind) || 'all')}
            options={[
              { value: 'all', label: 'all' },
              { value: 'running', label: 'running' },
              { value: 'recurring', label: 'recurring' },
            ]}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          state{' '}
          <Select
            ariaLabel="filter by task state"
            value={stateFilter ?? ''}
            onChange={(v) => void setStateFilter(v || null)}
            options={[
              { value: '', label: 'all' },
              ...[
                'pending',
                'running',
                'exited',
                'killed',
                'timed_out',
                'stranded',
                'ended_unobserved',
                'unaccounted',
              ].map((s) => ({
                value: s,
                label: s,
              })),
            ]}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          class{' '}
          <Select
            ariaLabel="filter by task class"
            value={classFilter ?? ''}
            onChange={(v) => void setClassFilter(v || null)}
            options={[
              { value: '', label: 'all' },
              ...Object.keys(data?.summary.byClass ?? {}).map((c) => ({ value: c, label: c })),
            ]}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Checkbox ariaLabel="include finished tasks" checked={includeEnded} onChange={(v) => void setIncludeEnded(v)} />{' '}
          include finished
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Checkbox ariaLabel="live kernel scan" checked={liveView} onChange={(v) => void setLiveView(v)} /> live kernel
          scan
        </label>
        <span style={{ opacity: 0.6, marginLeft: 'auto' }}>
          {data?.summary.total ?? 0} row(s)
          {live?.scan ? ` · ${live.scan.processes} process(es) scanned` : ''}
          {live?.foreign ? ` · ${live.foreign} foreign group(s)` : ''}
        </span>
      </div>

      {/* The empty state renders OUTSIDE the horizontally-scrolling table wrapper,
          and that placement is the whole point. The table carries a minWidth so its
          columns stay legible; inside it, a prose empty-state is laid out against
          1100px and CLIPPED in the ~365px left rail — the reader sees "Nothing enrolled
          is running right now — 115 proce" and nothing more, with the rest only
          reachable by horizontal scroll nobody thinks to try. Caught by screenshotting
          the rail (the DOM assertion passed happily: the full text IS in innerText,
          just not visible). Outside the wrapper it wraps to the pane's real width in
          both the rail and the full-width admin page. */}
      {showRunning && data && data.rows.length === 0 ? (
        // An empty table is USUALLY correct, not a fault, so lead with that — the common
        // case is simply that nothing enrolled is running this second. Enrolment binds at
        // SPAWN, so anything started before the task manager was enabled stays outside the
        // ledger for its whole life and never appears here.
        //
        // The previous copy asserted the opposite ("check the reconcile routine is armed")
        // and linked to /admin/schedules — itself 403-blanked in the desktop webview
        // (EI-18834967602055309), so its one remediation was a dead end. The System rail
        // tab shows the same routines and actually loads.
        <div style={{ ...cell, opacity: 0.8, maxWidth: 780, lineHeight: 1.5 }}>
          Nothing enrolled is running right now
          {live && typeof live.foreign === 'number' && live.foreign > 0 ? (
            <> — {live.foreign} process group(s) on this box are foreign (your own terminals, systemd units)</>
          ) : null}
          . Enrolment binds at spawn, so processes started before the task manager was enabled never appear here;
          they show up as their subtrees cycle. Tick <em>include finished</em> for completed tasks, or open the{' '}
          <strong>System</strong> tab to check the <code>task-reconcile</code> routine is armed.
        </div>
      ) : showRunning ? (
        <KillOutcomeProvider value={killOutcomeContext}>
          <div style={{ overflowX: 'auto' }}>
            <Table
              style={{ minWidth: 1180, ...mono }}
              columns={TASK_COLUMNS}
              rows={data?.rows ?? []}
              getRowKey={(r) => r.taskId}
            />
          </div>
        </KillOutcomeProvider>
      ) : null}

      {/* Renders only once the killed row has left the table — see `useKillOutcomeHoist`.
          A successful kill drops the row out of the default running-only view, taking the
          in-row chip with it, so without this the reader gets no answer at all. */}
      {killNotice}

      {/* WHAT IS ACTUALLY RUNNING.
          The ledger above answers "what did our enrolment seams record", and at any
          instant that is nearly empty — the three enrolled seams are all short-lived,
          so the pane showed 0 rows beside its own "400 process(es) scanned". Both
          numbers were right and the pane still read as broken (owner-reported).
          This section answers the question the tab actually promises. */}
      {showRunning && liveProcs.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ ...mono, fontSize: 13, marginBottom: 6 }}>
            Running now · {liveProcs.length} process(es)
            <span style={{ opacity: 0.65 }}>
              {' '}· {liveProcessBuckets.managed} managed lineage · {liveProcessBuckets.unaccounted} unaccounted ·{' '}
              {liveProcessBuckets['abandoned-window']} window closed · {liveProcessBuckets.exempt} out of scope
            </span>
          </div>
          <p style={{ opacity: 0.65, fontSize: 12, maxWidth: 780, marginBottom: 8, lineHeight: 1.45 }}>
            Managed-lineage processes run inside our owned slice. Unaccounted means the scanner found neither a
            managed task scope nor an allowed external lifetime. Window-closed and out-of-scope rows are shown for
            completeness; neither is automatically a task escape.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <Table
              style={{ minWidth: 560, ...mono }}
              columns={PROC_COLUMNS}
              rows={liveProcs}
              getRowKey={(p) => String(p.pid)}
            />
          </div>
        </div>
      )}

      {/* WHAT IS SCHEDULED TO RUN AT ALL (P-019) — the second KIND.
          The sections above are a PROCESS manager: they answer "what is executing this
          second", and everything recurring is invisible to them for the 99% of the time
          it is between fires. A sweep that has been failing every 2 minutes for six days
          looks identical to one that never existed, which is exactly how
          `dbos-executor-reaper` failed 100% of its passes undetected
          (EI-19445595198254637). These rows are the same collection /admin/schedules
          renders — projected through `collectScheduleInventory`, never re-derived, so the
          two panes cannot disagree about what exists. */}
      {showRecurring && scheduleError && (
        <div style={{ marginTop: 18, ...cell, border: '1px solid var(--warn)' }}>
          ⚠ Recurring inventory unavailable — {scheduleError}. This is NOT "nothing is scheduled": the read
          failed, so the recurring set is unknown right now.
        </div>
      )}
      {showRecurring && !scheduleError && schedules !== null && (
        <div style={{ marginTop: 18 }}>
          <div style={{ ...mono, fontSize: 13, marginBottom: 6 }}>
            Recurring · {schedules.length} scheduled task(s)
            {data?.scheduleSummary ? (
              <span style={{ opacity: 0.65 }}>
                {' '}
                ·{' '}
                {Object.entries(data.scheduleSummary.byTier)
                  .map(([t, n]) => `${n} ${t}`)
                  .join(' · ')}
              </span>
            ) : null}
          </div>
          <p style={{ opacity: 0.65, fontSize: 12, maxWidth: 780, marginBottom: 8, lineHeight: 1.45 }}>
            What is scheduled to run, across every mechanism — DBOS workflows, the routines table, in-process
            sweeps, and timers owned by sibling processes. <strong>armed (declared)</strong> means the row came
            from a static manifest rather than from asking the process that owns the timer, and{' '}
            <strong>unknown</strong> means its fire-state could not be reached — neither is a measurement of a
            live timer.
          </p>
          {schedules.length === 0 ? (
            <div style={{ ...cell, opacity: 0.8, maxWidth: 780, lineHeight: 1.5 }}>
              Nothing recurring is registered in this operator&apos;s view. That is a real answer, not a failed
              read — but note this inventory is PER-PROCESS: sweeps that run in <code>papercup-bg-host</code>{' '}
              appear only via federation, and a sibling that did not answer is reported as an unknown row rather
              than omitted.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <Table
                style={{ minWidth: 980, ...mono }}
                columns={SCHEDULE_COLUMNS}
                rows={schedules}
                getRowKey={(s) => s.key}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
