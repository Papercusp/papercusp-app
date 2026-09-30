/**
 * Push plan-lock changes to the lock banner (plan
 * semantic-search-fingerprint-coverage-2026-08-03, P-025 / D-042).
 *
 * The banner used to poll `/api/admin/locks/queue` on a 30s
 * `window.setInterval`. This is the push half that replaces it.
 *
 * ┌ WHY THE EXPLICIT `dedupeWindowMs` IS LOAD-BEARING ────────────────────────┐
 * │ Do not remove it, and do not let these emits fall back to the bus default.│
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The invalidation bus applies a 90s source-side dedupe per `(name, args)`
 * key, and it is FIRST-WINS, not trailing-edge: `shouldFanout()` DROPS a
 * repeat inside the window rather than deferring it
 * (`libs/generic/sync/src/server/invalidation-bus.ts:303-309`).
 *
 * A plan lock is routinely acquired and released well inside 90s. Both events
 * carry the SAME `(name, args)` key, so on the bus default the RELEASE is
 * discarded — and with the 30s poll gone there is nothing left to correct it.
 * The banner would keep showing a lock that no longer exists until some later
 * event happened to roll the window. That is strictly worse than the poll it
 * replaces (30s worst case, self-correcting by construction), which is the
 * regression D-042 caught before this shipped.
 *
 * The per-CALL override (`notifyOpts.dedupeWindowMs`, invalidation-bus.ts:339)
 * is deliberately used instead of the per-NAME bus policy proposed in
 * WI-37446: the owner DEFERRED that change, and it carries a standing
 * constraint not to lower the global default, which would re-arm the WI-840
 * invalidate storm. A per-call window touches nothing shared.
 *
 * ⚠ The PG-trigger + `queryNamesForTriggerEvent` bridge — normally the
 * idiomatic way to do this with no write sites at all — CANNOT be used here.
 * Bridged targets run through the same 90s window (invalidation-bus.ts:252-253)
 * and the bridged path has no per-call override, so it hits precisely the bug
 * WI-37446 documented. Explicit notifies are the only route with a working
 * escape hatch.
 *
 * ⚠ SCOPED TO PLAN PATHS ON PURPOSE. The file-lock guard this is called from
 * is the generic guard for EVERY agent file edit fleet-wide. Emitting on all
 * of them at a 1s window would re-create a WI-840-class fan-out storm; D-038's
 * measured 3.6 lock-changes/min is the PLAN-lock rate, not the fleet-wide file
 * -lock rate. Widening this filter is a volume decision, not a cosmetic one.
 */
import { PLANS_DIR_REL } from '../plans/source';
import { trackDetached } from '../../detached-imports';

/**
 * The sync query name the plan lock banner subscribes to. Args are
 * `{ path }` — a single scalar, per D-038: the bus dedupe key is
 * `name|args|dataHash`, so scoping on one scalar path gives every plan its
 * own dedupe bucket instead of one shared bucket for all locks.
 */
export const PLAN_LOCK_QUERY = 'planLock.byPath';

/**
 * Per-call dedupe window for lock invalidations, in ms.
 *
 * Small rather than zero: it still collapses a same-instant cross-process
 * burst (the thing source-side dedupe exists for) while letting a genuine
 * acquire→release pair through. Every lock transition is a discrete,
 * meaningful, already-rate-limited event — exactly the self-debounced-producer
 * case the per-call override was added for.
 */
export const PLAN_LOCK_DEDUPE_MS = 1_000;

/**
 * Is this lock path one the plan lock banner cares about?
 *
 * Matches the workspace-relative key `with-plan-lock.ts` / `planLockPath()`
 * build: `apps/operator/docs/plans/[archive/]<slug>.md`. Backslashes are
 * normalised so a Windows-shaped path cannot silently miss the filter.
 */
export function isPlanLockPath(lockPath: string): boolean {
  const norm = lockPath.replace(/\\/g, '/');
  return norm.startsWith(`${PLANS_DIR_REL}/`) && norm.endsWith('.md');
}

/**
 * Announce that the lock state for `paths` changed (acquired OR released).
 *
 * Fire-and-forget by design, matching every other `notifySyncInvalidate`
 * caller in this tree: a sync-bus fault must never fail — or even delay — the
 * lock operation that triggered it. Non-plan paths are filtered out, and
 * duplicates within one call are collapsed so a multi-path acquire emits once
 * per distinct plan.
 */
export function notifyPlanLockChange(paths: readonly string[]): void {
  const planPaths = [...new Set(paths.filter(isPlanLockPath))];
  if (planPaths.length === 0) return;
  void trackDetached(import('../../sync-sse'))
    .then(({ notifySyncInvalidate }) =>
      Promise.all(
        planPaths.map((path) =>
          notifySyncInvalidate(PLAN_LOCK_QUERY, { path }, undefined, {
            dedupeWindowMs: PLAN_LOCK_DEDUPE_MS,
          }),
        ),
      ),
    )
    .catch(() => {
      /* best-effort: the banner re-fetches on focus/visibility regardless */
    });
}
