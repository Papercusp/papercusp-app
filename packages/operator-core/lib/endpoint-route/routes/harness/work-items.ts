/**
 * GET /api/harness/:slug/work-items — the harness's UNIFIED work items
 * (blueprint-aware-harness-ui-2026-06-09 P-010 — the features/issues view ported onto
 * the unified `work_items` surface, unify-work-items D-001).
 *
 * Returns the merged feature-family {feature,research-task,chunk} + issue-family
 * {bug,change,task} items for the harness with the dimensions the old per-kind
 * FeaturesPanel/IssuesPanel lacked: `kind`/`family`, `assignee` + `assignedBy` (the
 * claim), `severity`, `priority`, `rank` (from the tested `listWorkItems` facade) PLUS,
 * for feature-family items, the v2 dimensions joined ROUTE-SIDE (P-010 v2 / D-009):
 *   - **plan-item linkage** — `source_plan_slug` + `source_plan_item_ids` columns on
 *     harness_features_consolidated;
 *   - **spine position** (which role/stage) — the latest `harness_shared.spawned_agents`
 *     row per feature (`child_role` + `status`).
 *
 * These are joined HERE (supplementary queries merged by id), NOT by widening
 * `FEATURE_COLS` / the canonical `WorkItem` facade — deliberately, because widening
 * FEATURE_COLS breaks ~25 integration tests (D-009). The pure merge is unit-tested.
 */
import {
  listWorkItems,
  countWorkItems,
  createWorkItem,
  isWorkItemKind,
  isDeprecatedWorkItemKind,
  WORK_ITEMS_MAX_LIMIT,
  type WorkItem,
  type WorkItemKind,
} from '../../../work-items';
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';

export interface WorkItemDimensions {
  /** Source plan this feature was imported from (hfc.source_plan_slug); null for issues / unplanned. */
  planSlug: string | null;
  /** Source plan item ids (hfc.source_plan_item_ids); [] when none. */
  planItemIds: string[];
  /** Latest spine role the work item's pipeline dispatched (spawned_agents.child_role). */
  spineRole: string | null;
  /** That spawn's status (running|done|failed|cancelled|reaped). */
  spineStatus: string | null;
}
export type EnrichedWorkItem = WorkItem & WorkItemDimensions;

/**
 * Pure merge: overlay the plan-link + spine-position maps onto the items by id.
 * Issue-family items (no feature row / no spawn) get null/[] dims. Unit-testable.
 */
export function mergeWorkItemDimensions(
  items: WorkItem[],
  planMap: Map<string, { planSlug: string | null; planItemIds: string[] }>,
  spineMap: Map<string, { role: string; status: string }>,
): EnrichedWorkItem[] {
  return items.map((i) => {
    const plan = planMap.get(i.id);
    const spine = spineMap.get(i.id);
    return {
      ...i,
      planSlug: plan?.planSlug ?? null,
      planItemIds: plan?.planItemIds ?? [],
      spineRole: spine?.role ?? null,
      spineStatus: spine?.status ?? null,
    };
  });
}

/**
 * Fetch the v2 dimensions for a harness's feature-family work items — the plan-link
 * (hfc columns) + spine-position (latest spawn per feature). Route-only: does NOT touch
 * the FEATURE_COLS facade. Empty `featureIds` ⇒ empty maps (no query).
 */
