import { gateParticipationConfig, gateParticipationServerConfig } from '@papercusp/test-config/vitest-config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: __dirname,
  // libs/generic/papergrid/package.json declares npm workspaces, so Vite's default fs.allow stops
  // at papergrid and a jsdom file cannot load the gate's setup file from libs/test-config
  // (WI-10003808). This widens it to the monorepo root, exactly as defineVitestConfig does.
  server: gateParticipationServerConfig(),
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    // Gate participation (WI-10003808): pass-proof recording, executed-inputs capture and the
    // per-file reuse skip list. vitest's default exclude already covers node_modules.
    ...gateParticipationConfig(),
  },
});
