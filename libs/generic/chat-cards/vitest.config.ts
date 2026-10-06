import { defineConfig } from 'vitest/config';
import { gateParticipationConfig } from '@papercusp/test-config/vitest-config';

// gateParticipationConfig carries the host-preflight globalSetup (WI-10005724), so a direct
// `npx vitest` here refuses a held restricted write the same way the test routers do. This
// package is not a declared root workspace, so scripts/check-vitest-config-enrollment.mjs
// never saw this config; it is enrolled by hand rather than left as the one plain config.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    ...gateParticipationConfig(),
  },
});
