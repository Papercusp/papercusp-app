/**
 * linkable-edges/types.ts — the contract for a generic typed-entity graph.
 *
 * A graph of polymorphic objects connected by typed, directed edges:
 *
 *   src {kind,ref}  —(rel)→  dst {kind,ref}
 *
 * Two capabilities are named here:
 *   Linkable — create/remove edges and query them by direction (out / in),
 *              optionally filtered by relation. Idempotent on (src, dst, rel).
 *   Taggable — sugar over Linkable: a tag on an object IS an edge
 *              `object →tagged→ {kind:'topic', ref:<slug>}`. Modelling tags as
 *              edges keeps the graph DRY (one edge store) and makes "what is
 *              tagged with X" a plain reverse-edge lookup.
 *
 * Host-agnostic by construction: the host owns identity (passes `created_by`)
 * and the clock (passes an ISO `created_ts`); the store backend is injected.
 * The lib names no consuming app and carries no domain coupling.
 */

/** A polymorphic reference to a graph object — a node. `kind` is the object
 *  type (e.g. 'issue' | 'feature' | 'plan' | 'topic'); `ref` is its id within
 *  that type (an issue id, plan slug, feature id, topic slug, …). */
export interface ObjectRef {
  kind: string;
  ref: string;
}

/** Canonical string key for an ObjectRef — a stable key for grouping edges by
 *  their `src`/`dst` or keying a batch result Map. Uses a NUL separator so it
 *  can't collide for any `{kind, ref}` pair (kinds + refs never contain NUL). */
export function objectKey(o: ObjectRef): string {
  return `${o.kind}\x00${o.ref}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Linkable — typed directed edges
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkRow {
  id: number;
  src: ObjectRef;
  dst: ObjectRef;
  rel: string;
  created_by: string | null;
  created_ts: string;
}

/** The rel used by Taggable for an object→topic edge. */
export const TAG_REL = 'tagged';

export interface LinkableStore {
  /** Create an edge src →(rel)→ dst. Idempotent on (src, dst, rel). */
  link(src: ObjectRef, dst: ObjectRef, rel: string, opts: { created_by?: string; created_ts: string }): Promise<void>;
  /** Remove an edge (idempotent). */
  unlink(src: ObjectRef, dst: ObjectRef, rel: string): Promise<void>;
  /** Out-edges of `src`, optionally filtered by rel. Ordered (created_ts, id) ascending. */
  listOut(src: ObjectRef, opts?: { rel?: string }): Promise<LinkRow[]>;
  /** In-edges to `dst`, optionally filtered by rel. Ordered (created_ts, id) ascending. */
  listIn(dst: ObjectRef, opts?: { rel?: string }): Promise<LinkRow[]>;
  /** Out-edges of MANY srcs in ONE round-trip — the batch form of listOut. Returns
   *  every matching edge across `srcs`; the caller groups by `src` (use `objectKey`).
   *  This is what turns an N+1 "list edges for each of N objects" into a single query.
   *  Empty `srcs` → `[]`. Ordered (created_ts, id) ascending. */
  listOutMany(srcs: ObjectRef[], opts?: { rel?: string }): Promise<LinkRow[]>;
  /** In-edges to MANY dsts in ONE round-trip — the batch form of listIn (the
   *  reverse-direction twin of listOutMany; the caller groups by `dst`).
   *  Empty `dsts` → `[]`. Ordered (created_ts, id) ascending. */
  listInMany(dsts: ObjectRef[], opts?: { rel?: string }): Promise<LinkRow[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Taggable — rides Linkable (object →tagged→ {kind:'topic'}). Thin sugar so a
// caller never hand-writes the edge shape.
// ─────────────────────────────────────────────────────────────────────────────

export interface TaggableStore {
  addTag(object: ObjectRef, topicSlug: string, opts: { created_by?: string; created_ts: string }): Promise<void>;
  removeTag(object: ObjectRef, topicSlug: string): Promise<void>;
  /** Topic slugs tagged on `object`. */
  listTags(object: ObjectRef): Promise<string[]>;
  /** Topic slugs for MANY objects in ONE round-trip — the batch form of listTags,
   *  keyed by `objectKey`. Objects with no tags are absent from the map (read as
   *  `[]`). Use when tagging a whole page of objects (e.g. a conversation list) to
   *  avoid an N+1 across listTags. Empty `objects` → empty map. */
  listTagsForMany(objects: ObjectRef[]): Promise<Map<string, string[]>>;
  /** Objects tagged with `topicSlug`. */
  listTagged(topicSlug: string): Promise<ObjectRef[]>;
}
