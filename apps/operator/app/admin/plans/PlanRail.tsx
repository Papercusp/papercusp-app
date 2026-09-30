'use client';

/**
 * Plan rail — the left-hand list of every plan, fed by usePlanList.
 *
 * P-102 deliverable. Sort: the `pSort` nuqs key selects an order from
 * plan-sorting.ts (PlanFilters owns the write); the default is the
 * smart order — live buckets first, then by `updated` desc.
 * Search input (managed by PlansClient via the `q` nuqs key) filters
 * rows client-side over title + slug; full cross-plan search is P-104.
 *
 * Per-row visuals: title, slug (secondary), plan status pill,
 * item counts by effectiveStatus (wip / needs-human / blocked / todo /
 * done / dropped), the `## Now` Next: line, last-updated date.
 */

import { useQueryState, parseAsArrayOf, parseAsBoolean, parseAsString, parseAsStringEnum } from 'nuqs';
import { forwardRef, memo, useImperativeHandle, useMemo, useCallback, useState, useRef } from 'react';
import { Play, Pause, Clock, Repeat, CalendarClock } from 'lucide-react';
import { AuthorBadge } from '../../_components/AuthorBadge';
import {
  bucketOf,
  startPlan,
  pausePlan,
  setPlanPriority,
  type AsyncResult,
  type PlanListRow,
  type ItemStatus,
  type PlanStatus,
  type PlanBucket,
  PLAN_BUCKETS,
  planTriggerSourceLabel,
  usePlanViewerEmail,
} from './plans-api';
import { type DateWindow } from './PlanFilters';
import {
  applyPlanFilters,
  OWNER_VIEWS,
  PLAN_TRIGGER_FILTERS,
  type OwnerView,
  type PlanTriggerFilter,
} from './plan-filtering';
import { comparePlans, PLAN_SORT_IDS, type PlanSort } from './plan-sorting';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';
import { useFlag } from '@/lib/flag-hooks';
import { FLAGS } from '@papercusp/flags';

/** Imperative handle PlansClient uses for J/K keyboard navigation. */
export interface PlanRailHandle {
  /** Move selection to the next visible plan (or first if none selected). */
  next: () => void;
  /** Move selection to the previous visible plan (or last if none selected). */
  prev: () => void;
}

// Derived from PLAN_BUCKETS rather than re-listed: a hand-typed copy silently
// drops any bucket added later, so the new one is unfilterable while every
// other surface shows it (P-004 added `awaiting`).
const BUCKET_FILTER_VALUES: PlanBucket[] = PLAN_BUCKETS.map((b) => b.id);

const COUNT_ORDER: Array<ItemStatus | 'unknown'> = [
  'wip',
  'needs-human',
  'blocked',
  'todo',
  'done',
  'dropped',
  'unknown',
];

const COUNT_LABELS: Record<ItemStatus | 'unknown', string> = {
  wip: 'wip',
  'needs-human': 'human',
  blocked: 'blocked',
  todo: 'todo',
  done: 'done',
  dropped: 'dropped',
  unknown: 'unknown',
};

interface Props {
  list: AsyncResult<{ plans: PlanListRow[] }>;
  /** Plans toggled into the cross-plan item filter (multi-select OR).
   *  Selected plans float to the top of the rail. */
  selectedSlugs: string[];
  query: string;
  /** Plan slugs the server-side cross-plan search returned. The rail
   *  unions these with the title/slug substring match so a search for
   *  body-only text ("memory" / "mem0") still surfaces matching plans
   *  instead of looking like "0 results". */
  searchHitSlugs?: ReadonlySet<string>;
  onSelect: (slug: string) => void;
  /** Called after a start/pause action so the parent can re-fetch. */
  onStartToggle?: () => void;
}

