import { defineConfig } from 'vitest/config';

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
    exclude: ['node_modules', 'dist'],
    testTimeout: 15_000,
  },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
});
