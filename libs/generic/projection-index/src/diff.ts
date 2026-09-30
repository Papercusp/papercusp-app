import type { Contribution, IndexedEntry, Delta, EntryRef } from './types';

/**
 * Separator for the compound identity ref `sourceId|key|entryId`. It is the ASCII
 * NUL control char (`\x00`) — DELIBERATELY a control char, not a space, so the ref
 * is unambiguous: a plain separator (e.g. a space) would collapse distinct
 * contributions whose fields share that char — `('topic a','d1')` and
 * `('topic','a d1')` would both render `'…topic a d1'`, yielding a false "duplicate
 * contribution" throw in `computeDelta` and a same-ref overwrite in the store. NUL
 * does not occur in topic tags, plan slugs, or domain ids, so the triple is safe.
 * (A field that literally embeds `\x00` would still be ambiguous — but that is not a
 * valid id/key; the lib treats NUL-free fields as the contract.)
 */
const SEP = '\x00';

/** Identity string for a contribution within the index. */
export function refOf(sourceId: string, key: string, entryId: string): string {
  return sourceId + SEP + key + SEP + entryId;
}

/**
 * Pure incremental delta between a source's previously-indexed entries (`prev`)
 * and its freshly projected contributions (`next`).
 *
 * - `put`    — every current contribution, stamped with `sourceId`. Upsert is
 *              idempotent and also captures `entry` / `sortKey` / `kind` edits, so
 *              re-indexing an unchanged record is a no-op write and re-indexing a
 *              changed one propagates the change.
 * - `delete` — prior refs the source no longer produces (an entry removed from the
 *              record, or moved to a different `key`).
 *
 * Throws if `next` contains two contributions with the same `(key, entryId)` — that
 * is an ambiguous projection (two entries claiming one identity) and would make the
 * index non-deterministic.
 */
export function computeDelta<E>(
  sourceId: string,
  prev: IndexedEntry<E>[],
  next: Contribution<E>[],
): Delta<E> {
  const nextRefs = new Set<string>();
  const put: IndexedEntry<E>[] = [];
  for (const c of next) {
    const ref = refOf(sourceId, c.key, c.entryId);
    if (nextRefs.has(ref)) {
      throw new Error(
        `projection-index: duplicate contribution key=${JSON.stringify(c.key)} entryId=${JSON.stringify(c.entryId)} from source ${JSON.stringify(sourceId)}`,
      );
    }
    nextRefs.add(ref);
    put.push({ ...c, sourceId });
  }

  const del: EntryRef[] = [];
  for (const p of prev) {
    if (!nextRefs.has(refOf(sourceId, p.key, p.entryId))) {
      del.push({ sourceId, key: p.key, entryId: p.entryId });
    }
  }

  return { put, delete: del };
}
