/**
 * work-item-blocking — the dependency/readiness SEAM (work-item-deps-and-readiness-2026-06-22 P-001).
 *
 * Consumers (the scheduler's get_next/claim path, the Queen survey, the readiness column
 * maintainer) call THIS, never the dependency table directly. That decouples them from where
 * blocking is stored, so the storage can evolve. Work-item→work-item `blocks` edges now live in
 * `work_item_deps`; `coord_links` remains the polymorphic store for every other relation and for
 * blocks whose endpoint is not a work item.
 *
 * The READINESS LOGIC is the existing pure predicate in dbos/frontier-readiness.ts (the "one
 * frontier, two views" keystone) — reused verbatim, NOT forked. This module adds (a) the storage
 * seam, and (b) the cross-family terminal set that fixes F2: a feature is terminal at
 * passed/deprecated, an ISSUE at resolved/closed — so an issue blocking a feature counts as
 * satisfied when resolved (the shared predicate previously only knew the feature set).
 */
import { PgLinkStore, type LinkRow, type ObjectRef } from '@papercusp/coordination/capabilities';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { getOrgPg } from '@papercusp/db-org';
import { getFeatureBlockers } from './dbos/feature-blockers-edges';
import { getWorkItemDepBlockers, workItemDepEdgeReader, type WorkItemBlockerRequirement } from './dbos/work-item-deps-store';
import { selectReady, TERMINAL_STATUSES, type ReadinessNode } from './dbos/frontier-readiness';
import { activeWorkspaceId } from './workspace-registry';

/** Issue-family terminal statuses (work-items.ts ISSUE_FAMILY_STATES: open/resolved/closed).
 *  work-item-status-full-unify (2026-07-19): + the unified terminals (`done`/`dropped`) as a
 *  TRANSITIONAL SUPERSET across the status-backfill migration (resolved→done, closed→dropped).
 *  Narrow to ['done','dropped'] after the cleanup pass. */
export const ISSUE_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['resolved', 'closed', 'done', 'dropped']);

/** The terminal set SPLIT by outcome — "it landed" vs "it was abandoned".
 *
 *  `ISSUE_TERMINAL_STATUSES` answers "is this finished?", which is all a
 *  blocking edge needs. Any surface REPORTING the loop's output needs the
 *  finer question "did it SHIP?", and the two must never be summed: a dropped
 *  idea is not a delivered one.
 *
 *  Each set pairs the unified spelling with its legacy alias (resolved≡done,
 *  closed≡dropped) because both still exist in the union during the
 *  work-item-status-full-unify transition. Hand-writing either list in a
 *  `WHERE state IN (...)` is how EI-18792873324746237 happened: the Learning
 *  tab's funnel filtered the PRE-flip spellings only, so 137 shipped ideas
 *  counted as 0 — a plausible-looking zero that no type checker can catch.
 *  Import these instead of retyping the members.
 *
 *  Invariant (asserted in work-item-blocking.test.ts): SHIPPED and ABANDONED
 *  partition ISSUE_TERMINAL_STATUSES — disjoint, and together exhaustive. That
 *  test is what fails if a future state joins the enum without being classified. */
export const ISSUE_SHIPPED_STATUSES: ReadonlySet<string> = new Set(['done', 'resolved']);
export const ISSUE_ABANDONED_STATUSES: ReadonlySet<string> = new Set(['dropped', 'closed']);

/**
 * Cross-family terminal set (F2): feature {passed,deprecated} ∪ issue {resolved,closed}. A blocker
 * in EITHER family is "satisfied" when terminal in its own vocabulary. (Dissolved entirely once the
 * work-item unification gives one state vocabulary — P-009 — but correct in the interim.)
 */
export const ALL_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  ...TERMINAL_STATUSES,
  ...ISSUE_TERMINAL_STATUSES,
]);
export const ALL_SUCCESSFUL_STATUSES: ReadonlySet<string> = new Set(['passed', 'resolved', 'done']);

/** A work-item's minimal identity for readiness (canonical, prefix-stripped id + its status). */
export interface BlockingNode {
  id: string;
  status: string;
  /** Active external blockers (events, gates, runtime, human dependencies). Empty when none. */
  externalBlockers?: readonly string[];
}

/**
 * The dependency STORAGE seam. One method: given a harness, return blocked-id → blocker-ids.
 * Swap the implementation (coord_links → work_item_deps → FK) without touching consumers.
 */
export interface BlockingStore {
  /** blocked id → its blocker ids, within `harnessSlug` (within-harness, prefix-stripped). */
  blockersFor(harnessSlug: string): Promise<Map<string, WorkItemBlockerRequirement[]>>;
}

