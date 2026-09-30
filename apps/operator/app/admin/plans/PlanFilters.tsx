'use client';

/**
 * PlanFilters — controls for PlanRail's filter set.
 *
 * P-103 deliverable. Every filter is a nuqs URL key (D-006) so the
 * state is shareable and survives reload. PlanRail reads the same
 * keys directly; this component owns the writes.
 *
 * Lifecycle status is NOT filtered here — the five bucket tabs
 * (PlanBucketTabs, `pBucket`) own that, rendered directly below.
 *
 * Filters:
 *   - date:            pDate         — `updated` recency window
 *   - owner:           pOwner        — frontmatter owner
 *   - has-needs-human: pInbox        — at least one needs-human item
 *   - has-actionable:  pActionable   — at least one effective-todo item
 *   - scout-origin:    pScout        — plans the Scout loop routed (origin 'scout')
 *   - archived:        pArchived     — archived-only rail filter
 *   - legacy:          pLegacy       — legacy-only rail filter
 *
 * Sort (not a filter, same write-here/read-in-rail split):
 *   - sort:            pSort         — rail order, see plan-sorting.ts
 *
 * The owner dropdown is populated from the plan list that PlansClient
 * already fetches for the rail and overview metrics. Keeping a single
 * read avoids duplicate calls while search/filter interactions stay
 * client-side and instant.
 */

import { useMemo, type RefObject } from 'react';
import { useQueryState, parseAsBoolean, parseAsString, parseAsStringEnum } from 'nuqs';
import { type AsyncResult, type PlanListRow, usePlanViewerEmail } from './plans-api';
import {
  OWNER_VIEWS,
  PLAN_TRIGGER_FILTERS,
  type OwnerView,
  type PlanTriggerFilter,
} from './plan-filtering';
import { PLAN_SORTS, PLAN_SORT_IDS, planSortLabel, type PlanSort } from './plan-sorting';
import { Select } from '@/app/harness/Select';

const OWNER_VIEW_LABELS: Record<OwnerView, string> = { all: 'all', mine: 'mine', others: "others'" };
const PLAN_TRIGGER_LABELS: Record<PlanTriggerFilter, string> = {
  all: 'all',
  'one-time': 'one-time',
  triggered: 'triggered',
};

