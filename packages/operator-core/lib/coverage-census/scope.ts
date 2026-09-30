/**
 * The ONE census scope resolver — used by the census that WRITES surfaces and by the
 * attribution layer that writes EVIDENCE against them.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-004, Decision D-011).
 *
 * ⚠ WHY THIS FILE EXISTS AT ALL — a measured, silent, total failure.
 *
 * `coverage_evidence` and `testing_surfaces` are joined on `(workspace_id, harness_slug)`.
 * Until D-011 the two halves derived that pair INDEPENDENTLY:
 *
 *   - the census (`routines/coverage-census-action.ts`) resolved it at RUNTIME —
 *     `activeWorkspaceId()` + `operatorHomeHarnessSlug()`, which always answer;
 *   - attribution (`attribution/context.ts`) re-derived it from ENV ONLY, mirroring the
 *     test-runs reporter's `resolveTestRunHarnessSlug()` / `resolveTestRunWorkspaceId()`,
 *     and REFUSED to write when either half was missing.
 *
 * The rationale for the second — "resolve it the way the reporter does, so a run's
 * `test_runs` rows and its evidence rows land in one scope" — was coherent and wrong,
 * because it was never checked against what the reporter actually resolves. It resolves
 * NOTHING: measured 2026-08-18, `harness_slug` was NULL on 100% of the 7,202 `test_runs`
 * rows written in the preceding 90 minutes (every source: gate `ci`, `local`, admin-UI),
 * and neither live operator host process had ANY of the four scope variables set. So the
 * scope those two functions agreed on was `(NULL, NULL)`, attribution correctly refused
 * it on every flush, and the layer could not have written a single evidence row no matter
 * how much traffic it observed. Arming it would have produced silence indistinguishable
 * from "the tests genuinely cover nothing".
 *
 * THE RULE THIS ENCODES: evidence must be scoped by the SAME call that scoped the
 * surfaces, not by a parallel derivation that happens to agree on a good day. That is the
 * census design's central invariant (`providers/types.ts` — identity comes from the
 * registration, never from a re-derivation) applied one level up, to the scope itself.
 *
 * WHY A RUNTIME FALLBACK IS NOT A "GUESS". The refusal it replaces was guarding against
 * MISATTRIBUTION — evidence landing on another harness's surface of the same name. A
 * resolver shared with the writer cannot do that: it returns the scope the surfaces are
 * actually in. And the store is belt-and-braces anyway — `pg-evidence-store` looks each
 * surface up WITHIN the scope and counts a miss as `unmatchedSurfaces` instead of
 * inserting, so a scope that is wrong writes zero rows loudly rather than wrong rows
 * quietly.
 *
 * PRECEDENCE, and why an env PIN still wins:
 *   1. An explicit pin, because a child/cross-process run is the one case where the
 *      ambient answer is wrong — a test fork driving another workspace's operator must be
 *      able to say so. These are the reporter's own variables, so a run pinned for
 *      `test_runs` attributes to the same place.
 *   2. The ambient runtime resolvers — the census's own answer, which always resolves.
 */

import type { CensusScope } from '@papercusp/testing-shell/census';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { activeWorkspaceId } from '../workspace-registry';

/**
 * Env pins for the workspace half.
 *
 * `PAPERCUSP_WORKSPACE_ID` is ALSO read by {@link activeWorkspaceId} (its step 2), so
 * naming it here is redundant-but-deliberate: this list is the documented contract, and a
 * reader should not have to walk into the registry to learn that a pin is honoured.
 * `PAPERCUSP_WORKSPACE` is the reporter's accepted alias and has no other reader.
 */
export const WORKSPACE_PIN_ENV = ['PAPERCUSP_WORKSPACE_ID', 'PAPERCUSP_WORKSPACE'] as const;

/**
 * Env pins for the harness half — the test-runs reporter's variables, in its order.
 * `PAPERCUSP_POT_HOME_SLUG` is not listed because {@link operatorHomeHarnessSlug} reads it
 * itself; it is the ambient answer, not a per-run pin.
 */
export const HARNESS_PIN_ENV = [
  'PAPERCUSP_TEST_RUN_HARNESS',
  'HARNESS_SLUG',
  'PAPERCUSP_HARNESS_SLUG',
] as const;

function firstNonEmptyEnv(names: readonly string[]): string | null {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

/**
 * Resolve the census scope. NEVER returns null: both halves have a total fallback, which
 * is the whole point — an unresolvable scope was the defect, not a safety feature.
 *
 * Callers that must tolerate a throwing registry read (attribution, which may not affect
 * the request it is describing) should wrap it; the census itself should not, because a
 * census that cannot resolve its own scope must fail loudly rather than write elsewhere.
 */
export function resolveCensusScope(): CensusScope {
  return {
    workspaceId: firstNonEmptyEnv(WORKSPACE_PIN_ENV) ?? activeWorkspaceId(),
    harnessSlug: firstNonEmptyEnv(HARNESS_PIN_ENV) ?? operatorHomeHarnessSlug(),
  };
}
