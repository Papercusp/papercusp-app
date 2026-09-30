/**
 * effectiveStatus — compute per-item status from storedStatus +
 * blocked-by graph.
 *
 * Per D-005 of agent-plan-tracking-2026-05-20.md: items with
 * `blocked-by: P-NNN` references whose blockers aren't yet *resolved*
 * have *effective* status `blocked`, regardless of what their stored
 * token says. A blocker counts as resolved when its stored status is
 * `done` (it completed) OR `dropped` (it was abandoned and will never
 * complete — keeping the dependent blocked forever would be the stale-
 * `blocked` trap D-005 exists to prevent). plans:lint emits a
 * `blocker_dropped` warning in that case so the dependency still gets
 * re-evaluated. As soon as all blockers resolve, effective reverts to
 * the stored token (typically `todo`).
 *
 * The stored `blocked` token is reserved for **external** blockers
 * (upstream PR, vendor response, awaiting release) — things markdown
 * genuinely can't compute. Stored `blocked` is always effective
 * `blocked`.
 *
 * Cycles: items in a blocked-by cycle resolve to effective `blocked`
 * and are flagged in `cycleMembers`.
 *
 * Missing refs: an item whose `blocked-by` references an unknown ID
 * resolves to effective `blocked` (we can't prove the blocker is done)
 * and is flagged in `missingRefs`.
 */

import type { ItemStatus, PlanItem, ParsedPlan } from './parser';
import { deriveNeedsHuman } from './risk-model';

export interface ResolvedItem extends PlanItem {
  effectiveStatus: ItemStatus;
  unresolvedBlockers: string[];
  /**
   * The DERIVED needs-human verdict (queen-autonomy-policy-2026-06-13 B-12 /
   * P-072): `needs-human` is no longer a stored token but the top band of the
   * risk model (D-001). The orchestrator DONE-gate + `plans:items needsHuman`
   * key on THIS, not on `storedStatus === 'needs-human'`, so the gate stays
   * correct under the new model. BEHAVIOR-NEUTRAL today (D-007): with the policy
   * unarmed `deriveNeedsHuman` returns exactly the stored token (plus the
   * authority=owner override, which no legacy item sets), so the value equals
   * `storedStatus === 'needs-human'` until the owner arms autonomy (P-092).
   */
  needsHuman: boolean;
  /**
   * Non-null when the stored token and the blocked-by graph DISAGREE. Two
   * directions, both purely diagnostic:
   *
   *  1. EI-19397307303043951 (below) — stored `blocked`, every dependency
   *     resolved. effectiveStatus stays `blocked` via the sticky token.
   *  2. EI-19412899868617052 — stored `done`/`dropped` with a dependency still
   *     unresolved. effectiveStatus is the TERMINAL token (a completed item
   *     cannot be blocked); the hint reports the now-stale edge so a plan
   *     author can drop or repoint it.
   *
   * EI-19397307303043951: non-null when the stored `blocked` token and the
   * blocked-by graph now DISAGREE — every listed blocked-by dependency has
   * resolved (done/dropped) yet effectiveStatus is still forced `blocked` by
   * the sticky stored token (see the module docstring). This is exactly the
   * failure that presents as its own opposite: `plans:get-item` shows
   * `unresolvedBlockers: []` right next to `effectiveStatus: 'blocked'`, a
   * caller reads that as "the lane is drained", and scheduler:get_next never
   * serves the linked work-item — real claimable work goes invisible.
   *
   * PURELY DIAGNOSTIC — never changes `effectiveStatus`. A stored `blocked`
   * kept for a genuinely external/deliberate reason (e.g. re-blocked by a
   * plan Decision after its blocked-by dependency resolved, as opposed to a
   * dependency-derived block that simply never got cleared) is a legitimate
   * case this module cannot distinguish from the trap by data alone — so it
   * never auto-clears the token. It only surfaces the contradiction so a
   * reader can act: clear the stored token with `plans:set-status` if the
   * block really was blocked-by-derived, or leave it and record why in a
   * plan Decision if it is deliberately still blocked for another reason.
   */
  staleBlockedHint: string | null;
}

/**
 * The derived needs-human verdict for one plan item (B-12 / P-072) — the pure
 * top-band derivation the DONE-gate keys on. Behavior-neutral by default
 * (`armed` defaults false ⇒ exactly the stored `needs-human` token, plus the
 * authority=owner override). The ARMED, ceiling-aware path (a high-risk item
 * above its category ceiling) flows once a caller supplies `ceiling` + `armed`;
 * plan items carry no tool/category today (work_items.risk_tier deferred, D-015),
 * so the live gate stays on the behavior-neutral path.
 */
export function deriveItemNeedsHuman(
  item: Pick<PlanItem, 'storedStatus' | 'riskTier' | 'authority'>,
  opts: { armed?: boolean; ceiling?: import('./risk-model').AutonomyCeiling | null } = {},
): boolean {
  return deriveNeedsHuman({
    storedNeedsHuman: item.storedStatus === 'needs-human',
    riskTier: item.riskTier ?? null,
    authority: item.authority ?? null,
    ceiling: opts.ceiling ?? null,
    armed: opts.armed ?? false,
  });
}

export interface ResolveResult {
  items: ResolvedItem[];
  missingRefs: Array<{ itemId: string; ref: string }>;
  cycleMembers: string[];
}

export function resolveEffectiveStatus(plan: ParsedPlan): ResolveResult {
  return resolveEffectiveStatusForItems(plan.items);
}

