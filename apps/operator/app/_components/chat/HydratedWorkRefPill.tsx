'use client';

/**
 * HydratedWorkRefPill — live status/title hydration for `WorkRefPill`
 * (chat-ref-pills-2026-07-26 P-005) through `@papercusp/sync`'s
 * `useSyncQuery` — never a hand-rolled fetch/setInterval (repo convention,
 * apps/operator CLAUDE.md "All client data sync goes through @papercusp/
 * sync"). Degrades gracefully to the plain 'unknown' pill (WorkRefPill's own
 * default) whenever the referenced item is still loading or can't be
 * resolved at all — a live query that never settles renders exactly like a
 * ref nobody has data for yet, never an error state.
 *
 * `kind` (parse-work-refs.ts's `WorkRefKind`, P-001) picks ONE of two
 * different live sources, since a WI-/EI-/F- id and a P-NNN id live in
 * different stores with different scoping rules:
 *  - 'work-item': `workItems.detail` — the SAME harness-scoped single-item
 *    read `DetailPanel`'s `WorkItemDetail` already uses for these ids
 *    (sync-resolver/index.ts).
 *  - 'plan-item': `plans.items` scoped to the CHAT MESSAGE'S OWN
 *    `planSlug` — P-NNN is unique only WITHIN a plan (P-006's "Known
 *    ambiguity"), so with no `planSlug` there is nothing safe to hydrate
 *    against and this renders 'unknown' rather than guess.
 *
 * Both `useSyncQuery` calls fire unconditionally (rules-of-hooks forbid
 * branching before a hook call) — the irrelevant one for a given `kind` is
 * simply `enabled: false`, which the sync layer treats as a no-op (no
 * request, `loading: false`, `data: []`), so there is no double-fetch cost.
 */
import { useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { WorkRefPill, type WorkRefPillProps } from './WorkRefPill';
import type { WorkRefKind } from './parse-work-refs';
import type { HarnessStatus } from '../../harness/theme';

/** The `workItems.detail` row shape this component reads (a subset of
 *  `EnrichedWorkItem` — endpoint-route/routes/harness/work-items.ts). */
interface WorkItemDetailRow {
  id: string;
  state?: string | null;
  title?: string | null;
  summary?: string | null;
}

/** The `plans.items` row shape this component reads — `PlanItemRow` in
 *  admin/plans/plans-api.ts, `{ plan, archived, item }` (the nested `item`
 *  is what carries `id`/`effectiveStatus`/`text`). */
interface PlanItemRowLike {
  item?: { id?: string | null; effectiveStatus?: string | null; text?: string | null } | null;
}

// Both the work-item unified state enum (open/wip/blocked/needs-human/done/
// dropped) and the plan-item ItemStatus enum (todo/wip/blocked/needs-human/
// done/dropped) are subsets of HarnessStatus's key set (theme.ts's
// _STATUS_TABLE carries both), so no per-source mapping table is needed —
// an unrecognized/absent value still degrades through STATUS's own
// neutral-grey Proxy fallback via WorkRefPill's 'unknown' default.
function asHarnessStatus(state: string | null | undefined): HarnessStatus | 'unknown' {
  return state ? (state as HarnessStatus) : 'unknown';
}

export interface HydratedWorkRefPillProps extends Omit<WorkRefPillProps, 'state' | 'title' | 'kind'> {
  kind: WorkRefKind;
  /** Harness scoping a 'work-item' ref's `workItems.detail` lookup. */
  harnessSlug: string;
  /** The CHAT MESSAGE's own plan_slug context — required to hydrate a
   *  'plan-item' ref at all (mirrors P-006's resolver stance one layer
   *  down: no plan context, no safe resolution). Omit/null when the
   *  message carries none; the pill then renders 'unknown'. */
  planSlug?: string | null;
}

/**
 * Live-hydrated `WorkRefPill` — resolves `state`/`title` for the given ref
 * through `@papercusp/sync` and forwards every other prop (`href`,
 * `onActivate`, `size`, `className`, …) straight to the pure presentational
 * `WorkRefPill` (P-003) unchanged.
 */
export function HydratedWorkRefPill({ kind, id, harnessSlug, planSlug, ...rest }: HydratedWorkRefPillProps) {
  const workItemQuery = useSyncQuery<WorkItemDetailRow>({
    queryName: 'workItems.detail',
    args: { harnessSlug, id },
    enabled: kind === 'work-item' && !!harnessSlug,
  });
  const planItemQuery = useSyncQuery<PlanItemRowLike>({
    queryName: 'plans.items',
    args: { slug: planSlug ?? '' },
    enabled: kind === 'plan-item' && !!planSlug,
  });

  const { state, title } = useMemo(() => {
    if (kind === 'work-item') {
      const row = workItemQuery.data[0];
      return { state: asHarnessStatus(row?.state), title: row?.title ?? row?.summary ?? null };
    }
    // kind === 'plan-item': no message plan_slug context → nothing safe to
    // hydrate against (P-006's "no plan context" stance one layer down).
    if (!planSlug) return { state: 'unknown' as const, title: null };
    const row = planItemQuery.data.find((r) => r.item?.id === id);
    return { state: asHarnessStatus(row?.item?.effectiveStatus), title: row?.item?.text ?? null };
  }, [kind, id, planSlug, workItemQuery.data, planItemQuery.data]);

  return <WorkRefPill id={id} kind={kind} state={state} title={title} {...rest} />;
}
