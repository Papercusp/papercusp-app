import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Inside the Papercusp monorepo, run its restricted-hold preflight before any test starts
// (Decision D-012, WI-10005765): this standalone config cannot import @papercusp/test-config,
// which carries that preflight for every other package. A standalone clone of this repo has no
// such file, so it runs none.
function monorepoHostPreflight(): string[] {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const candidate = join(dir, 'scripts/lib/vitest-host-preflight.mjs');
    if (existsSync(candidate)) return [candidate];
    if (dirname(dir) === dir) return [];
  }
}

// WI-4973: standalone config — a clone of this package's own repo
// (github.com/Papercusp/ui-primitives) has no sibling `libs/test-config` (a
// Papercusp-monorepo-private package), so this can no longer route through
// `@papercusp/test-config`'s `defineVitestConfig`. jsdom globally (not every
// test file here carries a per-file `// @vitest-environment jsdom` pragma —
// e.g. a11y.test.tsx relies on the config default) + the automatic JSX
// runtime (components omit `import React`).
export default defineConfig({
  test: {
    globalSetup: monorepoHostPreflight(),
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
