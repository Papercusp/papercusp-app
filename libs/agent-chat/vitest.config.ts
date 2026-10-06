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
// (github.com/Papercusp/agent-chat) has no sibling `libs/test-config` (a
// Papercusp-monorepo-private package), so this can no longer route through
// `@papercusp/test-config`'s `defineVitestConfig`. jsdom component/hook tests
// in this package opt into jsdom per-file via a `// @vitest-environment
// jsdom` pragma and need the automatic JSX runtime (components omit
// `import React`). The old config's `server.fs.strict:false` existed only to
// let vite's fs allow-list reach the shared fail-on-console setup file that
// lived outside this submodule's cwd in the superproject's libs/test-config —
// with that setup gone, the workaround is no longer needed.
export default defineConfig({
  test: {
    globalSetup: monorepoHostPreflight(),
    exclude: ['node_modules', 'dist'],
    testTimeout: 15_000,
  },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
});