/**
 * Historical compatibility name. `getFeatureBlockers` now reads the canonical
 * `work_item_deps` table, so this is no longer a distinct coord_links backend.
 */
export const coordLinksBlockingStore: BlockingStore = {
  blockersFor: async (harnessSlug: string) =>
    new Map([...(await getFeatureBlockers(harnessSlug))].map(([id, blockers]) => [id, blockers.map((blocker) => ({ id: blocker, satisfaction: 'settled' as const }))])),
};

/**
 * Canonical backend: the dedicated `work_item_deps` table.
 */
export const workItemDepsBlockingStore: BlockingStore = {
  blockersFor: (harnessSlug: string) => getWorkItemDepBlockers(harnessSlug),
};

/**
 * P-004 makes every readiness consumer read the same canonical table as the scheduler claim floor.
 */
export const defaultBlockingStore: BlockingStore = workItemDepsBlockingStore;

/**
 * The edge-LEVEL blocking seam (linking-notify-family-hardening P-005) — the
 * unblocked-EVENT emitter's counterpart to `BlockingStore`.
 *
 * `blockersFor` is a within-harness, id-only projection: it CANNOT represent the
 * polymorphic (kind, ref) edges the emitter needs — a bug can block a feature
 * across harnesses; `work_items:link` keys on ObjectRef, not the physical table.
 * So edge consumers read through THIS interface instead. Work-item blocks come from
 * `work_item_deps`; non-work blocks and every other relation are merged from the caller's
 * correctly-scoped coord_links store.
 */
export interface BlockingEdgeReader {
  listOut(src: ObjectRef, opts?: { rel?: string }): Promise<LinkRow[]>;
  listIn(dst: ObjectRef, opts?: { rel?: string }): Promise<LinkRow[]>;
  /** Batched listOut: ONE kind-grouped query for many srcs — never a per-src loop. */
  listOutMany(srcs: ObjectRef[], opts?: { rel?: string }): Promise<LinkRow[]>;
  /** Batched listIn: ONE kind-grouped query for many dsts — never a per-dst loop. */
  listInMany(dsts: ObjectRef[], opts?: { rel?: string }): Promise<LinkRow[]>;
}

const edgeLinkStore = new PgLinkStore({
  getSql: () => getOrgPg().sql,
  ensureSchema: async () => {},
  // Feature-family work items write their coord links in the active workspace.
  // Keep this resolver on the long-lived reader so work_items:links does not
  // silently query the legacy DEFAULT_COORD_WORKSPACE partition.
  workspaceId: DEFAULT_COORD_WORKSPACE,
  getWorkspaceId: () => activeWorkspaceId(),
});

const WORK_ITEM_KINDS = new Set(['issue', 'feature']);

function isWorkItemBlock(row: LinkRow): boolean {
  return row.rel === 'blocks' && WORK_ITEM_KINDS.has(row.src.kind) && WORK_ITEM_KINDS.has(row.dst.kind);
}

function edgeKey(row: LinkRow): string {
  return `${row.src.kind}\0${row.src.ref}\0${row.rel}\0${row.dst.kind}\0${row.dst.ref}`;
}

function mergeBlockingRows(coordRows: LinkRow[], depRows: LinkRow[]): LinkRow[] {
  const merged = new Map<string, LinkRow>();
  // work_item_deps is authoritative only for work-item→work-item blocks. Every other
  // coord relation — including issue→plan_item blocks — remains on coord_links.
  for (const row of coordRows) if (!isWorkItemBlock(row)) merged.set(edgeKey(row), row);
  for (const row of depRows) if (isWorkItemBlock(row)) merged.set(edgeKey(row), row);
  return [...merged.values()].sort(
    (a, b) => a.created_ts.localeCompare(b.created_ts) || a.id - b.id || edgeKey(a).localeCompare(edgeKey(b)),
  );
}

/**
 * Hybrid compatibility reader for the polymorphic Linkable surface.
 *
 * Work-item `blocks` edges come only from canonical work_item_deps. Non-work blocks
 * and every other relation stay on the caller's correctly-scoped PgLinkStore. The
 * filter is intentionally source-wide rather than "prefer canonical when present":
 * a stale coord_links duplicate must never resurrect after its canonical edge is removed.
 */
