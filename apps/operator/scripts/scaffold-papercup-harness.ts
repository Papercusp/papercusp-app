/**
 * One-shot script: scaffold per-slug schema for the papercup harness
 * registered by P-024. After this runs, feature-CRUD against
 * `papercusp-workspace` / `papercup` works via POST /api/harness/papercup/features.
 *
 * Idempotent — scaffoldHarnessSchema uses CREATE SCHEMA IF NOT EXISTS
 * + CREATE TABLE IF NOT EXISTS throughout.
 */

import { scaffoldHarnessSchema } from '@papercusp/operator-core/lib/scaffold-harness-schema';

async function main(): Promise<void> {
  console.log('[scaffold] papercup schema...');
  await scaffoldHarnessSchema('papercup');
  console.log('[scaffold] done.');
}

main().catch((err) => {
  console.error('[scaffold] ERROR:', err);
  process.exit(1);
});
