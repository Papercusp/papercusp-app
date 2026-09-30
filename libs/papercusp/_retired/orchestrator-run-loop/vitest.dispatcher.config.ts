import { defineConfig } from 'vitest/config';

/**
 * Dispatcher-level integration tests for handleNextValidator and similar
 * main-loop branches that the unit suite can't run in the threads pool —
 * the orchestrator's fire-and-forget setTimeouts (HTTP fetch timeouts,
 * etc.) keep worker_threads alive past the handler return and time the
 * test out even when the handler completed successfully.
 *
 * `pool: 'forks'` isolates each test in a separate process that exits
 * cleanly when the test function resolves, regardless of pending timers.
 *
 * Run via `pnpm test:dispatcher`.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.dispatcher.test.ts'],
    pool: 'forks',
    // Each test spawns 10-20 git subprocesses (worktree add/remove,
    // branch ops, checkout, merge); in tmpfs this is ~10s per test on
    // typical hardware. Generous timeout reflects the actual work.
    testTimeout: 45_000,
    // forks pool spawns one fork per file; share between files by
    // running them in a single pool worker so vitest doesn't re-import
    // main-loop.ts per file (each import is ~5s of TS transform).
    poolOptions: { forks: { singleFork: true } },
  },
});
