/**
 * P-009 (work-on-everything-goal-2026-08-23): the pure fold behind the HUD
 * Goals-board packages rail — local goal packages × their instance rows →
 * board entries.
 *
 * Lives beside the goals domain (not in the sync resolver) so the fold is
 * unit-testable without a DB and so the resolver stays a thin assembly. The
 * adoptable-stub discriminator is REUSED from start-from-package.ts — the
 * predicate that decides "never started" must be the same one the adopt path
 * uses, or the rail would offer "Start" against a row the door then refuses
 * (the exact two-definitions drift its export comment warns about).
 */

import type { LocalGoalPackage } from '../cupboard/goal-package-store';
import { isAdoptableStub } from './start-from-package';

/** The instance-side input: one `harness_shared.goals` row carrying a
 *  `metadata.goalPackageRef` stamp (install stub, adopted, or minted). */
export interface GoalPackageInstanceRow {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
}

export interface GoalPackageBoardInstance {
  goalId: string;
  status: string;
  /** True for the seeded, never-started install stub (paused, no agent
   *  identity) — the row "Start" ADOPTS rather than minting beside. */
  adoptableStub: boolean;
}

export interface GoalPackageBoardEntry {
  ref: string;
  title: string;
  description: string;
  layer: 'bundled' | 'user';
  version: string;
  standing: boolean;
  budgetCents: number | null;
  /** The DECLARED trailing budget window (P-004) — a label denominator, not a
   *  spend figure. Spend numbers come from the goals list rows, each labeled
   *  by ITS OWN window (`spendRecentWindowDays`); the two windows may differ
   *  and the rail must never present one under the other's label. */
  budgetWindowSec: number | null;
  /** Every instance row stamped with this ref — stubs included, so the rail
   *  can distinguish "installed, never started" from "no instance at all". */
  instances: GoalPackageBoardInstance[];
  /**
   * The one live instance the rail's readout (and card click) should target:
   * first ACTIVE non-stub, else first non-stub of any status (a paused live
   * instance still owns the pause readout). Null when only stubs (or nothing)
   * exist — which is exactly the "one-click start" case.
   */
  activeGoalId: string | null;
  featured: boolean;
}

/** The bundled first-party package the board features (P-007/P-009). */
export const FEATURED_GOAL_PACKAGE_REF = 'work-on-everything';

const refOf = (row: GoalPackageInstanceRow): string | null => {
  const ref = row.metadata?.goalPackageRef;
  return typeof ref === 'string' && ref.trim() !== '' ? ref.trim() : null;
};

/**
 * Fold the layered package catalog with the stamped instance rows.
 *
 * Every package in the catalog gets an entry, instances or not — the rail's
 * job is to show what COULD be started, which is precisely the set with no
 * rows. Instance rows whose ref resolves to no catalog entry are dropped
 * (the package was uninstalled from disk); their goals still render as
 * ordinary cards on the board, so nothing is hidden.
 *
 * Order: featured first, then bundled before user, then title — stable for
 * the board and for tests.
 */
export function foldGoalPackageBoard(
  packages: LocalGoalPackage[],
  rows: GoalPackageInstanceRow[],
): GoalPackageBoardEntry[] {
  const byRef = new Map<string, GoalPackageInstanceRow[]>();
  for (const row of rows) {
    const ref = refOf(row);
    if (!ref) continue;
    const list = byRef.get(ref);
    if (list) list.push(row);
    else byRef.set(ref, [row]);
  }

  const entries = packages.map((pkg): GoalPackageBoardEntry => {
    const instances = (byRef.get(pkg.ref) ?? []).map(
      (row): GoalPackageBoardInstance => ({
        goalId: row.id,
        status: row.status,
        adoptableStub: isAdoptableStub({ status: row.status, metadata: row.metadata }),
      }),
    );
    const nonStubs = instances.filter((i) => !i.adoptableStub);
    const activeGoalId =
      nonStubs.find((i) => i.status === 'active')?.goalId ?? nonStubs[0]?.goalId ?? null;
    return {
      ref: pkg.ref,
      title: pkg.title,
      description: pkg.description,
      layer: pkg.layer,
      version: pkg.version,
      standing: pkg.standing,
      budgetCents: pkg.budgetCents,
      budgetWindowSec: pkg.budgetWindowSec,
      instances,
      activeGoalId,
      featured: pkg.ref === FEATURED_GOAL_PACKAGE_REF,
    };
  });

  return entries.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.layer !== b.layer) return a.layer === 'bundled' ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
