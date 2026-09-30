/**
 * @papercusp/ui-primitives — ActivityTimelineView.
 *
 * Layout A of the Project History tab (plan
 * project-history-tab-desktop-and-portal-2026-09-16, P-010 / D-002): a reverse-chronological
 * per-pot activity timeline — plans, work items, decisions and checkpoints — with a live dot,
 * filter chips, day separators, and inline row expansion.
 *
 * DATA-IN VIA PROPS. This component never fetches. P-011 feeds it from
 * `useSyncQuery({ queryName: 'projectHistoryEvents' })` in the desktop app and from the portal's
 * REST sync hook on :3081; both hosts pass the same `events` array. Keeping the fetch outside is
 * what lets one component serve two apps with different transports, and what makes every branch
 * below reachable from a plain unit test with no network.
 *
 * Styling is the same `--ph-*` token contract as ProjectHistoryView.css — a host themes it by
 * declaring those custom properties on any ancestor. ActivityTimelineView.css.test.ts enforces
 * that the stylesheet references only `--ph-*`, declares a standalone fallback for each, and has
 * a rule for every `atl-*` class this file can emit.
 *
 * Controlled/uncontrolled: `filter`, `query` and `expandedId` each work either way — pass the
 * value plus its `on*Change` to control it (P-011 binds them to nuqs URL params, per the repo's
 * "almost all state should be in nuqs" rule), or omit it and the component keeps its own state.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import './ActivityTimelineView.css';

/** The four event families the history stream carries. */
export type ActivityEventKind = 'work-item' | 'plan' | 'decision' | 'checkpoint';

/** A filter chip selection — the four kinds plus the unfiltered view. */
export type ActivityFilter = 'all' | ActivityEventKind;

/** One row of the timeline. Host-shaped elsewhere; this component only renders it. */
export interface ActivityTimelineEvent {
  /** Stable React key + expansion handle. Unique within `events`. */
  id: string;
  kind: ActivityEventKind;
  /** ISO-8601 instant the event happened. Drives ordering, the time column and day grouping. */
  at: string;
  /** The subject's own identifier — `WI-10000249`, a plan slug, `D-007`. */
  ref: string;
  /** One-line human summary. */
  title: string;
  /** Who caused it — an agent ownerId or a person's name. */
  actor?: string | null;
  /** Renders the actor chip in the "human" style rather than the agent style. */
  actorIsHuman?: boolean;
  /** Status transition, when the event is one (`open` → `wip`). Both optional. */
  fromStatus?: string | null;
  toStatus?: string | null;
  /** Plan context for a plan-item event. */
  planSlug?: string | null;
  planItem?: string | null;
  /** Longer body shown when the row is expanded. */
  excerpt?: string | null;
  /** Label/value pairs shown in the expanded row's detail list. */
  details?: ReadonlyArray<{ label: string; value: string }>;
  /** Actions offered on the expanded row. `onAction` receives the event alongside the key. */
  actions?: ReadonlyArray<{ key: string; label: string }>;
}

export interface ActivityTimelineViewProps {
  /** Newest-first is the intended order; the component sorts defensively so a host cannot break it. */
  events: ReadonlyArray<ActivityTimelineEvent>;
  /** First-fetch skeleton. Distinct from `events: []`, which is the genuine empty state. */
  loading?: boolean;
  /** Whether the live subscription is connected — drives the dot and its label. */
  live?: boolean;
  /** When the stream last delivered. Rendered as "Ns ago" beside the live dot. */
  lastUpdatedAt?: string | Date | null;
  /** Injectable clock so relative times are deterministic under test. */
  now?: Date;
  filter?: ActivityFilter;
  defaultFilter?: ActivityFilter;
  onFilterChange?: (filter: ActivityFilter) => void;
  /** Free-text filter over ref + title + actor. */
  query?: string;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  /** Id of the inline-expanded row, or null. */
  expandedId?: string | null;
  defaultExpandedId?: string | null;
  onExpandedChange?: (id: string | null) => void;
  onAction?: (actionKey: string, event: ActivityTimelineEvent) => void;
  /** Rendered into the toolbar's left slot — the pot switcher in both hosts. */
  toolbarLeft?: ReactNode;
  emptyTitle?: string;
  emptyBody?: string;
  /** Optional call-to-action on the empty state ("Switch pot" in the mockup). */
  emptyAction?: { label: string; onClick: () => void };
  /** Skeleton row count while `loading`. */
  skeletonRows?: number;
  className?: string;
  /** Accessible name for the timeline list. */
  label?: string;
}

