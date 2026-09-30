import type {
  Projector,
  ProjectionStore,
  ChangeEvent,
  QueryOptions,
  IndexKey,
  IndexedEntry,
} from './types';
import { computeDelta } from './diff';

export interface ProjectionIndexOptions<S, E> {
  /** The pure domain mapping: a source record → the entries it contributes. */
  projector: Projector<S, E>;
  /** Where the index lives (in-memory default, or a host-injected backend). */
  store: ProjectionStore<E>;
}

/**
 * An event-maintained, structured→index projection.
 *
 * Feed it source records as they change (`index` / `remove` / `applyChange`); it
 * keeps an inverted index `key → entries` incrementally, computing the minimal
 * delta against each source's prior contributions so a record that drops or retags
 * an entry correctly removes the stale one. Query a key to get the aggregated
 * entries — no full scan, no re-summarisation, no drift.
 *
 * The domain mapping (record → contributions) and the persistence are injected;
 * the lib owns the incremental-maintenance algorithm and nothing else. It is the
 * generic core behind a topic-keyed "what+why" projection — e.g. query a
 * subsystem-topic, get its decisions + work-items + insights — but it is
 * consumer-agnostic: wire any change source to `applyChange` and project any
 * record into any entry shape.
 */
export class ProjectionIndex<S, E> {
  private readonly projector: Projector<S, E>;
  private readonly store: ProjectionStore<E>;

  constructor(opts: ProjectionIndexOptions<S, E>) {
    this.projector = opts.projector;
    this.store = opts.store;
  }

  /**
   * Upsert a source record: (re)project it and apply the delta vs its prior state.
   * Removing an entry from the record, retagging it to another key, or editing its
   * payload all follow from re-projecting and diffing — the caller never computes
   * what changed.
   */
  async index(sourceId: string, record: S): Promise<void> {
    const next = this.projector(record);
    const prev = await this.store.contributionsOf(sourceId);
    const delta = computeDelta(sourceId, prev, next);
    if (delta.put.length === 0 && delta.delete.length === 0) return;
    await this.store.applyDelta(sourceId, delta);
  }

  /** Remove a source entirely (its record was deleted) — drops all its entries. */
  async remove(sourceId: string): Promise<void> {
    const prev = await this.store.contributionsOf(sourceId);
    if (prev.length === 0) return;
    await this.store.applyDelta(sourceId, {
      put: [],
      delete: prev.map((p) => ({ sourceId, key: p.key, entryId: p.entryId })),
    });
  }

  /**
   * React to a change event — the event-maintenance entry point. Wire your event
   * engine (e.g. a `plans:add-decision` / work-item / insight change) to call this
   * with `{ op: 'upsert', sourceId, record }` or `{ op: 'delete', sourceId }`.
   */
  async applyChange(event: ChangeEvent<S>): Promise<void> {
    if (event.op === 'delete') return this.remove(event.sourceId);
    return this.index(event.sourceId, event.record);
  }

  /** (Re)index a batch of `[sourceId, record]` pairs — e.g. an initial backfill. */
  async reindexAll(records: Iterable<readonly [string, S]>): Promise<void> {
    for (const [sourceId, record] of records) await this.index(sourceId, record);
  }

  /** Query the index: the entries aggregated under a key, filtered + sorted. */
  query(key: IndexKey, opts?: QueryOptions): Promise<IndexedEntry<E>[]> {
    return this.store.byKey(key, opts);
  }
}
