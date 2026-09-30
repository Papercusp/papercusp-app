import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The e2e layer (EI-24442044145393058): `*.e2e.test.ts` files that drive a live running
// system. `npm run test:file` routes such a file here, so its test_runs row records
// testLayer 'e2e' from this config's runtime `provide` — acceptance BAR clauses whose
// requiredTestLayers name 'e2e' bind only to such a row. The unit config still collects
// these files too, so the gate's unit run keeps covering them.
export default defineVitestConfig({
  layer: 'e2e',
  setupFiles: [
    resolve(__dirname, 'lib/coverage-census/attribution/setup-vitest.ts'),
    resolve(__dirname, 'lib/detached-imports/setup-vitest.ts'),
  ],
});