/** The filter chips, in render order. Exported so hosts can mirror them in a URL param enum. */
export const ACTIVITY_FILTERS: ReadonlyArray<{ value: ActivityFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'plan', label: 'Plans' },
  { value: 'work-item', label: 'Work items' },
  { value: 'decision', label: 'Decisions' },
  { value: 'checkpoint', label: 'Checkpoints' },
];

/** Short badge per kind, matching the mockup's pills. */
const KIND_BADGE: Record<ActivityEventKind, string> = {
  'work-item': 'WI',
  plan: 'PLAN',
  decision: 'D',
  checkpoint: 'CP',
};

const KIND_LABEL: Record<ActivityEventKind, string> = {
  'work-item': 'Work item',
  plan: 'Plan',
  decision: 'Decision',
  checkpoint: 'Checkpoint',
};

const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

/**
 * "Ns ago" for the live indicator. Returns null for a missing/unparseable instant so the caller
 * renders nothing rather than "NaN ago" — an unknown timestamp must not read as a real age.
 */
export function formatRelativeTime(value: string | Date | null | undefined, now: Date): string | null {
  if (value == null) return null;
  const then = value instanceof Date ? value : new Date(value);
  const ms = then.getTime();
  if (Number.isNaN(ms)) return null;
  const delta = now.getTime() - ms;
  if (delta < 0) return 'just now';
  if (delta < 5_000) return 'just now';
  if (delta < MS.minute) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < MS.hour) return `${Math.floor(delta / MS.minute)}m ago`;
  if (delta < MS.day) return `${Math.floor(delta / MS.hour)}h ago`;
  return `${Math.floor(delta / MS.day)}d ago`;
}

/** Zero-padded wall-clock `HH:MM` for the time column. */
export function formatEventTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today" / "Yesterday" / "Mon 14 Sep" — the day-separator label. */
export function activityDayLabel(at: string, now: Date): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  const days = Math.round((startOfDay(now) - startOfDay(date)) / MS.day);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * Apply the chip + free-text filters. Pure and exported so the filtering contract is unit-testable
 * without rendering — the component is a thin shell over this.
 */
