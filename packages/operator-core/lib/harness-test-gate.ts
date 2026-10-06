/**
 * harness-test-gate — the TEST-COMPLETION GATE for `work_items:complete`
 * (enforce-system-on-generic-work-2026-06-29 P-006).
 *
 * A code/feature work-item promoted from a plan carries that plan's inline VAL-*
 * assertions (`harness_plan_assertions`), some of which DEMAND a passing framework
 * test (`requires_test = true`). This gate refuses a terminal completion of such an
 * item while any test-requiring VAL is not yet proven `passed` by the harness's
 * tests — reusing the SAME pure VAL↔test rollup (`harness-test-rollup.ts`) the
 * tests-tab and the plan-item coverage badges use, so the gate and the UI can never
 * disagree about what counts as "tested".
 *
 * FAIL-OPEN by construction: ANY thrown error (PG hiccup, missing provenance, a
 * shape surprise) returns `{ ok: true }` — a completion must never be blocked by a
 * bug in the gate. The gate only ever REFUSES on a positive signal: a covered plan
 * item whose test-requiring VALs are not all passing. With zero test-requiring VALs
 * anywhere there is nothing to prove, so it passes.
 *
 * Gated behind `FLAGS.TEST_COMPLETION_GATE` (default ON since 2026-07-04 — graduated
 * from the dark set after P-014 verified it live with zero blast radius, EI-7280) at
 * the call site (`agent-tools/work_items/complete.ts`).
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { resolvePlanItemProvenance } from './plan-item-provenance';
import {
  computePlanItemTestStatus,
  deriveAssertionStatus,
  type RollupAssertion,
  type RollupTest,
} from './harness-test-rollup';

export interface ItemTestGateResult {
  ok: boolean;
  /** Present only on a refusal — names the failing/uncovered required VAL(s). */
  reason?: string;
}

/**
 * Decide whether `featureId` (a feature work-item in `harness`) may be completed:
 * PASS iff for every COVERED plan item, `valsRequiringTest === 0` OR
 * `valsPassing === valsRequiringTest`. Refuse (`ok: false`) only when some
 * required-test VAL is not `passed`; the reason names the failing/uncovered VAL(s).
 * Zero required-test VALs anywhere ⇒ PASS (nothing to prove). FAIL-OPEN
 * (`{ ok: true }`) on any thrown error. A VAL promoted into an ENFORCEABLE spec clause
 * (`plan_spec_clauses.source_val_id`) is excluded: `specTestAdequacyCompletionGate` judges it
 * against current evidence bindings, and `harness_tests` can no longer prove anything new.
 */
export async function itemTestGate(
  harness: string,
  featureId: string,
): Promise<ItemTestGateResult> {
  try {
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();

    // 1. Provenance: which plan items was this feature promoted from?
    //    Resolved through plan-item-provenance, NOT a bare `source_plan_item_ids` read.
    //    That column has been effectively unwritten since the mint path moved to the
    //    `payload.plan_item` stamp (1 row vs 1,239 workspace-wide, measured 2026-08-03),
    //    so reading it alone made `itemIds` empty for every feature and this gate
    //    returned `{ ok: true }` on the very next line — structurally unable to refuse
    //    anything. EI-19435123521651527.
    const { planSlug, itemIds } = await resolvePlanItemProvenance(harness, featureId);
    if (!planSlug || itemIds.length === 0) return { ok: true }; // incomplete provenance ⇒ nothing safe to prove

    // 2. The source plan items' inline VAL assertions.
    const assertions = await sql<RollupAssertion[]>`
      SELECT val_id, item_id, requires_test
        FROM harness_shared.harness_plan_assertions
       WHERE workspace_id = ${ws}
         AND harness_slug = ${harness}
         AND plan_slug = ${planSlug}
         AND item_id = ANY(${itemIds})
    `;
    if (!assertions.some((a) => a.requires_test)) return { ok: true }; // nothing requires a test

    // 2b. SPEC-GOVERNED VALs are NOT judged here (WI-10004463). Since first-class spec clauses
    //     landed, a requires_test VAL that a plan item promoted into an ENFORCEABLE clause
    //     (`plan_spec_clauses.source_val_id`, current revision accepted|active) is proven by
    //     immutable `spec_evidence_bindings` and judged — with currentness, mutation and
    //     graded-adequacy semantics — by `specTestAdequacyCompletionGate` at the same close.
    //     `harness_tests` has had no writer since 2026-08-22 (its only writer is the
    //     replace-all POST /internal/test-snapshot), so re-asking it about such a VAL is
    //     structurally unsatisfiable: every NEW spec-era feature item was refused no matter
    //     how well proven. Only VALs with NO enforceable clause still use the legacy rollup.
    //     (A draft/exempt/retired/superseded clause does not exempt its VAL: nothing else
    //     would judge it.)
    const requiringVals = [...new Set(assertions.filter((a) => a.requires_test).map((a) => a.val_id))];
    const governed = await sql<{ val_id: string }[]>`
      SELECT c.source_val_id AS val_id
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id = c.workspace_id
         AND r.harness_slug = c.harness_slug
         AND r.plan_slug = c.plan_slug
         AND r.spec_id = c.spec_id
         AND r.revision = c.current_revision
       WHERE c.workspace_id = ${ws}
         AND c.harness_slug = ${harness}
         AND c.plan_slug = ${planSlug}
         AND c.source_val_id = ANY(${requiringVals})
         AND r.lifecycle_status IN ('accepted', 'active')
    `;
    const specGoverned = new Set(governed.map((g) => g.val_id));
    const legacyAssertions = assertions.filter((a) => !specGoverned.has(a.val_id));
    if (!legacyAssertions.some((a) => a.requires_test)) return { ok: true }; // all proof is spec-governed

    // 3. The harness's tests, mapped to the rollup shape (the VAL is the join key).
    const testRows = await sql<{ status: string; payload: { coversVALs?: unknown } }[]>`
      SELECT status, payload
        FROM harness_shared.harness_tests
       WHERE workspace_id = ${ws}
         AND harness_slug = ${harness}
    `;
    const tests: RollupTest[] = testRows.map((r) => ({
      status: r.status,
      coversVALs: Array.isArray(r.payload?.coversVALs)
        ? (r.payload.coversVALs as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
    }));

    // 4. Roll up by plan item; PASS iff every covered item has all of its
    //    test-requiring VALs passing (valsRequiringTest === 0 OR === valsPassing).
    const rollup = computePlanItemTestStatus(legacyAssertions, tests);
    const blocked = Object.values(rollup).some(
      (s) => s.valsRequiringTest > 0 && s.valsPassing < s.valsRequiringTest,
    );
    if (!blocked) return { ok: true };

    // 5. Name the specific not-yet-passing required VAL(s) for the refusal reason.
    const failing = [
      ...new Set(
        legacyAssertions
          .filter((a) => a.requires_test && deriveAssertionStatus(a.val_id, tests) !== 'passed')
          .map((a) => a.val_id),
      ),
    ];
    return {
      ok: false,
      reason:
        `test-requiring VAL(s) not yet passing: ${failing.join(', ')} — ` +
        `add or repair the covering framework test(s) before completing`,
    };
  } catch {
    // FAIL-OPEN: a gate bug / PG hiccup must never block a real completion.
    return { ok: true };
  }
}