// Perf rule #2 (performance.mdx): never render an unvirtualized list of >~50
// rows. The plan rail can hold the whole corpus (~559 plans: Draft+Ready+Running
// live, plus the much larger Shipped/Superseded archive). Rendering all of them
// mounted ~14.4k DOM nodes and cost a ~1.8s warm tab-switch every time the Create
// tab re-mounts (measured, app-impersonation-e2e-round6 D-001). Smart-order floats
// the LIVE buckets to the top, so a bounded initial render shows everything the
// user acts on; the long archival tail is revealed on demand via "show all". The
// imperative handle below still operates over the full `sorted` list — only the
// DOM render is capped.
const RAIL_RENDER_CAP = 80;

const PlanRail = forwardRef<PlanRailHandle, Props>(function PlanRail(
  { list, selectedSlugs, query, searchHitSlugs, onSelect, onStartToggle }: Props,
  ref,
) {
  const selectedKey = selectedSlugs.join('|');
  const { data, loading, error, refresh } = list;

  // Pointer-drag-to-reorder state for started plans (P-045).
  const [dragSlug, setDragSlug] = useState<string | null>(null);
  const [dragOverSlug, setDragOverSlug] = useState<string | null>(null);
  // Optimistic running-plans order — null means "use server order".
  const [runningOrder, setRunningOrder] = useState<string[] | null>(null);
  // Perf (D-001): cap the rendered rows; reveal the archival tail on demand.
  // Resets to false on every mount — and the Create panel re-mounts on each tab
  // switch — so every Create visit starts with the cheap, bounded render.
  const [showAll, setShowAll] = useState(false);

  // Filter reads — PlanFilters / PlanBucketTabs own the writes; same keys.
  // Plan-status is now multi-select (`?pBuckets=`); empty = all buckets.
  const [fBuckets] = useQueryState(
    'pBuckets',
    parseAsArrayOf(parseAsStringEnum<PlanBucket>(BUCKET_FILTER_VALUES)).withDefault([]),
  );
  const fBucketsKey = fBuckets.join('|');
  const [fDate] = useQueryState(
    'pDate',
    parseAsStringEnum<DateWindow>(['today', '7d', '30d']),
  );
  const [fOwner] = useQueryState('pOwner', parseAsString);
  const [fInitiative] = useQueryState('pInitiative', parseAsString);
  const [fView] = useQueryState('pView', parseAsStringEnum<OwnerView>([...OWNER_VIEWS]).withDefault('all'));
  const fViewerEmail = usePlanViewerEmail();
  const [fArchived] = useQueryState('pArchived', parseAsBoolean.withDefault(false));
  const [fLegacy] = useQueryState('pLegacy', parseAsBoolean.withDefault(false));
  const [fInbox] = useQueryState('pInbox', parseAsBoolean.withDefault(false));
  const [fActionable] = useQueryState('pActionable', parseAsBoolean.withDefault(false));
  const [fScout] = useQueryState('pScout', parseAsBoolean.withDefault(false));
  const [fScheduled] = useQueryState('pScheduled', parseAsBoolean.withDefault(false));
  const [fTrigger] = useQueryState(
    'pTrigger',
    parseAsStringEnum<PlanTriggerFilter>([...PLAN_TRIGGER_FILTERS]).withDefault('all'),
  );
  const [fSort] = useQueryState(
    'pSort',
    parseAsStringEnum<PlanSort>(PLAN_SORT_IDS).withDefault('default'),
  );

  const plans = data?.plans ?? [];

  // Apply structured filters → search filter → sort. Memoized so the
  // imperative-handle below sees the same list the body renders.
  const sorted = useMemo<PlanListRow[]>(() => {
    const filtered = applyPlanFilters(
      plans,
      { date: fDate, owner: fOwner, initiative: fInitiative, view: fView, viewerEmail: fViewerEmail, archived: fArchived, legacy: fLegacy, inbox: fInbox, actionable: fActionable, scout: fScout, scheduled: fScheduled, trigger: fTrigger },
      query,
      searchHitSlugs,
    );
    const bucketed = fBuckets.length
      ? filtered.filter((p) => fBuckets.includes(bucketOf(p)))
      : filtered;
    // Selection does NOT reorder the list. Floating the selected plan to the top
    // re-ran applyPlanFilters + re-sorted + reordered all rows on every click
    // (measured ~1s at 559 plans — the "clicking a plan does nothing" report).
    // Selection now only highlights (`is-active`); the order is selection-stable,
    // so `sorted` no longer depends on the selection and the memoized rows skip,
    // making a click instant.
    const raw = [...bucketed].sort(comparePlans(fSort));
    // Apply local drag-reorder override for running plans (P-045).
    if (!runningOrder) return raw;
    const orderMap = new Map(runningOrder.map((s, i) => [s, i]));
    return [...raw].sort((a, b) => {
      const oa = orderMap.get(a.slug);
      const ob = orderMap.get(b.slug);
      if (oa !== undefined && ob !== undefined) return oa - ob;
      if (oa !== undefined) return -1;
      if (ob !== undefined) return 1;
      return 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, fBucketsKey, fOwner, fInitiative, fView, fViewerEmail, fDate, fArchived, fLegacy, fInbox, fActionable, fScout, fScheduled, fTrigger, fSort, query, searchHitSlugs, runningOrder]);

  useImperativeHandle(
    ref,
    () => {
      // Anchor j/k navigation on the most-recently toggled plan.
      const cur = selectedSlugs[selectedSlugs.length - 1] ?? null;
      return {
        next: () => {
          if (!sorted.length) return;
          const i = sorted.findIndex((p) => p.slug === cur);
          const nextIdx = i < 0 ? 0 : Math.min(i + 1, sorted.length - 1);
          const nxt = sorted[nextIdx];
          if (nxt) onSelect(nxt.slug);
        },
        prev: () => {
          if (!sorted.length) return;
          const i = sorted.findIndex((p) => p.slug === cur);
          const prevIdx = i < 0 ? sorted.length - 1 : Math.max(i - 1, 0);
          const prv = sorted[prevIdx];
          if (prv) onSelect(prv.slug);
        },
      };
    },
    [sorted, selectedKey, onSelect], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Drag-to-reorder handlers for started plans (P-045). These hooks MUST be
  // declared BEFORE the early-return guards below: an early return that skips
  // a useCallback changes the hook count between renders (React #310) — the
  // loading→loaded transition tripped exactly that and crashed the whole
  // /admin/plans page to the error boundary.
  //
  // Native HTML5 drag-and-drop. It DOES work in the desktop's WebKitGTK
  // webview — the harness dock (dockview) and PlanDetail's kanban both use it
  // there — as long as two conditions the original reorder missed are met:
  //   1. Tauri's OS-level drag-drop handler must not swallow the in-page drag.
  //      It's at the default here and that's fine; dockview + PlanDetail prove
  //      native DnD fires in this shell unmodified.
  //   2. THE ACTUAL BUG: `dragstart` MUST call `dataTransfer.setData(...)`, or
  //      WebKit/Gecko silently abort the drag and never fire `dragover`/`drop`.
  //      The original handler set only React state and never touched
  //      `dataTransfer`, so the drag never initiated in the desktop — which got
  //      misread as "WebKitGTK doesn't support HTML5 DnD". It does.
  // (tauri-apps/tauri#6695 is about Tauri's *file*-drop handler; the setData
  // requirement is HTML-spec WebKit/Gecko behaviour, not a Tauri quirk.)
  //
  // These hooks MUST be declared BEFORE the early-return guards below: an early
  // return that skips a useCallback changes the hook count between renders
  // (React #310) — the loading→loaded transition tripped exactly that and
  // crashed the whole /admin/plans page to the error boundary.
  const runningPlans = sorted.filter((p) => bucketOf(p) === 'running');
  // Drag-to-reorder edits dispatch priority, which is only the visible
  // order under the default smart sort — hide the handles otherwise so a
  // drag can't silently rewrite priorities the current view doesn't show.
  const reorderable = fSort === 'default';
  const hasRunning = reorderable && runningPlans.length > 1; // single-plan: no reorder needed
  // Distinguishes a committed drop from an aborted drag (Esc / dropped outside
  // a row): `drop` fires before `dragend`, so by the time dragEnd runs this is
  // already true on success and false on abort.
  const droppedRef = useRef(false);

  const handleDragStart = useCallback((e: React.DragEvent, slug: string) => {
    // setData is load-bearing — WITHOUT it WebKitGTK aborts the drag before any
    // dragover/drop fires (this is the bug the original reorder hit).
    e.dataTransfer.setData('text/plain', slug);
    e.dataTransfer.effectAllowed = 'move';
    droppedRef.current = false;
    setDragSlug(slug);
    setDragOverSlug(slug);
    setRunningOrder(runningPlans.map((p) => p.slug));
  }, [runningPlans]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDragOver = useCallback((e: React.DragEvent, slug: string) => {
    if (!dragSlug) return;
    e.preventDefault(); // REQUIRED — without it the row is not a valid drop target
    e.dataTransfer.dropEffect = 'move';
    if (dragSlug === slug) return;
    setRunningOrder((prev) => {
      const cur = prev ?? runningPlans.map((p) => p.slug);
      const from = cur.indexOf(dragSlug);
      const to = cur.indexOf(slug);
      if (from < 0 || to < 0 || from === to) return cur;
      const next = [...cur];
      next.splice(from, 1);
      next.splice(to, 0, dragSlug);
      return next;
    });
    setDragOverSlug(slug);
  }, [dragSlug, runningPlans]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    droppedRef.current = true;
    const order = runningOrder;
    setDragSlug(null);
    setDragOverSlug(null);
    if (!order) return;
    // Persist the new order as integer priorities (1-based, lower = first).
    // Keep `runningOrder` until the re-fetch lands so the list doesn't snap
    // back to the stale server order between drop and refresh.
    await Promise.all(
      order.map((slug, i) => setPlanPriority(slug, i + 1).catch(() => {})),
    );
    onStartToggle?.(); // re-fetch so the server order reflects the new priorities
    setRunningOrder(null);
  }, [runningOrder, onStartToggle]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDragEnd = useCallback(() => {
    // Always fires after a drag. On a committed drop, handleDrop owns the
    // cleanup; only on an abort (no drop landed) do we discard the local
    // reorder and fall back to the server order.
    if (droppedRef.current) return;
    setDragSlug(null);
    setDragOverSlug(null);
    setRunningOrder(null);
  }, []);

  if (loading) {
    return <p className="pc-plans__placeholder">Loading plans…</p>;
  }
  if (error) {
    return (
      <div className="pc-plans__placeholder pc-plans__placeholder--error">
        <p>Failed to load plans:</p>
        <code>{error}</code>
        <button type="button" className="pc-plans__retry" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }
  if (!plans.length) {
    return <p className="pc-plans__placeholder">No plans found.</p>;
  }

  if (!sorted.length) {
    // Distinguish a search miss from a filter miss — `query` is the
    // search box, the rest are the PlanFilters keys.
    const q = query.trim();
    const filtersActive =
      fBuckets.length > 0 || !!fOwner || fView !== 'all' || !!fDate || fArchived || fLegacy || fInbox || fActionable || fScout || fScheduled || fTrigger !== 'all';
    const msg = q
      ? `No plans match “${q}”.`
      : filtersActive
        ? 'No plans match the active filters.'
        : 'No plans to show.';
    return <p className="pc-plans__placeholder">{msg}</p>;
  }

  // Perf cap (D-001): render at most RAIL_RENDER_CAP rows unless the user opts
  // into the full list. `sorted` is smart-ordered (live buckets first), so the
  // bounded window holds everything actionable; the archival tail is one click
  // away. A drag-reorder only applies to `running` plans, which sort to the very
  // top and are therefore always within the rendered window.
  const renderList = showAll ? sorted : sorted.slice(0, RAIL_RENDER_CAP);
  const hiddenCount = sorted.length - renderList.length;

  return (
    <>
      {hasRunning && (
        <p className="pc-plan-rail__drag-hint" aria-live="polite">
          Drag started plans to set their priority
        </p>
      )}
      <ul
        className={`pc-plan-rail__rows${dragSlug ? ' is-reordering' : ''}`}
        role="list"
        // The whole list is a drop zone so a drop landing in an inter-row gap
        // still commits (preventDefault marks it droppable); per-row reorder
        // targeting happens in each row's own onDragOver.
        onDragOver={hasRunning ? (e) => e.preventDefault() : undefined}
        onDrop={hasRunning ? handleDrop : undefined}
      >
        {renderList.map((p) => {
          const isRunning = bucketOf(p) === 'running';
          const canReorder = hasRunning && isRunning;
          return (
            <PlanRowMemo
              key={p.slug}
              plan={p}
              slug={p.slug}
              active={selectedSlugs.includes(p.slug)}
              onSelect={onSelect}
              onStartToggle={onStartToggle}
              showDragHandle={canReorder}
              isDragging={dragSlug === p.slug}
              isDragOver={dragOverSlug === p.slug}
              onHandleDragStart={canReorder ? (e) => handleDragStart(e, p.slug) : undefined}
              onRowDragOver={canReorder ? (e) => handleDragOver(e, p.slug) : undefined}
              onHandleDragEnd={canReorder ? handleDragEnd : undefined}
            />
          );
        })}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="pc-plan-rail__show-all"
          onClick={() => setShowAll(true)}
          aria-label={`Show all ${sorted.length} plans (${hiddenCount} more)`}
        >
          Show all {sorted.length} plans <span aria-hidden="true">({hiddenCount} more)</span>
        </button>
      )}
    </>
  );
});

export default PlanRail;

function PlanRow({
  plan,
  slug,
  active,
  onSelect,
  onStartToggle,
  showDragHandle = false,
  isDragging = false,
  isDragOver = false,
  onHandleDragStart,
  onRowDragOver,
  onHandleDragEnd,
}: {
  plan: PlanListRow;
  /** Passed alongside `plan` so the (stable) `onSelect` can be memo-friendly —
   *  the row calls `onSelect(slug)` instead of a per-row closure, so memo only
   *  re-renders the rows whose `active` actually flipped on a selection. */
  slug: string;
  active: boolean;
  onSelect: (slug: string) => void;
  onStartToggle?: () => void;
  showDragHandle?: boolean;
  isDragging?: boolean;
  isDragOver?: boolean;
  onHandleDragStart?: (e: React.DragEvent) => void;
  onRowDragOver?: (e: React.DragEvent) => void;
  onHandleDragEnd?: (e: React.DragEvent) => void;
}) {
  const title = plan.title ?? plan.slug;
  const source = sourceOfDraftPlan(plan);
  const [busy, setBusy] = useState(false);

  const handleStartToggle = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setBusy(true);
      try {
        if (plan.startStatus === 'started') {
          await pausePlan(plan.slug, plan.harness);
        } else {
          // plans:start emits the demand event that wakes the Queen
          // (start-hive-wake-orchestration D-001) — no harness launch kick
          // needed (the legacy /harness/:slug/launch run-loop is retired).
          await startPlan(plan.slug, plan.harness);
        }
        onStartToggle?.();
      } finally {
        setBusy(false);
      }
    },
    [plan.slug, plan.startStatus, onStartToggle],
  );

  const isStarted = plan.startStatus === 'started';
  // Start/Pause only makes sense once a plan is approved — draft plans
  // must be approved first (no start button), and shipped/rejected are
  // terminal. So the inline toggle shows only for ready + running.
  const bucket = bucketOf(plan);
  // retire-mug-kettle-su-only-2026-08-09 P-047 / D-010, owner-directed:
  // "its just the start/stopped functionality that made them 'pickable' for the
  // mug that we no longer need and the gui buttons driving that functionality."
  // op_status is that axis, and this button is its only owner-facing writer.
  //
  // ASYMMETRIC ON PURPOSE — the PAUSE half survives for an ALREADY-started plan
  // (`isStarted`), mirroring the server (plans:pause is deliberately un-gated,
  // D-061): the DBOS frontier still reads op_status='started', so hiding pause
  // too would freeze every pre-P-047 started plan dispatchable with no off
  // switch. It is self-extinguishing — once a plan is paused or cleared the
  // button never returns, because Start cannot be reached while the tier is
  // retired. A 'paused' plan correctly shows nothing (isStarted is false).
  // P-068/D-098: the tier flag is DELETED, so Start can never be reached — the
  // toggle survives only as PAUSE for an already-started (pre-P-047) plan.
  const showStartToggle = (bucket === 'ready' || bucket === 'running') && isStarted;

  return (
    <li
      className={`pc-plan-rail__item pc-plan-rail__item--${plan.status}${isStarted ? ' pc-plan-rail__item--started' : ''}${isDragging ? ' is-dragging' : ''}${isDragOver ? ' is-drag-over' : ''}`}
      data-plan-slug={plan.slug}
      // The whole row is the drop target so dragging over any part of it
      // reorders to this row's index (the handle below is the drag *source*).
      onDragOver={onRowDragOver}
    >
      {showDragHandle && (
        // The grab handle is a plain draggable <span> sitting OUTSIDE the row
        // <button> (an interactive button as the drag source swallows the
        // gesture — the original "started plans aren't draggable" bug). It uses
        // native HTML5 `draggable` — which works in the desktop's WebKitGTK
        // webview, same as dockview + PlanDetail — the key being that
        // onDragStart calls dataTransfer.setData (see PlanRail handlers above);
        // without that WebKit aborts the drag. The row <button> still handles
        // click-to-select. (P-045 fix.)
        <span
          className="pc-plan-row__drag-handle"
          draggable
          onDragStart={onHandleDragStart}
          onDragEnd={onHandleDragEnd}
          role="button"
          tabIndex={-1}
          aria-label={`Drag to reorder ${plan.slug}`}
          title="Drag to set dispatch priority"
        >
          ⠿
        </span>
      )}
      <button
        type="button"
        className={`pc-plan-row${showDragHandle ? ' has-drag-handle' : ''}${active ? ' is-active' : ''}`}
        onClick={() => onSelect(slug)}
        aria-label={`Open plan ${title} (${plan.slug})`}
        aria-current={active ? 'page' : undefined}
      >
        <div className="pc-plan-row__head">
          <span className="pc-plan-row__title">{title}</span>
          {showStartToggle ? (
            <Tooltip label={isStarted ? 'Pause plan (orchestrator stops picking features)' : 'Start plan (orchestrator picks features from this plan)'}><button
              type="button"
              className={`pc-plan-row__start-btn${isStarted ? ' is-started' : ''}`}
              disabled={busy}
              onClick={handleStartToggle}

              aria-label={isStarted ? `Pause plan ${plan.slug}` : `Start plan ${plan.slug}`}
            >
              {isStarted ? <Pause size={11} /> : <Play size={11} />}
              {isStarted ? 'Pause' : 'Start'}
            </button></Tooltip>
          ) : null}
        </div>
        <div className="pc-plan-row__meta-line">
          {source ? <SourcePill source={source} /> : null}
          {plan.harness ? <HarnessPill harness={plan.harness} /> : null}
          <StatusPill status={plan.status} />
          {plan.triggered ? <TriggerPill sources={plan.triggerSources} /> : null}
          {plan.scheduled ? <SchedulePill kind={plan.scheduleKind ?? null} active={plan.scheduleActive ?? false} /> : null}
          {plan.updated ? (
            <span
              className="pc-plan-row__updated"
              title={`Last updated ${formatUpdated(plan.updated)}`}
            >
              <Clock size={12} aria-hidden />
              {formatUpdatedShort(plan.updated)}
            </span>
          ) : null}
        </div>
        {plan.ownerIdentity || plan.lastEditor ? (
          <div className="pc-plan-row__meta-line" style={{ gap: 10 }} data-testid="plan-row-authors">
            {plan.ownerIdentity ? <AuthorBadge identity={plan.ownerIdentity} prefix="owner" /> : null}
            {plan.lastEditor ? <AuthorBadge identity={plan.lastEditor} prefix="edited by" /> : null}
          </div>
        ) : null}
        {plan.itemCounts ? <PlanProgressBar counts={plan.itemCounts} /> : null}
        {plan.itemCounts ? <ItemCounts counts={plan.itemCounts} /> : null}
        {plan.nextAction ? (
          <Tooltip label={plan.nextAction}>
            <div className="pc-plan-row__next">
              <span className="pc-plan-row__next-label">Next</span>
              <span className="pc-plan-row__next-text">{plan.nextAction}</span>
            </div>
          </Tooltip>
        ) : null}
      </button>
    </li>
  );
}

/**
 * Memoized — the rail renders ALL plans (no virtualization), so without this a
 * single selection or filter change re-renders every row (measured ~1s at 559
 * plans, which read as "clicking a plan does nothing"). With stable callbacks
 * (onSelect(slug) + a stable onStartToggle from PlansListPanel), memo re-renders
 * only the rows whose props actually changed — typically the two whose `active`
 * flipped — so selecting a plan is instant.
 */
const PlanRowMemo = memo(PlanRow);

function StatusPill({ status }: { status: PlanStatus }) {
  return <span className={`pc-pill pc-pill--${status}`}>{status}</span>;
}

function TriggerPill({ sources }: { sources: PlanListRow['triggerSources'] }) {
  const label = planTriggerSourceLabel(sources);
  return (
    <Tooltip label={`Triggered plan · ${label}`}>
      <span className="pc-pill pc-pill--trigger" data-testid="plan-trigger-source-badge">
        {label}
      </span>
    </Tooltip>
  );
}

/**
 * Schedule pill (scheduled-recurring-plans-2026-06-16 P-021) — the per-row glance
 * for a scheduled/recurring plan. Icon distinguishes a recurrence set (Repeat)
 * from a one-shot fire time (CalendarClock); the trailing dot + dimming shows
 * armed (firing) vs paused (saved-but-disarmed). Full schedule + next-fires +
 * run history live on the plan's Calendar/Runs surfaces — this is just the glance.
 */
function SchedulePill({ kind, active }: { kind: 'recurring' | 'one-shot' | null; active: boolean }) {
  const Icon = kind === 'one-shot' ? CalendarClock : Repeat;
  const label = kind === 'one-shot' ? 'one-shot' : 'recurring';
  const stateLabel = active ? 'armed — firing on schedule' : 'paused — saved but not armed';
  return (
    <Tooltip label={`Scheduled (${label}) · ${stateLabel}`}>
      <span
        className="pc-pill pc-pill--schedule"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: active ? 1 : 0.6 }}
        data-schedule-active={active ? 'true' : 'false'}
      >
        <Icon size={11} aria-hidden />
        {label}
        <span
          aria-hidden
          style={{ width: 6, height: 6, borderRadius: '50%', background: active ? 'var(--good, #34d399)' : 'var(--fg-mute, #7f9bb4)' }}
        />
      </span>
    </Tooltip>
  );
}