export function filterActivityEvents(
  events: ReadonlyArray<ActivityTimelineEvent>,
  filter: ActivityFilter,
  query: string,
): ActivityTimelineEvent[] {
  const needle = query.trim().toLowerCase();
  return events.filter((event) => {
    if (filter !== 'all' && event.kind !== filter) return false;
    if (!needle) return true;
    const haystack = [event.ref, event.title, event.actor ?? '', event.planSlug ?? '', event.planItem ?? '']
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export interface ActivityDayGroup {
  label: string;
  /** Day-start epoch ms — a stable key that survives re-labelling as "Today" rolls over. */
  key: number;
  events: ActivityTimelineEvent[];
}

/**
 * Newest-first grouping into day buckets. Sorts defensively rather than trusting the caller, so a
 * host that appends a live event to the tail still renders it in the right place.
 */
export function groupActivityEventsByDay(
  events: ReadonlyArray<ActivityTimelineEvent>,
  now: Date,
): ActivityDayGroup[] {
  const sorted = [...events].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const groups: ActivityDayGroup[] = [];
  for (const event of sorted) {
    const date = new Date(event.at);
    const key = Number.isNaN(date.getTime()) ? Number.NEGATIVE_INFINITY : startOfDay(date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.events.push(event);
    else groups.push({ key, label: activityDayLabel(event.at, now), events: [event] });
  }
  return groups;
}

/** Controlled-or-uncontrolled value, resolved once per render. */
function useOptionallyControlled<T>(
  controlled: T | undefined,
  initial: T,
  onChange: ((next: T) => void) | undefined,
): [T, (next: T) => void] {
  const [internal, setInternal] = useState<T>(initial);
  const isControlled = controlled !== undefined;
  const value = isControlled ? (controlled as T) : internal;
  const set = useCallback(
    (next: T) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );
  return [value, set];
}

export function ActivityTimelineView({
  events,
  loading = false,
  live = false,
  lastUpdatedAt = null,
  now,
  filter,
  defaultFilter = 'all',
  onFilterChange,
  query,
  defaultQuery = '',
  onQueryChange,
  expandedId,
  defaultExpandedId = null,
  onExpandedChange,
  onAction,
  toolbarLeft,
  emptyTitle = 'No activity yet in this pot',
  emptyBody = 'Work-item and plan changes will appear here as they happen.',
  emptyAction,
  skeletonRows = 6,
  className,
  label = 'Project activity timeline',
}: ActivityTimelineViewProps) {
  const [activeFilter, setFilter] = useOptionallyControlled(filter, defaultFilter, onFilterChange);
  const [activeQuery, setQuery] = useOptionallyControlled(query, defaultQuery, onQueryChange);
  const [openId, setOpenId] = useOptionallyControlled(expandedId, defaultExpandedId, onExpandedChange);

  // `now` is a prop so tests pin the clock; falling back per-render is correct for a live view.
  const clock = now ?? new Date();
  const visible = useMemo(
    () => filterActivityEvents(events, activeFilter, activeQuery),
    [events, activeFilter, activeQuery],
  );
  const groups = useMemo(() => groupActivityEventsByDay(visible, clock), [visible, clock]);
  const age = formatRelativeTime(lastUpdatedAt, clock);

  const counts = useMemo(() => {
    const byKind = new Map<ActivityFilter, number>([['all', events.length]]);
    for (const event of events) byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
    return byKind;
  }, [events]);

  const rootClass = ['atl-root', className].filter(Boolean).join(' ');

  return (
    <section className={rootClass} data-testid="activity-timeline">
      <div className="atl-toolbar">
        <div className="atl-toolbar-left">{toolbarLeft}</div>
        <div className="atl-toolbar-right">
          <label className="atl-search">
            <span className="atl-visually-hidden">Filter history</span>
            <input
              className="atl-search-input"
              type="search"
              placeholder="Filter history…"
              value={activeQuery}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <p className="atl-live" data-live={live ? 'on' : 'off'}>
            <span className="atl-live-dot" aria-hidden="true" />
            {/* Polite, not assertive: a reconnect must not interrupt a screen reader mid-row. */}
            <span className="atl-live-label" role="status" aria-live="polite">
              {live ? 'Live' : 'Offline'}
              {age ? <span className="atl-live-age"> · {age}</span> : null}
            </span>
          </p>
        </div>
      </div>

      <div className="atl-filters" role="group" aria-label="Filter timeline by event kind">
        {ACTIVITY_FILTERS.map(({ value, label: chipLabel }) => (
          <button
            key={value}
            type="button"
            className="atl-chip"
            aria-pressed={activeFilter === value}
            onClick={() => setFilter(value)}
          >
            {chipLabel}
            <span className="atl-chip-count">{counts.get(value) ?? 0}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="atl-skeleton" aria-busy="true" aria-label="Loading activity">
          {Array.from({ length: skeletonRows }, (_, index) => (
            <div className="atl-skeleton-row" key={index}>
              <span className="atl-gutter" aria-hidden="true">
                <span className="atl-rail" />
                <span className="atl-node atl-node-skeleton" />
              </span>
              <span className="atl-bar atl-bar-time" />
              <span className="atl-bar atl-bar-pill" />
              <span className="atl-bar atl-bar-title" />
              <span className="atl-bar atl-bar-actor" />
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="atl-empty">
          <h2 className="atl-empty-title">{events.length === 0 ? emptyTitle : 'No matching activity'}</h2>
          <p className="atl-empty-body">
            {events.length === 0 ? emptyBody : 'No events match the current filter.'}
          </p>
          {events.length === 0 && emptyAction ? (
            <button type="button" className="atl-ghost-button" onClick={emptyAction.onClick}>
              {emptyAction.label}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="atl-timeline">
          {groups.map((group) => (
            <section className="atl-day" key={group.key} aria-labelledby={`atl-day-${group.key}`}>
              <h3 className="atl-day-separator" id={`atl-day-${group.key}`}>
                <span className="atl-day-label">{group.label}</span>
                <span className="atl-day-rule" aria-hidden="true" />
              </h3>
              <ol className="atl-rows" aria-label={`${label} — ${group.label}`}>
                {group.events.map((event) => {
                  const open = openId === event.id;
                  const panelId = `atl-detail-${event.id}`;
                  return (
                    <li className="atl-item" key={event.id}>
                      <button
                        type="button"
                        className="atl-row"
                        data-kind={event.kind}
                        data-open={open ? 'true' : 'false'}
                        aria-expanded={open}
                        aria-controls={panelId}
                        onClick={() => setOpenId(open ? null : event.id)}
                      >
                        <span className="atl-gutter" aria-hidden="true">
                          <span className="atl-rail" />
                          <span className="atl-node" />
                        </span>
                        <time className="atl-time" dateTime={event.at}>
                          {formatEventTime(event.at)}
                        </time>
                        <span className="atl-pill">
                          <span className="atl-visually-hidden">{KIND_LABEL[event.kind]}</span>
                          <span aria-hidden="true">{KIND_BADGE[event.kind]}</span>
                        </span>
                        <span className="atl-title">
                          <span className="atl-ref">{event.ref}</span>
                          {event.planItem ? (
                            <>
                              <span className="atl-sep" aria-hidden="true">
                                ·
                              </span>
                              <span className="atl-plan-item">{event.planItem}</span>
                            </>
                          ) : null}
                          <span className="atl-title-text"> {event.title}</span>
                          {event.toStatus ? (
                            <span className="atl-transition">
                              {event.fromStatus ? (
                                <>
                                  <span className="atl-status" data-status={event.fromStatus}>
                                    {event.fromStatus}
                                  </span>
                                  <span className="atl-arrow" aria-label="changed to">
                                    →
                                  </span>
                                </>
                              ) : null}
                              <span className="atl-status" data-status={event.toStatus}>
                                {event.toStatus}
                              </span>
                            </span>
                          ) : null}
                        </span>
                        <span className="atl-actor" data-human={event.actorIsHuman ? 'true' : 'false'}>
                          {event.actor ?? '—'}
                        </span>
                      </button>

                      {open ? (
                        <div className="atl-detail" id={panelId}>
                          <div className="atl-detail-main">
                            <h4 className="atl-detail-title">{event.title}</h4>
                            {event.excerpt ? <p className="atl-excerpt">{event.excerpt}</p> : null}
                          </div>
                          {event.details?.length ? (
                            <dl className="atl-detail-list">
                              {event.details.map((entry) => (
                                <div className="atl-detail-pair" key={entry.label}>
                                  <dt className="atl-detail-term">{entry.label}</dt>
                                  <dd className="atl-detail-value">{entry.value}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                          {event.actions?.length ? (
                            <div className="atl-actions">
                              {event.actions.map((action) => (
                                <button
                                  key={action.key}
                                  type="button"
                                  className="atl-ghost-button"
                                  onClick={() => onAction?.(action.key, event)}
                                >
                                  {action.label}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
