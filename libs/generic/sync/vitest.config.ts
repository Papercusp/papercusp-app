import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { mergeConfig } from 'vitest/config';

// Shared base config (same pattern as libs/generic/papergrid/grid-core) so
// runs RECORD to the Tests tab (harness_shared.test_runs via the auto-wired
// admin reporter) instead of rendering perpetually neutral. Inside this
// monorepo @papercusp/test-config resolves via the hoisted root; an external
// borrower of this lib swaps back to a plain defineConfig.
//
// Local additions:
//   - jsdom so the renderHook tests for useOwnedSyncEntity have
//     window/document (focus/astro listeners) + react-dom.
//   - server.fs.strict:false — the shared fail-on-console setup file lives in
//     the SUPERPROJECT's libs/test-config, outside this submodule's cwd.
export default mergeConfig(defineVitestConfig({ layer: 'unit' }), {
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
  server: { fs: { strict: false } },
});
