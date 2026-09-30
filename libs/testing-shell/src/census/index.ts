/**
 * The coverage census — public surface.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-002).
 *
 * Exported as its own `@papercusp/testing-shell/census` subpath rather than through the package
 * barrel: the barrel re-exports React panels, and the census job runs server-side (a routine, a
 * gate, a CLI). Routing it through the barrel would drag the UI dependency tree into every
 * server-side consumer.
 */

export type {
  CensusContext,
  ExistingSurface,
  Fidelity,
  ObservedSurface,
  ProviderRun,
  SurfaceCensusProvider,
} from './types.js';
export { FIDELITY_ORDER, FIDELITY_RANK, isFidelity } from './types.js';

export type {
  CensusDiff,
  CensusRetire,
  CensusUpsert,
  DuplicateEmission,
  IdentityCollision,
  ResolvedSurface,
} from './diff.js';
export { diffCensus, runProvider } from './diff.js';

export type {
  CensusReport,
  CensusScope,
  CensusStore,
  ProviderRegistration,
  RunCensusOptions,
} from './run.js';
export { DEFAULT_MASS_RETIREMENT_THRESHOLD, runCensus } from './run.js';

export type { JsonSchema, SchemaArbitraryOptions } from './schema-arbitrary.js';
export {
  jsonSchemaToArbitrary,
  UnsatisfiableSchemaError,
  UnsupportedSchemaError,
} from './schema-arbitrary.js';
