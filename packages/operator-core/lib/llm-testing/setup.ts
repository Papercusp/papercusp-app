/**
 * Operator implementation of the runner's `applySetup` seam
 * (memory-backend-benchmark-2026-06-05 P-009 — first user: the T4
 * boot-recall tier).
 *
 * Seeds `scenario.setup.mem0` entries through the neutral memory seam
 * (`getMemoryBackend()` — the SAME store the live operator's pre-turn
 * injection reads, so a seeded gotcha is recallable by the SUT), and
 * returns the cleanup that forgets every seeded id after the run.
 *
 * Semantics:
 *   - Writes are VERBATIM (`verbatim: true` → mem0 `infer: false`): no
 *     LLM fact-extraction, exactly-one-entry-per-seed, zero extraction
 *     cost — the scenario controls the recallable bytes (D-008).
 *   - `scope` defaults to `harness:<PAPERCUSP_LLM_TEST_HARNESS|papercup>`.
 *     The operator-converse injection path searches ONLY harness pools
 *     when there is no session user (the llm-testing HTTP path), so
 *     user-scoped seeds would never surface — harness scope is the
 *     load-bearing default.
 *   - Every seed carries `metadata.llm_testing: true` + the runId, so
 *     an orphan (cleanup crashed) is identifiable and sweepable.
 *   - A seed that stores nothing (`ids: []`) throws: a T4 scenario whose
 *     gotcha never landed would silently measure nothing.
 *
 * `setup.features` / `setup.issues` are declared in the scenario type but
 * have no seeding implementation yet — we warn rather than silently
 * ignore, so an author finds out at run time.
 */

import type { ScenarioSetup, SetupCleanup } from '@papercusp/testing-shell/llm';

import { getMemoryBackend, type MemoryBackend } from '../memory/backend';
import { getResolvedMode } from '../memory/mem0-client';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

/** Default harness pool for seeds that don't name a scope. */
export function defaultSeedScope(): string {
  // Generalized: fall back to the configured operator-home pointer
  // (PAPERCUSP_POT_HOME_SLUG via operatorHomeHarnessSlug()), not a baked
  // 'papercup' literal — papercup→papercusp is an env switch, not a code edit.
  return `harness:${process.env.PAPERCUSP_LLM_TEST_HARNESS ?? operatorHomeHarnessSlug()}`; // allow-scope-default: LLM-test target harness; env-overridable, defaults to operator home
}

export async function applyScenarioSetup(
  setup: ScenarioSetup,
  ctx: { runId: string },
  backendOverride?: MemoryBackend,
): Promise<SetupCleanup | void> {
  if (setup.features?.length || setup.issues?.length) {
    console.warn(
      '[llm-testing] scenario.setup.features/issues seeding is not implemented — those entries are IGNORED.',
    );
  }
  const seeds = setup.mem0 ?? [];
  if (seeds.length === 0) return;

  const backend = backendOverride ?? getMemoryBackend();
  const avail = await backend.available();
  if (!avail.ok) {
    throw new Error(
      `[llm-testing] cannot seed scenario memory: backend '${backend.name}' unavailable (${avail.reason})`,
    );
  }

  const seededIds: string[] = [];
  try {
    for (const seed of seeds) {
      const scope = seed.scope ?? defaultSeedScope();
      const { ids } = await backend.remember(seed.body, {
        scope,
        kind: seed.kind,
        verbatim: true,
        metadata: { llm_testing: true, run_id: ctx.runId },
      });
      if (ids.length === 0) {
        throw new Error(
          `[llm-testing] memory seed stored NOTHING (backend '${backend.name}', scope '${scope}') — ` +
            `the scenario would run without its gotcha. Seed body: ${seed.body.slice(0, 80)}…`,
        );
      }
      const recall = await backend.search(seed.body, { scope, limit: 5 });
      if (!recall.some((hit) => hit.id && ids.includes(hit.id))) {
        const mode = getResolvedMode() ?? 'unknown';
        throw new Error(
          `[llm-testing] memory seed was not immediately recallable after write (backend '${backend.name}', scope '${scope}', resolved mode='${mode}') — ` +
            `the scenario would be flaky under degraded embedder mode. Seed body: ${seed.body.slice(0, 80)}…`,
        );
      }
      seededIds.push(...ids);
    }
  } catch (err) {
    // Partial seeding must not linger — forget what landed, then rethrow.
    await forgetAll(backend, seededIds);
    throw err;
  }

  return async () => forgetAll(backend, seededIds);
}

async function forgetAll(backend: MemoryBackend, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await backend.forget(id);
    } catch (err) {
      console.warn(
        `[llm-testing] failed to forget seeded memory ${id}: ${(err as Error).message} ` +
          '(orphan is tagged metadata.llm_testing=true — sweepable)',
      );
    }
  }
}
