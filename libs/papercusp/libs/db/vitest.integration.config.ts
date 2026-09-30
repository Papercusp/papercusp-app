import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { fileURLToPath } from 'node:url';

// Resolve setup files from this config's location, not Vitest's invocation cwd.
// A root-level invocation such as `--config libs/db/vitest.integration.config.ts`
// otherwise looks for the setup file at the papercusp submodule root.
const INTEGRATION_SETUP = fileURLToPath(new URL('./vitest.integration.setup.ts', import.meta.url));

// Integration layer: picks up *.integration.test.ts (the unit config excludes
// them). These tests provision their own fresh testcontainer database — no
// shared baseline schema needed — so no globalSetup is wired here.
//
// The setup file pins PAPERCUSP_PGBOUNCER=0: on a 'server'-class host the
// connection layer would otherwise reroute org-pool URLs through the BOX-WIDE
// PgBouncer (:6432 → the shared native PG), not the test's private container —
// the WI-1666 mis-route class (auth failures + dropped LISTEN under txn pooling).
export default defineVitestConfig({
  layer: 'integration',
  setupFiles: [INTEGRATION_SETUP],
});
