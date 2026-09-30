import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

// Integration layer: picks up src/**/*.integration.test.ts (the unit config
// excludes them). These tests provision their own fresh testcontainer
// database (Docker required) — no shared baseline schema, no globalSetup.
export default defineVitestConfig({
  layer: 'integration',
  include: ['src/**/*.integration.test.ts'],
});
