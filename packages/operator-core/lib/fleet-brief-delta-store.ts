/**
 * fleet-brief-delta-store — the IO half of P-022's wake-to-wake delta (D-011).
 *
 * The arithmetic and every honesty rule live in the pure `fleet-brief-delta.ts`; this module
 * only fetches. Split for the reason the sibling detectors are split: the interesting
 * behaviour (what counts as a baseline, what may be rendered as a zero) is then testable with
 * no database at all.
 *
 * TWO MEASUREMENTS HERE THAT ARE FLOORS, NOT TOTALS — both discovered by measuring the live
 * data before writing the query, and both reported as floors rather than quietly rounded:
 *
 *  1. `left` UNDER-REPORTS DEPARTURES, structurally. `fleet_membership_events` carries 3200
 *     `join` rows against 24 `leave` rows: a member that simply dies emits no leave event, so
 *     the log records arrivals far more faithfully than exits. The NET roster difference (from
 *     the snapshot) is therefore the reliable membership signal, and the churn counts are the
 *     supplement that can see a join+leave inside one window — not the other way round.
 *  2. `event` HAS FOUR VALUES, not two: `join`, `leave`, plus `lead` (341 rows — a leadership
 *     change, not an arrival) and `backfill` (8 — a repair). Both are matched EXPLICITLY. The
 *     tempting `event <> 'leave'` shorthand would have counted every leadership handover in
 *     this fleet's history as a member joining.
 *
 * The closes count deliberately reuses `ANY_FAMILY_TERMINAL_STATES` — the same constant
 * `work_items:burn_down` folds over — so the definition of "terminal" cannot drift between the
 * two surfaces. It also reproduces burn_down's `closed_ts`-not-`updated_ts` rule, whose
 * absence once reported 3,833 items as "closed in one hour" when a backfill had merely touched
 * them. What this does NOT reproduce is burn_down's four-way ATTRIBUTION split
 * (fleet/otherAgents/system/unattributed): that stays burn_down's job, and the brief points at
 * it rather than growing a second implementation that could disagree with the first.
 */

import { getOrgPg } from '@papercusp/db-org';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import { coerceJson } from './pg-jsonb';
import {
  rotateBriefSnapshot,
  computeFleetBriefDelta,
  describeFleetBriefDelta,
  type FleetBriefObservation,
  type FleetBriefSnapshotRow,
  type FleetBriefDelta,
  type MembershipChurn,
  type ClosesInput,
} from './fleet-brief-delta';

// Derived from getOrgPg rather than imported as a named type — the same workaround the sibling
// fleet modules use to avoid a TS2305 that reds the fleet's typecheck gate.
type OrgSql = ReturnType<typeof getOrgPg>['sql'];

export interface SnapshotKey {
  workspaceId: string;
  fleetSlug: string;
  ownerId: string;
}

/** Read the stored two-slot snapshot. A never-written key reads as null, never an error. */
export async function readBriefSnapshot(
  key: SnapshotKey,
  sqlOverride?: OrgSql,
): Promise<FleetBriefSnapshotRow | null> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT fire_count, baseline, observation
      FROM harness_shared.fleet_brief_snapshots
     WHERE workspace_id = ${key.workspaceId}
       AND fleet_slug   = ${key.fleetSlug}
       AND owner_id     = ${key.ownerId}
     LIMIT 1
  `) as Array<{ fire_count: string | number | null; baseline: unknown; observation: unknown }>;
  // baseline/observation are typed unknown on purpose: a jsonb column reads back as an OBJECT
  // on the prod getOrgPg client but as a raw JSON STRING under any prepare:false client (the
  // testcontainer pool), so the shape is genuinely not known until coerceJson decodes it.
  const row = rows[0];
  if (!row) return null;
  const observation = coerceJson<FleetBriefObservation>(row.observation);
  // A row whose observation will not decode is not a usable baseline. Reporting it as absent
  // makes the next read start a fresh boundary, which the delta renders as "no baseline" —
  // strictly better than differencing against a half-parsed snapshot.
  if (!observation) return null;
  return {
    // bigint arrives as an exact-precision string; the fire count is small, so Number is safe.
    fireCount: row.fire_count === null ? null : Number(row.fire_count),
    baseline: coerceJson<FleetBriefObservation>(row.baseline),
    observation,
  };
}

/** Upsert the rotated snapshot. Called ONLY when `rotateBriefSnapshot` reports `rotated`. */
export async function writeBriefSnapshot(
  key: SnapshotKey,
  row: FleetBriefSnapshotRow,
  sqlOverride?: OrgSql,
): Promise<void> {
  const sql = sqlOverride ?? getOrgPg().sql;
  await sql`
    INSERT INTO harness_shared.fleet_brief_snapshots
                (workspace_id, fleet_slug, owner_id, fire_count, baseline, observation, rotated_at)
         VALUES (${key.workspaceId}, ${key.fleetSlug}, ${key.ownerId}, ${row.fireCount},
                 -- jsonb is bound as an explicit JSON.stringify + cast: sql.json() THROWS on the
                 -- getOrgPg client (EI-607) and a bare object does not bind. A null baseline is
                 -- bound as SQL NULL rather than the jsonb literal 'null', so "no baseline yet"
                 -- and "a baseline that decoded to null" stay the same thing to the reader.
                 ${row.baseline ? JSON.stringify(row.baseline) : null}::jsonb,
                 ${JSON.stringify(row.observation)}::jsonb, now())
    ON CONFLICT (workspace_id, fleet_slug, owner_id) DO UPDATE
       SET fire_count  = EXCLUDED.fire_count,
           baseline    = EXCLUDED.baseline,
           observation = EXCLUDED.observation,
           rotated_at  = now()
  `;
}

/**
 * Membership churn from the durable event log. `left` is a FLOOR — see this module's header:
 * a member that dies emits no leave row, so exits are recorded far less faithfully than
 * arrivals.
 */
export async function readMembershipChurn(
  args: { workspaceId: string; fleetSlug: string; since: string },
  sqlOverride?: OrgSql,
): Promise<MembershipChurn> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT count(*) FILTER (WHERE event = 'join')  AS joined,
           count(*) FILTER (WHERE event = 'leave') AS left
      FROM harness_shared.fleet_membership_events
     WHERE workspace_id = ${args.workspaceId}
       AND fleet_slug   = ${args.fleetSlug}
       AND at           > ${args.since}::timestamptz
  `) as Array<{ joined: string | number; left: string | number }>;
  const row = rows[0];
  return { joined: Number(row?.joined ?? 0), left: Number(row?.left ?? 0) };
}

