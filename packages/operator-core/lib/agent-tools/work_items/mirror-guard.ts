/**
 * mirror-guard — detect the "mirror duplicate" anti-pattern at work_items:create
 * (EI-316). A bee/Queen handed an existing work-item id sometimes CREATES a new
 * item whose title embeds that id ("WI-118: Single-module REST API server")
 * instead of working the given one, then completes the mirror and strands the
 * original in `validating` forever — observers keyed on the real id (events:await
 * work-item:done:WI-118) wake on nothing, and history double-counts.
 *
 * The embedded-id prefix is a MACHINE-DETECTABLE signal: a title that references
 * an id which still resolves to an OPEN (non-terminal) work-item is almost
 * certainly an accidental mirror. This module is the pure detector; the create
 * tool wires the real `getWorkItem` lookup and refuses (override: force:true).
 *
 * Pure + lookup-injected so it unit-tests with no PG.
 */

/** Terminal work-item states across both families (feature + issue dialects, the
 *  normalizeWorkItemState targets): a title referencing one of these is fine —
 *  the work is done, not a live duplicate. Everything else is "open/in-flight". */
export const TERMINAL_WORK_ITEM_STATES: ReadonlySet<string> = new Set([
  'passed',
  'done',
  'deprecated',
  'resolved',
  'closed',
  'dropped',
]);

/**
 * Extract the work-item ids embedded in a title. Matches the numeric-id families
 * the unified surface mints + `getWorkItem` resolves cleanly: `WI-<n>` (any kind)
 * and `EI-<n>` (issue family). Case-insensitive; deduped; normalized upper-case.
 * Legacy `F-…` feature ids are intentionally NOT matched (their alphanumeric
 * shape — F-AUTO-… — is noisy and they are not the mirror vector EI-316 hit).
 */
export function extractWorkItemIds(title: string): string[] {
  const ids = new Set<string>();
  for (const m of title.matchAll(/\b(WI|EI)-\d+\b/gi)) {
    ids.add(m[0].toUpperCase());
  }
  return [...ids];
}

export interface MirrorLookupResult {
  id: string;
  state: string;
}

/**
 * Return the first embedded id in `title` that resolves to an OPEN (non-terminal)
 * work-item — the probable mirror target — or null if the title embeds no live
 * id. `lookup` returns the resolved item (id + state) or null when the id does
 * not exist (so a title that merely mentions a non-existent / already-finished
 * id never trips the guard).
 */
export async function findMirroredOpenItem(
  title: string,
  lookup: (id: string) => Promise<MirrorLookupResult | null>,
): Promise<MirrorLookupResult | null> {
  for (const id of extractWorkItemIds(title)) {
    let hit: MirrorLookupResult | null = null;
    try {
      hit = await lookup(id);
    } catch {
      hit = null; // a lookup error must never block a create — fail open
    }
    if (hit && !TERMINAL_WORK_ITEM_STATES.has(hit.state.toLowerCase())) {
      return { id: hit.id, state: hit.state };
    }
  }
  return null;
}
