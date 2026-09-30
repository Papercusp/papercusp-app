import { gateParticipationConfig, sharedHostWorkerCap } from '@papercusp/test-config/vitest-config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Per-file `// @vitest-environment jsdom` pragma switches the few suites
    // that need a DOM (localStorage store, React DockWorkspace). Keeping the
    // default `node` makes the pure-logic suites (layout, adapter, registry)
    // fast and dependency-free.
    testTimeout: 15_000,
    // See libs/sync/vitest.config.ts — every project in the root topology must
    // agree on maxWorkers or vitest 4 refuses the run.
    ...sharedHostWorkerCap(),
    // Gate participation (WI-10003808): pass-proof recording, executed-inputs capture and the
    // per-file reuse skip list. `dist` rides through the options: an `exclude` set beside the
    // spread would overwrite the skip list. node_modules is already in vitest's defaults.
    ...gateParticipationConfig({ exclude: ['dist'] }),
  },
});
