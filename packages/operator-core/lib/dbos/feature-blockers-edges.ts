/**
 * Feature→feature blocking on canonical `work_item_deps` rows. Migration 935 retires
 * the historical work-item `blocks` copies in coord_links; polymorphic/non-work links
 * remain there.
 *
 * A feature F blocked-by G is the edge:
 *   coord_links { workspace_id='default', rel='blocks', src_kind='feature',
 *                 src_ref=featureRef(harness, G)  // the BLOCKER
 *                 dst_kind='feature', dst_ref=featureRef(harness, F) }  // the BLOCKED
 * mirroring the issue→feature convention (issue-blocks-merge.ts: src `blocks` dst),
 * reusing su-a5a32's harness-qualified `featureRef` so 'F-001' can't collide across
 * harnesses. Distinct from ISSUE→feature blocking (src_kind='issue') — that's the
 * engineer-issues overlay; this is the feature-dependency the dispatch frontier reads.
 *
 * The dispatch frontier reads blocker sets from HERE unconditionally — these edges are the single source of truth for
 * feature blocking (the legacy `blocked_by` column + hfc_blocked_by_gin_idx were
 * dropped in migration 155). The feature-import write-path (features.ts) keeps them
 * current via syncFeatureBlockEdges.
 */
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { featureRef, FEATURE_KIND, isQualifiedFeatureRef } from '../issue-blocks-merge';
import {
  getWorkItemDepBlockers,
  syncWorkItemDepEdges,
  wouldCreateCycle,
  type WorkItemDependencyWriterOptions,
} from './work-item-deps-store';
import { detectDependencyCycle } from '../feature-deps';

/**
 * For one harness, every feature with ≥1 feature→feature `blocks` edge, keyed by the
 * blocked feature_id → its blocker feature_ids (within-harness, prefix-stripped). The
 * Pure read.
 */
export async function getFeatureBlockers(harnessSlug: string): Promise<Map<string, string[]>> {
  return new Map(
    [...(await getWorkItemDepBlockers(harnessSlug))].map(([blocked, blockers]) => [
      blocked,
      blockers.map((blocker) => blocker.id),
    ]),
  );
}

/**
 * Sync ONE feature's canonical feature→feature `blocks` edges to its current
 * `blocked_by` list (delete the feature's existing blocker edges, insert the new
 * set). Idempotent.
 * Transactional so a read never sees a half-updated blocker set.
 *
 * ACYCLICITY (P-003, audit finding F4): this is the AUTHORITATIVE blocks-edge writer,
 * so the cycle guard lives HERE. A feature→feature `blocks` cycle silently DEADLOCKS the
 * dispatch frontier (every item in the cycle is forever non-ready — its blocker never
 * terminates), so a cycle-closing set is REJECTED (throws) rather than written. P-006 routes
 * this facade through `mutateWorkItemDependencies`, whose full typed candidate analysis is the
 * guarantee. The old `enforceAcyclicity:false` escape hatch is deliberately gone: a backfill is
 * either admitted by the same policy or is an explicitly capability-confined SQL migration.
 */
export async function syncFeatureBlockEdges(
  harnessSlug: string,
  featureId: string,
  blockedBy: readonly string[],
  opts: WorkItemDependencyWriterOptions = {},
): Promise<void> {
  await syncWorkItemDepEdges(harnessSlug, featureId, blockedBy, opts);
}

/** One feature→feature `blocks` edge row, ready to INSERT into coord_links. */
export interface FeatureBlockEdge {
  workspace_id: string;
  src_kind: string;
  src_ref: string;
  dst_kind: string;
  dst_ref: string;
  rel: string;
}

/**
 * Pure: expand a feature's `blocked_by` (blocker feature ids) into coord_links
 * edge rows. The shared core of the backfill migration + its equivalence test, so
 * the migration's SQL and the read can't silently diverge. Self-edges + empty refs
 * dropped (mirrors resolveBlockedByRefs).
 */
export function featureBlockEdges(
  harnessSlug: string,
  featureId: string,
  blockedBy: readonly string[],
): FeatureBlockEdge[] {
  const out: FeatureBlockEdge[] = [];
  for (const blocker of blockedBy) {
    const b = blocker.trim();
    if (!b || b === featureId) continue;
    out.push({
      workspace_id: DEFAULT_COORD_WORKSPACE,
      src_kind: FEATURE_KIND,
      src_ref: featureRef(harnessSlug, b),
      dst_kind: FEATURE_KIND,
      dst_ref: featureRef(harnessSlug, featureId),
      rel: 'blocks',
    });
  }
  return out;
}

