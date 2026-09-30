import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { mergeConfig } from 'vitest/config';
import { resolve } from 'node:path';

const operatorRoot = resolve(import.meta.dirname, '../operator');

// `*.flakeproof.test.tsx` — the reserved scratch fixture for scripts/flake-soak.sh
// (WI-4481). A flake fix drops a KNOWN-FLAKY fixture next to the code under test
// and runs `flake-soak.sh --self-test <fixture>` to PROVE the soak lane can
// actually redden a load-sensitive race — a guard that only ever shows green has
// proven nothing (agent-insights/prove-it-discriminates-before-it-acts).
//
// It must never redden a NORMAL run, so it is excluded here for everyone except
// the soak's self-test (which sets FLAKE_SOAK_SELFTEST=1). It is also gitignored,
// so git-sync never commits one and it cannot become a landmine in CI. Merged
// (not replaced): vitest's mergeConfig concatenates array options, so this adds to
// the base excludes from defineVitestConfig rather than clobbering them.
const excludeFlakeproof =
  process.env.FLAKE_SOAK_SELFTEST === '1' ? [] : ['**/*.flakeproof.test.ts', '**/*.flakeproof.test.tsx'];

export default mergeConfig(defineVitestConfig({ layer: 'unit' }), {
  test: { exclude: excludeFlakeproof },
  resolve: {
    alias: [
      { find: '@', replacement: operatorRoot },
      // Shim next/* the same way vite.config.ts does so operator components
      // can be imported in tests without a real Next.js runtime.
      { find: /^next\/navigation$/, replacement: resolve(import.meta.dirname, 'shims/next-navigation.tsx') },
      { find: /^next\/link$/, replacement: resolve(import.meta.dirname, 'shims/next-link.tsx') },
      { find: /^next\/dynamic$/, replacement: resolve(import.meta.dirname, 'shims/next-dynamic.tsx') },
      { find: /^@bprogress\/next/, replacement: resolve(import.meta.dirname, 'shims/bprogress.tsx') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  server: { fs: { strict: false } },
});
