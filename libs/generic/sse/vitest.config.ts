import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(
  defineVitestConfig({
    layer: 'unit',
    exclude: ['node_modules', 'dist', '**/*.pg.test.ts'],
  }),
  {
    test: {
      globals: true,
      environment: 'node',
      // jsdom for the React hook test; per-file pragmas would do too, but
      // simpler to use a project-level split if we grow more browser tests.
      environmentMatchGlobs: [
        ['src/client/use-event-source.test.ts', 'jsdom'],
        ['src/__tests__/use-event-source.test.ts', 'jsdom'],
        ['src/client/resilient-event-source.visibility.test.ts', 'jsdom'],
      ],
      testTimeout: 15_000,
    },
  },
);
