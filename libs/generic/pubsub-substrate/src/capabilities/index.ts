/**
 * @papercusp/pubsub-substrate/capabilities — the pub/sub coordination
 * capabilities: Subscribable + Threadable + Topics + the objectToTargetRef codec
 * + the resolveObjectSubscribers fan-out, plus the interface-only Claimable /
 * Lifecycle contracts. Each table-backed capability is an interface with an
 * in-memory double passing one conformance suite.
 *
 * The typed-entity graph this builds on (`ObjectRef`, Linkable, Taggable) lives
 * in @papercusp/linkable-edges; `ObjectRef` + `TaggableStore` are re-exported
 * here for ergonomics. The Postgres backends are the host tie-in adapter and
 * live in @papercusp/coordination/capabilities. The conformance suites import
 * `vitest`, so they live behind the dedicated
 * `@papercusp/pubsub-substrate/capabilities/conformance` subpath, NOT this barrel.
 */

export type {
  ObjectRef,
  TaggableStore,
  DeliveryMode,
  SubscriptionTargetKind,
  SubscriptionRow,
  SubscribeInput,
  SubscribableStore,
  ThreadRow,
  ThreadPostRow,
  ThreadableStore,
  TopicRow,
  CreateTopicInput,
  TopicStore,
  ClaimableStore,
  LifecycleState,
  LifecycleStore,
  ResolvedSubscriber,
} from './types';
export {
  DELIVERY_MODES,
  LIFECYCLE_STATES,
  objectToTargetRef,
  targetRefToObject,
  mergeResolved,
  resolveObjectSubscribers,
} from './types';

export {
  InMemoryTopicStore,
  InMemoryEntitySubscriptionStore,
  InMemoryThreadStore,
} from './memory-stores';
