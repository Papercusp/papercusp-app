/**
 * tripwire/graduation.ts — the autonomy GRADUATION engine, pure core
 * (queen-autonomy-policy-2026-06-13 B-16 / P-082; D-005).
 *
 * "Trust graduation moves the effective level WITHIN the owner's cap" (D-005):
 * a category earns a higher `graduated_level` by EVIDENCE — consecutive clean
 * auto-passes per (category, class), each one an auto-decision whose tripwire
 * closed its watch window without tripping. The store clamps graduated_level ≤
 * ceiling, so graduation NEVER widens autonomy beyond what the owner authorized;
 * raising the ceiling itself stays the owner's authority (the eligibility REPORT,
 * never an auto edit).
 *
 * REUSE, don't rebuild (D-008): the trailing-clean-streak counter is the frontier
 * graduation tracker's {@link computeGraduationStandings} (lib/graduation/core).
 * We map each tripwire row to a `GraduationEvidenceItem` keyed by the composite
 * `<category>::<class>` so streaks are per (category, class), then read the
 * standings back. A `cleared` row = a clean 'verified' pass; a `tripped`/
 * `reverted` row = 'recurred' (resets the streak); an `armed` (window-open) row
 * is 'applied' (pending — neither counts nor resets). The tripwire sweep already
 * did the regression-checking when it chose clear-vs-trip, so no separate
 * regression feed is needed here.
 *
 * Pure logic — no DB, no IO, no Date.now() — exhaustively unit-testable. The PG
 * orchestration (raise graduated_level via the policy store, file the owner
 * report) lives in {@link ./scan}.
 */

import { AUTONOMY_CEILINGS, type AutonomyCeiling } from '@papercusp/plan-parser';
import { type AutonomyCategory, isProtectedCategory, AUTONOMY_CATEGORY_IDS } from '../categories';
import { type AutonomyCategoryPolicy, ceilingRank, minCeiling } from '../policy';
import {
  computeGraduationStandings,
  type ClassGraduationStanding,
  type GraduationEvidenceItem,
  type GraduationPolicy,
} from '../../graduation/core';
import type { TripwireRow } from './store';

/** Tunable thresholds for autonomy graduation (owner-overridable via the routine payload). */
export interface AutonomyGraduationPolicy {
  /** Consecutive clean auto-passes a (category, class) needs per tier (D-005: 10). */
  threshold: number;
  /** The zero-recurrence window in days — mirrors the tripwire watch + decay bar. */
  recurrenceWindowDays: number;
}

export const DEFAULT_AUTONOMY_GRADUATION_POLICY: AutonomyGraduationPolicy = {
  threshold: 10,
  recurrenceWindowDays: 14,
};

/** Composite (category, class) evidence key — keeps streaks per class within a category. */
export function gradKey(category: AutonomyCategory, findingClass: string): string {
  return `${category}::${findingClass}`;
}

/** Parse a composite key back to (category, class). Defensive on a malformed key. */
export function parseGradKey(key: string): { category: AutonomyCategory; findingClass: string } {
  const i = key.indexOf('::');
  const category = (i >= 0 ? key.slice(0, i) : key) as AutonomyCategory;
  const findingClass = i >= 0 ? key.slice(i + 2) : 'unclassified';
  return { category, findingClass };
}

/** Map a tripwire row's status to the graduation lifecycle the streak counter reads. */
function lifecycleFor(status: TripwireRow['status']): 'applied' | 'verified' | 'recurred' {
  switch (status) {
    case 'cleared':
      return 'verified'; // window closed clean → a clean pass
    case 'tripped':
    case 'reverted':
      return 'recurred'; // tripped → resets the streak (counter-evidence)
    case 'armed':
    default:
      return 'applied'; // window still open → pending (neither counts nor resets)
  }
}

/** Map tripwire rows → graduation evidence items (composite-keyed). Pure. */
export function tripwireEvidenceItems(rows: readonly TripwireRow[]): GraduationEvidenceItem[] {
  return rows.map((r) => ({
    id: r.id,
    findingClass: gradKey(r.category, r.findingClass),
    resolvedAtMs: r.resolvedAtMs ?? r.armedAtMs,
    lifecycle: lifecycleFor(r.status),
    autoDispatched: true, // every tripwire row IS an auto-decision
    hasEvidence: true, // a real auto-decision carrying a revert-handle is evidence
  }));
}

