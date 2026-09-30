import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

// Integration layer: the unit config excludes *.integration.test.ts, so this
// explicit config keeps the delta-eval harness covered by its owning lane.
export default defineVitestConfig({
  layer: 'integration',
  include: ['src/**/*.integration.test.ts'],
  setupFiles: ['./src/__tests__/test-setup.ts'],
});
