import { defineConfig } from 'vitest/config';

/**
 * This package's tests are `node:test` (run via `npm test` → `node --test
 * src/**\/*.node-test.ts` — see package.json), NOT Vitest.
 *
 * EI-10878: the PRIMARY defense against a stray Vitest run collecting these as
 * broken suites is the NAMING CONTRACT — every node:test file is
 * `*.node-test.ts`, which no Vitest `**\/*.test.ts` glob matches. That closes
 * the hole this config's original `include: []` could NOT: a root-level
 * `vitest run <file>` (an agent's bare invocation, or the green-checkpoint's
 * per-file isolation re-run) resolves the ROOT cwd's config, not this
 * package-local one, so `include: []` never applied and the `.test.ts`-named
 * node:test files were still imported → "No test suite found in file …" →
 * recorded as repeatedly-failing by the red-test watchdog even though they are
 * green under their own `node --test`. The recurrence guard is
 * `packages/operator-core/lib/node-test-naming-guard.test.ts` (gated unit test).
 *
 * `include: []` is kept as a belt for the CWD-is-this-package case: a bare
 * `vitest run` here finds zero suites and exits cleanly rather than erroring
 * "No test files found".
 */
export default defineConfig({
  test: {
    include: [],
    // An intentionally-empty Vitest project (see above) must not exit non-zero
    // just because it found zero tests — that would still read as "this
    // workspace's test run failed" to any broader sweep/gate.
    passWithNoTests: true,
  },
});
