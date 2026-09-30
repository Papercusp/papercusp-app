import { defineConfig } from 'vitest/config';

// WI-4973: standalone config — a clone of this package's own repo
// (github.com/Papercusp/ui-primitives) has no sibling `libs/test-config` (a
// Papercusp-monorepo-private package), so this can no longer route through
// `@papercusp/test-config`'s `defineVitestConfig`. jsdom globally (not every
// test file here carries a per-file `// @vitest-environment jsdom` pragma —
// e.g. a11y.test.tsx relies on the config default) + the automatic JSX
// runtime (components omit `import React`).
export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: ['node_modules', 'dist'],
    testTimeout: 15_000,
    // Vitest 4 refuses to run projects that share a `sequence.groupOrder` while
    // declaring DIFFERENT maxWorkers. Every other project in the root topology
    // takes its cap from `sharedHostWorkerCap()`; this one CANNOT import that
    // (see the note above — no sibling libs/test-config in the standalone repo),
    // so it gets a group of its own rather than a hand-copied cap that would
    // silently drift out of step with the shared one.
    sequence: { groupOrder: 4 },
  },
  esbuild: { jsx: 'automatic' },
});
