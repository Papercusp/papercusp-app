/**
 * line-event-by-id.ts — targeted single-envelope lookup on a coord LINE surface.
 *
 * The coord log has two surface families. An EVENT surface (`handoffs`,
 * `escalations`) is a single-record-per-id upsert store and already has a
 * by-id read: `coordLog.getEvent`. A LINE surface (`messages`, `plan-events`)
 * is append-only and has none — so a caller wanting ONE envelope has
 * historically had to read a bounded window and scan it, which answers wrong
 * (a null) the moment the target is older than the window.
 *
 * `getMessageById` solved that for `messages` alone (WI-3832) with a targeted
 * PG query plus a readLines fallback for the in-memory/fs test backends. This
 * module is that same read, surface-parameterised, so `plan-events` gets a
 * correct by-id lookup without a second hand-rolled copy of the query
 * (WI-7297 needs one to serve a single history row's payload on demand).
 *
 * Deliberately NOT widened into `CoordEventLog.getEvent`: that seam's
 * `EventSurface` type also gates `putEvent`/`putEvents`, whose ON CONFLICT
 * target is a partial index scoped to `handoffs`/`escalations`. Admitting a
 * line surface there would let a stray `putEvent('messages', …)` silently
 * INSERT a duplicate row instead of upserting — the exact hazard WI-3832
 * called out. Reading by id is safe; writing by id is not.
 */

import type { CoordEnvelope } from '@papercusp/coordination/core';
import { coordLog, coordWorkspaceId, coordSql, coordHasPgFastPath } from './log';

/** The append-only surfaces this by-id read covers. */
export type CoordLineSurface = 'messages' | 'plan-events';

/**
 * Look up a single envelope by `msg_id` on an append-only coord surface.
 * Returns null when no such envelope exists.
 *
 * PG fast path rides the `(workspace_id, msg_id)` index built for exactly this
 * `WHERE workspace_id = $1 AND surface = $2 AND msg_id = $3` shape (migration
 * 543). The `readLines` scan covers ONLY the non-PG test/dev backends, where
 * datasets are small enough that a scan is both correct and cheap. On PG a query
 * error PROPAGATES: there the scan would load and cache the whole surface
 * (host-memory-reduction-2026-09-27 D-011).
 *
 * `harness_slug` is normalised from the COLUMN, not the stored blob: the column
 * is the federation source of truth, so a NULL there must erase a stale
 * `body.harness_slug` rather than let an old blob re-federate a local record.
 */
export async function getLineEnvelopeById(
  surface: CoordLineSurface,
  msgId: string,
): Promise<CoordEnvelope | null> {
  if (!msgId) return null;
  if (coordHasPgFastPath()) {
    const sql = coordSql();
    const rows = await sql<{ body: unknown; harness_slug: string | null }[]>`
      SELECT body, harness_slug
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = ${surface}
         AND msg_id = ${msgId}
       LIMIT 1
    `;
    if (rows.length) {
      const row = rows[0];
      const envelope = (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as CoordEnvelope;
      if (row.harness_slug == null) delete envelope.harness_slug;
      else envelope.harness_slug = row.harness_slug;
      return envelope;
    }
    return null;
  }
  const lines = await coordLog.readLines(surface);
  return lines.find((l) => l.msg_id === msgId) ?? null;
}
