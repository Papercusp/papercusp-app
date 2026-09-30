/**
 * Done-without-test detector (enforce-system-on-generic-work-2026-06-29 P-009).
 *
 * The recurrence guard for the "claimed done, no framework test" class: a feature
 * work-item that has reached a TERMINAL/done state (`passed`) but still carries
 * `requires_test` VAL assertions that NO passing test covers. That is exactly the
 * silent gap the harness-test gate exists to close — an item declared done whose
 * required VALs were never proven by a framework test. This module is the PURE
 * detection core (a roll-up + filter over per-item counts); it has NO I/O, so it is
 * fully unit-testable.
 *
 * It REUSES the plan↔test rollup (`computePlanItemTestStatus` /
 * `deriveAssertionStatus`, harness-test-rollup.ts) — the SAME join the testing tab
 * and snapshot loop use — so "is this VAL proven by a passing test?" has one tested
 * implementation. The work-item → plan-item link is `source_plan_slug` +
 * `source_plan_item_ids`; assertions are keyed `(plan_slug, item_id)`, so item ids
 * are composite-keyed by plan before the rollup to avoid a cross-plan `item_id`
 * collision (two plans can both carry a "P-001").
 *
 * Mirrors zero-promotion-detect.ts (its sibling recurrence guard): a pure detector +
 * a single workspace-scoped PG read feeding it, registered as a watchdog collector in
 * `defaultPapercuspCollectors`. Unlike zero-promotion it needs NO flag gate — it is
 * naturally inert wherever the inline-VAL flow is dark (no `requires_test` assertions
 * ⇒ nothing to flag), so it only fires on a genuine done-without-test gap.
 */
import {
  computePlanItemTestStatus,
  type RollupAssertion,
  type RollupTest,
} from '../../harness-test-rollup';

/** A terminal/done feature work-item carrying its plan-item provenance. */
export interface DoneWorkItem {
  /** feature_id of the done work-item. */
  workItemId: string;
  harnessSlug: string;
  /** source_plan_slug — the plan this work-item was minted from. */
  planSlug: string;
  /** source_plan_item_ids — the plan-item(s) this work-item covers. */
  planItemIds: readonly string[];
}

/** One inline-VAL assertion (harness_plan_assertions row), already filtered to
 *  requires_test = true at the read site. plan_slug disambiguates a shared item_id. */
export interface DoneItemAssertion {
  planSlug: string;
  itemId: string;
  valId: string;
}

/**
 * A done-without-test finding, shaped to map directly onto a WatchdogSignal at the
 * collector site. Its own type so this pure module needs no import from the large
 * watchdog.ts (and no dependency on the WatchdogSource union). One finding PER
 * HARNESS — the per-harness metric is `count`, the number of flagged done work-items.
 */
export interface DoneWithoutTestFinding {
  source: 'done-without-test';
  /** dedup key — the harness slug (one rolled-up finding per harness). */
  key: string;
  title: string;
  body: string;
  severity: 'major';
  /** harness:<slug> so triage keys off the owning hive. */
  scope: string;
  findingClass: 'test-gate:done-without-test';
  /** Per-harness metric: count of done work-items flagged as done-without-test. */
  count: number;
  /** feature_ids of the flagged work-items (detail; also embedded in `body`). */
  workItemIds: string[];
}

/** Composite plan-item key: assertions are keyed (plan_slug, item_id); two plans can
 *  reuse the same item_id ("P-001"), so the rollup must not merge them. NUL is illegal
 *  in slugs/ids, so it can't collide with a real separator. */
function planItemKey(planSlug: string, itemId: string): string {
  return `${planSlug}\x00${itemId}`;
}

/**
 * Flag terminal/done feature work-items whose required VALs are NOT all proven by a
 * passing test, grouped into one finding per harness. Pure: the caller supplies the
 * done items, their plan assertions (requires_test only), and the harness's tests.
 *
 * Detection predicate (per work-item, summed across its plan-items): roll the item's
 * `requires_test` assertions up against the harness tests via computePlanItemTestStatus
 * (which derives each VAL's status via deriveAssertionStatus), then flag when
 * `valsRequiringTest > 0 && valsPassing < valsRequiringTest` — i.e. it requires at
 * least one test and at least one required VAL has no passing covering test.
 *
 * Tests/assertions MUST be scoped to ONE harness per call (VAL ids are harness-local,
 * not globally unique) — the collector loops per harness.
 */
