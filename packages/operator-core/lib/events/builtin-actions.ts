/**
 * Built-in NON-TOOL reaction actions (caching-layer-tag-eca-2026-06-22 P-004).
 *
 * A reaction `fire` is *usually* a projected-tool MCP name dispatched through the
 * auth/quota/audit dispatcher (`dispatch-reaction.ts`). But some first-party
 * reactions are pure in-process side effects with no tool surface — invalidating
 * the operator's cache is the motivating one. Routing a cache bump through a
 * projected tool would be ceremony with no payoff (no caller args to validate, no
 * capability to gate, no audit row worth keeping per table-change).
 *
 * So the dispatch layer recognises a small, closed set of `<group>.<verb>`
 * built-in action names HERE and runs them directly. They are workspace-scoped
 * (the caller resolved the workspace from the trigger ctx) and never throw —
 * they return the same `{ ok, error }` shape the engine logs.
 *
 * Add a new built-in by adding a case
 * to {@link fireBuiltinReactionAction} and its name to {@link BUILTIN_ACTIONS}.
 */

import type { FireReactionResult } from "./dispatch-reaction";
import { getOperatorCache } from "../cache/instance";
import { coalescedInvalidateByTags } from "../cache/debounced-invalidate";
import { invalidateL2ByTags } from "../cache/l2-tier";
import {
  reconcileLinkedWorkItemsForCompletedPlanItems,
  resyncDependentPlanItemLanesNow,
  resyncPlanItemLaneNow,
  type CompletedPlanItem,
} from "../plan-items/reconcile-linked-work-items";

/** The action name the cache-invalidation reaction fires. */
export const CACHE_BUMP_TAGS_ACTION = "cache.bumpTags";

/** EI-5925: the action name plan-items/reconcile-rule.ts fires when one or more
 *  plan items just transitioned to `done`, to auto-resolve any OTHER work-item
 *  still pointing at them (the reverse mirror of reflect-rules.ts). */
export const PLAN_ITEM_RECONCILE_ACTION = "plan-item.reconcileLinkedWorkItems";

/** EI-18732669095544832: the action name plan-items/lane-sync-rule.ts fires when a
 *  plan item's `blocked-by:` edge changes (`plans:set-item-blocked-by`), to resync
 *  that item's CURRENT effective lane (blocked/needs-human/actionable) onto its
 *  linked work-items RIGHT NOW, instead of waiting for the 15-min periodic sweep. */
export const PLAN_ITEM_LANE_RESYNC_ACTION = "plan-item.resyncLane";

/** P-004 (deterministic-plan-state-derivation-2026-08-31): the action name
 *  plan-items/plan-drain-rule.ts fires when a `plans:set-status` flip crosses
 *  the terminal boundary, to move the PLAN's lifecycle status when its item
 *  graph now warrants a different one (ready/active → awaiting-acceptance once
 *  drained, and back when an item reopens). Never ships a plan. */
export const PLAN_DRAIN_TRANSITION_ACTION = "plan.applyDrainTransition";

/** EI-19944784972017743: the action name deployment/account-default-marker-rule.ts
 *  fires when the owner's account override row changes, to re-publish THIS process's
 *  `PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE` marker. The marker is per-PROCESS, so without
 *  this a SIBLING long-lived host (bg-host) keeps its boot-time value and goes on
 *  routing in-process anthropic-direct calls at `~/.claude` after the owner has
 *  nominated a default pool account — the exact traffic setting a default is meant
 *  to move. Rides the change stream the override table already emits. */
export const ACCOUNT_DEFAULT_MARKER_SYNC_ACTION = "accounts.syncDefaultMarker";

/** green-gate-zero-wait P-001: a confirmed frozen-lineage admission pulls the existing
 * system:green-checkpoint routine due immediately after re-validating the live queue tuple. */
export const GATE_REJUDGE_ADMITTED_REPAIR_ACTION = "gate.rejudgeAdmittedRepair";

/** The closed set of recognised built-in (non-tool) reaction action names. */
export const BUILTIN_ACTIONS: ReadonlySet<string> = new Set<string>([
  CACHE_BUMP_TAGS_ACTION,
  PLAN_ITEM_RECONCILE_ACTION,
  PLAN_ITEM_LANE_RESYNC_ACTION,
  PLAN_DRAIN_TRANSITION_ACTION,
  ACCOUNT_DEFAULT_MARKER_SYNC_ACTION,
  GATE_REJUDGE_ADMITTED_REPAIR_ACTION,
]);

/** Whether `fire` names a built-in in-process action (vs a projected tool). */
export function isBuiltinReactionAction(fire: string): boolean {
  return BUILTIN_ACTIONS.has(fire);
}

/** Coerce an args value to a clean string[] of tags (drop empties / non-strings). */
function toTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
}

