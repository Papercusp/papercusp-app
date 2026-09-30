/**
 * Destructive-replan diff — the pure core of "re-promote a plan, dropping the
 * features it no longer declares" (the `destructive-replan → plans:promote` route
 * change flagged in `dbos-system-completion-2026-06-01`).
 *
 * Normal `plans:promote` re-promotion is idempotent-ADDITIVE: it appends only the
 * plan's new feature ids and never touches what's already in the harness
 * (`promote.ts` ~L797). A DESTRUCTIVE replan additionally retires the harness
 * features that were minted from this plan but are no longer in it — so the
 * harness queue converges to exactly the plan's current feature set.
 *
 * This module is deliberately PURE (no PG, no I/O): it takes the plan's current
 * feature ids + the harness features already sourced from that plan, and returns
 * the mint / keep / deprecate partition + the safety verdicts. The handler
 * (`promote.ts`, behind a `destructive: true` arg — see the `it.todo` specs in
 * the test) wires PG reads/writes around it and routes deprecations through the
 * canonical feature-state path, never a raw `harness_features` write.
 *
 * Two safety invariants are baked in here, NOT left to the caller — because the
 * whole risk of a destructive replan is silent data loss (cf. the operator's
 * `lost-work-to-replan` backstory, op-backstory-bank.ts: "Lost two days of work
 * to a replan once"):
 *
 *   1. PROTECTED STATUSES — a feature with real or in-flight work (default
 *      `passed` + `in_progress`) is NEVER auto-deprecated, even when the plan
 *      drops it. It surfaces in `protectedFromDeprecation` for the caller to
 *      report; retiring it is a human decision, not a re-promote side effect.
 *
 *   2. EMPTY-PLAN WIPE GUARD — a policy-less / empty plan set (no `## Promote`
 *      policy AND no explicit `features`) yields ZERO plan ids. Without a guard a
 *      destructive replan would then deprecate EVERY feature the plan ever minted.
 *      `unsafeEmptyReplan` flags exactly this case so the handler fails closed
 *      (refuse unless an explicit `force`), instead of silently emptying a queue.
 */

/** A harness feature currently sourced from the plan being re-promoted. */
export interface ExistingPlanFeature {
  featureId: string;
  /** Lifecycle status (todo | in_progress | passed | failing | deprecated | …). */
  status: string;
}

export interface DestructiveReplanDiff {
  /** Plan feature ids not yet present in the harness → mint. */
  toMint: string[];
  /** Plan feature ids already present → idempotent keep/update (not re-minted). */
  toKeep: string[];
  /** Harness-from-plan features the plan no longer declares AND safe to retire. */
  toDeprecate: string[];
  /**
   * Dropped-from-plan features held back by the protected-status guard (real /
   * in-flight work). Reported, never auto-deprecated.
   */
  protectedFromDeprecation: string[];
  /**
   * True when the plan declares ZERO features but the harness still has features
   * from it — a destructive apply here would wipe the whole plan's queue. The
   * handler MUST refuse (fail closed) unless the caller passes an explicit force.
   */
  unsafeEmptyReplan: boolean;
}

/** Statuses whose work is too valuable to retire as a re-promote side effect.
 *  work-item-status-full-unify: includes the unified equivalents (`done`≈passed, `wip`≈in_progress)
 *  as a transitional superset — a destructive replan must never auto-deprecate shipped work on
 *  either side of the status migration. */
export const DEFAULT_PROTECTED_STATUSES = ['passed', 'in_progress', 'done', 'wip'] as const;

/**
 * Partition a destructive replan into mint / keep / deprecate (+ safety verdicts).
 *
 * @param planFeatureIds  The plan's CURRENT feature ids — the source of truth the
 *   harness should converge to. Duplicates and falsy entries are ignored.
 * @param existingPlanFeatures  Harness features already sourced from THIS plan.
 *   (The caller scopes this to the plan — features from other plans are never
 *   eligible for deprecation here.)
 * @param opts.protectStatuses  Statuses never auto-deprecated. Defaults to
 *   {@link DEFAULT_PROTECTED_STATUSES}; pass `[]` to allow deprecating anything
 *   (e.g. an explicit `force` path), or a custom set.
 */
export function computeDestructiveReplanDiff(
  planFeatureIds: readonly string[],
  existingPlanFeatures: readonly ExistingPlanFeature[],
  opts?: { protectStatuses?: readonly string[] },
): DestructiveReplanDiff {
  const protectStatuses = new Set(opts?.protectStatuses ?? DEFAULT_PROTECTED_STATUSES);

  // Normalize the plan set: drop falsy, de-dup, preserve first-seen order.
  const planSet = new Set<string>();
  const planOrder: string[] = [];
  for (const id of planFeatureIds) {
    if (!id || planSet.has(id)) continue;
    planSet.add(id);
    planOrder.push(id);
  }

  const existingIds = new Set(existingPlanFeatures.map((f) => f.featureId));

  const toMint = planOrder.filter((id) => !existingIds.has(id));
  const toKeep = planOrder.filter((id) => existingIds.has(id));

  const toDeprecate: string[] = [];
  const protectedFromDeprecation: string[] = [];
  for (const f of existingPlanFeatures) {
    if (planSet.has(f.featureId)) continue; // still in the plan → keep
    if (f.status === 'deprecated' || f.status === 'dropped') continue; // already retired → no-op (unified: dropped)
    if (protectStatuses.has(f.status)) {
      protectedFromDeprecation.push(f.featureId);
    } else {
      toDeprecate.push(f.featureId);
    }
  }

  const unsafeEmptyReplan = planSet.size === 0 && existingPlanFeatures.length > 0;

  return { toMint, toKeep, toDeprecate, protectedFromDeprecation, unsafeEmptyReplan };
}

/** The fail-closed / force decision the handler acts on. */
export interface DestructiveReplanDecision {
  action: 'apply' | 'refuse';
  /** Set when action==='refuse'. */
  refusalCode?: 'unsafe_empty_replan';
  refusalDetail?: string;
  /** Features to deprecate when applying (empty on refuse). */
  toDeprecate: string[];
  /**
   * Dropped-from-plan features held back by the protected-status guard — present
   * regardless of action so the caller can surface them for a human retire call.
   * Empty when `force` was used (the diff was computed with no protected set).
   */
  protectedHeld: string[];
}

/**
 * Apply the destructive-replan safety policy over a {@link computeDestructiveReplanDiff}
 * result: refuse (fail closed) on an empty-plan wipe unless `force`, else apply.
 *
 * `force` is expected to ALSO have been threaded into the diff (as
 * `protectStatuses: []`), so a forced decision deprecates protected work too and
 * `protectedHeld` is empty; an unforced decision keeps protected work and reports
 * it. Pure — the handler does the PG read + the deprecation writes around it.
 */
export function decideDestructiveReplan(
  diff: DestructiveReplanDiff,
  opts?: { force?: boolean },
): DestructiveReplanDecision {
  const force = opts?.force ?? false;
  if (diff.unsafeEmptyReplan && !force) {
    return {
      action: 'refuse',
      refusalCode: 'unsafe_empty_replan',
      refusalDetail:
        `the plan resolved to zero features, so a destructive replan would deprecate ` +
        `all ${diff.toDeprecate.length + diff.protectedFromDeprecation.length} feature(s) it minted — ` +
        `pass force:true to confirm wiping the plan's queue`,
      toDeprecate: [],
      protectedHeld: diff.protectedFromDeprecation,
    };
  }
  return { action: 'apply', toDeprecate: diff.toDeprecate, protectedHeld: diff.protectedFromDeprecation };
}
