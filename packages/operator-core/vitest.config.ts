import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// operator-core unit tests. Resolution of internal imports is relative
// (no @/ alias in this package); @papercusp/* workspace deps resolve via the
// hoisted node_modules symlinks. The defineVitestConfig tsconfigPaths plugin
// reads this package's tsconfig (no paths) — harmless. The admin test-runs
// reporter (the /admin/testing status chips) is AUTO-WIRED by defineVitestConfig
// — no per-config wiring needed.
// laneSplit: this workspace OPTS IN to the pure/stateful lane split
// (plan gate-suite-speedup-2026-08-12). It is inert unless PC_TEST_LANE names a lane, so
// `npm run test` — including every re-run the green-checkpoint gate performs — is byte-for-byte
// unchanged: the full suite, isolated. Only the dedicated lane legs opt in.
//
// operator-core is the workspace this exists for: its leg is ~50% of the gate's entire serial
// test phase (D-031), and ~69% of its 4,105 unit files never touch the module registry, so they
// can share a fork instead of cold-transpiling the operator-core graph once per file.
// Coverage-census attribution (plan deterministic-coverage-census-2026-08-17, P-004). Wired
// here — not into @papercusp/test-config's shared setup list — because only this workspace and
// apps/operator run tests that can reach a Hono route or an MCP dispatch; every other workspace
// would load it to observe traffic it cannot generate. Inert unless PAPERCUSP_TEST_ATTRIBUTION=1
// (the setup file registers no hooks at all when disarmed).
// detached-imports: drains tracked fire-and-forget dynamic imports before each file's
// environment is torn down. Without it a lazy side-effect import (sync-sse / system-health /
// calibration) that outlives its test file throws EnvironmentTeardownError mid-graph, and in
// the pure lane (isolate:false, shared fork) that failure is attributed to whichever CO-RESIDENT
// file is collecting — victims report `(0 test)` and pass again in a fresh process. Wired here
// rather than in @papercusp/test-config for the same reason as the census setup above: these
// imports only exist in this workspace.
export default defineVitestConfig({
  layer: 'unit',
  laneSplit: true,
  setupFiles: [
    resolve(__dirname, 'lib/coverage-census/attribution/setup-vitest.ts'),
    resolve(__dirname, 'lib/detached-imports/setup-vitest.ts'),
    resolve(__dirname, 'lib/release/dependency-copy-isolation.setup-vitest.ts'),
  ],
});
