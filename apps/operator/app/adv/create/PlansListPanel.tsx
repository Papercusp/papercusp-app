'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * create:filter — the plan-browser sidebar of the Create dock, always visible
 * beside CreateViewRail. It owns search, plan-status bucket filters, and the
 * plan list; CreateViewRail owns New plan. The plan list acts as a filter on whichever view is active —
 * clicking a plan in Inbox/Sessions toggles the ?itemPlans item filter; in
 * Plans view it opens that plan full-width on the right (?plan).
 *
 * Mirrors PlansClient's rail (search + buckets + PlanRail), lifted so the dock
 * behaves like the original Plans tab.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { ClipboardList, Inbox, Plus, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { launchAgent } from '@papercusp/operator-core/lib/launch-agent';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import { useLexicon } from '@/lib/useLexicon';
import PlanFilters from '@/app/admin/plans/PlanFilters';
import PlanBucketTabs from '@/app/admin/plans/PlanBucketTabs';
import PlanRail from '@/app/admin/plans/PlanRail';
import { usePlanSearch } from '@/app/admin/plans/plans-api';
import { Select } from '@/app/harness/Select';
import { useDebouncedValue } from '@/app/harness/picker-kit';
import {
  useCreateScope,
  usePlanListMaps,
  useItemPlanFilter,
  useResolvedHarnessSlug,
  useCreateView,
} from './use-create-data';

/** Compact, icon-only view switcher that sits to the left of the Create dock. */
export function CreateViewRail() {
  const t = useLexicon();
  const [view, setView] = useCreateView();
  const resolvedSlug = useResolvedHarnessSlug();
  const [launching, setLaunching] = useState(false);

  // Preserve the existing New-plan behavior; only its visual home moves from
  // the plan browser into the compact action rail.
  const onNewPlan = async () => {
    if (launching) return;
    setLaunching(true);
    try {
      const result = await launchAgent({
        slug: resolvedSlug ?? null,
        planSlug: null,
        label: resolvedSlug ? `new-plan · ${resolvedSlug}` : 'new-plan',
        kickoff: { kind: 'new-plan' },
        deferSpawn: true,
      });
      if (result.ok) {
        toast.success('Plan-drafting agent queued — opening as a pane in the dock.', { duration: 3000 });
      } else if (result.installCmd) {
        toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setLaunching(false);
    }
  };

  return (
    <nav className="pc-create-plans-sidebar__view-rail" aria-label="Create view">
      <Tooltip label={resolvedSlug
            ? `Launch an agent session to draft a new plan in ${resolvedSlug}`
            : `Launch an agent session to draft a new plan (no active ${t('pot', { lower: true })} — agent will ask)`}><button
        type="button"
        className="pc-plans__new-plan pc-create-plans-sidebar__new-plan"
        onClick={onNewPlan}
        disabled={launching}
        aria-label={launching ? 'Launching…' : 'New plan'}
      >
        <span className="pc-create-plans-sidebar__view-icon" aria-hidden>
          <Plus size={14} />
        </span>
        <span className="pc-create-plans-sidebar__new-plan-label">{launching ? 'Launching…' : 'New'}</span>
      </button></Tooltip>
      <Tooltip label="Plans — open a plan from the list to view/edit it full-width."><button
        type="button"
        aria-label="Plans"
        className={`pc-plans__plans-btn pc-create-plans-sidebar__view-btn${view === 'plans' ? ' is-active' : ''}`}
        onClick={() => void setView('plans')}
      >
        <span className="pc-create-plans-sidebar__view-icon" aria-hidden>
          <ClipboardList size={14} />
        </span>
      </button></Tooltip>
      <Tooltip label={`Queue — every decision & action surface across plans the ${t('brain')} did not auto-handle (list + detail).`}><button
        type="button"
        aria-label="Queue"
        className={`pc-plans__queue-btn pc-create-plans-sidebar__view-btn${view === 'queue' ? ' is-active' : ''}`}
        onClick={() => void setView('queue')}
      >
        <span className="pc-create-plans-sidebar__view-icon" aria-hidden>
          <Inbox size={14} />
        </span>
      </button></Tooltip>
      <Tooltip label="Sessions — live agent roster (list + detail)."><button
        type="button"
        aria-label="Sessions"
        className={`pc-plans__sessions-btn pc-create-plans-sidebar__view-btn${view === 'sessions' ? ' is-active' : ''}`}
        onClick={() => void setView('sessions')}
      >
        <span className="pc-create-plans-sidebar__view-icon" aria-hidden>
          <Terminal size={14} />
        </span>
      </button></Tooltip>
    </nav>
  );
}

export default function PlansListPanel(_props?: PanelComponentProps) {
  const t = useLexicon();
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const [view, setView] = useCreateView();
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  // The search box updates ?q on every keystroke (instant input), but the
  // EXPENSIVE consumers — the cross-plan body search (a server round-trip) and
  // the per-keystroke bucket-count / rail re-filter — read this DEBOUNCED value,
  // so typing stays responsive and the heavy work runs only once typing settles.
  const debouncedQ = useDebouncedValue(q, 250);
  const [plan, setPlan] = useQueryState('plan', parseAsString);
  const [harnessFilter, setHarnessFilter] = useQueryState('h', parseAsString);
  const [itemPlans, setItemPlans] = useItemPlanFilter();
  const searchRef = useRef<HTMLInputElement>(null);

  const railSearchHits = usePlanSearch(debouncedQ);
  const searchHitSlugs = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const h of railSearchHits.data?.hits ?? []) s.add(h.plan);
    return s;
  }, [railSearchHits.data]);

  const filteredPlanList = useMemo(
    () => ({
      ...maps.planList,
      data: maps.planList.data ? { ...maps.planList.data, plans: maps.visiblePlans } : null,
    }),
    [maps.planList, maps.visiblePlans],
  );

  // The plan list filters whichever view is active: in Plans view it OPENS the
  // plan full-width (?plan) — a plain select, not a toggle, since the Plans
  // view always shows a plan; in Inbox/Sessions it toggles the ?itemPlans filter.
  //
  // STABLE identity (refs for the live view/itemPlans) so PlanRail's memoized
  // rows don't all re-render on every keystroke/selection — the 559-row rail is
  // unvirtualized, so a fresh callback here re-rendered every row (~1s lag, read
  // as "clicking a plan does nothing"). setPlan/setItemPlans are stable nuqs setters.
  const viewRef = useRef(view);
  viewRef.current = view;
  const itemPlansRef = useRef(itemPlans);
  itemPlansRef.current = itemPlans;
  const onSelectPlan = useCallback(
    (s: string) => {
      if (viewRef.current === 'plans') {
        void setPlan(s);
      } else {
        const cur = itemPlansRef.current;
        void setItemPlans(cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]);
      }
    },
    [setPlan, setItemPlans],
  );
  // Stable onStartToggle (ref to the live planList) for the same memo reason.
  const planListRef = useRef(maps.planList);
  planListRef.current = maps.planList;
  const onStartToggle = useCallback(() => {
    planListRef.current.refresh();
  }, []);
  const selectedSlugs = view === 'plans' ? (plan ? [plan] : []) : itemPlans;

  return (
    <div className="pc-plans__rail pc-create-plans-sidebar__browser">
      <div className="pc-plans__group">
        {maps.harnessOptions.length > 1 ? (
          <div className="pc-plans__harness-filter">
            <label className="pc-plans__harness-filter-label" htmlFor="pc-create-harness-filter">
              {t('pot')}
            </label>
            <Select
              id="pc-create-harness-filter"
              triggerClassName="pc-plans__harness-filter-select"
              value={harnessFilter ?? ''}
              onChange={(value) => void setHarnessFilter(value === '_all' ? null : value)}
              ariaLabel={`Filter plans by ${t('pot', { lower: true })}`}
              options={[
                { value: '_all', label: `All (${maps.planList.data?.plans.length ?? 0})` },
                ...maps.harnessOptions.map((h) => {
                  const count = (maps.planList.data?.plans ?? []).filter((p) => p.harness === h).length;
                  return { value: h, label: `${h} (${count})` };
                }),
              ]}
            />
          </div>
        ) : null}

        <PlanFilters list={filteredPlanList} query={q} onQueryChange={setQ} searchRef={searchRef} />
        <PlanBucketTabs plans={maps.visiblePlans} query={debouncedQ} searchHitSlugs={searchHitSlugs} />
      </div>

      <div className="pc-plans__list" aria-label="Plans">
        <PlanRail
          list={filteredPlanList}
          selectedSlugs={selectedSlugs}
          query={debouncedQ}
          searchHitSlugs={searchHitSlugs}
          onSelect={onSelectPlan}
          onStartToggle={onStartToggle}
        />
      </div>
    </div>
  );
}
