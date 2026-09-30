/**
 * list-meta — the "carry page metadata on a flat sync read" convention, in one
 * place. Pure (no React, no PG) so the SERVER resolver and the CLIENT panel both
 * import it.
 *
 * Why it exists: every `useSyncQuery` resolver returns a BARE array (the flat-row
 * sync contract — no `{rows,total}` envelope). So a capped read (`LIMIT n`) has no
 * channel to tell the UI the TRUE total, and panels end up showing the downloaded
 * length as if it were the total (e.g. "(300)" when 404 exist). The fix is to
 * stash the metadata on the FIRST row's `_meta` — the array stays a flat array,
 * but row[0] carries `{ total }`. `coord.feed` pioneered this; these helpers make
 * it reusable and symmetric (attach on the server, read on the client).
 *
 * Usage (server, in a resolver):
 *   const [rows, total] = await Promise.all([listX({limit}), countX()]);
 *   return attachListMeta(rows, { total });
 *
 * Usage (client, in a panel):
 *   const total = readListTotal(items);                 // the true count
 *   api.setTitle(`X (${listCountLabel(items.length, total)})`);  // "N" or "N of TOTAL"
 */

/** Page metadata stashed on the first row. `total` = the true store count for the
 *  read's filter, independent of any LIMIT. Open-ended for future fields. */
export interface ListMeta {
  total?: number;
  /** Opaque keyset cursor for the next page; null means exhausted. */
  nextCursor?: string | null;
  /** Authoritative exhaustion bit. False whenever no fresh cursor exists. */
  hasMore?: boolean;
  [k: string]: unknown;
}

export interface ListPageMetaInput extends Omit<ListMeta, 'nextCursor' | 'hasMore'> {
  nextCursor: string | null;
  hasMore: boolean;
  /** Cursor used to request this page. Repeating it is no growth, so exhaust. */
  previousCursor?: string | null;
}

/** A row that MAY carry list metadata (only row[0] does, by convention). */
export type WithListMeta<T> = T & { _meta?: ListMeta };

/**
 * Stash `meta` on the first row's `_meta` (merging with any existing `_meta`),
 * preserving the flat-array contract. No-op (returns the same array) when empty —
 * an empty read has nothing to carry metadata on, and the client falls back to a
 * length of 0. Does not mutate the input rows (clones row[0]).
 */
export function attachListMeta<T extends object>(rows: T[], meta: ListMeta): T[] {
  if (rows.length === 0) return rows;
  return rows.map((r, i) =>
    i === 0 ? { ...r, _meta: { ...(r as WithListMeta<T>)._meta, ...meta } } : r,
  );
}

/**
 * Attach normalized cursor metadata to a bounded flat-row page.
 *
 * A server may optimistically report `hasMore` after a full page, but an empty
 * page, a missing cursor, or a cursor equal to the request cursor cannot make
 * forward progress. All three normalize to `{ hasMore:false,nextCursor:null }`
 * so a consumer cannot spin forever on a no-growth page. An empty array has no
 * metadata carrier; that is still unambiguous exhaustion.
 */
export function attachListPageMeta<T extends object>(
  rows: T[],
  input: ListPageMetaInput,
): T[] {
  const cursorAdvances =
    rows.length > 0 &&
    input.nextCursor !== null &&
    input.nextCursor.length > 0 &&
    input.nextCursor !== (input.previousCursor ?? null);
  const hasMore = input.hasMore && cursorAdvances;
  const { previousCursor: _previousCursor, ...meta } = input;
  return attachListMeta(rows, {
    ...meta,
    nextCursor: hasMore ? input.nextCursor : null,
    hasMore,
  });
}

/**
 * Read metadata from the row that currently carries it.
 *
 * `attachListMeta` always writes row[0], but a set-based delta merge preserves
 * rows by identity rather than by server position. When the sorted first row
 * changes, the row carrying `_meta` can therefore move elsewhere in the
 * reconstructed array. Searching the bounded page keeps the flat-row contract
 * intact and prevents callers from mistaking the page length for the total.
 */
export function readListMeta<T extends object>(
  rows: ReadonlyArray<WithListMeta<T>> | null | undefined,
): ListMeta | undefined {
  if (!rows) return undefined;
  for (const row of rows) {
    if (row._meta !== undefined) return row._meta;
  }
  return undefined;
}

/**
 * Whether the bounded page can advance. Reads the explicit bit first, then the
 * legacy `nextCursor` convention. Empty pages are always exhausted even if a
 * malformed row somehow carries contradictory metadata.
 */
export function readListHasMore<T extends object>(
  rows: ReadonlyArray<WithListMeta<T>> | null | undefined,
): boolean {
  if (!rows || rows.length === 0) return false;
  const meta = readListMeta(rows);
  const cursorAdvances = typeof meta?.nextCursor === 'string' && meta.nextCursor.length > 0;
  return typeof meta?.hasMore === 'boolean' ? meta.hasMore && cursorAdvances : cursorAdvances;
}

/**
 * The true total for the read. Prefers `_meta.total`; falls back to the
 * downloaded length (so a resolver that doesn't attach a total still yields a
 * sensible number, just not a capped-aware one).
 */
export function readListTotal<T extends object>(
  rows: ReadonlyArray<WithListMeta<T>> | null | undefined,
): number {
  if (!rows) return 0;
  return readListMeta(rows)?.total ?? rows.length;
}

/**
 * Honest count label: "N of TOTAL" when the read was capped (total exceeds the
 * shown rows), else just the total. Never lets the downloaded length read as the
 * total. `shown` is the rendered/filtered row count; `total` the true store count
 * (from `readListTotal`).
 */
export function listCountLabel(shown: number, total: number | undefined): string {
  return total != null && total > shown ? `${shown} of ${total}` : `${total ?? shown}`;
}
