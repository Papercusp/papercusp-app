/**
 * harness-test-rollup — the plan↔test link, through the VAL.
 *
 * Phase G (P-081/P-082) of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * The VAL is the sole join key (decision D-006): a test declares `coversVALs`,
 * a plan-item's inline assertion lands in `harness_plan_assertions` keyed by
 * `(val_id, item_id)`. These pure helpers do the join — no PG, no I/O — so the
 * snapshot endpoint (status loop) and the rollup route share one tested
 * implementation.
 *
 * Tests with no `coversVALs` (the Built-in / generalized tier: lint, typecheck,
 * smoke) match no assertion and contribute to no plan item — they stay
 * harness-level (P-084).
 */

export interface RollupTest {
  /** VAL ids this test proves. Empty for infra/Built-in tests. */
  coversVALs: string[];
  /** harness_tests status: 'passing' | 'failing' | 'skipped' | 'not_run' | … */
  status: string;
}

export interface RollupAssertion {
  val_id: string;
  item_id: string;
  requires_test: boolean;
}

export type AssertionStatus = 'todo' | 'validating' | 'passed' | 'failed';

/** Tests covering `valId` (case-exact match on coversVALs). */
function coveringTests(valId: string, tests: RollupTest[]): RollupTest[] {
  return tests.filter((t) => Array.isArray(t.coversVALs) && t.coversVALs.includes(valId));
}

/**
 * Derive a VAL's assertion status from the tests covering it (P-081):
 *   - no covering test            → `todo` (nothing proves it yet)
 *   - any covering test failing    → `failed`
 *   - every covering test passing  → `passed`
 *   - otherwise (covered, pending) → `validating`
 */
export function deriveAssertionStatus(valId: string, tests: RollupTest[]): AssertionStatus {
  const covering = coveringTests(valId, tests);
  if (covering.length === 0) return 'todo';
  if (covering.some((t) => t.status === 'failing')) return 'failed';
  if (covering.every((t) => t.status === 'passing')) return 'passed';
  return 'validating';
}

export interface PlanItemTestStatus {
  itemId: string;
  /** All assertions on the item. */
  valsTotal: number;
  /** Assertions that require a test (requires_test = true). */
  valsRequiringTest: number;
  /** Of the test-requiring VALs, how many have ≥1 covering test. */
  valsCovered: number;
  /** Of the test-requiring VALs, how many derive to `passed`. */
  valsPassing: number;
}

/**
 * Roll assertions up to their plan items, joined against the harness's tests
 * by VAL (P-082). Only `requires_test` VALs count toward covered/passing — an
 * exempt VAL (copy, design-spec) never needs a test, so it never drags the
 * item's coverage down.
 */
export function computePlanItemTestStatus(
  assertions: RollupAssertion[],
  tests: RollupTest[],
): Record<string, PlanItemTestStatus> {
  const out: Record<string, PlanItemTestStatus> = {};
  for (const a of assertions) {
    const s =
      out[a.item_id] ??
      { itemId: a.item_id, valsTotal: 0, valsRequiringTest: 0, valsCovered: 0, valsPassing: 0 };
    s.valsTotal += 1;
    if (a.requires_test) {
      s.valsRequiringTest += 1;
      if (coveringTests(a.val_id, tests).length > 0) s.valsCovered += 1;
      if (deriveAssertionStatus(a.val_id, tests) === 'passed') s.valsPassing += 1;
    }
    out[a.item_id] = s;
  }
  return out;
}
