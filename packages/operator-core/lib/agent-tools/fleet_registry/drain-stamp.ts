/**
 * drain-stamp.ts — the P-006 auto-drain stamp for fleet:wind-down / fleet:pause
 * (work-item-claimability-clarity-2026-07-20).
 *
 * When a leader winds a fleet down BECAUSE its lane is drained, the durable
 * control_reason should record WHY — but "0 claimable" is the one claim the whole
 * claimability-clarity plan exists to make trustworthy: `status='open'` is not
 * claimability (~12 unconditional floors sit between them), so a hand-rolled
 * `WHERE status='open'` count a successor writes to re-check overcounts ~13x and
 * lies about whether the wind-down was premature.
 *
 * This helper snapshots the ONE authoritative oracle instead: it runs the SAME
 * `aggregateIssueClaimExclusions` that `scheduler:get_next`'s own miss-diagnosis
 * uses (WI-5561 / EI-13965), scoped to the fleet's sentinel claim-spec filter, and
 * hands back (a) a compact per-floor breakdown summary to stamp onto the reason and
 * (b) the exact re-verify command (`scheduler:get_next { harness }`) so a successor
 * reconciles against the live oracle in one call rather than re-deriving floors in
 * SQL. Reusing the scheduler's own predicate is the point — a second SQL copy is
 * exactly the drift this plan (P-001/P-002) removes.
 *
 * FAILS SOFT by contract: any error (no sentinel spec, unresolvable harness, PG
 * hiccup) returns null and the wind-down proceeds with the caller's bare reason.
 * A diagnosis annotation must never wedge the control-state flip.
 */
import {
  getClaimSpecRecord,
  fleetSpecBeeKey,
  resolveClaimSpecWorkspace,
} from '../../scheduler/claim-spec-store';
import {
  aggregateIssueClaimExclusions,
  type IssueClaimExclusionBreakdown,
} from '../../scheduler/get-next';
import { formatSpecRef } from '../../scheduler/claim-spec';

export interface FleetDrainStamp {
  /** The harness the breakdown was computed against (the fleet's lane). */
  harness: string;
  /** The authoritative per-floor exclusion breakdown from the scheduler oracle. */
  breakdown: IssueClaimExclusionBreakdown;
  /** Which claim spec scoped the breakdown (provenance a successor can re-run). */
  spec: { specId: string; revision: number | null; source: 'cup' | 'fleet' | 'default' };
  /** Compact one-line summary suitable for appending to the durable control_reason. */
  summary: string;
  /** The exact authoritative re-verify command — the scheduler oracle itself, no SQL. */
  reVerifyCommand: string;
}

/**
 * Build the drain stamp for a fleet, or null if it cannot be computed (fails soft).
 * `harnessCandidates` are tried in priority order (explicit arg → invoker's session
 * harness), then the fleet sentinel spec's own harness scope as a last resort.
 */
export async function buildFleetDrainStamp(args: {
  fleetSlug: string;
  ownerId: string;
  workspaceId: string | null;
  /** Harness hints in priority order (e.g. [args.harness, ctx.harnessSlug]). */
  harnessCandidates?: (string | null | undefined)[];
  rigAvailable?: boolean;
}): Promise<FleetDrainStamp | null> {
  try {
    const ws = resolveClaimSpecWorkspace(args.workspaceId);
    // The fleet's sentinel spec (`fleet:<slug>` bee key) gives us both the lane
    // FILTER to scope the breakdown and its provenance. Absent/invalid ⇒ the record
    // resolver hands back DEFAULT_CLAIM_SPEC (unfiltered = the whole issue-family
    // lane for the harness), which is still a meaningful "whole lane" snapshot.
    const rec = await getClaimSpecRecord({
      cupId: fleetSpecBeeKey(args.fleetSlug),
      workspaceId: ws,
    }).catch(() => null);

    const harness =
      (args.harnessCandidates ?? []).find((h): h is string => !!h && h !== '*') ??
      (rec?.harnessSlug && rec.harnessSlug !== '*' ? rec.harnessSlug : null);
    if (!harness) return null;

    const filter = rec?.spec.view.filter;
    const states = rec?.spec.states;
    const breakdown = await aggregateIssueClaimExclusions(filter, {
      harness,
      states,
      assignee: args.ownerId,
      rigAvailable: args.rigAvailable,
    });

    const reVerifyCommand = `scheduler:get_next { harness: '${harness}' }`;
    const top = Object.entries(breakdown.excluded)
      .filter(([, n]) => (n as number) > 0)
      .sort((a, b) => (b[1] as number) - (a[1] as number));
    const specLabel = rec?.spec ? formatSpecRef(rec.spec.specId, rec.spec.revision) : 'default';
    // EI-22185555381915875: the drained/floor-gated VERDICT is `breakdown.claimable` —
    // the count that survives spec_match AND every floor — and NOTHING else. The floor
    // buckets OVERLAP by construction, so a non-empty `top` says only "some rows were
    // floored", never "none got through". Deriving the verdict from `top.length` (as
    // this summary once did) asserts "0 surviving ALL floors" while the same object
    // reports claimable=583, and because control-core concatenates this string into the
    // durable control_reason, that false justification is persisted permanently. The
    // sibling diagnosis in scheduler/fleet-scope-admission.ts already discriminates on
    // `breakdown.claimable > 0` (its `survivorsReported`); this is the same guard.
    const strandedClause =
      top.length > 0
        ? `; stranded by: ${top.map(([k, n]) => `${k}=${n}`).join(', ')} (buckets independent — a row can count under more than one)`
        : ' — none floored';
    const summary =
      `[auto-drain-stamp ${new Date().toISOString()} · spec ${specLabel}] ` +
      `${breakdown.matchedByFilter} in-lane issue-family row(s) matched the fleet spec's filter` +
      (breakdown.matchedByFilter === 0
        ? ' — the SPEC matches nothing (not a floor story)'
        : breakdown.claimable > 0
          ? `${strandedClause}; BUT ${breakdown.claimable} surviving ALL floors ⇒ claimable work REMAINS, the lane is NOT floor-gated, and this wind-down may be premature`
          : top.length > 0
            ? `${strandedClause}; 0 surviving ALL floors ⇒ the lane is genuinely floor-gated, not premature`
            : `${strandedClause}, yet 0 surviving ALL floors — the buckets do not account for the gap, so treat "drained" as UNPROVEN`) +
      `. Re-verify against the authoritative oracle (no hand-rolled SQL): ${reVerifyCommand}.`;

    return {
      harness,
      breakdown,
      spec: {
        specId: rec?.spec.specId ?? 'default-fixed-ordering',
        revision: rec?.spec.revision ?? 0,
        source: rec?.source ?? 'default',
      },
      summary,
      reVerifyCommand,
    };
  } catch {
    return null;
  }
}
