/**
 * file-lock-summary — the MEASURED file-lock plane, for the primary lock read
 * surface (`locks:list`).
 *
 * WHY THIS EXISTS (EI-20192110087737961). `locks:list` answers about the
 * NAMED-RESOURCE plane only; a caller asking "does a peer hold this FILE" gets
 * `holders: []` no matter what, which reads as "safe to edit". The prior remedy
 * for that (EI-19400582907190258) was a PROSE pointer stamped on the result —
 * `plane: 'resource'` plus a `fileLockHint` naming `locks:queue`.
 *
 * That pointer went live 2026-08-03 and this item was filed 2026-08-11, by an
 * agent who read `locks:list`, concluded it "did not show repository file
 * locks", and had to go find `locks:queue` themselves. So the pointer was
 * already present, in the payload, and it did not prevent the friction — which
 * is the whole reason this module exists rather than a third wording of the
 * hint. Prose next to an empty array loses to the empty array: `holders: []` is
 * a datum and the sentence beside it is not, so the reader's eye settles on the
 * one that looks like a measurement. The fix is to put a REAL MEASUREMENT next
 * to it — `activeCount: 4` cannot be read as "nothing is locked", and needs no
 * discipline from the reader to land.
 *
 * ⚠ FAIL-EXPLICIT, NEVER FAIL-ZERO. A read that fails reports
 * `activeCount: null` + `unreadable`, never `0`. Reporting zero on failure would
 * manufacture the exact false "nothing holds this" that this whole file exists
 * to kill, and would be strictly worse than the empty-array it replaced: a
 * confident wrong number outranks a hint in a reader's attention just as
 * reliably as a right one. This is also why it does NOT reuse
 * `liveLockHoldings()` from live-lock-paths.ts — that seam is deliberately
 * fail-SOFT (`catch { return [] }`) for collision-avoidance callers whose
 * historical contract is best-effort. Correct there, inverted here.
 *
 * ⚠ NO `lock_id`. The rollup names WHO holds WHAT and WHY, and stops there.
 * `lock_id` is the release handle for `locks:release`, and the failure this item
 * names is "agents may misdiagnose a peer's lock or release the WRONG lock" —
 * so handing a release handle to a discovery surface would widen precisely the
 * hazard it was filed about. A caller who genuinely means to release goes
 * through `locks:queue`, where the paths are explicit and the intent is
 * deliberate.
 */

import { readQueue } from './su-lock-store';
import { acquireWithContentionRetry } from './contention-retry';

/** Bounds for the inline rollup. `locks:list` already averages ~89.5KB/call
 * (see list-shape.ts), so this block stays a summary; the uncapped read is
 * `locks:queue`. Cuts are reported, never silent. */
export const FILE_LOCK_SUMMARY_CAPS = { holders: 20, pathsPerHolder: 8 } as const;

export const FILE_LOCK_READ_VIA =
  'locks:queue { paths: [...] } for full rows (lock_id, waiters, expiry); omit paths for every active row.';

export interface FileLockHolderRollup {
  owner: string;
  /** The holder's declared edit intent — why they are on the path. */
  intent: string | null;
  /** Total paths this owner holds, INDEPENDENT of the `paths` cap below. */
  pathCount: number;
  paths: string[];
  /** Present only when `paths` was cut; the number omitted from it. */
  morePaths?: number;
}

export interface FileLockSummary {
  plane: 'file';
  /** MEASURED across every coordination domain — or `null` when unreadable. */
  activeCount: number | null;
  waitingCount: number | null;
  distinctHolders: number | null;
  holders: FileLockHolderRollup[];
  /** Present only when the holder rollup was cut. */
  truncated?: { showingHolders: number; ofHolders: number };
  /** Present only on a failed read; `activeCount` is then `null`, never `0`. */
  unreadable?: string;
  readVia: string;
}

/** The subset of a `readQueue` result this summary consumes. Structural so the
 * module does not re-export the store's row types. */
interface QueueShape {
  active_locks: Array<{ path: string; owner: string; intent?: string | null }>;
  waiting?: Array<unknown>;
}

type PoolLike = Parameters<typeof readQueue>[0];

export function rollUpFileLocks(queue: QueueShape): FileLockSummary {
  const active = queue.active_locks ?? [];
  const byOwner = new Map<string, { intent: string | null; paths: string[] }>();
  for (const row of active) {
    const path = (row.path ?? '').trim();
    if (!path) continue;
    const entry = byOwner.get(row.owner) ?? { intent: null, paths: [] };
    // First non-empty intent wins: one owner holding several paths under one
    // edit declares the same intent on each, and an empty later row must not
    // erase a populated earlier one.
    if (!entry.intent && row.intent?.trim()) entry.intent = row.intent.trim();
    entry.paths.push(path);
    byOwner.set(row.owner, entry);
  }

  const all = [...byOwner.entries()].sort((a, b) => b[1].paths.length - a[1].paths.length);
  const shown = all.slice(0, FILE_LOCK_SUMMARY_CAPS.holders);
  const holders: FileLockHolderRollup[] = shown.map(([owner, e]) => {
    const paths = e.paths.slice(0, FILE_LOCK_SUMMARY_CAPS.pathsPerHolder);
    return {
      owner,
      intent: e.intent,
      pathCount: e.paths.length,
      paths,
      ...(e.paths.length > paths.length ? { morePaths: e.paths.length - paths.length } : {}),
    };
  });

  return {
    plane: 'file',
    activeCount: active.length,
    waitingCount: (queue.waiting ?? []).length,
    distinctHolders: all.length,
    holders,
    ...(all.length > shown.length
      ? { truncated: { showingHolders: shown.length, ofHolders: all.length } }
      : {}),
    readVia: FILE_LOCK_READ_VIA,
  };
}

/** The unreadable result. Kept as one constructor so no caller can spell a
 * zero-count failure by hand. */
export function unreadableFileLockSummary(err: unknown): FileLockSummary {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    plane: 'file',
    activeCount: null,
    waitingCount: null,
    distinctHolders: null,
    holders: [],
    unreadable: `file-lock plane read failed (${msg.slice(0, 200)}) — this is NOT "zero locks held"; re-read with ${FILE_LOCK_READ_VIA}`,
    readVia: FILE_LOCK_READ_VIA,
  };
}

/**
 * Read + roll up every currently-held file lock, across EVERY coordination
 * domain.
 *
 * `coordinationDomain: null` is load-bearing, not a default: the domain
 * resolves from whichever checkout the operator process loaded, and this box
 * serves :3070 from `papercup-release` and :3170 from the staging tree — so a
 * caller-scoped read reports a genuinely-held lock as absent (WI-5979, the same
 * reasoning `locks:queue` and `live-lock-paths.ts` both record). Under-reporting
 * here reads as permission to write on a file a peer holds.
 */
export async function readFileLockSummary(pool: PoolLike): Promise<FileLockSummary> {
  try {
    // Same contention retry `locks:queue` uses: readQueue scopes a 1s
    // statement_timeout, which a cheap indexed SELECT can transiently trip
    // under fleet-load contention (EI-7454). Riding out that dip matters more
    // here than there — a transient 57014 would otherwise surface as
    // `unreadable` on a plane that is in fact perfectly readable.
    const queue = await acquireWithContentionRetry(() =>
      readQueue(pool, { coordinationDomain: null }),
    );
    return rollUpFileLocks(queue as unknown as QueueShape);
  } catch (err) {
    return unreadableFileLockSummary(err);
  }
}
