/**
 * bee-completion-reconcile.ts — the post-bee-exit work-item completion safety net
 * (WI-222).
 *
 * THE GAP. The Hive's bee-placement path (the Queen's `cup:spawn { role:'bee',
 * featureId }` → operator-spawn.ts) runs a bee fire-and-forget and, on exit,
 * settles only the SPAWN row (done/failed/cancelled) — it never settles the bee's
 * WORK-ITEM. A bee that claims its feature (→ `in_progress`), implements + commits,
 * and exits rc=0 WITHOUT landing `work_items:complete` leaves the feature
 * non-terminal forever. The placement-watchdog (hive/placement-watchdog.ts) then
 * sees a dead holder on a non-terminal unit and re-places it, repeating until the
 * cursed-item circuit breaker trips (observed in hiveloop: greeting.js features
 * re-placed ~47× each; 20 downstream papercup items cursed).
 *
 * WHY THE DBOS NET DOESN'T COVER IT. The DBOS feature pipeline already closes this
 * loop deterministically on its terminal DONE (orchestrator-finalize.ts
 * `reconcileDoneStatus`, wired into `realFinalizer`). But that path NEVER runs for
 * a HIVE MEMBER harness: `orchestrator-loop.ts:resolveTickHarnesses` only sweeps
 * STARTED hive HOMES (kind:'hive'), so member coding harnesses are filtered out and
 * their features are worked EXCLUSIVELY by Queen-placed bees, never the
 * director→worker→DONE pipeline. So the bee-placement path needs its OWN equivalent
 * net — this module.
 *
 * THE COMPLETION SIGNAL (deliberately conservative, mirroring `reconcileDoneStatus`):
 *   - the bee's own claim (→ `in_progress`) is the "I engaged with this work" signal;
 *   - rc=0 + non-aborted is the "I finished my turn cleanly" signal;
 *   - only `in_progress`/`validating` → `passed` is flipped. A `todo` feature the
 *     bee never claimed is LEFT for re-placement (a bee that did nothing is never
 *     force-passed); terminal-failure states (`failing`/`deprecated`) and an explicit
 *     `blocked` deferral are never overridden; an already-`passed` feature is a no-op.
 *
 * This is the bee-path analogue of `reconcileDoneStatus`, with the identical accepted
 * trade-off: a bee that exited rc=0 leaving a CLAIMED feature `in_progress` without
 * deferring it (the persona instructs `set_state → blocked` for a real deferral) is
 * treated as "did the work, forgot to mark it" — the lesser evil versus the cursed
 * re-placement loop, bounded by the never-touch-todo/terminal-failure guard.
 *
 * Unlike `reconcileDoneStatus` (which takes a legacy `.prepare()/.get()` client that
 * the porsager `adminClientForHarness` does NOT satisfy), this routes through the
 * canonical `setWorkItemState`, so it ALSO fires the `work-item:done:<id>` +
 * dependent-`unblocked` events (work-items-events) — the downstream un-gating the
 * placement-watchdog would otherwise only notice on its next ≤30s sweep.
 */
import { runWithWorkspace } from '../workspace-als';
import { getWorkItem, setWorkItemState } from '../work-items';

/** What the spawn finalizer knows about a just-exited child. */
export interface BeeExitContext {
  /** The spawned child role (only `bee` is reconciled). */
  role: string;
  /** The child's process exit code (0 = clean). */
  exitCode: number | null;
  /** Whether the spawn was cancelled (fleet:cancel / abort) — never a completion. */
  aborted: boolean;
  /** The work-item (feature) the bee was placed on, if any. */
  featureId: string | null | undefined;
}

/**
 * Pure: does this spawn exit warrant the bee-completion reconcile? Only a `bee`
 * that exited rc=0 cleanly (not cancelled) while placed on a concrete featureId.
 * Narrows `featureId` to a string for the caller.
 */
export function shouldReconcileBeeCompletion(ctx: BeeExitContext): ctx is BeeExitContext & { featureId: string } {
  return (
    ctx.role === 'cup' &&
    ctx.exitCode === 0 &&
    !ctx.aborted &&
    typeof ctx.featureId === 'string' &&
    ctx.featureId.length > 0 &&
    ctx.featureId !== '-'
  );
}

/** The in-flight states a clean bee exit settles → `passed`. Mirrors
 *  `reconcileDoneStatus`: never force-passes `todo` (bee never engaged),
 *  `failing`/`deprecated` (recorded failure), `blocked` (deliberate deferral), or
 *  an already-`passed` feature. */
