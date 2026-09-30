/**
 * P-013 instrumentation, measure 7 — DEFECT ESCAPE on the work-item axis.
 *
 * "Escape" here means work that was declared finished and then had to be picked up again: an
 * item with a WON claim recorded after its own close. Paired with measure 6 (`spec-enforcement-
 * latency.ts`) it answers the question enforcement is actually judged on — not "did items get
 * slower", but "did they come back".
 *
 * ## Why the ledger, and not the obvious status signal
 *
 * The obvious detector is a point-in-time one: an item that is currently NON-terminal but still
 * carries `terminal_owner`, which `issues-engineer.ts` documents as "never cleared on reopen".
 * That detector was measured before being trusted, and it is STRUCTURALLY BLIND here:
 *
 *   - 0 of 3,687 non-terminal work-items carry a `terminal_owner` (open 3,256 · blocked 302 ·
 *     todo 65 · needs-human 62 · wip 2 — every one of them zero).
 *   - Yet the append-only claim ledger shows 4 items with a WON claim recorded after their own
 *     `closed_ts`, across 5 such claims.
 *
 * The two signals disagree, so the snapshot one is not a reliable escape detector — it can only
 * ever see an item still SITTING in a reopened state at census time, and an item that was
 * reopened and re-closed is invisible to it. A bare zero from it would have read as "nothing
 * escapes". That is why this module measures from the append-only ledger instead, and why the
 * snapshot's blindness is stated in `notDerivable` rather than left for a reader to rediscover.
 *
 * ## The denominator is the instrument's REACH, not the corpus
 *
 * An item with no ledger row cannot exhibit a post-close reclaim no matter how many times it
 * really escaped, so including such items in the denominator would push the rate toward zero for
 * INSTRUMENT reasons and let ledger coverage masquerade as quality. The denominator is therefore
 * items that are closed AND carry a won claim — the population where an escape was detectable at
 * all — and `coverage` reports how much of the corpus that is.
 */
import type { EnforcementBucket, FirstClaimRow, WorkItemLifecycleRead } from './spec-enforcement-latency';
import {
  listWonClaimEnvelope,
  listWorkItemLifecycle,
  LATENCY_ITEM_LIMIT,
  LATENCY_PLAN_LIMIT,
} from './spec-enforcement-latency';
import { defaultListPlanAdoption } from './spec-reconciliation';
import { enforcementEligibility, type PlanAdoptionRow } from './spec-enforcement-eligibility';

/**
 * How long after a close a won claim must land before it counts as rework rather than the
 * closing agent's own trailing bookkeeping.
 *
 * Not zero on purpose: a claim released and re-recorded within the same closing transaction
 * would otherwise register as an escape, manufacturing a defect out of normal lifecycle noise.
 */
export const ESCAPE_REWORK_GRACE_MS = 60_000;

export interface EscapeRow {
  workItemId: string;
  planSlug: string | null;
  bucket: EnforcementBucket;
  closedAtMs: number;
  reclaimedAtMs: number;
  /** How long after the close the item was picked back up. */
  gapMs: number;
}

export interface EscapeLane {
  /** Items in this bucket where an escape was DETECTABLE (closed + in ledger reach). */
  detectable: number;
  escaped: number;
}

export interface SpecEnforcementEscapeRollup {
  /** The denominator: closed items carrying a won claim. NOT the whole corpus — see the header. */
  detectableItems: number;
  escapedItems: number;
  /**
   * Escapes per thousand DETECTABLE items. Null when nothing was detectable — an unmeasured
   * rate, never a clean 0/1000. A perfectly round rate over a tiny denominator is a definitional
   * artifact far more often than it is a real distribution, so the denominator travels with it.
   */
  escapesPerThousand: number | null;
  byEnforcement: Record<EnforcementBucket, EscapeLane>;
  coverage: {
    /**
     * EVERY row the reader returned, observations included — the read's own size, not the
     * measured population. Named to match the identical field on the latency and
     * repeated-approach rollups so the three blocks of one `plans:spec-reconciliation` payload
     * can be compared directly; a reader who finds three different numbers here is looking at
     * three different snapshots (the scans are independent), which is the only signal that
     * divergence leaves.
     */
    itemsRead: number;
    /**
     * Turn-end notes excluded before measurement — those the reader dropped in SQL PLUS any
     * this module dropped defensively. Both terms are required: reporting only the reader's
     * count while also filtering here makes this module's own drops vanish from its coverage,
     * so a payload could state that nothing was excluded while a denominator silently shrank.
     */
    observationsExcluded: number;
    /** Of those, how many were closed at all. */
    closedItems: number;
    /**
     * Closed items with NO ledger row — invisible to this measure in both directions. A large
     * value caps how strongly `escapesPerThousand` may be read.
     */
    closedItemsOutsideLedgerReach: number;
    graceMs: number;
  };
  notDerivable: readonly { measure: string; reason: string }[];
  bounded: {
    itemLimit: number;
    truncatedByItemLimit: boolean;
    countsAreFloor: boolean;
  };
}

export interface SpecEnforcementEscapeLedger {
  rows: EscapeRow[];
  rollup: SpecEnforcementEscapeRollup;
}

export interface SpecEnforcementEscapeDeps {
  listWorkItemLifecycle?: (input: {
    harnessSlug?: string;
    limit: number;
  }) => Promise<WorkItemLifecycleRead>;
  listWonClaims?: (input: {
    harnessSlug?: string;
    workItemIds: string[];
  }) => Promise<FirstClaimRow[]>;
  listPlanAdoption?: (input: { harnessSlug?: string; limit: number }) => Promise<PlanAdoptionRow[]>;
}