export function createBlockingEdgeReader(
  coordStore: Pick<BlockingEdgeReader, 'listOut' | 'listIn' | 'listOutMany' | 'listInMany'>,
  depStore: BlockingEdgeReader = workItemDepEdgeReader,
): BlockingEdgeReader {
  const merge = async (coord: Promise<LinkRow[]>, deps: Promise<LinkRow[]>): Promise<LinkRow[]> => {
    const [coordRows, depRows] = await Promise.all([coord, deps]);
    return mergeBlockingRows(coordRows, depRows);
  };
  return {
    listOut: (src, opts) => merge(coordStore.listOut(src, opts), workItemDepsFor(opts, () => depStore.listOut(src, opts))),
    listIn: (dst, opts) => merge(coordStore.listIn(dst, opts), workItemDepsFor(opts, () => depStore.listIn(dst, opts))),
    listOutMany: (srcs, opts) =>
      merge(coordStore.listOutMany(srcs, opts), workItemDepsFor(opts, () => depStore.listOutMany(srcs, opts))),
    listInMany: (dsts, opts) =>
      merge(coordStore.listInMany(dsts, opts), workItemDepsFor(opts, () => depStore.listInMany(dsts, opts))),
  };
}

function workItemDepsFor(opts: { rel?: string } | undefined, read: () => Promise<LinkRow[]>): Promise<LinkRow[]> {
  return opts?.rel != null && opts.rel !== 'blocks' ? Promise.resolve([]) : read();
}

/** The production edge reader: canonical work-item blocks + coord_links compatibility edges. */
export const blockingEdgeReader: BlockingEdgeReader = createBlockingEdgeReader(edgeLinkStore);

/** The three edge sets a settle fans out on (WI-10003631): outgoing `blocks`
 *  (merged with canonical work_item_deps exactly as `blockingEdgeReader.listOut`
 *  merges them), outgoing `fixes`, and incoming `duplicates`. */
export interface SettleEdges {
  blocksOut: LinkRow[];
  fixesOut: LinkRow[];
  duplicatesIn: LinkRow[];
}

/** One coord_links statement (plus the canonical deps read, concurrently) instead of
 *  three separate `listOut`/`listIn` reads per settle. Row sets are identical to
 *  `blockingEdgeReader.listOut(ref,{rel:'blocks'})`, `.listOut(ref,{rel:'fixes'})`
 *  and `.listIn(ref,{rel:'duplicates'})`. */
export async function readSettleEdges(
  ref: ObjectRef,
  store: Pick<PgLinkStore, 'listAround'> = edgeLinkStore,
  depStore: Pick<BlockingEdgeReader, 'listOut'> = workItemDepEdgeReader,
): Promise<SettleEdges> {
  const [around, depBlocks] = await Promise.all([
    store.listAround(ref, { outRels: ['blocks', 'fixes'], inRels: ['duplicates'] }),
    depStore.listOut(ref, { rel: 'blocks' }),
  ]);
  return {
    blocksOut: mergeBlockingRows(around.out.filter((r) => r.rel === 'blocks'), depBlocks),
    fixesOut: around.out.filter((r) => r.rel === 'fixes'),
    duplicatesIn: around.in.filter((r) => r.rel === 'duplicates'),
  };
}

/** Build readiness nodes from items + a blocker map (pure). */
export function toReadinessNodes(
  items: readonly BlockingNode[],
  blockers: ReadonlyMap<string, readonly (string | WorkItemBlockerRequirement)[]>,
): ReadinessNode[] {
  return items.map((it) => ({
    id: it.id,
    status: it.status,
    blockedBy: blockers.get(it.id) ?? [],
    ...(it.externalBlockers && it.externalBlockers.length > 0 ? { externalBlockers: it.externalBlockers } : {}),
  }));
}

/**
 * Partition items into ready/blocked over a blocker map, using the cross-family terminal set.
 * Pure — the DB-coupled part is fetching `items` + `store.blockersFor(...)`; this composes them
 * with the shared `selectReady` predicate so the claim path and the survey share ONE readiness.
 */
export function partitionReady(
  items: readonly BlockingNode[],
  blockers: ReadonlyMap<string, readonly (string | WorkItemBlockerRequirement)[]>,
  dispatchable: ReadonlySet<string>,
  owned: ReadonlySet<string> = new Set<string>(),
): { ready: ReadinessNode[]; blocked: ReadinessNode[] } {
  return selectReady(toReadinessNodes(items, blockers), owned, dispatchable, ALL_TERMINAL_STATUSES, ALL_SUCCESSFUL_STATUSES);
}

/** Is one item ready right now, given the full node set + the blocker map? (Convenience over partitionReady.) */
export function isReady(
  itemId: string,
  items: readonly BlockingNode[],
  blockers: ReadonlyMap<string, readonly (string | WorkItemBlockerRequirement)[]>,
  dispatchable: ReadonlySet<string>,
  owned: ReadonlySet<string> = new Set<string>(),
): boolean {
  return partitionReady(items, blockers, dispatchable, owned).ready.some((n) => n.id === itemId);
}
