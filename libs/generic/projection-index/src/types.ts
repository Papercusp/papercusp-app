/**
 * @papercusp/projection-index — core types.
 *
 * The lib maintains an inverted index `key → entries` over a stream of changing
 * source records. The two things it does NOT own — and therefore takes as a seam
 * — are (1) the domain mapping from a record to the entries it contributes (the
 * `Projector`) and (2) where the index lives (the `ProjectionStore`). Everything
 * here is opaque to the lib except the identity triple `(sourceId, key, entryId)`.
 */

/** A bucket the index aggregates entries under (e.g. a subsystem-topic). */
export type IndexKey = string;

/**
 * One unit a source record contributes: an `entry` placed under a `key`.
 *
 * The `(sourceId, key, entryId)` triple is a contribution's identity. Re-indexing
 * the same source *replaces* same-identity contributions (so entry/sortKey/kind
 * edits propagate) and *drops* the ones the source no longer produces (so a
 * removed or retagged entry disappears). `entryId` need only be unique within a
 * source — uniqueness across `(source, key)` is what the diff relies on.
 */
export interface Contribution<E> {
  /** The bucket this entry belongs under. */
  key: IndexKey;
  /** Stable id of this entry within its source. */
  entryId: string;
  /** The projected payload — opaque to the lib (the compact domain rendering). */
  entry: E;
  /**
   * Optional ordering signal within a key. Supply a homogeneous (all-string or
   * all-number) value per key for deterministic ordering — e.g. a timestamp or a
   * monotonic counter. Contributions without a `sortKey` sort last.
   */
  sortKey?: string | number;
  /** Optional discriminator for query-time filtering (e.g. 'decision' | 'work_item' | 'insight'). */
  kind?: string;
}

/** A contribution as persisted / returned — carries the source it came from. */
export interface IndexedEntry<E> extends Contribution<E> {
  sourceId: string;
}

/** Identity of a single persisted contribution. */
export interface EntryRef {
  sourceId: string;
  key: IndexKey;
  entryId: string;
}

/**
 * Pure domain mapping: a fully-loaded source record → the entries it contributes.
 *
 * No I/O, no async — the consumer loads the record, the projector shreds it into
 * indexable contributions. Returning `[]` means "this record contributes nothing"
 * (and any prior contributions from it are removed). It MUST be deterministic for
 * a given record: the same record in always yields the same contributions out.
 */
export type Projector<S, E> = (record: S) => Contribution<E>[];

/** A change to a source record the index reacts to — the event-maintenance unit. */
export type ChangeEvent<S> =
  | { op: 'upsert'; sourceId: string; record: S }
  | { op: 'delete'; sourceId: string };

/** The delta the index computes for one source and the store applies atomically. */
export interface Delta<E> {
  /** Contributions to upsert (identity = `sourceId` + `key` + `entryId`). */
  put: IndexedEntry<E>[];
  /** Contribution refs to remove. */
  delete: EntryRef[];
}

/** Direction to sort a key's entries over their `sortKey`. */
export type SortOrder = 'asc' | 'desc';

export interface QueryOptions {
  /** Restrict to these kinds (entries with no `kind` are excluded when set). */
  kinds?: string[];
  /** Max entries returned (after sort). */
  limit?: number;
  /** Sort direction over `sortKey` (default 'asc'). Entries without a `sortKey` sort last. */
  order?: SortOrder;
}

/**
 * The persistence seam. The host injects this; the lib ships an in-memory default
 * (`InMemoryProjectionStore`). It maps cleanly onto a single table keyed by
 * `(source_id, key, entry_id)`:
 *   - `contributionsOf` → `SELECT … WHERE source_id = $1`
 *   - `applyDelta`      → `DELETE … ` + `INSERT … ON CONFLICT DO UPDATE`, in one tx
 *   - `byKey`           → `SELECT … WHERE key = $1 ORDER BY sort_key`
 *
 * `applyDelta` MUST be atomic for the given source — partial application can leave
 * the index inconsistent with the source.
 */
export interface ProjectionStore<E> {
  /** All contributions currently persisted for a source (used to diff on re-index). */
  contributionsOf(sourceId: string): Promise<IndexedEntry<E>[]>;
  /** Atomically apply a per-source delta (puts upsert by identity; deletes by ref). */
  applyDelta(sourceId: string, delta: Delta<E>): Promise<void>;
  /** Entries aggregated under a key, filtered + sorted + limited per `opts`. */
  byKey(key: IndexKey, opts?: QueryOptions): Promise<IndexedEntry<E>[]>;
}
