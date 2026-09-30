/**
 * @papercusp/coordination/capabilities/memory-stores — re-export shim. The
 * in-memory doubles now live in the two borrowable libs: the Linkable/Taggable
 * doubles in @papercusp/linkable-edges; the Topic/Subscribable/Threadable
 * doubles in @papercusp/pubsub-substrate. Re-exported so the capabilities barrel
 * surface is unchanged.
 */

export { InMemoryLinkStore, InMemoryTaggableStore } from '@papercusp/linkable-edges';
export {
  InMemoryTopicStore,
  InMemoryEntitySubscriptionStore,
  InMemoryThreadStore,
} from '@papercusp/pubsub-substrate/capabilities';
