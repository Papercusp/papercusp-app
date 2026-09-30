import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

export default defineVitestConfig({
  layer: 'unit',
  include: ['src/**/*.test.ts'],
  exclude: [
    'src/main-loop.test.ts',
    // Pre-existing bug — leaks into the runner's real
    // ~/.papercusp/global-plugins/ dir. See quarantine.txt.
    'src/plugin-hooks.test.ts',
    // Dispatcher-level tests need pool=forks; run via
    // vitest.dispatcher.config.ts / `pnpm test:dispatcher`.
    'src/**/*.dispatcher.test.ts',
  ],
});