/** What graduated_level a category should be raised to, and the supporting class. */
export interface CategoryGraduationTarget {
  category: AutonomyCategory;
  /** The level the evidence has earned, already clamped ≤ ceiling. */
  targetGraduatedLevel: AutonomyCeiling;
  /** The current stored graduated level (pre-write). */
  currentGraduatedLevel: AutonomyCeiling;
  /** True iff target ≠ current AND the write is permitted (not locked/protected/pinned). */
  shouldWrite: boolean;
  /** Why no write (locked / protected / pinned / no-change / ceiling-floor), for the log. */
  reason: string;
  /** The strongest (category, class) standing driving the target. */
  driver: ClassGraduationStanding | null;
}

/** Owner override `{ pinned: true }` freezes graduated_level (D-005 / policy.ts). */
export function isPinned(policy: AutonomyCategoryPolicy): boolean {
  return policy.ownerOverride != null && (policy.ownerOverride as { pinned?: unknown }).pinned === true;
}

/**
 * The level a streak has EARNED on the autonomy scale: one ceiling-rank per
 * completed threshold tier (10 clean passes → rank 1 'trivial', 20 → 'low', …),
 * clamped to the category ceiling. never-auto when nothing earned.
 */
export function earnedLevelForStreak(
  cleanStreak: number,
  threshold: number,
  ceiling: AutonomyCeiling,
): AutonomyCeiling {
  const earnedRank = Math.floor(cleanStreak / Math.max(1, threshold));
  const capped = Math.min(earnedRank, ceilingRank(ceiling));
  return AUTONOMY_CEILINGS[Math.max(0, capped)]!;
}

/**
 * Compute, per category, the graduated_level its evidence has earned — the
 * category is driven by its STRONGEST class (the max earned level across its
 * classes). Honors the cap (clamped ≤ ceiling), the lock/protected gate (a
 * locked or protected category never graduates — D-005), and the owner pin.
 *
 * Returns one target per category that has any evidence; categories with no
 * tripwire rows are omitted (nothing to do).
 */
export function computeCategoryGraduationTargets(
  standings: readonly ClassGraduationStanding[],
  policies: ReadonlyMap<AutonomyCategory, AutonomyCategoryPolicy>,
  policy: AutonomyGraduationPolicy = DEFAULT_AUTONOMY_GRADUATION_POLICY,
): CategoryGraduationTarget[] {
  // Group standings by category (the standing's findingClass is the composite key).
  const byCategory = new Map<AutonomyCategory, ClassGraduationStanding[]>();
  for (const s of standings) {
    const { category } = parseGradKey(s.findingClass);
    const list = byCategory.get(category);
    if (list) list.push(s);
    else byCategory.set(category, [s]);
  }

  const targets: CategoryGraduationTarget[] = [];
  for (const [category, classStandings] of byCategory) {
    const cat = policies.get(category);
    const ceiling: AutonomyCeiling = cat?.ceiling ?? 'never-auto';
    const current: AutonomyCeiling = cat?.graduatedLevel ?? 'never-auto';
    const locked = cat?.locked ?? isProtectedCategory(category);

    // The category's earned level = the MAX earned across its classes; the driver
    // (for the report / log) is the class with the strongest clean streak.
    let bestRank = 0;
    for (const s of classStandings) {
      bestRank = Math.max(bestRank, ceilingRank(earnedLevelForStreak(s.cleanStreak, policy.threshold, ceiling)));
    }
    const bestLevel = AUTONOMY_CEILINGS[bestRank]!;
    const driver = classStandings.reduce<ClassGraduationStanding | null>(
      (best, s) => (best === null || s.cleanStreak > best.cleanStreak ? s : best),
      null,
    );
    // Never raise above the ceiling (defensive; earnedLevelForStreak already clamps).
    const target = minCeiling(bestLevel, ceiling);

    let shouldWrite = true;
    let reason = `earned ${target} from class '${driver?.findingClass ?? '—'}'`;
    if (locked || isProtectedCategory(category)) {
      shouldWrite = false;
      reason = 'category is locked/protected — never graduates (D-005)';
    } else if (cat && isPinned(cat)) {
      shouldWrite = false;
      reason = 'owner pinned graduated_level (ownerOverride.pinned) — frozen';
    } else if (ceilingRank(target) === ceilingRank(current)) {
      shouldWrite = false;
      reason = `already at earned level ${current} — no change`;
    } else if (ceilingRank(target) < ceilingRank(current)) {
      // target < current — the earned level is BELOW the stored graduated_level.
      // Two very different causes, and only one warrants a demote (EI-513):
      //   (a) a TRIP reset a class's clean streak → reconcile DOWN to the
      //       evidence-consistent level (the trip's immediate one-step demote in
      //       the scan may have over/under-shot; this reconciles to the truth).
      //   (b) the category was freshly ARMED/raised and simply hasn't ACCRUED the
      //       streak yet — a COLD START with NO trip. Reconciling down here is the
      //       deadlock: it resets the owner-granted level toward never-auto BEFORE
      //       the Queen can auto-act + earn it (and an in-window tripwire reads as
      //       cleanStreak=0, so every fresh auto-action would reset it). So HOLD
      //       the owner level — the GRACE — until a real trip occurs. The owner
      //       grant is the FLOOR; only a trip lowers it (D-003). Once clean
      //       evidence accrues, target rises to meet current and this stops firing.
      // The immediate demote-on-trip (scan.ts demoteGraduatedLevel) is a SEPARATE
      // path and is unaffected, so a genuine trip still steps the level down.
      const hasTrip = classStandings.some((s) => s.totalRecurred > 0);
      if (hasTrip) {
        shouldWrite = true;
        reason = `streak shrank after a trip → reconcile ${current} → ${target}`;
      } else {
        shouldWrite = false;
        reason = `freshly armed / no trip yet → hold owner level ${current} while evidence accrues (EI-513 grace)`;
      }
    }

    targets.push({
      category,
      targetGraduatedLevel: target,
      currentGraduatedLevel: current,
      shouldWrite,
      reason,
      driver,
    });
  }
  return targets;
}