async function fetchDimensionMaps(
  harnesses: readonly string[],
  featureIds: string[],
): Promise<{
  planMap: Map<string, { planSlug: string | null; planItemIds: string[] }>;
  spineMap: Map<string, { role: string; status: string }>;
}> {
  const planMap = new Map<string, { planSlug: string | null; planItemIds: string[] }>();
  const spineMap = new Map<string, { role: string; status: string }>();
  if (featureIds.length === 0 || harnesses.length === 0) return { planMap, spineMap };
  const { sql } = getOrgPg();
  const planRows = await sql<
    { feature_id: string; source_plan_slug: string | null; source_plan_item_ids: string[] | null }[]
  >`
    SELECT feature_id, source_plan_slug, source_plan_item_ids
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ANY(${harnesses as string[]}::text[])
       AND feature_id IN ${sql(featureIds)}`;
  for (const r of planRows) {
    planMap.set(r.feature_id, { planSlug: r.source_plan_slug ?? null, planItemIds: r.source_plan_item_ids ?? [] });
  }
  // DISTINCT ON (feature_id) + ORDER BY started_at DESC = the LATEST spawn per feature.
  const spineRows = await sql<{ feature_id: string; child_role: string; status: string }[]>`
    SELECT DISTINCT ON (feature_id) feature_id, child_role, status
      FROM harness_shared.spawned_agents
     WHERE harness_slug = ANY(${harnesses as string[]}::text[])
       AND feature_id IN ${sql(featureIds)}
     ORDER BY feature_id, started_at DESC`;
  for (const r of spineRows) spineMap.set(r.feature_id, { role: r.child_role, status: r.status });
  return { planMap, spineMap };
}

/**
 * The full enriched read this route serves — listWorkItems + the v2 dimension
 * joins. Exported so the `workItems.byHarness` sync-resolver entry serves the
 * IDENTICAL rows the route does (one assembly, two transports).
 */
/**
 * List-view payload diet (whole-app-sync-payload-audit-2026-07-19 P-003): the
 * unified list (WorkItemsPanel + its shared DetailPanel row, and the HTTP list
 * route) renders NONE of these heavy per-row blobs — verified across every adv /
 * device / mobile consumer — yet they dominated the 6MB `workItems.byHarness`
 * payload (payload ~920KB + terminalCompletionRef ~941KB + terminalCompletionEvidence
 * ~492KB at limit 2000). Null them out of the LIST rows so both transports shrink
 * identically. `summary` is intentionally KEPT here because DetailPanel renders it
 * off this same shared query; slimming summary belongs to the list/detail split.
 */
function slimListRow(row: EnrichedWorkItem): EnrichedWorkItem {
  return {
    ...row,
    payload: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    externalBlockers: undefined,
  };
}

export async function listEnrichedWorkItems(opts: {
  harness?: string;
  harnesses?: readonly string[];
  kind?: WorkItemKind;
  state?: string;
  limit?: number;
}): Promise<EnrichedWorkItem[]> {
  const limit = Math.min(opts.limit ?? 200, WORK_ITEMS_MAX_LIMIT);
  const workItems = await listWorkItems({
    harness: opts.harness,
    harnesses: opts.harness ? undefined : opts.harnesses,
    kind: opts.kind,
    state: opts.state,
    limit,
  });
  const featureIds = workItems.filter((w) => w.family === 'feature').map((w) => w.id);
  const harnesses = opts.harness
    ? [opts.harness]
    : opts.harnesses
      ? [...opts.harnesses]
      : [...new Set(workItems.map((item) => item.harness).filter((h): h is string => !!h))];
  const { planMap, spineMap } = await fetchDimensionMaps(harnesses, featureIds);
  return mergeWorkItemDimensions(workItems, planMap, spineMap).map(slimListRow);
}

/**
 * The single-item ENRICHED read (whole-app-sync-payload-audit phase2 P-006) — one
 * work item with the same v2 dimensions the list carries, but NOT slimmed: the
 * detail view shows the full `summary` (which the list drops) plus the `payload` /
 * completion blobs the list nulls. Backs the `workItems.detail` sync query so the
 * Detail pane fetches one row on demand instead of the whole harness carrying
 * every row's summary. Returns null when the id isn't found in this harness.
 */
export async function getEnrichedWorkItem(harness: string, id: string): Promise<EnrichedWorkItem | null> {
  const { getWorkItem } = await import('../../../work-items');
  const wi = await getWorkItem(id, harness);
  if (!wi) return null;
  const featureIds = wi.family === 'feature' ? [wi.id] : [];
  const { planMap, spineMap } = await fetchDimensionMaps([harness], featureIds);
  // NO slimListRow: the detail view is exactly the on-demand consumer of the full
  // summary + payload + completion refs the list strips.
  return mergeWorkItemDimensions([wi], planMap, spineMap)[0] ?? null;
}

