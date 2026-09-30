/**
 * promote.ts — pure validator for `plans:promote`. PURE.
 *
 * (Extracted verbatim from coordination/promote.ts:findUnknownFromItems.)
 */

/**
 * Collect every `from_items` id across `features` that is NOT in
 * `knownItemIds`. Sorted, de-duplicated. A non-empty result means the
 * caller named a plan item that does not exist.
 */
export function findUnknownFromItems(
  features: Array<{ from_items?: string[] }>,
  knownItemIds: Iterable<string>,
): string[] {
  const known = new Set(knownItemIds);
  const unknown = new Set<string>();
  for (const f of features) {
    for (const id of f.from_items ?? []) {
      if (!known.has(id)) unknown.add(id);
    }
  }
  return [...unknown].sort();
}
