/**
 * Cached read-through adapter for the hot, read-only plan-index query.
 *
 * `listPlanIndexRows` stays the strong-consistency primitive used by mutation,
 * deduplication, and explicit audit paths. Recurring observers (system health and
 * Pot survey) use this adapter so concurrent/repeated reads share the existing
 * operator cache, tag invalidation, and durable L2 tier.
 */
import { cachedRead } from '../../cache';
import { listPlanIndexRows, resolvePlanScope, type PlanIndexRow } from './source';

export const PLAN_INDEX_ROWS_SOFT_TTL_MS = 45_000;
export const PLAN_INDEX_ROWS_HARD_TTL_MS = 5 * 60_000;

type ListPlanIndexRowsOptions = NonNullable<Parameters<typeof listPlanIndexRows>[0]>;

/**
 * Normalize every output-determining option into the cache key. The legacy
 * filesystem override fields accepted by PlanSourceOpts are deliberately absent:
 * PG-canonical reads ignore them, so they cannot affect the result.
 */
function planIndexRowsCacheKey(
  workspaceId: string,
  harnessSlug: string,
  opts: ListPlanIndexRowsOptions,
): Record<string, unknown> {
  return {
    workspaceId,
    harnessSlug,
    includeArchived: opts.includeArchived === true,
    status: opts.status || null,
    limit: typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : null,
    includeInstances: opts.includeInstances === true,
    template: opts.template || null,
    templateSlug: opts.templateSlug || null,
    createdSince: opts.createdSince || null,
    updatedSince: opts.updatedSince || null,
    order: opts.order ?? 'slug',
    includeItems: opts.includeItems !== false,
    heavyFields: opts.heavyFields === true,
  };
}

/**
 * Read the plan index through the existing workspace-scoped cache.
 *
 * The resolved Hive-home scope is used both for the key and the source read, so
 * two member slugs that collapse to the same plan store may safely share an entry.
 * `harness_plans` covers row/item/status changes; `trigger_bindings` covers the
 * derived `hasExternalTrigger` projection in the index query.
 */
export async function listPlanIndexRowsCached(opts: ListPlanIndexRowsOptions = {}): Promise<PlanIndexRow[]> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const sourceOpts: ListPlanIndexRowsOptions = {
    ...opts,
    workspaceId,
    harnessSlug,
  };

  return cachedRead(
    { workspaceId },
    {
      tool: 'plans:index-rows',
      key: planIndexRowsCacheKey(workspaceId, harnessSlug, opts),
      tags: ['harness_plans', 'trigger_bindings'],
      softTtlMs: PLAN_INDEX_ROWS_SOFT_TTL_MS,
      hardTtlMs: PLAN_INDEX_ROWS_HARD_TTL_MS,
      l2: true,
    },
    () => listPlanIndexRows(sourceOpts),
  );
}
