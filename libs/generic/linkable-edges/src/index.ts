/**
 * @papercusp/linkable-edges — a generic typed-entity graph.
 *
 * Polymorphic, directed, typed edges between `{kind, ref}` object references:
 * `src —(rel)→ dst`, with idempotent link/unlink and directional listOut/listIn
 * queries over an injected store. Ships:
 *   - the `LinkableStore` port + `LinkRow`/`ObjectRef` types,
 *   - `InMemoryLinkStore` (a zero-I/O backend / test double),
 *   - `LinkBackedTaggable` — Taggable rides Linkable (a tag IS an
 *     `object →tagged→ {kind:'topic'}` edge),
 *   - and one conformance suite (behind the `./conformance` subpath, since it
 *     imports vitest) any backend can run to prove swappability.
 *
 * Zero domain coupling and zero runtime deps: the host injects the store
 * backend (PG, etc.), owns identity (`created_by`) and the clock (`created_ts`).
 */

export type { ObjectRef, LinkRow, LinkableStore, TaggableStore } from './types';
export { TAG_REL, objectKey } from './types';
export { LinkBackedTaggable } from './taggable';
export { InMemoryLinkStore, InMemoryTaggableStore } from './memory-store';
