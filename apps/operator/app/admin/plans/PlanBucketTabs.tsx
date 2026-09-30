'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * PlanBucketTabs — plan lifecycle filter chips (Draft / Ready / Running /
 * Shipped / Superseded).
 *
 * Multi-select + additive: each chip toggles its bucket in the
 * `?pBuckets=` array. Selecting several is an OR *within* the plan-status
 * facet, and the selection scopes which plans' items appear in the main
 * list (PlansClient AND-s it with the item-status filters). None selected
 * = all buckets. Count badges reflect the live search/filter state.
 */

import { useMemo } from 'react';
import {
  useQueryState,
  parseAsArrayOf,
  parseAsBoolean,
  parseAsString,
  parseAsStringEnum,
} from 'nuqs';
import {
  bucketOf,
  PLAN_BUCKETS,
  type PlanBucket,
  type PlanListRow,
  usePlanViewerEmail,
} from './plans-api';
import {
  applyPlanFilters,
  OWNER_VIEWS,
  PLAN_TRIGGER_FILTERS,
  type OwnerView,
  type PlanTriggerFilter,
} from './plan-filtering';
import { type DateWindow } from './PlanFilters';

const BUCKET_IDS: PlanBucket[] = PLAN_BUCKETS.map((b) => b.id);

interface Props {
  /** The harness-scoped plan list (pre bucket/filter), as PlansClient holds it. */
  plans: PlanListRow[];
  /** The search box value (`?q=`). */
  query: string;
  /** Server-side cross-plan body-search hits, unioned into the query match. */
  searchHitSlugs?: ReadonlySet<string>;
}

export default function PlanBucketTabs({ plans, query, searchHitSlugs }: Props) {
  const [buckets, setBuckets] = useQueryState(
    'pBuckets',
    parseAsArrayOf(parseAsStringEnum<PlanBucket>(BUCKET_IDS)).withDefault([]),
  );

  // Same filter keys PlanRail reads — so the badges track the live view.
  const [date] = useQueryState('pDate', parseAsStringEnum<DateWindow>(['today', '7d', '30d']));
  const [owner] = useQueryState('pOwner', parseAsString);
  const [initiative] = useQueryState('pInitiative', parseAsString);
  const [view] = useQueryState('pView', parseAsStringEnum<OwnerView>([...OWNER_VIEWS]).withDefault('all'));
  const viewerEmail = usePlanViewerEmail();
  const [archived] = useQueryState('pArchived', parseAsBoolean.withDefault(false));
  const [legacy] = useQueryState('pLegacy', parseAsBoolean.withDefault(false));
  const [inbox] = useQueryState('pInbox', parseAsBoolean.withDefault(false));
  const [actionable] = useQueryState('pActionable', parseAsBoolean.withDefault(false));
  const [scout] = useQueryState('pScout', parseAsBoolean.withDefault(false));
  const [scheduled] = useQueryState('pScheduled', parseAsBoolean.withDefault(false));
  const [trigger] = useQueryState(
    'pTrigger',
    parseAsStringEnum<PlanTriggerFilter>([...PLAN_TRIGGER_FILTERS]).withDefault('all'),
  );

  const counts = useMemo<Record<PlanBucket, number>>(() => {
    const filtered = applyPlanFilters(
      plans,
      { date, owner, initiative, view, viewerEmail, archived, legacy, inbox, actionable, scout, scheduled, trigger },
      query,
      searchHitSlugs,
    );
    // Seeded from BUCKET_IDS, not hand-listed: a bucket missing from this
    // accumulator is `undefined`, and `undefined += 1` is NaN — so the chip
    // renders "NaN" rather than "0", and only for the bucket nobody remembered.
    // P-004's `awaiting` hit exactly that.
    const acc = Object.fromEntries(BUCKET_IDS.map((id) => [id, 0])) as Record<PlanBucket, number>;
    for (const p of filtered) acc[bucketOf(p)] += 1;
    return acc;
  }, [plans, date, owner, initiative, view, viewerEmail, archived, legacy, inbox, actionable, scout, scheduled, trigger, query, searchHitSlugs]);

  const toggle = (id: PlanBucket) => {
    const has = buckets.includes(id);
    void setBuckets(has ? buckets.filter((b) => b !== id) : [...buckets, id]);
  };

  return (
    <div className="pc-plan-buckets" role="group" aria-label="Plan status filters">
      {PLAN_BUCKETS.map(({ id, label }) => {
        const active = buckets.includes(id);
        return (
          <Tooltip key={id} label={active ? `${label}: on — click to remove from the filter` : `Add ${label} plans to the filter`}><button

            type="button"
            className={`pc-plans__view pc-plan-bucket pc-plan-bucket--${id} ${active ? 'is-active' : ''}`}
            aria-pressed={active}
            onClick={() => toggle(id)}

          >
            <span className="pc-plans__view-label">{label}</span>
            <span className="pc-plans__view-count">{counts[id]}</span>
          </button></Tooltip>
        );
      })}
    </div>
  );
}