/**
 * Acyclicity guard for the LINK tools (P-003, audit finding F4): would ADDING the single
 * feature→feature `blocks` edge "blocker blocks blocked" (within `harnessSlug`) close a cycle in
 * the LIVE graph? The link tools (issues:link / work_items:link) create one coord_links edge at a
 * time — bypassing syncFeatureBlockEdges' replace-semantics guard — so they call this to reject a
 * cycle-closing edge BEFORE the write. Loads the live graph (getFeatureBlockers), appends the new
 * blocker to the blocked feature's existing set, and reuses `wouldCreateCycle`. A self-edge is not
 * a cycle here (blocked === blocker is dropped by the writer / no-self-block invariant).
 */
export async function wouldFeatureBlockEdgeCreateCycle(
  harnessSlug: string,
  blockedFeatureId: string,
  blockerFeatureId: string,
): Promise<boolean> {
  if (blockedFeatureId === blockerFeatureId) return false;
  const current = await getFeatureBlockers(harnessSlug);
  const merged = Array.from(new Set([...(current.get(blockedFeatureId) ?? []), blockerFeatureId]));
  return wouldCreateCycle(current, blockedFeatureId, merged);
}

/**
 * Tool-facing acyclicity guard (P-003, audit finding F4): given the coord_links refs a `blocks`
 * edge would write — `srcRef` is the BLOCKER, `dstRef` the BLOCKED (the src-blocks-dst convention) —
 * reject it iff it closes a feature→feature cycle. A no-op (returns null) for any edge that is NOT
 * feature→feature within ONE harness (cross-kind / cross-harness edges can't form a feature-frontier
 * deadlock, so they're out of scope here). Returns a ready-to-surface error string when the edge
 * would cycle, else null. The link tools call this before writing a raw coord_links 'blocks' edge.
 */
export async function guardFeatureBlockEdgeAcyclic(srcRef: string, dstRef: string): Promise<string | null> {
  if (!isQualifiedFeatureRef(srcRef) || !isQualifiedFeatureRef(dstRef)) return null;
  const srcHash = srcRef.indexOf('#');
  const dstHash = dstRef.indexOf('#');
  const blockerHarness = srcRef.slice(0, srcHash);
  const blockedHarness = dstRef.slice(0, dstHash);
  if (blockerHarness !== blockedHarness) return null; // cross-harness — not a single-harness frontier cycle
  const blockerId = srcRef.slice(srcHash + 1);
  const blockedId = dstRef.slice(dstHash + 1);
  if (await wouldFeatureBlockEdgeCreateCycle(blockedHarness, blockedId, blockerId)) {
    return `'blocks' edge ${srcRef} → ${dstRef} would create a feature-dependency cycle — rejected (a cycle permanently deadlocks the scheduler frontier)`;
  }
  return null;
}

/**
 * Read-only RECONCILIATION (P-003, audit finding F4): detect any PRE-EXISTING cycle in the
 * LIVE feature→feature blocks graph for `harnessSlug`. The write-path guard (syncFeatureBlockEdges)
 * stops NEW cycles, but a cycle predating the guard (or one written through a path that bypassed it)
 * would silently deadlock the frontier forever — this surfaces it. Pure detection: loads the live
 * graph via getFeatureBlockers and runs `detectDependencyCycle`. Returns the cycle members (empty
 * when acyclic) and, when a cycle is found, logs a loud warning so a reconciliation sweep can act.
 */
export async function detectFeatureBlockGraphCycle(
  harnessSlug: string,
): Promise<{ hasCycle: boolean; cycleNodes: string[] }> {
  const current = await getFeatureBlockers(harnessSlug);
  const result = detectDependencyCycle(current);
  if (result.hasCycle) {
    console.warn(
      `[feature-blockers-edges] PRE-EXISTING feature-dependency CYCLE in harness '${harnessSlug}' among: ${result.cycleNodes.join(', ')} — these features are permanently non-ready (frontier deadlock); reconcile the blocks edges`,
    );
  }
  return result;
}