/**
 * Effective-status resolution over a bare item array — the core algorithm
 * (`resolveEffectiveStatus` is the ParsedPlan-shaped wrapper). Lets a caller
 * resolve from the PG-canonical structured `items` index (plans-pg-canonical-
 * migration Stage 3) without re-parsing the content blob. Only `id`,
 * `storedStatus`, and `blockedBy` drive the result; the rest of each PlanItem is
 * carried through to the ResolvedItem unchanged.
 */
export function resolveEffectiveStatusForItems(planItems: PlanItem[]): ResolveResult {
  const byId = new Map(planItems.map((it) => [it.id, it]));
  const missingRefs: Array<{ itemId: string; ref: string }> = [];
  const cycleMembers: string[] = [];

  const colors = new Map<string, 0 | 1 | 2>();
  const inCycle = new Set<string>();

  const visit = (id: string, stack: Set<string>): void => {
    const c = colors.get(id) ?? 0;
    if (c === 2) return;
    if (c === 1) {
      for (const sid of stack) inCycle.add(sid);
      inCycle.add(id);
      return;
    }
    colors.set(id, 1);
    stack.add(id);
    const it = byId.get(id);
    if (it) {
      for (const dep of it.blockedBy) {
        if (!byId.has(dep)) {
          missingRefs.push({ itemId: id, ref: dep });
          continue;
        }
        visit(dep, stack);
      }
    }
    stack.delete(id);
    colors.set(id, 2);
  };

  for (const it of planItems) visit(it.id, new Set());
  cycleMembers.push(...inCycle);

  const items: ResolvedItem[] = planItems.map((it) => {
    // The derived needs-human top band (B-12 / P-072) is computed from the item's
    // own risk axes, INDEPENDENT of the blocked-by graph (an item awaiting a human
    // decision still needs that human whether or not it is currently blocked) — so
    // it is the same on every effectiveStatus branch below.
    const needsHuman = deriveItemNeedsHuman(it);

    if (inCycle.has(it.id)) {
      return {
        ...it,
        effectiveStatus: 'blocked',
        unresolvedBlockers: it.blockedBy,
        needsHuman,
        staleBlockedHint: null,
      };
    }

    const unresolved: string[] = [];
    for (const dep of it.blockedBy) {
      const depItem = byId.get(dep);
      if (!depItem) {
        unresolved.push(dep);
        continue;
      }
      if (depItem.storedStatus !== 'done' && depItem.storedStatus !== 'dropped') {
        unresolved.push(dep);
      }
    }

    if (it.storedStatus === 'blocked') {
      const staleBlockedHint =
        it.blockedBy.length > 0 && unresolved.length === 0
          ? `stored status is 'blocked' but every blocked-by dependency (${it.blockedBy.join(', ')}) has ` +
            `already resolved (done/dropped) — effectiveStatus stays 'blocked' because the stored token is ` +
            `sticky (reserved for external blockers) until someone clears it. If this block was purely ` +
            `blocked-by-derived, clear it with plans:set-status; if it is deliberately still blocked for ` +
            `another reason, record that in a plan Decision.`
          : null;
      return { ...it, effectiveStatus: 'blocked', unresolvedBlockers: unresolved, needsHuman, staleBlockedHint };
    }

    // EI-19412899868617052: a TERMINAL stored token wins over the blocked-by
    // graph. The graph exists to gate work that has NOT happened; it must never
    // re-open work that already has — a completed item cannot be "blocked".
    //
    // Without this short-circuit the branch below fires for a stored `done`
    // item whose dependency is merely still running, and the mislabel is not
    // cosmetic: `system:plan-item-lane-sync` reads effectiveStatus and HOLDS the
    // linked work-item open, so `work_items:complete` refuses it and the item
    // stays claimable forever. Flipping the plan item to `done` does not clear
    // that — it is precisely the state that triggers it — so the only escapes
    // were `force: true` or editing the plan graph, i.e. the trap pushed every
    // agent who hit it into overriding a guard that is usually right.
    //
    // Measured live on prose-embedding-384-untrained-mrl-fix-2026-08-02: P-007
    // stored `done`, blockedBy ['P-006'], P-006 legitimately still `wip` (a ~28h
    // refill) — the normal "migrate, then verify" shape where the dependent
    // finishes early against a partial result it only needed part of.
    //
    // Deliberately placed AFTER the cycle and sticky stored-`blocked` branches:
    // a blocked-by CYCLE is a structural plan-authoring error worth keeping loud
    // (and it is reported separately via `cycleMembers`), and a stored `blocked`
    // token is documented above as intentionally sticky.
    if (it.storedStatus === 'done' || it.storedStatus === 'dropped') {
      const staleBlockedHint =
        unresolved.length > 0
          ? `stored status is '${it.storedStatus}' but blocked-by dependency (${unresolved.join(', ')}) ` +
            `has not resolved — effectiveStatus is '${it.storedStatus}' because a completed item cannot be ` +
            `blocked. The edge is likely stale, or was only partly required (the dependent finished against ` +
            `a partial result). Drop or repoint the blocked-by edge with plans:set-content if it no longer ` +
            `holds; if the dependency really was required in full, this item may have been closed early.`
          : null;
      return {
        ...it,
        effectiveStatus: it.storedStatus,
        unresolvedBlockers: [],
        needsHuman,
        staleBlockedHint,
      };
    }

    if (unresolved.length > 0) {
      return {
        ...it,
        effectiveStatus: 'blocked',
        unresolvedBlockers: unresolved,
        needsHuman,
        staleBlockedHint: null,
      };
    }

    return {
      ...it,
      effectiveStatus: it.storedStatus,
      unresolvedBlockers: [],
      needsHuman,
      staleBlockedHint: null,
    };
  });

  return { items, missingRefs, cycleMembers };
}
