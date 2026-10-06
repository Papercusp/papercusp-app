/**
 * @papercusp/decision-model — a provider-agnostic client for TYPED DECISION
 * models: models that answer typed questions (choice / score / yes-no) about a
 * piece of state with probabilities, instead of generating text.
 *
 * Ships the types, one provider adapter (TypeSafe Jev, pinned to a versioned
 * model id), and a client that owns the deadline, the 429/529 backoff, the
 * credential lookup and a fire-and-forget call observer. Every failure is a typed
 * `inconclusive{reason}`, so a consumer falls back to its pre-model behaviour and
 * an unavailable judge can never be read as an empty verdict.
 *
 * Zero domain coupling: the host injects the credential resolver and the
 * observer through `createDecisionClient` and installs the result with
 * `configureDecisionModel`.
 */
export * from './types.js';
export {
  createJevProvider,
  JEV_ENDPOINT,
  JEV_PINNED_MODEL,
  JEV_MAX_CHOICE_OPTIONS,
  JEV_MIN_SCORE_LEVELS,
  JEV_MAX_SCORE_LEVELS,
  type JevProviderOptions,
} from './jev.js';
export {
  createDecisionClient,
  configureDecisionModel,
  getDecisionClient,
  decide,
  eventLoopUtilizationMeter,
  type HostLoadMeter,
  type DecisionClient,
  type DecisionClientOptions,
  type DecideOptions,
  type DeadlineHook,
  type FetchLike,
  type TransportTiming,
} from './client.js';
export {
  createWorkerTransport,
  WORKER_TRANSPORT_MAX_FAILURES,
  type WorkerTransport,
  type WorkerTransportEvent,
  type WorkerTransportOptions,
} from './worker-transport.js';
export { describeError, errorFields, isErrorFields, type ErrorFields } from './error-detail.js';
export {
  toDecisionLedgerEntry,
  canonicalJson,
  sha256Hex,
  stateSha256,
  questionsSchemaSha256,
  optionOrderOf,
  type DecisionLedgerEntry,
  type DecisionLedgerOptions,
  type DecisionPricing,
} from './ledger.js';
