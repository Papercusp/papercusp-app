/**
 * @papercusp/coordination/capabilities — the six shared coordination
 * capabilities (D-001 "Subscribable is a capability, not a table"), built once
 * and polymorphic over object kind, backing coord_topics /
 * coord_entity_subscriptions / coord_threads(+posts) / coord_links (migration
 * 123). Every domain object (conversation / issue / feature / plan / topic) and
 * the Phase-2 fan-out import from here.
 *
 * Table-backed (PG + in-memory double, one conformance suite): Subscribable,
 * Taggable, Threadable, Linkable, plus the TopicStore vocabulary. Claimable +
 * Lifecycle are interface-only — the domain object stores the scalar on its own
 * table. The conformance suites import vitest, so they live behind the dedicated
 * `@papercusp/coordination/capabilities/conformance` subpath, NOT this barrel.
 */

export type {
  ObjectRef,
  DeliveryMode,
  SubscriptionTargetKind,
  SubscriptionRow,
  SubscribeInput,
  SubscribableStore,
  LinkRow,
  LinkableStore,
  TaggableStore,
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
  TAG_REL,
  objectKey,
  objectToTargetRef,
  targetRefToObject,
  mergeResolved,
  resolveObjectSubscribers,
} from './types';

export { LinkBackedTaggable } from './taggable';

export {
  type PgCapabilityStoreOptions,
  ensureCoordCapabilityTables,
  PgTopicStore,
  PgEntitySubscriptionStore,
  PgLinkStore,
  PgTaggableStore,
  PgThreadStore,
} from './pg-stores';

export {
  InMemoryTopicStore,
  InMemoryEntitySubscriptionStore,
  InMemoryLinkStore,
  InMemoryTaggableStore,
  InMemoryThreadStore,
} from './memory-stores';