/**
 * Harness pill — P-023. Shows the resolved harness slug each plan
 * row lives in so the rail is legible when the user expands the
 * scope to include multiple harnesses (Phase 2 sub-harness scope).
 */
function HarnessPill({ harness }: { harness: string }) {
  const t = useLexicon();
  return (
    <Tooltip label={`${t('pot', { lower: true })}: ${harness}`}>
      <span className="pc-pill pc-pill--harness">{harness}</span>
    </Tooltip>
  );
}

/**
 * Whether a draft plan was authored by the user or by the scoper. Mirrors
 * the convention used by the plansDrafts.bySlug resolver so the rail and
 * ProposalsPanel agree on labelling — only draft plans get a source tag
 * (active/shipped plans have outlived the proposal stage).
 */
function sourceOfDraftPlan(plan: PlanListRow): 'user' | 'scoper' | null {
  if (plan.status !== 'draft') return null;
  return plan.slug.startsWith('scoper-proposal-') ? 'scoper' : 'user';
}

function SourcePill({ source }: { source: 'user' | 'scoper' }) {
  return (
    <span
      className={`pc-pill pc-pill--source-${source}`}
      title={source === 'scoper' ? 'Authored by the scoper' : 'Authored by you'}
    >
      {source === 'scoper' ? 'scoper' : 'you'}
    </span>
  );
}

