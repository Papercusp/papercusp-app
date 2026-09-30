/**
 * `system:doc-anchor-reconcile` — the periodic FULL doc-anchor reconcile (#5 PART B).
 *
 * The git-sync sweep (`sweep-after-sync.ts`) re-derives a doc's denormalised anchor
 * cache ONLY when its FILE changed in that tick (re-anchor-on-change). That misses a
 * STALE cache that slipped past — a `documents:` frontmatter edit in a tick whose diff
 * range the sweep never saw (a force-push / squash / a sync with no prev↔head), a record
 * seeded before the re-anchor logic existed, or a partial-failure that left the cache
 * half-written. A stale anchor cache silently makes the freshness reverse-index match the
 * WRONG paths → real drift is missed and unrelated changes false-flag.
 *
 * This handler runs `reconcileAllDocAnchors` for the routine's harness: re-derive anchors
 * from CURRENT frontmatter for ALL anchor-derived (manual/augmented) docs and rewrite the
 * cache where it drifted — reusing the same `anchorManualDoc` + `recomputeDocStatus` path
 * the sweep's self-bootstrap loop uses. Generated docs are skipped (their anchors + baseline
 * belong to the documenter regeneration, not author frontmatter).
 *
 * Pure DB/git maintenance — spawns no agent, makes no LLM call. Idempotent + safe to re-run
 * from the top (a clean cache is a no-op), as system actions must be (they replay on recovery).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';

registerSystemAction('doc-anchor-reconcile', async (ctx: SystemActionCtx) => {
  const { reconcileAllDocAnchors } = await import('../docs/sweep-after-sync');
  const r = await reconcileAllDocAnchors(ctx.installSlug, ctx.workspaceId);
  console.log(
    `[doc-anchor-reconcile] "${ctx.installSlug}" (ws=${ctx.workspaceId}): ` +
      `scanned ${r.scanned} anchor-derived doc(s), reconciled ${r.reconciled} stale cache(s)` +
      `${r.failed ? `, ${r.failed} re-anchor failure(s)` : ''}`,
  );
});
