import { defineConfig } from 'vitest/config';

// WI-4973: standalone config — a clone of this package's own repo
// (github.com/Papercusp/git-graph) has no sibling `libs/test-config` (a
// Papercusp-monorepo-private package), so this can no longer route through
// `@papercusp/test-config`'s `defineVitestConfig`. git-graph ships React
// components; render-level tests (CommitDetail.test.tsx) opt into jsdom
// per-file via a `// @vitest-environment jsdom` pragma and need the
// automatic JSX runtime so test-file JSX doesn't require an explicit
// `import React` — esbuild defaults to the classic runtime, so opt in here.
export default defineConfig({
  test: {
    exclude: ['node_modules', 'dist'],
    testTimeout: 15_000,
  },
  esbuild: { jsx: 'automatic' },
});