/**
 * Terminal transitions since `since`. `isFloor` is true when terminal rows exist whose close
 * time is unknown (pre-migration-698 rows): the window may contain closes this cannot place in
 * time, so the count is a lower bound. Surfacing that is what keeps "nothing closed" and "this
 * window is unmeasurable" from reading identically.
 */
export async function readClosesSince(
  args: { workspaceId: string; harnessSlug: string | null; since: string },
  sqlOverride?: OrgSql,
): Promise<ClosesInput> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const sinceMs = Date.parse(args.since);
  if (!Number.isFinite(sinceMs)) return { delta: null, isFloor: false };
  const terminal = [...ANY_FAMILY_TERMINAL_STATES];
  const rows = (await sql`
    SELECT count(*) FILTER (WHERE closed_ts IS NOT NULL AND closed_ts > ${sinceMs}) AS closes,
           count(*) FILTER (WHERE closed_ts IS NULL)                                AS undated
      FROM harness_shared.work_items
     WHERE workspace_id = ${args.workspaceId}
       AND status = ANY(${terminal})
       ${args.harnessSlug ? sql`AND harness_slug = ${args.harnessSlug}` : sql``}
  `) as Array<{ closes: string | number; undated: string | number }>;
  const row = rows[0];
  if (!row) return { delta: null, isFloor: false };
  return { delta: Number(row.closes ?? 0), isFloor: Number(row.undated ?? 0) > 0 };
}

/**
 * Resolve the whole delta block for one brief read: rotate the boundary, fetch the derived
 * axes against it, and assemble.
 *
 * BEST-EFFORT BY CONTRACT. Every caller path is wrapped so a delta failure can never cost the
 * leader the rest of the brief — the same discipline the spec-pool preview and the custom
 * invariant registry already follow here. A failure returns null, which the brief renders as
 * an absent block rather than as a quiet set of zeroes.
 */
export async function resolveFleetBriefDelta(
  args: {
    key: SnapshotKey;
    harnessSlug: string | null;
    observation: FleetBriefObservation;
    /** The caller's loop fire count; null when no loop is armed (boundary becomes per-read). */
    fireCount: number | null;
    /** An explicit caller-supplied boundary, which overrides the stored one. */
    since?: string | null;
  },
  sqlOverride?: OrgSql,
): Promise<{ delta: FleetBriefDelta; summary: string } | null> {
  const stored = await readBriefSnapshot(args.key, sqlOverride);
  const rotation = rotateBriefSnapshot(stored, args.observation, args.fireCount);
  if (rotation.rotated) {
    await writeBriefSnapshot(args.key, rotation.next, sqlOverride);
  }

  const explicit = args.since ?? null;
  const boundary = explicit ? ('explicit' as const) : rotation.boundary;
  const window = explicit ?? rotation.baseline?.at ?? null;

  let churn: MembershipChurn | null = null;
  let closes: ClosesInput = { delta: null, isFloor: false };
  if (window) {
    // Each read is isolated: a membership-log failure must not also cost the closes count.
    try {
      churn = await readMembershipChurn(
        { workspaceId: args.key.workspaceId, fleetSlug: args.key.fleetSlug, since: window },
        sqlOverride,
      );
    } catch {
      churn = null;
    }
    try {
      closes = await readClosesSince(
        { workspaceId: args.key.workspaceId, harnessSlug: args.harnessSlug, since: window },
        sqlOverride,
      );
    } catch {
      closes = { delta: null, isFloor: false };
    }
  }

  // An EXPLICIT window still needs a baseline for the snapshot-only axes (pool factor, prior
  // spec revision) — those have no durable history to re-read at an arbitrary timestamp, so
  // they stay unavailable rather than being back-filled from a boundary they never saw.
  const delta = computeFleetBriefDelta({
    baseline: rotation.baseline,
    observation: args.observation,
    boundary,
    churn,
    closes,
    since: explicit,
  });
  return { delta, summary: describeFleetBriefDelta(delta) };
}