const getWorkItems = defineTool({
  method: 'GET',
  path: '/harness/:slug/work-items',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const kindParam = url.searchParams.get('kind');
    const kind = kindParam && isWorkItemKind(kindParam) ? kindParam : undefined;
    const state = url.searchParams.get('state') || undefined;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '200') || 200, WORK_ITEMS_MAX_LIMIT);
    try {
      const [enriched, total] = await Promise.all([
        listEnrichedWorkItems({ harness: slug, kind, state, limit }),
        countWorkItems({ harness: slug, kind, state }),
      ]);
      // `count` = rows returned (may be capped); `total` = the true count in the
      // store for this filter, so a consumer never reads the downloaded length
      // as the total.
      return Response.json({ harness: slug, count: enriched.length, total, workItems: enriched });
    } catch (e) {
      return Response.json({ error: `work-items list failed: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

/**
 * POST /api/harness/:slug/work-items — create one work item for the harness
 * (`harness-provided-cadence-ops-2026-06-26` P-007). The generic write seam a
 * HARNESS sidecar uses to enqueue from a dispatched op: the oddsmith `prospect`
 * op (now sidecar-owned) reads the bet-analysis backlog via the GET above for
 * dedup and POSTs one generic `kind:'task'` item per survivor here (the
 * `bet-analysis` payload, D-009/D-014), instead of operator-core hard-coding
 * `createWorkItem` for it. A thin wrapper over the tested `createWorkItem` facade.
 *
 * `auth: 'loopback'` — a LOCAL sidecar enqueues over loopback (writes, unlike the
 * public read above). Body: { kind, title, summary?, payload?, createdBy?,
 * severity?, parent?, topics?, assignee? }. `kind` must be a known work-item kind.
 */
const postWorkItem = defineTool({
  method: 'POST',
  path: '/harness/:slug/work-items',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const kind = body.kind;
    if (typeof kind !== 'string' || !isWorkItemKind(kind)) {
      return Response.json({ ok: false, error: `unknown or missing work_item kind '${String(kind)}'` }, { status: 400 });
    }
    if (isDeprecatedWorkItemKind(kind)) {
      return Response.json(
        {
          ok: false,
          error: 'deprecated_kind',
          message:
            "work-item kind 'chunk' is deprecated and cannot be created; existing chunk rows remain readable.",
        },
        { status: 410 },
      );
    }
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '';
    if (!title) return Response.json({ ok: false, error: 'title required' }, { status: 400 });
    try {
      const item = await createWorkItem({
        // Born-pending (work-queue-admission-and-bulk-dedup-2026-08-24 P-002). This is
        // a SIDECAR enqueue seam — a machine emitter filing one item per survivor of
        // its own dedup pass — which is the population the admission gate exists for.
        // Nothing here has passed review, so it lands pending and the promoter judges
        // it on corpus-wide evidence. Deliberately NOT caller-overridable: an emitter
        // asserting its own admission is the bypass this gate replaces.
        admission: 'pending',
        kind,
        title,
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        harness: slug,
        payload: 'payload' in body ? body.payload : undefined,
        createdBy: typeof body.createdBy === 'string' ? body.createdBy : undefined,
        severity: body.severity as never,
        parent: typeof body.parent === 'string' ? body.parent : undefined,
        topics: Array.isArray(body.topics) ? (body.topics as string[]) : undefined,
        assignee: typeof body.assignee === 'string' ? body.assignee : undefined,
      });
      return Response.json({ ok: true, id: item.id, item });
    } catch (e) {
      return Response.json({ ok: false, error: `work-item create failed: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

export default [getWorkItems, postWorkItem];

// Exported for unit tests (the pure merge; the SQL is live-exercised).
export const __test = { mergeWorkItemDimensions };
