/**
 * Drain tracked fire-and-forget imports before the test environment is torn down.
 *
 * Wired from packages/operator-core/vitest.config.ts — here rather than in
 * @papercusp/test-config's shared setup list, for the same reason the coverage-census
 * attribution setup lives in this workspace: operator-core is where the lazy side-effect
 * imports are, so every other workspace would load this to await work it cannot start.
 *
 * See ./index.ts for the failure this prevents (EnvironmentTeardownError poisoning
 * co-resident files in the pure lane).
 */

import { afterAll, afterEach } from 'vitest';

import { drainDetached } from './index';

// afterEach: the common case — an import fired by the test that just finished.
afterEach(async () => {
  await drainDetached();
});

// afterAll: catches work started from a hook rather than a test body, which would otherwise
// still be in flight when the file's environment goes away.
afterAll(async () => {
  await drainDetached();
});
