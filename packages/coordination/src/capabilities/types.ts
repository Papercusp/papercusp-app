/**
 * @papercusp/coordination/capabilities/types — re-export shim. The capability
 * contracts were split into two borrowable libs:
 *   - the typed-entity graph (ObjectRef / Linkable / Taggable + TAG_REL) →
 *     @papercusp/linkable-edges
 *   - the pub/sub capabilities (Subscribable / Threadable / Topics / Claimable /
 *     Lifecycle + the objectToTargetRef codec + the resolveObjectSubscribers
 *     fan-out) → @papercusp/pubsub-substrate
 * The papercusp-bound Pg* backends stay in pg-stores.ts; this re-export keeps the
 * @papercusp/coordination/capabilities public surface unchanged.
 */

export type { ObjectRef, LinkRow, LinkableStore, TaggableStore } from '@papercusp/linkable-edges';
export { TAG_REL, objectKey } from '@papercusp/linkable-edges';

export type {
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
} from '@papercusp/pubsub-substrate/capabilities';
export {
  DELIVERY_MODES,
  LIFECYCLE_STATES,
  objectToTargetRef,
  targetRefToObject,
  mergeResolved,
  resolveObjectSubscribers,
} from '@papercusp/pubsub-substrate/capabilities';