/** Coerce an args value to a clean CompletedPlanItem[] (drop malformed entries). */
function toCompletedPlanItems(value: unknown): CompletedPlanItem[] {
  if (!Array.isArray(value)) return [];
  const out: CompletedPlanItem[] = [];
  for (const v of value) {
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { planSlug?: unknown }).planSlug === "string" &&
      typeof (v as { itemId?: unknown }).itemId === "string"
    ) {
      const harnessSlug = typeof (v as { harnessSlug?: unknown }).harnessSlug === "string"
        ? (v as { harnessSlug: string }).harnessSlug
        : null;
      // EI-18677799334390930: carry the best-effort resolved triggering actor
      // through to the reconciler so it can attribute the terminal close it stamps.
      const triggeredBy = typeof (v as { triggeredBy?: unknown }).triggeredBy === "string"
        ? (v as { triggeredBy: string }).triggeredBy
        : null;
      out.push({
        planSlug: (v as { planSlug: string }).planSlug,
        itemId: (v as { itemId: string }).itemId,
        harnessSlug,
        ...(triggeredBy ? { triggeredBy } : {}),
      });
    }
  }
  return out;
}

/** One { planSlug, itemId, harnessSlug } target for `plan-item.resyncLane`. */
interface LaneResyncItem {
  planSlug: string;
  itemId: string;
  harnessSlug: string | null;
}

/** Coerce an args value to a clean LaneResyncItem[] (drop malformed entries). */
function toLaneResyncItems(value: unknown): LaneResyncItem[] {
  if (!Array.isArray(value)) return [];
  const out: LaneResyncItem[] = [];
  for (const v of value) {
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { planSlug?: unknown }).planSlug === "string" &&
      typeof (v as { itemId?: unknown }).itemId === "string"
    ) {
      const harnessSlug = typeof (v as { harnessSlug?: unknown }).harnessSlug === "string"
        ? (v as { harnessSlug: string }).harnessSlug
        : null;
      out.push({ planSlug: (v as { planSlug: string }).planSlug, itemId: (v as { itemId: string }).itemId, harnessSlug });
    }
  }
  return out;
}

/** Coerce the `plans` arg of {@link PLAN_DRAIN_TRANSITION_ACTION}. Unlike the
 *  lane-resync items this needs no `itemId`: the transition is a statement
 *  about the PLAN, and which item's flip triggered it is irrelevant to the
 *  decision (the action re-derives from the whole graph). De-duplicated because
 *  a bulk flip of N items fans into N events naming the SAME plan — the action
 *  is idempotent, so this only saves N-1 locked reads. The key is a JSON tuple
 *  rather than a joined string so no separator can collide with a slug. */
function toDrainTransitionPlans(
  value: unknown,
): Array<{ planSlug: string; harnessSlug: string | null }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ planSlug: string; harnessSlug: string | null }> = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (v && typeof v === "object" && typeof (v as { planSlug?: unknown }).planSlug === "string") {
      const planSlug = (v as { planSlug: string }).planSlug;
      const harnessSlug =
        typeof (v as { harnessSlug?: unknown }).harnessSlug === "string"
          ? (v as { harnessSlug: string }).harnessSlug
          : null;
      const key = JSON.stringify([harnessSlug, planSlug]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ planSlug, harnessSlug });
    }
  }
  return out;
}

/**
 * Run a built-in reaction action in-process. Never throws — returns
 * `{ ok:false, error }` on a bad/unknown action so the engine can log it.
 *
 * `cache.bumpTags { tags: string[] }` — bumps the per-(workspace, tag)
 * generation for each tag on the operator's singleton cache, lazily marking
 * every `getOrSet` entry carrying any of those tags stale on its next read. The
 * workspace is the trigger's (D-010): tags never cross a workspace boundary.
 *
 * Routed through `coalescedInvalidateByTags` (P-008/D-006): tags for the
 * APPEND-HEAVY log tables (coord_event_log, …) are DEBOUNCED — coalesced to at
 * most one bump per window — so an append storm can't tank a consumer's hit-rate;
 * every other tag bumps immediately, unchanged.
 *
 * `plan-item.reconcileLinkedWorkItems { completedItems: {planSlug,itemId}[] }`
 * (EI-5925) — for each just-completed plan item, auto-resolve any OTHER
 * work-item still linked to it (no independent in-flight progress). See
 * plan-items/reconcile-linked-work-items.ts. Always `{ok:true}` (the sweep is
 * internally fail-safe per item) unless the args are entirely malformed.
 *
 * `plan-item.resyncLane { items?: {planSlug,itemId,harnessSlug}[],
 *                        dependencies?: {planSlug,itemId,harnessSlug}[] }`
 * (EI-18732669095544832) — for each item, re-classify its CURRENT effective
 * lane (blocked-by-graph aware) and sync it onto every linked work-item RIGHT
 * NOW, instead of waiting for the 15-min `plan-item-orphan-reconcile` sweep.
 * EI-21018197537550703 extends the SAME action with `dependencies`: each target
 * is a dependency whose terminality changed, so the action re-reads the plan,
 * enumerates its direct dependents, and resyncs their current effective lanes.
 * See plan-items/reconcile-linked-work-items.ts's `resyncPlanItemLaneNow`.
 * Always `{ok:true}` (fail-safe per item) unless the args are entirely
 * malformed.
 */
