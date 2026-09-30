/**
 * pause-holds.ts — the claim-hold leg of fleet:wind-down / fleet:pause / fleet:resume
 * (EI-20199397615670608).
 *
 * ── THE BUG THIS CLOSES ──────────────────────────────────────────────────────
 * A fleet PAUSE parked the agents but left the lane's work CLAIMABLE. Worse, it
 * INSTRUCTED its own exposure: the wind-down cue (control-core's
 * {@link fleetControlCueText}) tells every member "release your claims", and
 * `applyFleetControl` did nothing to protect what they released. So the moment a
 * member COMPLIED, its item fell back into the claimable pool and the very next
 * `scheduler:get_next` — by any agent, in or out of the fleet — silently resumed the
 * paused work. Compliance with the pause was what created the leak, which is why no
 * amount of agent carefulness ever fixed it and why it recurred a week after being
 * filed (observed live 2026-08-11 and again 2026-08-18: WI-39265 was served from the
 * sidestage default spec while the fleet's owner-directed pause was still in force).
 *
 * This is a known class in this codebase, not a novel one: `pot/get_steering.ts:100`
 * already documents that `pauseNewWork` "does NOT pause anything — it only ever gated
 * the MUG's placement". A control named "pause" that does not actually pause is the
 * trap; this module exists so fleet:pause does not reintroduce it under a new verb.
 *
 * ── WHY A DURABLE PARK AND NOT A HOLD-OPEN LEASE (the load-bearing choice) ────
 * {@link setWorkItemClaimHold} offers two provenance modes (work-items.ts): `opts.by`
 * stamps a LEASE (`held_open_*`) and `opts.parkedBy` stamps a DURABLE PARK
 * (`claim_hold_*`). A lease is LIVENESS-BOUND — the WI-4531 reaper lifts it once the
 * holder is dead past a 2h grace.
 *
 * A lease is therefore exactly wrong here, and fails in the specific way that recreates
 * the bug: a paused fleet's members are, by construction, about to park or end. Their
 * leases would expire ~2h later and re-expose precisely the work the pause protected —
 * silently, with no second pause event to notice. That is the WI-321 boomerang the
 * park/lease split was introduced to fix (eight agents in 27h re-claimed the SAME
 * parked item because each park lapsed when its parker's session died). A pause must
 * outlive the sessions it pauses, so it takes the DURABLE PARK.
 *
 * ── WHY RESUME CLEARS ONLY WHAT PAUSE SET ────────────────────────────────────
 * Blanket-clearing every `_claimHold` on resume would wipe unrelated DELIBERATE parks —
 * a WI-2797 hand-park an agent set on purpose ("do not self-select this again") would be
 * silently undone by an unrelated fleet resuming. So the set leg stamps a machine-
 * matchable provenance marker into `claim_hold_reason` ({@link fleetPauseHoldMarker},
 * scoped to the fleet slug) and the clear leg matches ONLY that marker. A park whose
 * reason someone has since rewritten no longer matches and is deliberately left alone.
 *
 * ── FAIL-SOFT BY CONTRACT ────────────────────────────────────────────────────
 * Both legs mirror the sibling {@link buildFleetDrainStamp} contract: any error returns
 * a zeroed result and the control flip proceeds untouched. Protecting the lane must
 * never wedge the ability to pause (or, worse, to RESUME) the fleet.
 */
import { getOrgPg } from '@papercusp/db-org';
import { setWorkItemClaimHold } from '../../work-items';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';

/**
 * The provenance marker stamped into `payload.claim_hold_reason` by the pause leg and
 * matched by the resume leg. Fleet-scoped so one fleet's resume can never lift another
 * fleet's pause holds.
 */
export function fleetPauseHoldMarker(fleetSlug: string): string {
  return `[fleet-pause:${fleetSlug}]`;
}

export interface FleetPauseHoldResult {
  /** Item ids whose claim-hold this call SET (pause) or CLEARED (resume). */
  items: string[];
  /** Items matched but whose write failed — surfaced, never thrown. */
  failed: string[];
  /**
   * Set ONLY when the leg failed wholesale (the query threw). Distinguishes "nothing
   * matched" — a normal, healthy outcome — from "this protection did not run", which
   * are otherwise the SAME empty result.
   *
   * This field exists because fail-soft nearly shipped the original bug back: the first
   * draft of the query named a column that does not exist on `harness_shared.work_items`
   * (`assignee`; the claim holder is `taken_by`). The catch below swallowed it, so a
   * pause would have reported success while parking NOTHING — the exact leak this module
   * closes, now wearing a "fixed" label and impossible to notice. Fail-soft is still
   * right (a hold failure must never wedge a pause, still less a RESUME), but it must be
   * LOUD: silence here is indistinguishable from correctness.
   */
  degraded?: string;
}

const EMPTY: FleetPauseHoldResult = { items: [], failed: [] };

/** Fail-soft, but never silent — see {@link FleetPauseHoldResult.degraded}. */
function degraded(leg: 'pause' | 'resume', fleetSlug: string, err: unknown): FleetPauseHoldResult {
  const message = (err as Error)?.message ?? String(err);
  console.warn(`[fleet-pause-holds] ${leg} leg FAILED for '${fleetSlug}' — lane NOT protected:`, message);
  return { ...EMPTY, degraded: message };
}

