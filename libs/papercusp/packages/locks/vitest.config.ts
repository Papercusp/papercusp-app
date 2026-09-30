import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

// Gate participation (WI-10003808): the shared base wires pass-proof recording, executed-inputs
// capture and the per-file reuse skip list, and it widens server.fs.allow past this nested
// libs/papercusp workspace root so jsdom files can load the gate's setup file. Without a config
// file this workspace ran on vitest defaults and never reported to the gate.
export default defineVitestConfig({
  layer: 'unit',
  include: ['src/**/*.test.ts'],
});
