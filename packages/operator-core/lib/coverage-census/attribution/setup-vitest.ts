/**
 * Vitest SETUP for coverage attribution — publishes "which test is running right now" so the
 * in-process dispatcher hooks can stamp it onto the evidence they write.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-004).
 *
 * WHY A SETUP FILE AND NOT A REPORTER. A vitest reporter runs in the MAIN process; the tests —
 * and the in-process Hono app / MCP dispatcher they drive — run in FORKS. The ambient slot the
 * hooks read is fork-local, so only code running inside the fork can write it. `setupFiles` is
 * that code.
 *
 * ⚠ WHY EVERYTHING IS BEHIND THE ARMING CHECK, INCLUDING THE IMPORTS. This file is loaded once
 * per test FILE across two whole workspaces, so its DISARMED cost is the cost this
 * instrumentation imposes on everyone not using it. Disarmed, that cost is one module
 * evaluation, one env read, and nothing else: the sink and the reporter are behind dynamic
 * imports, and the `beforeEach`/`afterEach`/`afterAll` hooks are never registered, so no
 * per-test work is added to any ordinary run. A hook that registers and then returns early
 * would still cost a hook per test — hence the check here, not inside the hooks.
 *
 * SCOPE: wired into `packages/operator-core` and `apps/operator` only — the two workspaces
 * whose tests can actually reach a route or a tool dispatch. Adding it to the shared setup list
 * in `@papercusp/test-config` would load it for every workspace in the monorepo, to observe
 * traffic none of them can generate.
 */

import { afterAll, afterEach, beforeEach, expect } from 'vitest';
import { isAttributionArmed } from './context';

if (isAttributionArmed()) {
  const [{ setAmbientTestContext }, { flushTrafficEvidence }, { toWorkspaceRel }] =
    await Promise.all([
      import('./context'),
      import('./sink'),
      import('@papercusp/test-config/admin-test-runs-reporter'),
    ]);

  beforeEach(() => {
    // `expect.getState()` is vitest's own per-test state — the same object the built-in
    // matchers read — so `currentTestName` and `testPath` are exactly what the runner believes
    // is executing, with no parallel bookkeeping that could drift from it.
    const s = expect.getState();
    setAmbientTestContext({
      // Relativized through the reporter's OWN function so this path and `test_runs.file_path`
      // are byte-identical — they are the join key. See `toWorkspaceRel`'s doc comment.
      file: s.testPath ? toWorkspaceRel(s.testPath) : null,
      case: s.currentTestName ?? null,
    });
  });

  afterEach(() => {
    // Cleared between tests so a call made OUTSIDE a test body (a module-scope side effect, an
    // async handler that outlived its test) is attributed to no test rather than to whichever
    // test happened to run last. A WRONG attribution is worse than a missing one: it reads as
    // real coverage that no test actually provides.
    setAmbientTestContext(null);
  });

  afterAll(async () => {
    // The sink's own debounce timer is unref'd (it must never hold a process open), so the tail
    // of a file's traffic could otherwise be lost when the fork exits promptly. This is the
    // deterministic drain; the sink's `beforeExit` hook remains the backstop for the
    // cross-process case, where no vitest lifecycle exists at all.
    await flushTrafficEvidence();
  });
}