export async function fireBuiltinReactionAction(
  fire: string,
  args: Record<string, unknown>,
  workspaceId: string,
): Promise<FireReactionResult> {
  switch (fire) {
    case CACHE_BUMP_TAGS_ACTION: {
      const tags = toTags(args.tags);
      if (tags.length === 0) {
        // No tags ⇒ nothing to invalidate. Not an error (a change on an
        // untagged/unmapped table legitimately bumps nothing).
        return { ok: true };
      }
      try {
        coalescedInvalidateByTags(getOperatorCache(), workspaceId, tags);
        // D-082: the same bust must reach the DURABLE tier, or an L2 row would keep
        // serving a value every worker's L1 has already discarded — turning L2 from a
        // cold-start sharer into a staleness source. Fire-and-forget + never throws
        // (see invalidateL2ByTags); a no-op when the tier is off.
        invalidateL2ByTags(workspaceId, tags);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    case PLAN_ITEM_RECONCILE_ACTION: {
      const items = toCompletedPlanItems(args.completedItems);
      if (items.length === 0) return { ok: true };
      await reconcileLinkedWorkItemsForCompletedPlanItems(items);
      return { ok: true };
    }
    case PLAN_ITEM_LANE_RESYNC_ACTION: {
      const items = toLaneResyncItems(args.items);
      const dependencies = toLaneResyncItems(args.dependencies);
      if (items.length === 0 && dependencies.length === 0) return { ok: true };
      // Per-item best-effort — resyncPlanItemLaneNow itself never throws, but keep
      // the loop resilient to a stray rejection either way.
      for (const it of items) {
        await resyncPlanItemLaneNow(it.planSlug, it.itemId, it.harnessSlug).catch(() => null);
      }
      for (const dependency of dependencies) {
        await resyncDependentPlanItemLanesNow(
          dependency.planSlug,
          dependency.itemId,
          dependency.harnessSlug,
        ).catch(() => []);
      }
      return { ok: true };
    }
    case PLAN_DRAIN_TRANSITION_ACTION: {
      const plans = toDrainTransitionPlans(args.plans);
      if (plans.length === 0) return { ok: true };
      // Imported lazily: this module is loaded by the event engine on every
      // reaction dispatch, and agent-tools/plans pulls in the whole plan write
      // stack (locks, revisions, Postgres). Per-plan best-effort — the
      // transition reacts to somebody else's already-successful write, so a
      // failure here must never be reported as a failure of theirs. P-005's
      // periodic sweep is the backstop for anything dropped.
      const { applyPlanDrainTransition } = await import(
        "../agent-tools/plans/plan-drain-transition"
      );
      for (const p of plans) {
        await applyPlanDrainTransition(p.planSlug, p.harnessSlug).catch(() => null);
      }
      return { ok: true };
    }
    case ACCOUNT_DEFAULT_MARKER_SYNC_ACTION: {
      // Imported lazily for the same reason as the drain transition above: this
      // module is loaded on EVERY reaction dispatch, and account-pool-store pulls
      // in the pool/override/gateway-observability stack. A static import would
      // also risk a cycle, since that stack reaches back into operator state.
      //
      // `syncDefaultAccountEnv` is itself fail-soft (it keeps the previous marker
      // on a read error rather than flipping every in-process call to a different
      // transport), so a failure here is already the safe direction; the next
      // override write re-fires this, and host boot re-syncs regardless.
      const { syncDefaultAccountEnv } = await import("../deployment/account-pool-store");
      await syncDefaultAccountEnv(workspaceId).catch(() => undefined);
      return { ok: true };
    }
    case GATE_REJUDGE_ADMITTED_REPAIR_ACTION: {
      const candidate = typeof args.candidate === "string" ? args.candidate : "";
      const repairHead = typeof args.repairHead === "string" ? args.repairHead : "";
      const installSlug = typeof args.installSlug === "string" ? args.installSlug : "";
      if (!candidate || !repairHead || !installSlug) {
        return { ok: false, error: "gate.rejudgeAdmittedRepair requires candidate, repairHead, and installSlug" };
      }
      try {
        // The builtin runs before dispatch-reaction's generic withWorkspace branch. Establish the
        // originating workspace explicitly, then reuse the one frozen-queue reader and the one
        // routine requeue writer — no parallel launch or scheduler surface.
        const { withWorkspace, getOrgPg } = await import("@papercusp/db-org");
        const { readFrozenCandidateRepairQueue, requeueGreenCheckpointAfterCapacity } = await import(
          "../harness/routines/release-actions"
        );
        return await withWorkspace(workspaceId, async () => {
          const queue = await readFrozenCandidateRepairQueue({ workspaceId, installSlug });
          // Durable reactions may arrive late or out of order. Only the exact live tuple may
          // advance scheduling; a newer admission has its own reaction, and a retired/replaced
          // queue must stay untouched.
          if (!queue || queue.candidate !== candidate || queue.repairHead !== repairHead) {
            return { ok: true };
          }
          await requeueGreenCheckpointAfterCapacity(getOrgPg().sql, installSlug, 0);
          return { ok: true };
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    default:
      return { ok: false, error: `unknown built-in reaction action "${fire}"` };
  }
}