export type DateWindow = 'today' | '7d' | '30d';
const DATE_WINDOWS: Array<{ id: DateWindow; label: string }> = [
  { id: 'today', label: 'today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

function dateWindowLabel(window: DateWindow): string {
  return DATE_WINDOWS.find((d) => d.id === window)?.label ?? window;
}

interface PlanFiltersProps {
  list: AsyncResult<{ plans: PlanListRow[] }>;
  query: string;
  onQueryChange: (query: string | null) => unknown;
  searchRef: RefObject<HTMLInputElement | null>;
}

export default function PlanFilters({
  list,
  query,
  onQueryChange,
  searchRef,
}: PlanFiltersProps) {
  const [dateWindow, setDateWindow] = useQueryState(
    'pDate',
    parseAsStringEnum<DateWindow>(['today', '7d', '30d']),
  );
  const [owner, setOwner] = useQueryState('pOwner', parseAsString);
  const [initiative, setInitiative] = useQueryState('pInitiative', parseAsString);
  const [view, setView] = useQueryState(
    'pView',
    parseAsStringEnum<OwnerView>([...OWNER_VIEWS]).withDefault('all'),
  );
  // The viewer's plan-owner email; null ⇒ identity unresolvable, so hide the
  // my/others view toggle (the raw owner dropdown still works).
  const viewerEmail = usePlanViewerEmail();
  const [archivedOnly, setArchivedOnly] = useQueryState(
    'pArchived',
    parseAsBoolean.withDefault(false),
  );
  const [legacyOnly, setLegacyOnly] = useQueryState(
    'pLegacy',
    parseAsBoolean.withDefault(false),
  );
  const [inbox, setInbox] = useQueryState(
    'pInbox',
    parseAsBoolean.withDefault(false),
  );
  const [actionable, setActionable] = useQueryState(
    'pActionable',
    parseAsBoolean.withDefault(false),
  );
  const [scout, setScout] = useQueryState(
    'pScout',
    parseAsBoolean.withDefault(false),
  );
  const [scheduled, setScheduled] = useQueryState(
    'pScheduled',
    parseAsBoolean.withDefault(false),
  );
  const [trigger, setTrigger] = useQueryState(
    'pTrigger',
    parseAsStringEnum<PlanTriggerFilter>([...PLAN_TRIGGER_FILTERS]).withDefault('all'),
  );
  const [sort, setSort] = useQueryState(
    'pSort',
    parseAsStringEnum<PlanSort>(PLAN_SORT_IDS).withDefault('default'),
  );

  // Distinct owners across all plans, for the owner dropdown.
  const owners = useMemo(() => {
    const set = new Set<string>();
    for (const p of list.data?.plans ?? []) {
      if (p.owner) set.add(p.owner);
    }
    return [...set].sort();
  }, [list.data]);

  // P-015: distinct initiative labels across all plans, for the initiative facet.
  const initiatives = useMemo(() => {
    const set = new Set<string>();
    for (const p of list.data?.plans ?? []) {
      if (p.initiative) set.add(p.initiative);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [list.data]);

  const activeCount =
    (dateWindow ? 1 : 0) +
    (view !== 'all' ? 1 : 0) +
    (owner ? 1 : 0) +
    (initiative ? 1 : 0) +
    (archivedOnly ? 1 : 0) +
    (legacyOnly ? 1 : 0) +
    (inbox ? 1 : 0) +
    (actionable ? 1 : 0) +
    (scout ? 1 : 0) +
    (scheduled ? 1 : 0) +
    (trigger !== 'all' ? 1 : 0) +
    (sort !== 'default' ? 1 : 0);

  const activeTokens = [
    sort !== 'default' ? { key: 'sort', label: `sort: ${planSortLabel(sort)}`, clear: () => setSort(null) } : null,
    dateWindow ? { key: 'date', label: `updated: ${dateWindowLabel(dateWindow)}`, clear: () => setDateWindow(null) } : null,
    view !== 'all' ? { key: 'view', label: `view: ${OWNER_VIEW_LABELS[view]}`, clear: () => setView(null) } : null,
    owner ? { key: 'owner', label: `owner: ${owner}`, clear: () => setOwner(null) } : null,
    initiative ? { key: 'initiative', label: `initiative: ${initiative}`, clear: () => setInitiative(null) } : null,
    inbox ? { key: 'needs-human', label: 'has needs-human', clear: () => setInbox(false) } : null,
    actionable ? { key: 'actionable', label: 'has actionable', clear: () => setActionable(false) } : null,
    scout ? { key: 'scout', label: 'scout-created', clear: () => setScout(false) } : null,
    scheduled ? { key: 'scheduled', label: 'scheduled', clear: () => setScheduled(false) } : null,
    trigger !== 'all' ? { key: 'trigger', label: `type: ${trigger}`, clear: () => setTrigger(null) } : null,
    archivedOnly ? { key: 'archived', label: 'archived', clear: () => setArchivedOnly(false) } : null,
    legacyOnly ? { key: 'legacy', label: 'legacy', clear: () => setLegacyOnly(false) } : null,
  ].flatMap((token) => (token ? [token] : []));

  const clearAll = () => {
    setDateWindow(null);
    setView(null);
    setOwner(null);
    setInitiative(null);
    setArchivedOnly(false);
    setLegacyOnly(false);
    setInbox(false);
    setActionable(false);
    setScout(false);
    setScheduled(false);
    setTrigger(null);
    setSort(null);
  };

  return (
    <div className="pc-filters" aria-label="Plan filters">
      <div className="pc-filters__head">
        <span className="pc-filters__kicker-row">
          {activeCount > 0 ? (
            <span className="pc-filters__active-count">{activeCount} active</span>
          ) : null}
        </span>
        {activeCount > 0 ? (
          <button
            type="button"
            className="pc-filters__clear"
            onClick={clearAll}
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className={`pc-filters__primary ${owners.length > 1 ? 'has-owner' : ''}`}>
        <input
          ref={searchRef}
          type="search"
          className="pc-plans__search-input"
          placeholder="Search plans…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value || null)}
          aria-label="Search plans"
          data-plan-search-input
        />

        {owners.length > 1 ? (
          <Select
            value={owner ?? '_all'}
            onChange={(v) => setOwner(v === '_all' ? null : v)}
            options={[
              { value: '_all', label: 'Owner' },
              ...owners.map((o) => ({ value: o, label: o })),
            ]}
            ariaLabel="Plan owner filter"
            triggerClassName="pc-filters__select"
          />
        ) : null}

        {initiatives.length > 0 ? (
          <Select
            value={initiative ?? '_all'}
            onChange={(v) => setInitiative(v === '_all' ? null : v)}
            options={[
              { value: '_all', label: 'Initiative' },
              ...initiatives.map((i) => ({ value: i, label: i })),
            ]}
            ariaLabel="Plan initiative filter"
            triggerClassName="pc-filters__select"
          />
        ) : null}

        <Select
          value={sort}
          onChange={(v) => setSort(v === 'default' ? null : (v as PlanSort))}
          options={PLAN_SORTS.map((s) => ({ value: s.id, label: s.label }))}
          ariaLabel="Plan sort order"
          triggerClassName="pc-filters__select"
        />
      </div>

      {viewerEmail ? (
        <div className="pc-filters__views" role="group" aria-label="Plan owner view">
          {OWNER_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              className={`pc-filter-chip ${view === v ? 'is-on' : ''}`}
              aria-pressed={view === v}
              onClick={() => setView(v === 'all' ? null : v)}
            >
              {OWNER_VIEW_LABELS[v]}
            </button>
          ))}
        </div>
      ) : null}

      <div className="pc-filters__views" role="group" aria-label="Plan trigger type">
        {PLAN_TRIGGER_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            className={`pc-filter-chip ${trigger === value ? 'is-on' : ''}`}
            aria-pressed={trigger === value}
            onClick={() => setTrigger(value === 'all' ? null : value)}
          >
            {PLAN_TRIGGER_LABELS[value]}
          </button>
        ))}
      </div>

      <div className="pc-filters__quick" role="group" aria-label="Quick plan filters">
        {DATE_WINDOWS.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`pc-filter-chip ${dateWindow === d.id ? 'is-on' : ''}`}
            aria-pressed={dateWindow === d.id}
            onClick={() => setDateWindow(dateWindow === d.id ? null : d.id)}
          >
            {d.label}
          </button>
        ))}
        <Toggle on={inbox} onChange={setInbox} label="needs human" />
        <Toggle on={actionable} onChange={setActionable} label="actionable" />
        <Toggle on={scout} onChange={setScout} label="scout" />
        <Toggle on={scheduled} onChange={setScheduled} label="scheduled" />
        <Toggle on={legacyOnly} onChange={setLegacyOnly} label="legacy" />
        <Toggle on={archivedOnly} onChange={setArchivedOnly} label="archived" />
      </div>

      {activeTokens.length > 0 ? (
        <div className="pc-filters__active" aria-label="Active plan filters">
          {activeTokens.map((token) => (
            <button
              key={token.key}
              type="button"
              className="pc-filters__token"
              onClick={token.clear}
              aria-label={`Clear ${token.label} filter`}
            >
              <span>{token.label}</span>
              <strong aria-hidden="true">×</strong>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`pc-filter-toggle ${on ? 'is-on' : ''}`}
      onClick={() => onChange(!on)}
      aria-pressed={on}
    >
      {label}
    </button>
  );
}

/**
 * Shared date-window predicate — PlanRail imports this so the filter
 * logic lives in exactly one place.
 */
export function withinDateWindow(
  updated: string | null | undefined,
  window: DateWindow | null,
): boolean {
  if (!window) return true;
  if (!updated) return false;
  const t = Date.parse(updated);
  if (!Number.isFinite(t)) return false;
  const ageMs = Date.now() - t;
  const day = 86_400_000;
  if (window === 'today') return ageMs < day;
  if (window === '7d') return ageMs < day * 7;
  return ageMs < day * 30;
}
