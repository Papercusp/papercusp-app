import { defineConfig } from 'vitest/config';
import { gateParticipationConfig } from '@papercusp/test-config/vitest-config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Hand-rolled config (not defineVitestConfig) → gateParticipationConfig() wires what the
    // green-checkpoint gate needs: the /admin/testing reporter, the per-file pass-proof
    // recorder + input capture when armed, and the reuse skip list (WI-10003716).
    ...gateParticipationConfig(),
  },
});
