/**
 * Calendar tab — the schedulable time-surface for scheduled/recurring plans
 * (scheduled-recurring-plans-2026-06-16 P-018/P-019). FullCalendar renders the
 * backend-computed occurrences (plans.scheduledOccurrences) for the visible
 * window — the rrule lib on the backend is the single source of truth, so the
 * calendar UI lib stays swappable (D-004). View + selection live in nuqs so the
 * surface is deep-linkable and agent-drivable (ui:dispatch).
 *
 * v1 renders + inspects. Drag-drop rescheduling + the RRULE recurrence editor are
 * P-020 (layered on top via the interaction plugin + plans:set-schedule).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { DatesSetArg, EventClickArg, EventDropArg, EventInput } from '@fullcalendar/core';
import type { DateClickArg } from '@fullcalendar/interaction';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { CalendarPlus, ExternalLink, Pencil, X } from 'lucide-react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Modal } from '@/app/harness/Modal';
import { Tooltip } from '@/app/harness/Tooltip';
import ScheduledRoutinesPane from './ScheduledRoutinesPane';
import ScheduleEditor, { runScheduleTool, type ScheduleMode } from './ScheduleEditor';
import './scheduled-calendar.css';

type CalView = 'dayGridMonth' | 'timeGridWeek' | 'timeGridDay';

interface ScheduledOccurrenceRow {
  templateSlug: string;
  title: string | null;
  harnessSlug: string;
  occurrenceMs: number;
  kind: 'recurring' | 'one-shot';
  scheduleActive: boolean;
  lastOutcome: string | null;
}

/** The open schedule-editor target (P-020). */
interface EditorState {
  slug: string;
  title: string | null;
  /** The plan's harness — threaded to the write tools for non-primary pots (D-020). */
  harness?: string;
  /** ISO date the editor seeds on (from a day-click → one-shot). */
  seedDate?: string;
  seedMode?: ScheduleMode;
  isArmed: boolean;
}

/** The fields the "Schedule a plan" picker reads off plans.list (P-021 schedule glance). */
interface PlanListLite {
  slug: string;
  title: string | null;
  scheduled?: boolean;
  scheduleActive?: boolean;
  harness: string;
}

/** A plan's raw authored schedule (plans.schedule row) — drives editor pre-fill + per-occurrence drag (D-020). */
interface PlanScheduleRow {
  templateSlug: string;
  title: string | null;
  harnessSlug: string;
  schedule: {
    kind?: string;
    rrule?: string;
    dtstart?: string;
    tzid?: string;
    rdate?: string[];
    exdate?: string[];
    cron?: string;
  } | null;
  scheduledAt: string | null;
  expiresAt: string | null;
  tzid: string | null;
  scheduleActive: boolean;
}

const VIEW_VALUES: CalView[] = ['dayGridMonth', 'timeGridWeek', 'timeGridDay'];

