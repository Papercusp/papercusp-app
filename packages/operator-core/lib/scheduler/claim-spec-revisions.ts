/**
 * claim-spec-revisions.ts — the READ path over `harness_shared.cup_claim_spec_revisions`
 * (EI-18677010014746233 gap 2).
 *
 * Migration 810 made a destroyed claim spec RETAINED. Retained is not the same as
 * RECOVERABLE: until this module the bytes were reachable only by hand-writing
 * `dev:pg_query` SQL against a table whose ordering rule is not obvious (see
 * `supersededAt` below), which is exactly the position the 2026-07-26 incident was in
 * — the data existed somewhere and the agent holding the incident could not get at it.
 *
 * WHY A NEW MODULE RATHER THAN AN EXPORT ON claim-spec-store.ts. 19 test files
 * `vi.mock` that module with factories enumerating its exports; a new export there is
 * `undefined` in every one of them the moment a call site is committed — the standing
 * red recorded as EI-19992501422428824. This file has no mocks pointed at it, so the
 * read can be added without stranding anything.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { OrgSql } from '../work-items';

/** One superseded (or deleted) version of a lane, carrying enough to REBUILD it. */
export interface ClaimSpecRevision {
  /** The revision of the spec being retained — the one that was superseded, not the one
   *  that replaced it. Revisions are NOT unique per lane: clearing a lane restarts the
   *  counter, so the same revision legitimately recurs (see migration 810's PK note). */
  revision: number;
  /** The prior spec BYTES — the thing that was unrecoverable in the incident. */
  spec: unknown;
  /** Raw TG_OP: 'update' (superseded in place) or 'delete' (cleared, or the DELETE half of
   *  a scope-change re-home). Deliberately uninterpreted — the trigger cannot distinguish a
   *  clear from a re-home, and a label it cannot verify would be a confident wrong value. */
  cause: 'update' | 'delete';
  supersededAt: string;
  updatedBy: string | null;
  harnessSlug: string | null;
  idOnly: boolean | null;
}

export interface ClaimSpecRevisionWindow {
  /** The bee_id these rows are for, stated because it is NOT always the row that answered
   *  the current-spec read: a CLEARED lane resolves its current spec to the fleet or to
   *  DEFAULT while its own history is the thing worth recovering. An empty `revisions` is
   *  only "no history" for THIS subject. */
  subject: string;
  revisions: ClaimSpecRevision[];
  /** Rows returned (bounded by `limit`) — never a total. */
  returned: number;
  /** TRUE when older rows exist beyond the window. A bounded count read as a total is how a
   *  floor becomes a confident wrong number, so the boundedness rides on the aggregate
   *  itself rather than only on the row list. */
  more: boolean;
}

export const CLAIM_SPEC_HISTORY_MAX = 20;

/**
 * The sentence an EMPTY history window needs when the current spec was INHERITED.
 *
 * History is read for the target the caller ADDRESSED, which is right — a cleared lane's
 * own bytes are the recoverable thing even though its current spec now resolves elsewhere.
 * But it makes one empty result ambiguous: for a cup running an inherited fleet spec,
 * `revisions: []` means "this cup never had a lane of its own", NOT "this lane has no
 * history". Those read identically and only one of them is true, so the weaker claim is
 * stated explicitly along with the read that answers the stronger one.
 *
 * Returns undefined whenever the empty window is unambiguous — a direct `fleet:` read, a
 * non-inherited spec, or a window that actually returned rows.
 */
export function claimSpecHistoryElsewhereHint(args: {
  returned: number;
  source: 'cup' | 'fleet' | 'default';
  fleetSlug?: string;
  /** True when the caller addressed a fleet directly — then the fleet lane IS the subject. */
  addressedFleet: boolean;
  limit: number;
}): string | undefined {
  if (args.returned > 0 || args.addressedFleet) return undefined;
  if (args.source !== 'fleet' || !args.fleetSlug) return undefined;
  return (
    `this cup has no lane history of its own; its spec is INHERITED from fleet '${args.fleetSlug}' — ` +
    `read { fleet: '${args.fleetSlug}', history: ${args.limit} } for that lane's history`
  );
}

/**
 * Read the most recent superseded versions of one lane, newest first.
 *
 * ORDERING. `superseded_at` is `now()`, i.e. the TRANSACTION timestamp — so the DELETE and
 * INSERT halves of a scope-change re-home share it exactly. `id DESC` breaks that tie in
 * true insertion order; ordering by the timestamp alone would return the pair in an
 * arbitrary order and can answer "what was this lane before the last write" with the wrong
 * half of a single re-home.
 */
export async function readClaimSpecRevisions(
  args: { cupId: string; workspaceId?: string; limit?: number },
  sqlOverride?: OrgSql,
): Promise<ClaimSpecRevisionWindow> {
  const ws = args.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const limit = Math.max(1, Math.min(CLAIM_SPEC_HISTORY_MAX, Math.trunc(args.limit ?? 5)));
  const sql = sqlOverride ?? getOrgPg().sql;
  // limit + 1: fetching one extra row is what lets `more` be a MEASURED fact rather than an
  // inference from `returned === limit` (which is wrong exactly when the window lands flush
  // on the last row).
  const rows = (await sql`
    SELECT revision, spec, cause, superseded_at, updated_by, harness_slug, id_only
      FROM harness_shared.cup_claim_spec_revisions
     WHERE workspace_id = ${ws} AND bee_id = ${args.cupId}
     ORDER BY superseded_at DESC, id DESC
     LIMIT ${limit + 1}`) as Array<{
    revision: number;
    spec: unknown;
    cause: string;
    superseded_at: string | Date;
    updated_by: string | null;
    harness_slug: string | null;
    id_only: boolean | null;
  }>;
  const more = rows.length > limit;
  return {
    subject: args.cupId,
    revisions: rows.slice(0, limit).map((r) => ({
      revision: r.revision,
      spec: r.spec,
      cause: r.cause === 'delete' ? 'delete' : 'update',
      supersededAt:
        r.superseded_at instanceof Date ? r.superseded_at.toISOString() : String(r.superseded_at),
      updatedBy: r.updated_by,
      harnessSlug: r.harness_slug,
      idOnly: r.id_only,
    })),
    returned: Math.min(rows.length, limit),
    more,
  };
}
