/**
 * HydratedWorkRefPill — live status/title hydration for `WorkRefPill` through
 * `@papercusp/sync`'s `useSyncQuery` — never a hand-rolled fetch/setInterval
 * (repo convention: all client data sync goes through @papercusp/sync).
 *
 * MOVED here from apps/operator/app/_components/chat/HydratedWorkRefPill.tsx
 * (chat-ref-pills-2026-07-26 P-005) for papercup-chat-one-component-one-
 * contract-2026-09-06 P-007 (parity row `op-work-ref-pill`). Same two live
 * sources, same degrade: the plain 'unknown' pill whenever the referenced item
 * is still loading or cannot be resolved — a live query that never settles
 * renders exactly like a ref nobody has data for yet, never an error state.
 *
 * ONLY the owner host mounts this (D-005: `md-work-refs` is `public=inert
 * owner=render`) — on the public host `PapercupChat` never splices a pill node
 * in the first place, so this component is unreachable there and its sync
 * queries never fire against a host that cannot answer them.
 *
 *  - 'work-item': `workItems.detail` — the same harness-scoped single-item read
 *    the operator's DetailPanel uses (sync-resolver/index.ts).
 *  - 'plan-item': `plans.items` scoped to the CHAT MESSAGE'S OWN `planSlug` —
 *    P-NNN is unique only WITHIN a plan, so with no `planSlug` there is nothing
 *    safe to hydrate against and this renders 'unknown' rather than guess.
 *
 * Both `useSyncQuery` calls fire unconditionally (rules-of-hooks forbid
 * branching before a hook call) — the irrelevant one for a given `kind` is
 * simply `enabled: false`, which the sync layer treats as a no-op.
 */
import { useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { WorkRefPill, type WorkRefPillProps, type WorkRefState } from './WorkRefPill';
import type { WorkRefKind } from './parse-work-refs';

/** The `workItems.detail` row shape this component reads (a subset of
 *  `EnrichedWorkItem` — endpoint-route/routes/harness/work-items.ts). */
interface WorkItemDetailRow {
  id: string;
  state?: string | null;
  title?: string | null;
  summary?: string | null;
}

/** The `plans.items` row shape this component reads — `PlanItemRow` in
 *  admin/plans/plans-api.ts, `{ plan, archived, item }`. */
interface PlanItemRowLike {
  item?: { id?: string | null; effectiveStatus?: string | null; text?: string | null } | null;
}

function asState(state: string | null | undefined): WorkRefState {
  return state ? state : 'unknown';
}

export interface HydratedWorkRefPillProps extends Omit<WorkRefPillProps, 'state' | 'title' | 'kind'> {
  kind: WorkRefKind;
  /** Harness scoping a 'work-item' ref's `workItems.detail` lookup. */
  harnessSlug: string;
  /** The CHAT MESSAGE's own plan_slug context — required to hydrate a
   *  'plan-item' ref at all. Omit/null when the message carries none; the pill
   *  then renders 'unknown'. */
  planSlug?: string | null;
}

/**
 * Live-hydrated `WorkRefPill` — resolves `state`/`title` for the given ref
 * through `@papercusp/sync` and forwards every other prop (`href`,
 * `onActivate`, `size`, `className`, …) straight to the presentational pill.
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
      return { state: asState(row?.state), title: row?.title ?? row?.summary ?? null };
    }
    if (!planSlug) return { state: 'unknown' as const, title: null };
    const row = planItemQuery.data.find((r) => r.item?.id === id);
    return { state: asState(row?.item?.effectiveStatus), title: row?.item?.text ?? null };
  }, [kind, id, planSlug, workItemQuery.data, planItemQuery.data]);

  return <WorkRefPill id={id} kind={kind} state={state} title={title} {...rest} />;
}