/**
 * PAUSE leg: park every non-terminal work-item currently held by a member of this fleet,
 * so a member complying with the wind-down cue ("release your claims") cannot leak its
 * item back into the claimable pool.
 *
 * MEMBERSHIP IS READ FROM THE LATEST `fleet_membership_events` FACT, WITH NO LIVENESS
 * FILTER — deliberately NOT via `coord_presence.fleet_slug` or
 * `hostAudienceResolvers.listFleetMembers`. The presence label is only a projection and
 * the delivery resolver drops muted and stale/parked heartbeats. Those exclusions are
 * correct for sending a message and WRONG here: a muted member still holds claims, and a
 * member that has already parked in response to the pause is the very case this protects.
 * The append-only fact is the durable current-membership source, so a reaped member is
 * still included while an owner who has moved to another fleet is not.
 *
 * Items already claim-held are skipped, so a re-invoked pause neither double-writes nor
 * overwrites an existing deliberate park's provenance (which would then be wrongly
 * cleared by this fleet's resume).
 */
export async function applyFleetPauseHolds(args: {
  fleetSlug: string;
  workspaceId: string | null;
  /** The pause invoker — recorded as the park's `claim_hold_by` provenance. */
  byOwnerId: string;
  /**
   * Registry leader retained for call-site compatibility. It is intentionally NOT unioned
   * into the holder set: one leader can control several fleets, but a holder's work-item
   * claim has no fleet id, so an unconditional leader union parks unrelated claims. The
   * latest durable membership fact below is the only safe fleet-scope predicate.
   */
  leaderOwnerId?: string | null;
  /** The control reason, appended after the marker for human triage. */
  reason?: string | null;
}): Promise<FleetPauseHoldResult> {
  try {
    const { sql } = getOrgPg();
    const marker = fleetPauseHoldMarker(args.fleetSlug);
    const parkedReason = args.reason ? `${marker} ${args.reason}` : marker;

    // NB: the claim HOLDER column is `taken_by`, not `assignee` — `assignee` is a
    // TOOL-LAYER projection name (work_items:list/get) with no column behind it. Verified
    // against the live relation: a query naming `assignee` raises 42703, which the
    // fail-soft catch would otherwise have hidden completely.
    const rows = await sql<{ feature_id: string; harness_slug: string | null }[]>`
      WITH current_membership AS (
        SELECT DISTINCT ON (e.owner_id)
               e.owner_id, e.fleet_slug
          FROM harness_shared.fleet_membership_events e
         WHERE e.workspace_id = ${args.workspaceId}
         ORDER BY e.owner_id, e.id DESC
      )
      SELECT w.feature_id, w.harness_slug
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${args.workspaceId}
         AND w.taken_by IS NOT NULL
         AND w.taken_by <> ''
         AND NOT (w.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         -- Already parked (by anyone, for any reason): leave its provenance alone.
         AND COALESCE(w.payload, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM 'true'
         AND w.taken_by IN (
           SELECT m.owner_id
             FROM current_membership m
            WHERE m.fleet_slug = ${args.fleetSlug}
         )`;

    return await writeHolds(rows, true, {
      parkedBy: args.byOwnerId,
      parkedReason,
    });
  } catch (err) {
    return degraded('pause', args.fleetSlug, err);
  }
}

/**
 * RESUME leg: lift ONLY the parks this fleet's pause set, identified by the marker in
 * `claim_hold_reason`. Terminal rows are included on purpose — a park left on an item
 * that was completed during the pause is pure residue, and the sibling
 * `reclaimStaleHoldOpens` sweep clears such residue for the same reason.
 */
export async function clearFleetPauseHolds(args: {
  fleetSlug: string;
  workspaceId: string | null;
}): Promise<FleetPauseHoldResult> {
  try {
    const { sql } = getOrgPg();
    const marker = fleetPauseHoldMarker(args.fleetSlug);
    const rows = await sql<{ feature_id: string; harness_slug: string | null }[]>`
      SELECT w.feature_id, w.harness_slug
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${args.workspaceId}
         AND COALESCE(w.payload, '{}'::jsonb) ->> '_claimHold' = 'true'
         AND COALESCE(w.payload, '{}'::jsonb) ->> 'claim_hold_reason' LIKE ${`${marker}%`}`;

    return await writeHolds(rows, false, {});
  } catch (err) {
    return degraded('resume', args.fleetSlug, err);
  }
}

/** Shared per-item write loop — one failure never aborts the rest, and never throws. */
async function writeHolds(
  rows: { feature_id: string; harness_slug: string | null }[],
  hold: boolean,
  opts: { parkedBy?: string; parkedReason?: string },
): Promise<FleetPauseHoldResult> {
  const items: string[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    const applied = await setWorkItemClaimHold(row.feature_id, hold, {
      ...(row.harness_slug ? { harness: row.harness_slug } : {}),
      ...opts,
    }).catch(() => null);
    if (applied) items.push(row.feature_id);
    else failed.push(row.feature_id);
  }
  return { items, failed };
}