import { formatRelativeUpdated } from '@papercusp/operator-core/lib/format/relative-time';

/**
 * Thin wrapper kept for call-site stability inside this file. The
 * canonical implementation lives at `@/lib/format/relative-time`
 * (P-027 / D-011) so the picker in AdvSessionsClient + any future
 * caller renders the same "Nd ago" string.
 */
function formatUpdated(updated: string): string {
  return formatRelativeUpdated(updated);
}

/**
 * Bare relative time for the row's last-updated chip — drops the
 * trailing " ago" so it reads as a compact "4d" / "today" next to the
 * clock icon (the full "4d ago" stays in the title attribute).
 *
 * For the `today` / `yesterday` pills we also append an abbreviated
 * HH:MM time-of-day ("today 14:32") — "today" alone spans 24h, so the
 * clock time is the useful precision. Older pills ("4d", dated) keep the
 * relative form (a time-of-day on "4d" would just be noise).
 */
function formatUpdatedShort(updated: string): string {
  const rel = formatRelativeUpdated(updated).replace(/\s*ago$/, '');
  if (rel === 'today' || rel === 'yesterday') {
    const t = Date.parse(updated);
    if (Number.isFinite(t)) {
      const time = new Date(t).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      return `${rel} ${time}`;
    }
  }
  return rel;
}

