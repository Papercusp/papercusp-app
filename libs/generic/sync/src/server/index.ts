/**
 * @papercusp/sync/server — the server half of the live-query stack.
 *
 * Pairs with the client (`@papercusp/sync`): the host builds a query
 * registry + an invalidation bus + mounts the HTTP/SSE routes, and the
 * client's `useSyncQuery` reads through them with cross-process,
 * server-pushed invalidation. Everything domain/transport-specific is
 * injected — this entry point pulls in no database or framework.
 *
 * PG LISTEN/NOTIFY adapters live at the `@papercusp/sync/server/pg`
 * sub-path (re-exported here for convenience; they are still dep-free —
 * the host supplies the postgres client).
 */

export {
  NAME_NOT_FOUND,
  createResolver,
  knownQueryNames,
  isRegistered,
  QueryResolveTimeoutError,
  type NameNotFound,
  type ArgsValidator,
  type QueryEntry,
  type QueryRegistry,
  type NamedQueryResolver,
  type CreateResolverOptions,
} from './query-registry';

export {
  createInvalidationBus,
  DEFAULT_BRIDGE_COALESCE_WINDOW_MS,
  type SyncEvent,
  type ListenSource,
  type NotifySink,
  type SubscribeHandle,
  type SubscribeOptions,
  type CreateInvalidationBusOptions,
  type InvalidationBus,
  type BridgeTarget,
  type NotifyInvalidateOpts,
} from './invalidation-bus';

export {
  createRestQueryHandler,
  createSseHandler,
  type SsePrimitives,
} from './http-routes';

export {
  createPgListenSource,
  createPgNotifySink,
  type PgSqlLike,
} from './pg-adapter';

/**
 * The interest-declaration wire contract. Shared with the CLIENT half rather
 * than restated here: the param name is the only thing making the two sides
 * agree, and a drifted copy fails silently (the server simply sees no
 * declaration and falls back to full fan-out).
 */
export {
  INTEREST_PARAM,
  MAX_DECLARED_QUERY_NAMES,
  classifyInterestNames,
  normalizeInterestNames,
  parseInterestDeclaration,
  parseInterestParam,
  withInterestParam,
  type InterestDeclaration,
  type InterestDisposition,
} from '../interest-protocol';
