/**
 * ratification-gate.ts — the scout-draft RATIFICATION gate
 * (blender-su-grade-integration-2026-08-11 D-015, WI-38047).
 *
 * WHY THIS EXISTS. Flipping a scout draft plan to `ready` is the ENTIRE approval
 * step on this rail: `ready-plan-autostart` consumes that flip and promotes the
 * draft's items straight into the claimable pool, with no second gate ("ratifying
 * IS the approval"). The Queen used to perform the flip; she is retired, and the
 * named approver is now the Blender STEWARD (the GOAL holder).
 *
 * [owner 2026-08-11, interactive] D-015 REMOVED the item-count cap that used to
 * bound what a steward may ratify — a draft of any size is now eligible. Two
 * qualitative conditions survive and, with the cap gone, are the ENTIRE safety
 * margin:
 *
 *   1. Nothing in the dangerous set (irreversible migration / outward-facing
 *      publish or send / fleet-autonomy escalation / auth-security / kill-switch).
 *   2. NEVER a draft whose idea the steward filed itself.
 *
 * This module enforces (2) — the mechanical, unambiguous one — as a REFUSAL, in the
 * same shape as `blender:grade-idea`'s no-self-grade guard (D-012): the originator is
 * read BEFORE the write, so a self-ratification never reaches the plan row and the
 * autostart sweep can never see it. The reasoning is identical to the self-grade
 * case: a proposal approved by its own author is a self-licking loop, and here the
 * loop spends fleet capacity rather than just polluting a learning signal.
 *
 * ⚠ (1) IS NOT ENFORCED HERE, IS NOT SILENTLY IMPLIED TO BE, AND IS NOT PENDING.
 * [D-026, 2026-09-05, WI-38057] condition (1) is ACCEPTED AS DOCTRINE — enforced by
 * the steward's adherence alone. Do not read this module's existence as evidence that
 * both guards are live, and do not refile (1) as unimplemented work.
 *
 * The obvious mechanisation was MEASURED before it was rejected, so the rejection is a
 * number rather than an opinion. Classifying the 30 plans reachable from
 * `scout_routed_ideas WHERE rail='plan'` with the obvious keyword sets flagged 30/30 —
 * and hand-checking the most-flagged found 0 true positives (matches were a REFERENCE
 * to an applied migration, the word "migration" inside an error string, and a plan that
 * is "Zero-secret by construction"). Measured precision 0.00. The noise is the DOMAIN,
 * not the keyword choice: this is a codebase about fleets, release gates, migrations and
 * auth-bearing tools, so the dangerous-set vocabulary is every plan's ordinary working
 * vocabulary. An advisory that fires on 100% of drafts trains the ratifier to ignore the
 * channel and would degrade guard (2)'s genuine refusal by association.
 *
 * REOPENS ON: a measured true positive on this rail, or a classifier that beats the
 * recorded 0.00-precision baseline on that same corpus. The burden of proof sits with
 * the proposal, not with the gap.
 *
 * ⚠ POPULATION — RE-MEASURED 2026-09-05, AND IT HAS FLIPPED. This module previously
 * recorded (measured 2026-08-12) that all 6 `rail='plan'` rows had `created_by` NULL,
 * so no current row could trigger the refusal and the guard was "FORWARD-acting". That
 * is NO LONGER TRUE and must not be carried forward: `rail='plan'` now holds 27 rows
 * WITH an originator on record (15 routed 2026-08-13..15, 12 more 2026-08-20..2026-09-05),
 * against 6 originator-less rows from June. The guard is LIVE, not forward-acting — an
 * su routing its own filing to the plan rail is now the ordinary case, which is exactly
 * the case D-015 names.
 *
 * Re-check before relying on either number (the shape of the read, not a remembered
 * total):
 *   SELECT count(*) FILTER (WHERE created_by IS NOT NULL) AS with_originator, count(*)
 *     FROM harness_shared.scout_routed_ideas WHERE rail = 'plan';
 *
 * The lesson generalises past this module: the 2026-08-12 note was pinned by a unit test
 * that passed `createdBy: null` BY HAND, so it asserted a claim about the live ledger
 * while measuring only the pure function. It could never fail when the population moved,
 * and it did not. A population claim needs a probe that reads the population.
 *
 * FAIL-SOFT, deliberately, and VISIBLE. An unattributable caller or a lookup failure
 * yields `satisfied: true` with a `skipped` reason rather than a refusal — a DB blip
 * must not wedge the ratification rail, and an unattributable caller cannot be a
 * PROVEN self-ratification (exactly D-012's rule). Every such degradation names
 * itself in `skipped`, so a caller can log the difference between "checked and clean"
 * and "could not check".
 */
import { getOrgPg } from '@papercusp/db-org';