/** P-023: segmented progress bar showing done / active / remaining proportions. */
function PlanProgressBar({
  counts,
}: {
  counts: Partial<Record<ItemStatus | 'unknown', number>>;
}) {
  const done = counts['done'] ?? 0;
  const active = (counts['wip'] ?? 0) + (counts['needs-human'] ?? 0);
  const remaining = (counts['todo'] ?? 0) + (counts['blocked'] ?? 0) + (counts['unknown'] ?? 0);
  const total = done + active + remaining + (counts['dropped'] ?? 0);
  if (total === 0) return null;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  return (
    <div
      className="pc-plan-row__progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={`${done} of ${total} items done`}
      title={`${done} done · ${active} active · ${remaining} remaining`}
    >
      {done > 0 && <span className="pc-progress__done" style={{ width: pct(done) }} />}
      {active > 0 && <span className="pc-progress__active" style={{ width: pct(active) }} />}
      {remaining > 0 && <span className="pc-progress__remaining" style={{ width: pct(remaining) }} />}
    </div>
  );
}

function ItemCounts({
  counts,
}: {
  counts: Partial<Record<ItemStatus | 'unknown', number>>;
}) {
  const present = COUNT_ORDER.filter((k) => (counts[k] ?? 0) > 0);
  if (!present.length) return null;
  return (
    <div className="pc-plan-row__counts">
      {present.map((k) => (
        <span
          key={k}
          className={`pc-count pc-count--${k}`}
          aria-label={`${counts[k]} ${COUNT_LABELS[k]} items`}
        >
          {counts[k]} {COUNT_LABELS[k]}
        </span>
      ))}
    </div>
  );
}
