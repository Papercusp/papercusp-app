/**
 * @papercusp/projection-index — a generic, event-maintained structured→index
 * projection.
 *
 * Feed it source records as they change; it maintains an inverted index
 * `key → entries` incrementally, computing the minimal delta against each
 * source's prior contributions so a dropped / retagged / edited entry is handled
 * without the caller diffing anything. Query a key to get the aggregated entries:
 * no full scan, no re-summarisation, no drift.
 *
 * SEAM: the domain mapping (`Projector`: record → contributions) and the
 * persistence (`ProjectionStore`) are injected. The lib owns only the
 * incremental-maintenance algorithm — zero I/O, zero domain coupling, zero runtime
 * deps. An in-memory store ships as the default + the reference a PG-backed store
 * is conformance-tested against.
 *
 * Canonical consumer: a topic-keyed "what+why" projection over plans / work-items
 * / insights (docs-and-memory-as-projections-2026-06-05) — but it is
 * consumer-agnostic. See generalize-libs-to-generic-2026-06-05 D-003 #11.
 */

export { ProjectionIndex } from './projection-index';
export type { ProjectionIndexOptions } from './projection-index';
export { InMemoryProjectionStore } from './in-memory-store';
export { computeDelta, refOf } from './diff';
export type {
  IndexKey,
  Contribution,
  IndexedEntry,
  EntryRef,
  Projector,
  ChangeEvent,
  Delta,
  SortOrder,
  QueryOptions,
  ProjectionStore,
} from './types';
