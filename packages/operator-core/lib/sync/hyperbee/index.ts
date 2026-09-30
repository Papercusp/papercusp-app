/**
 * Hyperbee sync substrate — public exports.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * This is the entry point the rest of the operator imports from.
 * Sub-modules are implementation details and can change without
 * breaking consumers.
 */

export {
  getHarnessStore,
  closeHarnessStore,
  type HarnessStoreOpts,
} from './corestore';

// The projection-layer op envelope. (The multi-writer Autobase data layer —
// `autobase-setup.ts` — was retired in the Model B substrate rewrite; the
// op-envelope contract outlived it and now lives in its own module.)
export { type OpEnvelope } from './op-envelope-types';

export {
  CURRENT_SCHEMA_VERSION,
  acceptOpVersion,
  getKnownMaxSchemaVersion,
  schemaVersionEvents,
  type SchemaVersionAlert,
} from './schema-version';

export {
  markSqlMigrationsComplete,
  markRuntimeEnsureComplete,
  isReadyForProjection,
  awaitEnsurePaths,
  BootGateTimeoutError,
} from './boot-gate';

export {
  registerProjection,
  getProjection,
  applyHyperbeeOpToPg,
  lwwPick,
  type TableProjection,
} from './projection';
