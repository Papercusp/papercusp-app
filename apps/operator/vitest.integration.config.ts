import { defineVitestConfig, BASELINE_SCHEMA_GLOBAL_SETUP_PATH } from '@papercusp/test-config/vitest-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The admin test-runs reporter is auto-wired by defineVitestConfig — so
// apps/operator's *.integration.test.ts files record to harness_shared.test_runs
// and show their real status in the /admin/testing tab instead of NEUTRAL.
export default defineVitestConfig({
  layer: 'integration',
  include: [
    'test/**/*.integration.test.ts',
    'app/**/*.integration.test.ts',
    'lib/**/*.integration.test.ts',
    // The cc/omp hook scripts' live-operator rungs (coord-e2e P-008) live
    // beside the scripts they exercise, like their unit siblings.
    'scripts/**/*.integration.test.ts',
  ],
  // P-015 (self-contained-migration-baseline-2026-06-02): stand up the COMPLETE
  // harness_shared schema once per run by applying the real migration set, and expose
  // its DSN via inject('baselineSchemaDsn'). Now lifted into @papercusp/test-config so
  // packages/operator-core (which got the carved plans integration tests) shares it.
  globalSetup: [
    BASELINE_SCHEMA_GLOBAL_SETUP_PATH,
    resolve(__dirname, '../../packages/operator-core/test/_org-template.globalSetup.ts'),
  ],
  // Coverage-census attribution (P-004) — see the note in vitest.config.ts. The INTEGRATION
  // layer is where this actually produces rows: it is the layer with a reachable Postgres, so
  // a flush lands instead of disabling the sink.
  setupFiles: [
    resolve(__dirname, 'vitest-shims/psu-pty-temp-dir.ts'),
    resolve(__dirname, '../../packages/operator-core/lib/coverage-census/attribution/setup-vitest.ts'),
  ],
});
