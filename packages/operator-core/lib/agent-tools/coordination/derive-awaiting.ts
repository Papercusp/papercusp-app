/**
 * derive-awaiting.ts — the sender's REGISTERED waits, derived at send time
 * (coord-derived-fields-2026-08-31 D-003, P-004).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 *
 * The DERIVED half of the blockedOn ruling. The authored per-section
 * `blockedOn` carries a claim only the sender can make — "THIS statement waits
 * on X" — and D-003 makes its ref mandatory. But the sender's SESSION-LEVEL
 * waits are machine ledgers the system already holds, so they are stamped the
 * way `basedOn` is: read at send time, envelope-level (a property of the
 * session, not of a paragraph — D-064), fail-soft, provenance-marked.
 *
 *   · `event_awaits` — an active `events:await` registration IS the machine
 *     record of "this session is parked on key K". Ref = the event key itself,
 *     which a reader can `events:await` too.
 *   · work-item external blockers — `work_items:set_blocker` records on items
 *     the sender currently HOLDS (`taken_by`), status 'active'. Ref =
 *     `work-item:<id>` plus the blocker's own `<kind>:<ref>`.
 *
 * ⚠ DELIBERATELY EXCLUDED — and why, so nobody "completes" this later without
 * reading the trade-off:
 *   · The standing `coord:inbox-wake:<owner>` subscription: every live agent
 *     holds one permanently (see `event_awaits_inbox_wake_one_per_agent`);
 *     stamping it would put an identical plumbing line on every message —
 *     fill-rate theatre, information-free.
 *   · Lock-queue waits (`agent_lock_waiters`): sub-minute transients the lock
 *     hook retries through; a stamp would mostly capture waits already over by
 *     read time. Addable behind this same seam if a real reader emerges.
 *
 * ── FIELD NAME ───────────────────────────────────────────────────────────────
 *
 * `awaiting`, NOT `blockedOn`: the authored field is a claim about a specific
 * statement; this is an observation about the session. Conflating them would
 * let a machine observation be read as the sender's own attribution — the
 * exact confusion `fieldProvenance` exists to prevent (P-004 names this).
 *
 * ── FAIL-SOFT, AND NEVER FABRICATE ───────────────────────────────────────────
 *
 * Same contract as based-on.ts, stated there in full: every failure degrades to
 * LESS information (no field), never wrong information, and never a failed
 * send. No rows ⇒ no field — an empty wait set and an unmeasured one are
 * indistinguishable to a reader, and only one of them would be true.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeExternalBlockers } from '../../external-blockers';
import { EXPLICIT_PARK_NOTE_MARKER } from '../../events/await/types';

/** Max entries stamped — a pointer set, not a transcript (basedOn's rule). */
export const AWAITING_MAX_ENTRIES = 6;

/** `fieldProvenance.awaiting` — always; this field has no authored form. */
export const AWAITING_DERIVED_PROVENANCE = 'session-derived';

export interface AwaitingEntry {
  /** What kind of registered wait this is. */
  kind: 'event-await' | 'work-item-blocker';
  /**
   * The wait's identity, awaitable where the kind allows it: for
   * 'event-await' the events:catalog key itself; for 'work-item-blocker' the
   * held item (`work-item:<id>`) — its clearing is observable via the item.
   */
  ref: string;
  /**
   * 'work-item-blocker' only — the blocker's own `<kind>:<ref>` from set_blocker, or
   * `blocks:<blocker ref>` for an unresolved `work_item_deps` edge (WI-10005020: a work-item
   * dependency is stored as an edge, never as an external blocker row).
   */
  blocker?: string;
  /** ISO — when the wait was registered, so a reader can age it. */
  since?: string;
}

/**
 * Derive the sender's registered waits. Returns `[]` — never throws — when
 * there is nothing to say or anything at all goes wrong.
 */
export async function deriveAwaiting(opts: {
  ownerId: string;
  workspaceId: string;
  limit?: number;
}): Promise<AwaitingEntry[]> {
  if (!opts.ownerId || !opts.workspaceId) return [];
  const limit = opts.limit ?? AWAITING_MAX_ENTRIES;
  try {
    const { sql } = getOrgPg();
    const out: AwaitingEntry[] = [];

    // Leg 1 — active event awaits. The inbox-wake standing subscription is
    // plumbing every agent holds; excluded (see module header).
    const awaits = await sql<{ event_key: string; created_at: Date }[]>`
      SELECT event_key, created_at
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${opts.workspaceId}
         AND subscriber_id = ${opts.ownerId}
         AND fired_at IS NULL
         AND cancelled_at IS NULL
         AND (
           event_key NOT LIKE 'coord:inbox-wake:%'
           OR note LIKE ${EXPLICIT_PARK_NOTE_MARKER + '%'}
         )
       ORDER BY created_at DESC
       LIMIT ${limit}`;
    for (const row of awaits) {
      if (out.length >= limit) break;
      out.push({
        kind: 'event-await',
        ref: row.event_key,
        since: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
      });
    }

    // Leg 2 — active external blockers on items the sender holds. Bounded: the
    // holder set is small by construction (an agent holds a handful of items).
    if (out.length < limit) {
      const held = await sql<{ feature_id: string; payload: unknown }[]>`
        SELECT feature_id, payload
          FROM harness_shared.work_items
         WHERE workspace_id = ${opts.workspaceId}
           AND taken_by = ${opts.ownerId}
           AND status NOT IN ('done', 'resolved', 'deprecated')
           AND payload ? 'externalBlockers'
         LIMIT 20`;
      for (const item of held) {
        if (out.length >= limit) break;
        for (const blocker of activeExternalBlockers(item.payload)) {
          if (out.length >= limit) break;
          out.push({
            kind: 'work-item-blocker',
            ref: `work-item:${item.feature_id}`,
            blocker: `${blocker.kind}:${blocker.ref}`,
          });
        }
      }
    }

    // Leg 3 — unresolved `blocks` edges on items the sender holds (WI-10005020, plan
    // feature-drain-delivery-readiness-and-outcome-accounting-2026-10-01 D-008 §4a). A blocker
    // that names another work item lives on an edge, not in externalBlockers (R-2/R-15), so
    // without this leg a migrated wait would silently vanish from the stamp. Its own try: an
    // edge-read failure must cost only this leg, never legs 1–2 (less information, not none).
    // Dynamic import keeps work-items.ts out of this module's static graph.
    if (out.length < limit) {
      try {
        const { readHeldUnresolvedDepBlockers } = await import('../../work-items');
        const edges = await readHeldUnresolvedDepBlockers({
          ownerId: opts.ownerId,
          workspaceId: opts.workspaceId,
          limit: limit - out.length,
        });
        for (const edge of edges) {
          if (out.length >= limit) break;
          out.push({
            kind: 'work-item-blocker',
            ref: `work-item:${edge.featureId}`,
            blocker: `blocks:${edge.blockerRef}`,
            ...(edge.since ? { since: edge.since } : {}),
          });
        }
      } catch {
        // keep what legs 1–2 found
      }
    }

    return out;
  } catch {
    return []; // a decorative stamp must never fail the send it decorates
  }
}
