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

// Standalone config (mirrors ui-primitives): a clone of this package's own
// repo has no sibling monorepo test-config, so it must not route through
// @papercusp/test-config. jsdom for component tests when they land; the
// component is currently covered end-to-end by its two monorepo consumers'
// suites (LearningTab.test.tsx, ObservationsPanel.test.tsx).
export default defineConfig({
  test: {
    globalSetup: monorepoHostPreflight(),
    environment: 'jsdom',
  },
});
