/**
 * A work-item read whose FAILURE cannot be mistaken for ABSENCE (WI-6746).
 *
 * `getWorkItem()` returns `null` for exactly one reason: the query ran and matched
 * zero rows. It never catches — a PG fault (connection loss, statement_timeout, a
 * workspace-resolution failure) throws straight through it. So the idiom
 *
 *     const item = await getWorkItem(id, harness).catch(() => null);
 *
 * collapses two different facts — "it is not there" and "I could not ask" — into
 * the same `null`, and every downstream `if (!item)` then speaks with a confidence
 * the read never earned. That is benign where an absent item only costs the reader
 * a decoration, and a REAL BUG in two places it was actually used:
 *
 *   - `work_items:claim` derived its claim-hold refusal from the swallowed read, so
 *     a blip made `claimHoldRefusal` null and the hold guard was skipped entirely
 *     (`claimWorkItem` has no hold check of its own — the pre-read IS the guard).
 *   - `work_items:checkpoint` derived its `not_holder` refusal the same way, so a
 *     blip let anyone overwrite the real holder's in-flight state
 *     (`setWorkItemCheckpoint` has no assignee check — again the pre-read IS the
 *     guard). Exactly the corruption EI-18132462898750489 added that guard to stop.
 *
 * Both failed OPEN. A guard that disappears precisely when the database is
 * unhealthy is worse than no guard, because its presence in the source reads as
 * protection.
 *
 * The fix is type-level rather than a patch at each call site: this union has no
 * "absent" value a read failure can fall into, so the compiler makes every caller
 * answer "what if I could not ask?" — including the next caller anyone adds.
 * Truthiness is deliberately useless here; `status` must be matched explicitly.
 */
import { getWorkItem, type WorkItem } from '../../work-items';

export type WorkItemLookup =
  /** The query ran and matched a row. */
  | { status: 'found'; item: WorkItem }
  /** The query ran and matched ZERO rows — genuinely not there. */
  | { status: 'missing' }
  /** The query did not produce an answer. Says NOTHING about whether the item exists. */
  | { status: 'unreadable'; error: string };

/** Compact, log-safe rendering of whatever the read threw. */
function describeReadFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine || 'unknown error';
}

/**
 * `getWorkItem`, with the read failure kept DISTINCT from a zero-row result.
 *
 * Never throws — callers still get a value to branch on — but the value it returns
 * on failure cannot be confused with "not found".
 */
export async function lookupWorkItem(id: string, harness?: string): Promise<WorkItemLookup> {
  try {
    const item = await getWorkItem(id, harness);
    return item ? { status: 'found', item } : { status: 'missing' };
  } catch (err) {
    return { status: 'unreadable', error: describeReadFailure(err) };
  }
}
