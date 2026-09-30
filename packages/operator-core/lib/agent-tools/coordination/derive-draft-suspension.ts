/**
 * derive-draft-suspension.ts — the I/O half of `draft-suspension.ts`.
 *
 * Split for the same reason `stale-basis.ts` (pure) and `derive-awaiting.ts` (async) are:
 * the decision is a pure function over timestamps and is tested without a database, while
 * everything that can fail lives here and fails soft.
 *
 * Reads the sender's OWN recent tool activity. Deliberately NOT restricted to
 * `READ_TOOL_NAMES` the way `deriveBasedOn` is: this asks "was this session doing anything
 * at all", so an agent that spent the interval editing has no gap, and a genuine
 * suspension shows up regardless of what it was doing before it.
 */

import { getOrgPg } from '@papercusp/db-org';
import {
  DRAFT_SUSPENSION_THRESHOLD_MS,
  suspensionGap,
  type DraftSuspensionStamp,
} from './draft-suspension';

/**
 * How far back to look. Wider than `BASED_ON_WINDOW_MS` (30m) on purpose — that window is
 * why the motivating 45-minute interleave was invisible to an age check built on the read
 * trace, so a window that could not contain the failure would reproduce the bug.
 */
export const DRAFT_SUSPENSION_WINDOW_MS = 4 * 60 * 60_000;

/** Bounds the query independently of the window, so a burst-calling agent costs the same. */
const DRAFT_SUSPENSION_SCAN_ROWS = 500;

/**
 * Largest gap in the sender's recent activity, or null when it was working continuously,
 * has no recorded activity, or anything at all goes wrong.
 */
export async function deriveDraftSuspension(opts: {
  ownerId: string;
  workspaceId: string;
  nowMs?: number;
  windowMs?: number;
  thresholdMs?: number;
}): Promise<DraftSuspensionStamp | null> {
  if (!opts.ownerId || !opts.workspaceId) return null;
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? DRAFT_SUSPENSION_WINDOW_MS;
  try {
    const { sql } = getOrgPg();
    const since = new Date(nowMs - windowMs);
    const rows = await sql<{ invoked_at: Date }[]>`
      SELECT invoked_at
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${opts.workspaceId}
         AND coord_owner_id = ${opts.ownerId}
         AND invoked_at >= ${since}
       ORDER BY invoked_at DESC
       LIMIT ${DRAFT_SUSPENSION_SCAN_ROWS}`;
    // A scan cap that truncated the history would invent a gap at the cut — the oldest
    // row kept would sit an arbitrary distance from the window edge. Only the interval
    // actually covered by rows is measured, so a busy sender under-reports rather than
    // fabricating a suspension it can no longer see the far side of.
    const invokedAtMs = rows.map((r) =>
      (r.invoked_at instanceof Date ? r.invoked_at : new Date(r.invoked_at)).getTime(),
    );
    if (!invokedAtMs.length) return null;
    return suspensionGap(invokedAtMs, {
      nowMs,
      thresholdMs: opts.thresholdMs ?? DRAFT_SUSPENSION_THRESHOLD_MS,
    });
  } catch {
    return null;
  }
}
