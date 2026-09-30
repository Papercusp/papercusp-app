/**
 * p2p/sandbox/quota-volume.ts — P-105 §1 remainder: disk-QUOTA enforcement
 * on a foreign workspace's clone volume (DESIGN-p2p-P105-…md §1).
 *
 * The GIT leg's clone/private-ODB mechanics are ALREADY BUILT (P-109 leg
 * iv, `p2p/foreign-clone.ts` — `git clone --no-local` + `privateOdbViolation`
 * verification). What §1 still asks for is the QUOTA on that volume: a
 * disk-space cap per foreign workspace, independent of the clone mechanics.
 *
 * This module is a STANDALONE, composable check — deliberately NOT wired
 * into `foreign-clone.ts`'s `provisionForeignClone` call path. Per the
 * p2p-parity-parallel-lanes-2026-07-09 P-004 scope note, wiring any of
 * P-105's mechanisms into a live spawn/provision path rides WI-1937
 * (owner-sign-off-gated); this item stops at "build to the ratified spec +
 * tests + drill". A future build lane calls `enforceForeignWorkspaceQuota`
 * from `provisionForeignClone` (post-clone) and from a periodic sweep
 * (mirroring `foreign-supervision.ts`'s cadence) once that wiring is
 * authorized.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DirStatSeam {
  readdir: (path: string) => Promise<{ name: string; isDirectory: () => boolean; isFile: () => boolean }[]>;
  stat: (path: string) => Promise<{ size: number }>;
}

const defaultSeam: DirStatSeam = {
  readdir: (path) => readdir(path, { withFileTypes: true }),
  stat: (path) => stat(path),
};

/**
 * Recursively sum file sizes under `rootPath`. A read error on any one
 * entry (permission, a race with concurrent writes) is skipped rather than
 * aborting the whole walk — an undercount here is the safe direction for a
 * QUOTA check (it can only make the cap look further away, never
 * artificially trip it); the walk is best-effort, not authoritative
 * accounting.
 */
export async function computeDirectorySizeBytes(rootPath: string, seam: DirStatSeam = defaultSeam): Promise<number> {
  let total = 0;
  let entries: Awaited<ReturnType<DirStatSeam['readdir']>>;
  try {
    entries = await seam.readdir(rootPath);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(rootPath, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await computeDirectorySizeBytes(full, seam);
      } else if (entry.isFile()) {
        const s = await seam.stat(full);
        total += s.size;
      }
    } catch {
      continue;
    }
  }
  return total;
}

export type QuotaDecision = { exceeded: false } | { exceeded: true; usedBytes: number; capBytes: number };

/** Pure comparison — kept separate from the disk walk so a caller with an
 *  already-known usage figure (e.g. from a filesystem-native quota API)
 *  doesn't have to re-walk the tree. */
export function decideQuotaExceeded(usedBytes: number, capBytes: number): QuotaDecision {
  if (usedBytes > capBytes) return { exceeded: true, usedBytes, capBytes };
  return { exceeded: false };
}

export interface EnforceQuotaResult {
  usedBytes: number;
  capBytes: number;
  decision: QuotaDecision;
}

/**
 * Compose the walk + the decision for one foreign workspace root. Returns
 * data, never throws on a filesystem read glitch (the walk itself already
 * fails soft) — the caller (a future supervision sweep) decides what to do
 * with an `exceeded: true` result (e.g. transition to 'winding-down',
 * mirroring `foreign-supervision.ts`'s H12/H13 pattern).
 */
export async function enforceForeignWorkspaceQuota(
  rootPath: string,
  capBytes: number,
  seam: DirStatSeam = defaultSeam,
): Promise<EnforceQuotaResult> {
  const usedBytes = await computeDirectorySizeBytes(rootPath, seam);
  return { usedBytes, capBytes, decision: decideQuotaExceeded(usedBytes, capBytes) };
}
