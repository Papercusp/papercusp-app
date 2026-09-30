/**
 * Dot-path resolution over an arbitrary value.
 *
 * `getPath(event, 'args.item.id')` walks `.`-separated segments. Numeric
 * segments index into arrays (`'items.0.name'`). Returns `undefined` the
 * moment a segment is missing or an intermediate is null/undefined — never
 * throws. This is the "fact" extractor the data-matcher resolves conditions
 * against, so it must be total (no exceptions) and cheap.
 */

/** Split a dot-path into segments once. `''` → `[]` (the root). */
export function splitPath(path: string): string[] {
  if (path === '') return [];
  return path.split('.');
}

/** Resolve a dot-path against a value. Total: missing → `undefined`. */
export function getPath(root: unknown, path: string): unknown {
  if (path === '') return root;
  let cur: unknown = root;
  for (const seg of splitPath(path)) {
    if (cur == null) return undefined;
    if (typeof cur !== 'object') return undefined;
    // Arrays: numeric segment indexes; named segment misses.
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** True iff a dot-path resolves to something that is neither undefined nor null. */
export function hasPath(root: unknown, path: string): boolean {
  return getPath(root, path) != null;
}