const RECONCILABLE_IN_FLIGHT: ReadonlySet<string> = new Set(['in_progress', 'validating']);

/** Injectable seams so the wiring unit-tests without a database. */
export interface BeeReconcileDeps {
  getWorkItem: typeof getWorkItem;
  setWorkItemState: typeof setWorkItemState;
  /** Best-effort provenance write; default = the real feature-audit. */
  audit: (harnessSlug: string, featureId: string, from: string) => void;
  log: (msg: string) => void;
}

/**
 * Reconcile ONE bee-worked feature: if it is still an in-flight state the bee left
 * non-terminal, flip it `→ passed` via the canonical `setWorkItemState` (so the
 * settled-events fire). Returns whether the flip was applied. Runs inside the
 * pipeline's captured workspace scope so `getWorkItem`'s active-workspace read
 * resolves the right row (the finalizer is fire-and-forget; the active workspace
 * may have moved on).
 *
 * `skipCompletionGate` (work-item-completion-integrity-2026-07-01 WI-1403, contract
 * C-1): this flip is an INFERENCE from "the bee's process exited rc=0", not a
 * genuine completion record — there is no completion body, no commit ref, and
 * `by: 'hive-bee-exit'` names the reconciler, not the claiming principal that did
 * the work. Passing a fabricated completionRef here would let a bee that silently
 * forgot to call `work_items:complete` masquerade as a verified completion — the
 * exact failure mode C-1 exists to prevent (WI-1405's genuine-completions metric
 * must NOT count this bucket). So this stays a best-effort safety net (avoiding the
 * cursed re-placement loop) that is explicitly excluded from "genuine", the same
 * bucket as the watchdog/hygiene dedup markers.
 */
export async function reconcileBeeCompletion(
  input: { harnessSlug: string; featureId: string; workspaceId: string },
  deps: Partial<BeeReconcileDeps> = {},
): Promise<boolean> {
  const get = deps.getWorkItem ?? getWorkItem;
  const set = deps.setWorkItemState ?? setWorkItemState;
  const log = deps.log ?? ((m) => console.log(m));
  const { harnessSlug, featureId, workspaceId } = input;
  return runWithWorkspace(workspaceId, async () => {
    const wi = await get(featureId, harnessSlug);
    if (!wi) return false;
    if (!RECONCILABLE_IN_FLIGHT.has(wi.state)) return false;
    const prior = wi.state;
    const updated = await set(featureId, 'passed', {
      harness: harnessSlug,
      by: 'hive-bee-exit',
      skipCompletionGate: true,
    });
    const flipped = updated?.state === 'passed';
    if (flipped) {
      log(
        `[bee-exit-reconcile] ${harnessSlug}/${featureId} status reconciled ${prior}→passed ` +
          `(bee exited rc=0 without landing work_items:complete)`,
      );
      const auditFn = deps.audit;
      if (auditFn) {
        auditFn(harnessSlug, featureId, prior);
      } else {
        try {
          const { auditFeatureChange } = await import('../feature-audit');
          auditFeatureChange(harnessSlug, featureId, 'status', prior, 'passed', 'hive-bee-exit');
        } catch {
          /* best-effort provenance — never fail the reconcile on an audit miss */
        }
      }
    }
    return flipped;
  });
}

/**
 * Gate + reconcile in one call for the spawn finalizer. Best-effort: the predicate
 * gates non-bee / crashed / cancelled / featureless exits to a no-op, and any
 * thrown error (DB hiccup) is swallowed — bee completion bookkeeping must never
 * fail the spawn finalizer.
 */
export async function maybeReconcileBeeCompletion(
  ctx: BeeExitContext & { harnessSlug: string; workspaceId: string },
  deps: Partial<BeeReconcileDeps> = {},
): Promise<boolean> {
  if (!shouldReconcileBeeCompletion(ctx)) return false;
  try {
    return await reconcileBeeCompletion(
      { harnessSlug: ctx.harnessSlug, featureId: ctx.featureId, workspaceId: ctx.workspaceId },
      deps,
    );
  } catch (e) {
    (deps.log ?? ((m) => console.warn(m)))(
      `[bee-exit-reconcile] ${ctx.harnessSlug}/${ctx.featureId} reconcile failed (non-fatal): ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