export default function ScheduledCalendarTab() {
  const calRef = useRef<FullCalendar | null>(null);
  const [view, setView] = useQueryState('calView', parseAsStringEnum<CalView>(VIEW_VALUES).withDefault('dayGridMonth'));
  const [selected, setSelected] = useQueryState('calPlan', parseAsString);
  // Visible window — set from FullCalendar's datesSet so the sync query tracks the view.
  const [range, setRange] = useState<{ startMs: number; endMs: number } | null>(null);

  const { data, loading, invalidate } = useSyncQuery<ScheduledOccurrenceRow>({
    queryName: 'plans.scheduledOccurrences',
    args: { rangeStartMs: range?.startMs ?? 0, rangeEndMs: range?.endMs ?? 0 },
    enabled: !!range,
  });
  const occurrences = useMemo(() => data ?? [], [data]);

  // ── Schedule editor + drag-drop (P-020) ──
  // The editor authors a plan's schedule (recurring RRULE or one-shot) via
  // plans:set-schedule and arms it via plans:arm-schedule. `null` = closed.
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The plan list (incl. P-021 schedule fields) powers the "Schedule a plan"
  // picker — pick an unscheduled plan to give it a first schedule.
  // The no-args plans.list subscription is the canonical active-workspace
  // superset: callPlansReadRaw injects workspaceWide:true. Keep it lazy, but do
  // not fan out harnessProjects.lite — harness_slugs is capped at 64 and large
  // workspaces would make the schedule picker fail before it rendered.
  const { data: planListData } = useSyncQuery<PlanListLite>({
    queryName: 'plans.list',
    args: {},
    enabled: pickerOpen,
  });
  const planList = useMemo(() => (Array.isArray(planListData) ? planListData : []), [planListData]);
  // Each scheduled plan's RAW schedule (rrule/scheduledAt/exdate/rdate) — editor
  // pre-fill + the per-occurrence EXDATE/RDATE drag read this (D-020).
  const { data: schedData, invalidate: invalidateSchedules } = useSyncQuery<PlanScheduleRow>({ queryName: 'plans.schedule', args: {} });
  const scheduleBySlug = useMemo(() => {
    const m = new Map<string, PlanScheduleRow>();
    for (const s of schedData ?? []) m.set(s.templateSlug, s);
    return m;
  }, [schedData]);
  const afterWrite = useCallback(() => {
    void invalidate?.();
    void invalidateSchedules?.();
  }, [invalidate, invalidateSchedules]);

  const events: EventInput[] = useMemo(
    () =>
      occurrences.map((o) => ({
        id: `${o.templateSlug}:${o.occurrenceMs}`,
        title: o.title ?? o.templateSlug,
        start: new Date(o.occurrenceMs).toISOString(),
        extendedProps: o,
        classNames: [
          'pc-sched-event',
          o.scheduleActive ? 'pc-sched-event--armed' : 'pc-sched-event--paused',
          o.lastOutcome ? `pc-sched-event--${o.lastOutcome}` : '',
          o.kind === 'one-shot' ? 'pc-sched-event--oneshot' : '',
        ].filter(Boolean),
      })),
    [occurrences],
  );
  const stats = useMemo(() => {
    let armed = 0;
    let paused = 0;
    let oneShot = 0;
    let failed = 0;
    let partial = 0;
    for (const o of occurrences) {
      if (o.scheduleActive) armed += 1;
      else paused += 1;
      if (o.kind === 'one-shot') oneShot += 1;
      if (o.lastOutcome === 'failed') failed += 1;
      if (o.lastOutcome === 'partial' || o.lastOutcome === 'timed-out') partial += 1;
    }
    return { total: occurrences.length, armed, paused, oneShot, failed, partial };
  }, [occurrences]);

  const onDatesSet = useCallback(
    (arg: DatesSetArg) => {
      setRange({ startMs: arg.start.getTime(), endMs: arg.end.getTime() });
      // Keep the URL view param in sync with FullCalendar's own toolbar.
      if (arg.view.type !== view && VIEW_VALUES.includes(arg.view.type as CalView)) {
        void setView(arg.view.type as CalView);
      }
    },
    [view, setView],
  );

  // URL → FullCalendar (agent ui:dispatch / deep link sets ?calView=).
  useEffect(() => {
    const api = calRef.current?.getApi();
    if (api && api.view.type !== view) api.changeView(view);
  }, [view]);

  const onEventClick = useCallback(
    (arg: EventClickArg) => {
      const slug = (arg.event.extendedProps as ScheduledOccurrenceRow).templateSlug;
      void setSelected(slug);
    },
    [setSelected],
  );

  // Click/drag onto a day = a one-shot for the SELECTED plan (P-020). With no
  // plan selected there's no target, so open the picker to choose one instead.
  const onDateClick = useCallback(
    (arg: DateClickArg) => {
      if (!selected) {
        setPickerOpen(true);
        return;
      }
      const row = occurrences.find((o) => o.templateSlug === selected);
      setEditor({
        slug: selected,
        title: row?.title ?? selected,
        harness: row?.harnessSlug,
        seedDate: arg.date.toISOString(),
        seedMode: 'one-shot',
        isArmed: row?.scheduleActive ?? false,
      });
    },
    [selected, occurrences],
  );

  // Drag an event to a new day. A one-shot just moves (rewrite scheduledAt). A
  // recurring occurrence can't be moved in isolation without the source RRULE
  // (the occurrence row doesn't carry it), so revert + open the editor for an
  // edit-all — per-occurrence EXDATE+RDATE drag is a documented follow-on.
  const onEventDrop = useCallback(
    async (arg: EventDropArg) => {
      const o = arg.event.extendedProps as ScheduledOccurrenceRow;
      const newStart = arg.event.start;
      if (!newStart) {
        arg.revert();
        return;
      }
      const hArg = o.harnessSlug ? { harness: o.harnessSlug } : {};
      if (o.kind === 'one-shot') {
        const r = await runScheduleTool('plans:set-schedule', {
          slug: o.templateSlug,
          ...hArg,
          schedule: null,
          scheduledAt: newStart.toISOString(),
        });
        if (!r.ok) arg.revert();
        else afterWrite();
        return;
      }
      // Recurring occurrence → edit-THIS-occurrence: exclude the original fire
      // (EXDATE) and pin the dragged one (RDATE). Needs the source RRULE; if we
      // don't have it, fall back to opening the editor (edit-all).
      const cur = scheduleBySlug.get(o.templateSlug);
      if (!cur?.schedule?.rrule) {
        arg.revert();
        setEditor({ slug: o.templateSlug, title: o.title, harness: o.harnessSlug, isArmed: o.scheduleActive });
        return;
      }
      const oldIso = new Date(o.occurrenceMs).toISOString();
      const next = {
        ...cur.schedule,
        exdate: [...(cur.schedule.exdate ?? []), oldIso],
        rdate: [...(cur.schedule.rdate ?? []), newStart.toISOString()],
      };
      const r = await runScheduleTool('plans:set-schedule', {
        slug: o.templateSlug,
        ...hArg,
        schedule: next,
        expiresAt: cur.expiresAt,
        tzid: cur.tzid,
      });
      if (!r.ok) arg.revert();
      else afterWrite();
    },
    [afterWrite, scheduleBySlug],
  );

  const selectedPlan = useMemo(() => {
    if (!selected) return null;
    const rows = occurrences.filter((o) => o.templateSlug === selected);
    if (rows.length === 0) return null;
    const now = Date.now();
    const upcoming = rows.filter((o) => o.occurrenceMs >= now).sort((a, b) => a.occurrenceMs - b.occurrenceMs);
    return { row: rows[0], upcoming: upcoming.slice(0, 5) };
  }, [selected, occurrences]);

  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <div className="pc-sched-cal">
        <header className="pc-sched-cal__masthead">
          <div className="pc-sched-cal__titleblock">
            <p className="pc-sched-cal__eyebrow">Scheduled plans</p>
            <h2>Calendar</h2>
          </div>
          <div className="pc-sched-cal__stats" aria-label="Calendar occurrence summary">
            <span><strong>{stats.total}</strong> in view</span>
            <span><strong>{stats.armed}</strong> armed</span>
            {stats.failed > 0 ? <span className="is-danger"><strong>{stats.failed}</strong> failed</span> : null}
            {stats.partial > 0 ? <span className="is-warn"><strong>{stats.partial}</strong> partial</span> : null}
            {stats.paused > 0 ? <span><strong>{stats.paused}</strong> paused</span> : null}
            {stats.oneShot > 0 ? <span><strong>{stats.oneShot}</strong> one-shot</span> : null}
            {loading ? <span>Loading</span> : null}
          </div>
          <Tooltip label="Author a schedule for a plan" side="bottom" align="end">
            <button type="button" className="pc-sched-cal__add" onClick={() => setPickerOpen(true)}>
              <CalendarPlus size={14} aria-hidden />
              <span>Schedule</span>
            </button>
          </Tooltip>
        </header>
        <div className="pc-sched-cal__legend" aria-label="Calendar status legend">
          <span><i className="pc-sched-cal__swatch pc-sched-cal__swatch--success" /> last run ok</span>
          <span><i className="pc-sched-cal__swatch pc-sched-cal__swatch--failed" /> last run failed</span>
          <span><i className="pc-sched-cal__swatch pc-sched-cal__swatch--partial" /> partial</span>
          <span><i className="pc-sched-cal__swatch pc-sched-cal__swatch--paused" /> paused</span>
          <span className="pc-sched-cal__oneshot">italic = one-shot</span>
        </div>
        <div className="pc-sched-cal__body">
          <aside className="pc-sched-cal__routines">
            <ScheduledRoutinesPane onSelect={(slug) => void setSelected(slug)} />
          </aside>
          <div className="pc-sched-cal__main">
            <FullCalendar
              ref={calRef}
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView={view}
              headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' }}
              events={events}
              datesSet={onDatesSet}
              eventClick={onEventClick}
              dateClick={onDateClick}
              eventDrop={onEventDrop}
              editable
              eventStartEditable
              eventDurationEditable={false}
              height="100%"
              nowIndicator
              dayMaxEvents={4}
              firstDay={1}
            />
          </div>
          {selectedPlan && (
            <aside className="pc-sched-cal__aside">
              <div className="pc-sched-cal__aside-head">
                <h3>{selectedPlan.row.title ?? selectedPlan.row.templateSlug}</h3>
                <button
                  type="button"
                  className="pc-sched-cal__iconbtn"
                  onClick={() => void setSelected(null)}
                  aria-label="Close selected plan"
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
              <dl>
                <dt>Plan</dt>
                <dd>{selectedPlan.row.templateSlug}</dd>
                <dt>Pot</dt>
                <dd>{selectedPlan.row.harnessSlug}</dd>
                <dt>State</dt>
                <dd>{selectedPlan.row.scheduleActive ? 'Armed (firing)' : 'Paused (disarmed)'}</dd>
                <dt>Kind</dt>
                <dd>{selectedPlan.row.kind === 'one-shot' ? 'One-shot' : 'Recurring'}</dd>
                <dt>Last run</dt>
                <dd>{selectedPlan.row.lastOutcome ?? '—'}</dd>
              </dl>
              <h3>Next fires</h3>
              {selectedPlan.upcoming.length === 0 ? (
                <p className="pc-sched-cal__empty pc-sched-cal__empty--compact">No upcoming occurrences in view.</p>
              ) : (
                <ul className="pc-sched-cal__next-list">
                  {selectedPlan.upcoming.map((o) => (
                    <li key={o.occurrenceMs}>
                      {new Date(o.occurrenceMs).toLocaleString()}
                    </li>
                  ))}
                </ul>
              )}
              <p className="pc-sched-cal__planlink">
                <a href={`/adv?tab=plans&plan=${encodeURIComponent(selectedPlan.row.templateSlug)}`}>
                  <ExternalLink size={12} aria-hidden />
                  <span>Open plan</span>
                </a>
              </p>
              <div className="pc-sched-cal__actions">
                <button
                  type="button"
                  className="pc-sched-cal__edit"
                  onClick={() =>
                    setEditor({
                      slug: selectedPlan.row.templateSlug,
                      title: selectedPlan.row.title,
                      harness: selectedPlan.row.harnessSlug,
                      isArmed: selectedPlan.row.scheduleActive,
                    })
                  }
                >
                  <Pencil size={12} aria-hidden />
                  Edit schedule
                </button>
              </div>
            </aside>
          )}
        </div>

        {pickerOpen && (
          <SchedulePicker
            plans={planList}
            onPick={(p) => {
              setPickerOpen(false);
              setEditor({ slug: p.slug, title: p.title, harness: p.harness, isArmed: p.scheduleActive ?? false });
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}

        {editor && (
          <Modal
            open
            onOpenChange={(open: boolean) => {
              if (!open) setEditor(null);
            }}
            title={`Edit schedule for ${editor.title ?? editor.slug}`}
            contentClassName="pc-sched-cal__modal-card"
          >
            <ScheduleEditor
              planSlug={editor.slug}
              planTitle={editor.title}
              harness={editor.harness}
              seedDate={editor.seedDate}
              seedMode={editor.seedMode}
              initial={scheduleBySlug.get(editor.slug) ?? null}
              isArmed={editor.isArmed}
              onClose={() => setEditor(null)}
              onSaved={afterWrite}
            />
          </Modal>
        )}
      </div>
    </TooltipPrimitive.Provider>
  );
}
/** Plan picker for "Schedule a plan" — choose any plan to (re)author its schedule.
 *  Unscheduled plans float to the top (the common case); already-scheduled ones
 *  remain pickable to edit. Reuses the P-021 `scheduled` glance off plans.list. */
function SchedulePicker({
  plans,
  onPick,
  onClose,
}: {
  plans: PlanListLite[];
  onPick: (p: PlanListLite) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = needle
      ? plans.filter((p) => p.slug.toLowerCase().includes(needle) || (p.title ?? '').toLowerCase().includes(needle))
      : plans;
    // Unscheduled first, then by title/slug.
    return [...rows]
      .sort((a, b) => {
        const sa = a.scheduled ? 1 : 0;
        const sb = b.scheduled ? 1 : 0;
        if (sa !== sb) return sa - sb;
        return (a.title ?? a.slug).localeCompare(b.title ?? b.slug);
      })
      .slice(0, 60);
  }, [plans, q]);

  return (
    <Modal
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
      title="Schedule a plan"
      contentClassName="pc-sched-cal__modal-card pc-sched-cal__picker-card"
    >
      <div className="pc-sched-cal__picker">
        <div className="pc-sched-cal__picker-head">
          <strong>Schedule a plan</strong>
          <button type="button" onClick={onClose} aria-label="Close picker" className="pc-sched-cal__iconbtn">
            <X size={14} aria-hidden />
          </button>
        </div>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter plans..."
          aria-label="Filter plans"
          className="pc-sched-cal__picker-search"
        />
        {filtered.length === 0 ? (
          <p className="pc-sched-cal__empty pc-sched-cal__empty--compact">No plans match.</p>
        ) : (
          <ul className="pc-sched-cal__picker-list">
            {filtered.map((p) => (
              <li key={`${p.harness}:${p.slug}`}>
                <button type="button" onClick={() => onPick(p)} className="pc-sched-cal__picker-row">
                  <span>{p.title ?? p.slug}</span>
                  {p.scheduled ? (
                    <em className={p.scheduleActive ? 'is-armed' : ''}>{p.scheduleActive ? 'armed' : 'scheduled'}</em>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