export const ESCAPE_NOT_DERIVABLE: readonly { measure: string; reason: string }[] = [
  {
    measure: 'reopened-then-reclosed items',
    reason:
      'A point-in-time status signal (non-terminal row still carrying terminal_owner, which is ' +
      'never cleared on reopen) reads 0 across all 3,687 non-terminal items here while the ' +
      'append-only ledger shows 4 items reclaimed after close. It can only see an item still ' +
      'sitting in a reopened state at census time, so an item reopened and re-closed is ' +
      'invisible to it. This measure uses the ledger instead; escapes that left no claim row ' +
      'are still uncounted.',
  },
  {
    measure: 'defects filed later citing a closed item',
    reason:
      'The second escape shape P-013 names — a NEW defect filed against work already closed — ' +
      'needs a citation edge from the new item back to the closed one. No such edge is recorded ' +
      'at filing time, so it is not counted here rather than being approximated from prose.',
  },
] as const;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'resolved',
  'closed',
  'dropped',
  'deprecated',
  'passed',
]);

/** Exported so a caller can assert on the vocabulary rather than duplicating the literal set. */
export { TERMINAL_STATUSES as ESCAPE_TERMINAL_STATUSES };

export async function computeSpecEnforcementEscape(
  deps: SpecEnforcementEscapeDeps = {},
  opts: { harnessSlug?: string; itemLimit?: number; graceMs?: number } = {},
): Promise<SpecEnforcementEscapeLedger> {
  const itemLimit = opts.itemLimit ?? LATENCY_ITEM_LIMIT;
  const graceMs = opts.graceMs ?? ESCAPE_REWORK_GRACE_MS;
  const readItems = deps.listWorkItemLifecycle ?? listWorkItemLifecycle;
  const readClaims = deps.listWonClaims ?? listWonClaimEnvelope;
  const readPlans = deps.listPlanAdoption ?? defaultListPlanAdoption;

  const read = await readItems({ harnessSlug: opts.harnessSlug, limit: itemLimit });
  const truncatedByItemLimit = read.rows.length >= itemLimit;
  const claimable = read.rows.filter((r) => r.lane !== 'observation');

  const [claims, planRows] = await Promise.all([
    readClaims({ harnessSlug: opts.harnessSlug, workItemIds: claimable.map((r) => r.workItemId) }),
    readPlans({ harnessSlug: opts.harnessSlug, limit: LATENCY_PLAN_LIMIT }),
  ]);

  const claimByItem = new Map(claims.map((c) => [c.workItemId, c]));
  const eligibilityByPlan = new Map(
    planRows.map((p) => [
      p.planSlug,
      enforcementEligibility({
        status: p.status,
        clauseCount: p.clauseCount,
        legacyValSignal: p.legacyValSignal,
      }),
    ]),
  );

  const lanes: Record<EnforcementBucket, EscapeLane> = {
    enforced: { detectable: 0, escaped: 0 },
    'not-enforced': { detectable: 0, escaped: 0 },
    unattributed: { detectable: 0, escaped: 0 },
  };

  const rows: EscapeRow[] = [];
  let closedItems = 0;
  let closedItemsOutsideLedgerReach = 0;

  for (const wi of claimable) {
    if (wi.closedAtMs == null) continue;
    closedItems += 1;

    const claim = claimByItem.get(wi.workItemId);
    if (!claim) {
      // Closed, but the ledger cannot see it — so an escape here was never detectable. Counted
      // as coverage, deliberately NOT added to the denominator.
      closedItemsOutsideLedgerReach += 1;
      continue;
    }

    const eligibility = wi.sourcePlanSlug ? (eligibilityByPlan.get(wi.sourcePlanSlug) ?? null) : null;
    const bucket: EnforcementBucket =
      eligibility == null ? 'unattributed' : eligibility.enforcing ? 'enforced' : 'not-enforced';

    lanes[bucket].detectable += 1;

    const gapMs = claim.lastWonAtMs - wi.closedAtMs;
    if (gapMs > graceMs) {
      lanes[bucket].escaped += 1;
      rows.push({
        workItemId: wi.workItemId,
        planSlug: wi.sourcePlanSlug,
        bucket,
        closedAtMs: wi.closedAtMs,
        reclaimedAtMs: claim.lastWonAtMs,
        gapMs,
      });
    }
  }

  const detectableItems =
    lanes.enforced.detectable + lanes['not-enforced'].detectable + lanes.unattributed.detectable;
  const escapedItems = lanes.enforced.escaped + lanes['not-enforced'].escaped + lanes.unattributed.escaped;

  return {
    rows,
    rollup: {
      detectableItems,
      escapedItems,
      escapesPerThousand:
        detectableItems === 0 ? null : (escapedItems / detectableItems) * 1000,
      byEnforcement: lanes,
      coverage: {
        itemsRead: read.rows.length,
        observationsExcluded: read.observationsExcluded + (read.rows.length - claimable.length),
        closedItems,
        closedItemsOutsideLedgerReach,
        graceMs,
      },
      notDerivable: ESCAPE_NOT_DERIVABLE,
      bounded: {
        itemLimit,
        truncatedByItemLimit,
        countsAreFloor: truncatedByItemLimit,
      },
    },
  };
}
