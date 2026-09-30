/**
 * Restore-what-you-found guard for the PROCESS-GLOBAL projected-tool registry.
 *
 * `_resetProjectionRegistryForTests()` empties the registry so a test can register a small
 * fixture set and assert on it in isolation. That is fine for tooldef's own unit tests, whose
 * baseline really is empty — but in operator-core the registry is the REAL agent-tool catalog,
 * populated once by `import '../agent-tools/index'` as a module side effect. There is no
 * re-registration entry point ("importing this file once at app startup is enough"), so once a
 * reused worker's module cache holds that import, a later file's `import` is a no-op and the
 * catalog CANNOT be rebuilt. A test that empties it therefore destroys shared state it did not
 * create, for every file that runs after it in the same fork.
 *
 * Under `isolate: true` this was invisible — a fresh process per file meant the damage died with
 * the file. Under the P-003 pure lane's `isolate: false` it is load-bearing: three pure-lane
 * files clear the registry (plugin-discovery-clamp, agent-tools/hono-shim-dispatch,
 * transport/mcp-slash-prompts), and `__tests__/semantic-argument-vocabulary.test.ts` — which
 * snapshots the catalog at module scope — then saw an EMPTY catalog and failed all 12 cases with
 * "rubrics:get must be registered: expected undefined" (plan gate-suite-speedup-2026-08-12,
 * D-034). Note the victim is order-dependent, not fixed: any catalog-reading file scheduled after
 * a clearer is exposed.
 *
 * The rule this encodes: a test that mutates process-global state RESTORES it. Restoring the
 * observed baseline (rather than asserting the registry starts empty) is what makes it correct
 * under both lanes — an isolated run captures an empty-or-full baseline and puts back exactly
 * that, so behaviour is unchanged where it was already fine.
 *
 * ⚠ PLACEMENT: call this at module scope BEFORE the file registers any fixtures of its own. The
 * baseline is captured EAGERLY at the call (not in a `beforeAll`), so anything registered above
 * the call would be captured as baseline and then re-registered — leaking the fixture forward,
 * which is the very thing this prevents.
 */
import { afterAll } from 'vitest';
import {
  listAllProjectedTools,
  registerProjectedTool,
  _resetProjectionRegistryForTests,
} from '@papercusp/agent-mcp';

/**
 * Capture the projected-tool registry as it is RIGHT NOW and put it back after this file's
 * last test. Returns nothing; the restore is registered as an `afterAll` hook.
 */
export function preserveProjectionRegistryBaseline(): void {
  // Eager, at call time — see the PLACEMENT note above. `.slice()` because the return value is a
  // live snapshot array built from the registry's own values.
  const baseline = listAllProjectedTools().slice();
  afterAll(() => {
    // Clear first: the file's own fixtures are still registered, and re-registering the baseline
    // over them would leave both populations behind.
    _resetProjectionRegistryForTests();
    for (const tool of baseline) registerProjectedTool(tool);
  });
}