/** Run the trailing-clean-streak counter over tripwire evidence (composite-keyed). */
export function computeAutonomyStandings(
  rows: readonly TripwireRow[],
  policy: AutonomyGraduationPolicy = DEFAULT_AUTONOMY_GRADUATION_POLICY,
  nowMs = 0,
): ClassGraduationStanding[] {
  const items = tripwireEvidenceItems(rows);
  // Belt-and-braces: flag protected categories as never-graduate at the class
  // level too (the authoritative gate is the locked check at the write).
  const gradPolicy: GraduationPolicy = {
    threshold: policy.threshold,
    recurrenceWindowDays: policy.recurrenceWindowDays,
    neverGraduateClassPatterns: AUTONOMY_CATEGORY_IDS.filter((c) => isProtectedCategory(c)),
  };
  // No separate regression feed — the sweep already chose clear vs trip.
  return computeGraduationStandings(items, [], gradPolicy, nowMs);
}

export interface AutonomyGraduationReport {
  title: string;
  body: string;
  watchdogKey: string;
  category: AutonomyCategory;
  findingClass: string;
  tier: number;
}

/**
 * Build the owner "category X is graduation-eligible" report (P-082 / P-032). The
 * ASK is to raise the category's ceiling (authority — never an auto edit). Dedup
 * key `autonomy-graduation:<category>:<class>:n<tier>` files once per tier; the
 * next report only fires when the streak doubles (a new tier).
 */
export function buildAutonomyGraduationReport(
  standing: ClassGraduationStanding,
  currentCeiling: AutonomyCeiling,
  policy: AutonomyGraduationPolicy = DEFAULT_AUTONOMY_GRADUATION_POLICY,
): AutonomyGraduationReport {
  const { category, findingClass } = parseGradKey(standing.findingClass);
  const tier = standing.eligibleTier ?? policy.threshold;
  const title = `Autonomy graduation: '${category}' / class '${findingClass}' reached ${standing.cleanStreak} clean auto-passes (tier n${tier})`;
  const body = [
    `**Owner ratification ask (queen-autonomy-policy-2026-06-13 P-082 / D-005 — raising a ceiling is never automatic).**`,
    '',
    `Autonomy category \`${category}\` (class \`${findingClass}\`) has accumulated the evidence the trust-graduation policy asks for:`,
    '',
    `- **${standing.cleanStreak} consecutive clean auto-passes** — each one an auto-decision of a REVERSIBLE action whose revert-tripwire closed its ${policy.recurrenceWindowDays}d watch window with no EKG drift / validator bounce / gym regression / owner thumbs-down.`,
    `- Lifetime: ${standing.totalClean} clean / ${standing.totalRecurred} tripped / ${standing.totalDirty} dirty / ${standing.pendingWindow} still in-window.`,
    '',
    `**What already happened automatically:** the graduation engine has raised this category's \`graduated_level\` toward your current ceiling (\`${currentCeiling}\`) — evidence moving WITHIN your cap (D-005). It can never exceed the ceiling.`,
    '',
    `**The act, if you ratify:** raise the **ceiling** for \`${category}\` in the autonomy settings (Settings → Autonomy) — this is the cap the graduated level earns up to, and it is yours alone to move. Nothing widens the ceiling automatically.`,
    '',
    `Counting trail: ${standing.reasons.join(' · ')}`,
  ].join('\n');
  return {
    title,
    body,
    watchdogKey: `autonomy-graduation:${category}:${findingClass}:n${tier}`,
    category,
    findingClass,
    tier,
  };
}