export function detectDoneWithoutTest(
  doneItems: readonly DoneWorkItem[],
  assertions: readonly DoneItemAssertion[],
  tests: readonly RollupTest[],
): DoneWithoutTestFinding[] {
  // Roll the requires_test assertions up to their (plan, item) once, composite-keyed.
  const rollupAssertions: RollupAssertion[] = assertions.map((a) => ({
    val_id: a.valId,
    item_id: planItemKey(a.planSlug, a.itemId),
    requires_test: true,
  }));
  const byItem = computePlanItemTestStatus(rollupAssertions, [...tests]);

  // Aggregate per harness: a work-item is flagged when, across all its plan-items, it
  // requires ≥1 test and not every required VAL is passing.
  const flaggedByHarness = new Map<string, string[]>();
  for (const wi of doneItems) {
    let requiring = 0;
    let passing = 0;
    for (const itemId of wi.planItemIds) {
      const s = byItem[planItemKey(wi.planSlug, itemId)];
      if (!s) continue;
      requiring += s.valsRequiringTest;
      passing += s.valsPassing;
    }
    if (requiring > 0 && passing < requiring) {
      const ids = flaggedByHarness.get(wi.harnessSlug) ?? [];
      ids.push(wi.workItemId);
      flaggedByHarness.set(wi.harnessSlug, ids);
    }
  }

  return [...flaggedByHarness].map(([harnessSlug, ids]) => ({
    source: 'done-without-test' as const,
    key: harnessSlug,
    title: `Done work-items missing a passing test: ${harnessSlug}`,
    body:
      `${ids.length} work-item(s) in ${harnessSlug} are marked done (terminal/passed) but carry ` +
      `requires_test VAL(s) with no passing covering test: ${ids.join(', ')}. ` +
      `A claimed-done feature whose required VALs were never proven by a framework test is the ` +
      `"done without test" recurrence (enforce-system-on-generic-work P-009) — the harness-test ` +
      `gate must not let it return silently.`,
    severity: 'major' as const,
    scope: `harness:${harnessSlug}`,
    findingClass: 'test-gate:done-without-test' as const,
    count: ids.length,
    workItemIds: ids,
  }));
}

/**
 * The PG read that feeds the pure detector (enforce-system-on-generic-work P-009).
 * Reads, per TERMINAL/done feature work-item in the workspace that carries plan
 * provenance, its plan-items' `requires_test` assertions (harness_plan_assertions) and
 * the harness's tests (harness_tests — `status` + `payload.coversVALs`), then keeps
 * items where a required VAL has no passing covering test. One finding per harness,
 * `count` = number of flagged items.
 *
 * No flag gate: where the inline-VAL flow is dark the assertion read is empty, so the
 * detector produces nothing by design — it can only fire on a genuine done-without-test
 * gap. Three workspace-scoped queries, LIMITed; cheap enough for the per-tick watchdog.
 * Tests are matched per-harness (VAL ids are harness-local).
 */
export async function collectDoneWithoutTestSignals(
  workspaceId: string,
): Promise<{ signals: DoneWithoutTestFinding[]; note?: string }> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();

  // 1. Terminal/done feature work-items with plan provenance. `passed` is the genuine
  //    "claimed done" feature-terminal state; `deprecated` (abandoned/dropped) is
  //    excluded — a dropped item is not "done", so a missing test there is not a gap.
  const doneRows = await sql<
    { feature_id: string; harness_slug: string; source_plan_slug: string; source_plan_item_ids: string[] }[]
  >`
    SELECT feature_id, harness_slug, source_plan_slug, source_plan_item_ids
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId}
       AND status = 'passed'
       AND source_plan_slug IS NOT NULL
       AND source_plan_item_ids IS NOT NULL
       AND array_length(source_plan_item_ids, 1) > 0
     ORDER BY harness_slug
     LIMIT 500
  `;
  if (doneRows.length === 0) return { signals: [] };

  const harnesses = [...new Set(doneRows.map((r) => r.harness_slug))];
  const planSlugs = [...new Set(doneRows.map((r) => r.source_plan_slug))];

  // 2. requires_test assertions for those harnesses + plans.
  const assertionRows = await sql<
    { harness_slug: string; plan_slug: string; item_id: string; val_id: string }[]
  >`
    SELECT harness_slug, plan_slug, item_id, val_id
      FROM harness_shared.harness_plan_assertions
     WHERE workspace_id = ${workspaceId}
       AND requires_test = true
       AND harness_slug = ANY(${harnesses})
       AND plan_slug = ANY(${planSlugs})
  `;

  // 3. Tests for those harnesses (status + payload.coversVALs).
  const testRows = await sql<
    { harness_slug: string; status: string; payload: { coversVALs?: unknown } | null }[]
  >`
    SELECT harness_slug, status, payload
      FROM harness_shared.harness_tests
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ANY(${harnesses})
  `;

  const coversOf = (payload: { coversVALs?: unknown } | null): string[] => {
    const raw = payload?.coversVALs;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  };

  // VAL ids are harness-local, so run the detector ONCE PER HARNESS over that
  // harness's done items / assertions / tests.
  const signals: DoneWithoutTestFinding[] = [];
  for (const harness of harnesses) {
    const doneItems: DoneWorkItem[] = doneRows
      .filter((r) => r.harness_slug === harness)
      .map((r) => ({
        workItemId: r.feature_id,
        harnessSlug: r.harness_slug,
        planSlug: r.source_plan_slug,
        planItemIds: r.source_plan_item_ids ?? [],
      }));
    const assertions: DoneItemAssertion[] = assertionRows
      .filter((a) => a.harness_slug === harness)
      .map((a) => ({ planSlug: a.plan_slug, itemId: a.item_id, valId: a.val_id }));
    const tests: RollupTest[] = testRows
      .filter((t) => t.harness_slug === harness)
      .map((t) => ({ coversVALs: coversOf(t.payload), status: t.status }));
    signals.push(...detectDoneWithoutTest(doneItems, assertions, tests));
  }
  return { signals };
}
