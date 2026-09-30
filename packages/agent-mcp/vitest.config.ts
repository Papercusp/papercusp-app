import { defineConfig } from 'vitest/config';
import { gateParticipationConfig } from '@papercusp/test-config/vitest-config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // This workspace hand-rolls its vitest config (not defineVitestConfig), so
    // gateParticipationConfig() wires what the green-checkpoint gate needs: the /admin/testing
    // reporter, the per-file pass-proof recorder + input capture when armed, and the reuse skip
    // list (WI-10003716). Its own setup/exclude go THROUGH the options — set beside the spread,
    // they would overwrite the capture setup and the skip list.
    ...gateParticipationConfig({
      // Registers Papercusp's capability→tier policy (plan P-012) for every test
      // file, mirroring production where importing @papercusp/agent-mcp activates
      // it. Without this, defineTool/definePrompt stamp the engine's 'low' default.
      setupFiles: ['./src/__tests__/test-setup.ts'],
      exclude: ['src/**/*.integration.test.ts'],
    }),
  },
});
