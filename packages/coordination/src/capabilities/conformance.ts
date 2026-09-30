/**
 * @papercusp/coordination/capabilities/conformance — re-export shim. The
 * capability contract suites live in the two borrowable libs: the LinkableStore
 * suite in @papercusp/linkable-edges; the Topic/Subscribable/Threadable +
 * resolveObjectSubscribers suites in @papercusp/pubsub-substrate. The operator's
 * live-PG integration test imports them from here to run the Pg* stores against
 * the SAME assertions as the in-memory doubles.
 */

export { describeLinkableStoreConformance } from '@papercusp/linkable-edges/conformance';
export {
  describeTopicStoreConformance,
  describeSubscribableStoreConformance,
  describeThreadableStoreConformance,
  describeResolveObjectSubscribers,
} from '@papercusp/pubsub-substrate/capabilities/conformance';