export type ScoutRatificationGateCode = 'no_self_ratification';

/** Why the gate did not apply. Each value is a DIFFERENT claim about how much was
 *  actually verified — never collapse them into a bare `satisfied: true`. */
export type ScoutRatificationSkip =
  /** The plan has no routed-idea row — not a scout-rail draft, so this gate is silent. */
  | 'not-scout-plan'
  /** The caller could not be attributed to a coord ownerId (D-012's rule: an
   *  unattributed caller cannot be a proven self-ratification). */
  | 'caller-unattributable'
  /** The routed row exists but records no originator (every origin='scout' row today). */
  | 'no-originator-on-record'
  /** The originator lookup itself failed — NOT a clean check. */
  | 'lookup-failed';

export interface ScoutRatificationVerdict {
  satisfied: boolean;
  /** Present iff the gate did not actually compare an originator (see the type). */
  skipped?: ScoutRatificationSkip;
  /** Present iff the gate refused. */
  code?: ScoutRatificationGateCode;
  /** Teaching message for the refusal — names the escalation route, not just the no. */
  message?: string;
  /** The routed idea consulted, when one was found. */
  ideaId?: string;
  /** The originator on record, when one was found. */
  originator?: string | null;
}

/**
 * The routed-artifact ref convention for the plan rail (`scout_routed_ideas.routed_ref`,
 * migration 194): `'plan:<slug>'`. Kept next to the query it feeds so the two cannot
 * drift apart silently.
 */
export function planRoutedRef(planSlug: string): string {
  return `plan:${planSlug}`;
}

/**
 * PURE: the refusal decision, split from IO so it is unit-testable with no PG.
 * `createdBy`/`callerOwnerId` are the two originator identities being compared.
 */
export function decideSelfRatification(args: {
  callerOwnerId: string | null;
  createdBy: string | null;
  found: boolean;
}): ScoutRatificationVerdict {
  if (!args.callerOwnerId) return { satisfied: true, skipped: 'caller-unattributable' };
  if (!args.found) return { satisfied: true, skipped: 'not-scout-plan' };
  if (!args.createdBy) return { satisfied: true, skipped: 'no-originator-on-record' };
  if (args.createdBy === args.callerOwnerId) {
    return {
      satisfied: false,
      code: 'no_self_ratification',
      originator: args.createdBy,
      message:
        "cannot ratify this draft (status → 'ready'): you FILED the idea it came from, and ratifying is the " +
        'approval step — a `ready` flip promotes the draft\'s items straight into the claimable pool with no ' +
        'second gate. [owner 2026-08-11, D-015] the steward may never ratify a draft whose idea it filed ' +
        'itself; this survived the removal of the item-count cap and is now one of only two remaining guards. ' +
        'Route it to a DIFFERENT steward (coord:send the plan slug to a live GRADE/GOAL-mode su) or escalate ' +
        'to the owner (coord:ask-owner) — the same rule, and the same reason, as blender:grade-idea refusing a ' +
        'self-grade.',
    };
  }
  return { satisfied: true, originator: args.createdBy };
}

/**
 * Evaluate the gate for a plan about to be flipped to `ready`.
 *
 * Never throws: a lookup failure degrades to `satisfied: true, skipped: 'lookup-failed'`
 * (see the fail-soft note in the module header).
 */
export async function evaluateScoutRatificationGate(args: {
  planSlug: string;
  callerOwnerId: string | null;
}): Promise<ScoutRatificationVerdict> {
  // Cheapest exit first: an unattributable caller can never be a PROVEN self-ratification,
  // so there is no reason to spend a query on it.
  if (!args.callerOwnerId) return { satisfied: true, skipped: 'caller-unattributable' };

  let row: { idea_id: string; created_by: string | null } | undefined;
  try {
    const { sql } = getOrgPg();
    // PK-free lookup by the routed ref, deliberately NOT workspace-narrowed — the same
    // EI-346 reason grade-idea's readers give: the ledger row and the caller can sit in
    // different workspace scopes, and a narrowed read would silently find nothing (which
    // is indistinguishable from "not a scout draft" and would fail the guard OPEN).
    const rows = await sql<{ idea_id: string; created_by: string | null }[]>`
      SELECT idea_id, created_by
        FROM harness_shared.scout_routed_ideas
       WHERE routed_ref = ${planRoutedRef(args.planSlug)}
       ORDER BY routed_at DESC
       LIMIT 1`;
    row = rows[0];
  } catch {
    return { satisfied: true, skipped: 'lookup-failed' };
  }

  const verdict = decideSelfRatification({
    callerOwnerId: args.callerOwnerId,
    createdBy: row?.created_by ?? null,
    found: row != null,
  });
  return row ? { ...verdict, ideaId: row.idea_id } : verdict;
}
