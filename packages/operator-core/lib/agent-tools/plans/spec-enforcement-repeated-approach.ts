/**
 * P-013 instrumentation, measure 4 — REPEATED FAILED WORK on the work-item axis.
 *
 * Completes the work-item trio: measure 6 (`spec-enforcement-latency.ts`) asks how long work
 * takes, measure 7 (`spec-enforcement-escape.ts`) asks whether it came back after being closed,
 * and this asks the question the prior-attempt brief exists to answer — when work is picked up
 * again after a failed attempt, does it fail AGAIN?
 *
 * ## Relationship to the EXISTING rework measure — read this before adding another rate
 *
 * `pot-eval/efficiency-metrics.ts` already computes **`reworkRate`** = (validator bounces +
 * re-placements + abandoned claims) ÷ completedItems. This measure is a RELATIVE of it, not a
 * rival, and the two are deliberately named apart:
 *
 *   - `reworkRate` is scoped to ONE pot-eval run's telemetry and counts every re-placement.
 *   - This is scoped to the WORK-ITEM CORPUS over the append-only claim ledger, and counts only
 *     the narrower event: a re-attempt that ITSELF failed. A single hand-off that then succeeds
 *     is rework, but it is not a repeated failure.
 *
 * Two correct numbers under unrelated names read as rivals, so the narrowing is stated here
 * rather than left for a reader to infer.
 *
 * ## What is measured, precisely
 *
 * Over an item's ordered won claims `c1..cn` (append-only, so a reclaim ADDS a row):
 *
 *   - `c2..cn` are RE-ATTEMPTS — a claim that followed a prior claim (`n - 1` of them).
 *   - A claim FAILED when another claim follows it: it did not carry the item to done. So
 *     `c1..c(n-1)` failed.
 *   - A REPEATED failure is therefore a re-attempt that also failed — `c2..c(n-1)`, i.e.
 *     `n - 2` of them.
 *
 * The denominator is `reattempts`, not the corpus: a repeat can only be OBSERVED where a
 * re-attempt happened at all. Counting never-re-attempted items as clean observations would let
 * ledger coverage masquerade as quality — the same denominator discipline as measure 7.
 *
 * ## The D-003 pairing — why this metric must never be read alone
 *
 * A favourable metric in isolation games, so `reworkRate`'s own module pairs every win with the
 * failure that must stay low to credit it. This one has a specific and dangerous gaming mode:
 * **the repeated-failure rate improves if agents leave LESS behind.** Nothing can be repeated
 * from a record that was never written, and an item whose prior holder left no note is
 * byte-indistinguishable from one never started.
 *
 * The pair is therefore `unbriefableReattemptedItems` — re-attempted items with NO durable
 * carry-note for the next claimant to read. `work-item-prior-work.ts` names this exact shape as
 * the dangerous one ("prior work WITHOUT a checkpoint … nothing else on the row hints that the
 * item has a history"), and Stage 2's `enrichmentDelivery` is its per-claim counterpart. A low
 * repeated-failure rate over a high unbriefable rate is luck, not the brief working.
 *
 * ## Why the ledger, and not `work_items.attempts`
 *
 * The row's own claim columns are overwritten or nulled by the very transitions being counted:
 * release and completion run `SET taken_by = NULL, taken_at = NULL`, which is why `taken_at`
 * survives on only 41 of 35,593 non-observation items here. `harness_shared.claim_audit` is
 * append-only, so it is the only source where an attempt SURVIVES the attempt ending.
 */
import type { MetricPairing } from '../../pot-eval/efficiency-metrics';
import { workItemCheckpointScope } from '../../work-item-checkpoint';
import type { EnforcementBucket, FirstClaimRow, WorkItemLifecycleRead } from './spec-enforcement-latency';
import { listWonClaimEnvelope, listWorkItemLifecycle, LATENCY_ITEM_LIMIT, LATENCY_PLAN_LIMIT } from './spec-enforcement-latency';
import { defaultListPlanAdoption } from './spec-reconciliation';
import { enforcementEligibility, type PlanAdoptionRow } from './spec-enforcement-eligibility';

export interface RepeatedApproachRow {
  workItemId: string;
  planSlug: string | null;
  bucket: EnforcementBucket;
  /** Won claims on this item — the attempt count. */
  attempts: number;
  /** Claims that followed a prior claim (`attempts - 1`). */
  reattempts: number;
  /** Re-attempts that themselves failed (`attempts - 2`). */
  repeatedFailures: number;
  distinctClaimants: number;
  /** No durable carry-note existed for the next claimant to read — the paired failure. */
  unbriefable: boolean;
}

export interface RepeatedApproachLane {
  /** Items where a re-attempt was OBSERVABLE at all — i.e. carrying a ledger row. */
  detectableItems: number;
  /** Of those, items actually re-attempted (more than one won claim). */
  reattemptedItems: number;
  /** Re-attempt EVENTS, not items: won claims that followed a prior won claim. */
  reattempts: number;
  /** Re-attempts that themselves failed. The numerator. */
  repeatedFailures: number;
  /** Re-attempted items whose prior attempt left NO durable note. The D-003 pair. */
  unbriefableReattemptedItems: number;
  /** Re-attempted items where every attempt was by the SAME claimant. */
  sameClaimantReattemptedItems: number;
}

export interface SpecEnforcementRepeatedApproachRollup {
  /** The population where a repeat was detectable: items carrying a won claim. NOT the corpus. */
  detectableItems: number;
  reattemptedItems: number;
  reattempts: number;
  repeatedFailures: number;
  /**
   * Repeated failures per thousand RE-ATTEMPTS. Null when nothing was re-attempted — an
   * unmeasured rate, never a clean 0. The denominator travels with it because a round rate over
   * a small denominator is a definitional artifact far more often than a real distribution.
   */
  repeatedFailuresPerThousand: number | null;
  unbriefableReattemptedItems: number;
  /** Per thousand RE-ATTEMPTED ITEMS. Null when nothing was re-attempted. */
  unbriefablePerThousand: number | null;
  /**
   * Re-attempted items where every attempt was by the same claimant. Reported apart because a
   * self-reclaim (a compaction, a crash, a resumed loop) is a materially different event from a
   * hand-off to a fresh agent, which is the case the prior-attempt brief exists to serve.
   */
  sameClaimantReattemptedItems: number;
  /** The longest attempt chain observed — a floor-level check that the ledger is being read. */
  deepestChain: number;
  byEnforcement: Record<EnforcementBucket, RepeatedApproachLane>;
  /**
   * The D-003 coupling, in the SAME shape `pot-eval/efficiency-metrics.ts` uses, so a scorer can
   * consume it without learning a second vocabulary.
   *
   * `metric` is 0 when the rate is UNMEASURED (no re-attempts) — the established convention from
   * that module's `roundTrip` pairing, whose `metric` is likewise 0 when unmeasured. Read
   * `repeatedFailuresPerThousand` instead when the distinction matters: it is null, not 0.
   */
  pairing: MetricPairing;
  coverage: {
    /** EVERY row the reader returned, observations included — the read's own size. */
    itemsRead: number;
    /**
     * Turn-end notes excluded before measurement — those the reader dropped in SQL PLUS any
     * this module dropped defensively. Both terms are required: this module filters
     * `lane = 'observation'` itself, so reporting only the reader's count made its own drops
     * invisible — a payload could state that four were excluded while five left the
     * denominator. The latency rollup has always summed both; this now matches it, so the
     * three blocks of one payload answer the question the same way.
     */
    observationsExcluded: number;
    /** Items with no ledger row — invisible to this measure in both directions. */
    itemsOutsideLedgerReach: number;
  };
  notDerivable: readonly { measure: string; reason: string }[];
  bounded: {
    itemLimit: number;
    truncatedByItemLimit: boolean;
    countsAreFloor: boolean;
  };
}

export interface SpecEnforcementRepeatedApproachLedger {
  rows: RepeatedApproachRow[];
  rollup: SpecEnforcementRepeatedApproachRollup;
}

export interface SpecEnforcementRepeatedApproachDeps {
  listWorkItemLifecycle?: (input: { harnessSlug?: string; limit: number }) => Promise<WorkItemLifecycleRead>;
  listWonClaims?: (input: { harnessSlug?: string; workItemIds: string[] }) => Promise<FirstClaimRow[]>;
  /** Returns the subset of `workItemIds` that carry a non-empty durable carry-note. */
  listCheckpointedItems?: (input: { harnessSlug?: string; workItemIds: string[] }) => Promise<string[]>;
  listPlanAdoption?: (input: { harnessSlug?: string; limit: number }) => Promise<PlanAdoptionRow[]>;
}

export const REPEATED_APPROACH_NOT_DERIVABLE: readonly { measure: string; reason: string }[] = [
  {
    measure: 'whether the SAME approach was retried',
    reason:
      'P-013 names this measure "repeated failed APPROACH rate", but approach identity is not ' +
      'recoverable from any store. claim_audit.detail carries the CLAIM SPEC ' +
      '({source, specId, revision}), not what was attempted; a work-item checkpoint is a single ' +
      'carry_notes row overwritten in place, so only the LAST note survives; and an ordinary ' +
      'release writes no audit_log row at all (only work_items:release:force does). What is ' +
      'reported is therefore that the work FAILED AGAIN, under that name — not that the same ' +
      'approach was tried twice. Two agents can fail one item in two entirely different ways.',
  },
  {
    measure: 'attempts predating the claim ledger',
    reason:
      'harness_shared.claim_audit begins 2026-07-26. An item worked before that carries no ' +
      'attempt rows, so its earlier failures are uncounted rather than counted as clean.',
  },
  {
    measure: 'the final attempt in a chain',
    reason:
      'An attempt is judged failed by a LATER claim following it, so the most recent attempt is ' +
      'never counted as a repeated failure even when it has plainly stalled. The rate is a floor ' +
      'by construction, deliberately: inferring failure from an absence of progress would ' +
      'manufacture defects out of work still in flight.',
  },
  {
    measure: 'an attempt that ended without a claim row',
    reason:
      'A hard kill or an OOM can end an attempt without any release being recorded. Such an ' +
      'attempt is invisible here, which biases the measure DOWN, never up.',
  },
] as const;

function emptyLane(): RepeatedApproachLane {
  return {
    detectableItems: 0,
    reattemptedItems: 0,
    reattempts: 0,
    repeatedFailures: 0,
    unbriefableReattemptedItems: 0,
    sameClaimantReattemptedItems: 0,
  };
}

const WORKITEM_SCOPE_PREFIX = 'workitem:';

/**
 * Recover the work-item id from a carry-note scope, IGNORING the harness component.
 *
 * A checkpoint keys under `workitem:<harness>:<id>`, where `<harness>` is whatever the WRITING
 * session resolved — the harness slug, or the `*` wildcard when it had none. Measured here:
 * 3,370 notes under `papercusp`, 427 under `*`, and a long tail under other slugs. Matching only
 * the harness-qualified key misses the rest and reports those items as un-briefed, which
 * INFLATES the paired failure — measured at 1 re-attempted item, small but wrong in the
 * direction that makes the system look worse than it is.
 *
 * Ignoring the harness component is safe for exactly the reason `work-item-checkpoint.ts` gives
 * for collapsing it onto a sentinel in the first place: "The work-item id is unique within the
 * workspace, so collapsing the harness component onto a single sentinel never collides." This is
 * that same invariant, read rather than written. {@link checkpointScopeRoundTripsToItemId} pins
 * the two together so a change to the scope FORMAT cannot silently strand this parser.
 */
export function itemIdFromCheckpointScope(scope: string): string | null {
  if (!scope.startsWith(WORKITEM_SCOPE_PREFIX)) return null;
  const rest = scope.slice(WORKITEM_SCOPE_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator < 0) return null;
  const id = rest.slice(separator + 1);
  return id.length > 0 ? id : null;
}

/**
 * Falsifiability seam, exported for the test rather than asserted in prose: the canonical scope
 * BUILDER and this parser must agree. If `workItemCheckpointScope` ever changes shape, this
 * returns false and the test fails, instead of the parser silently returning null for every row
 * and reporting a comfortable "nothing is briefable".
 */
export function checkpointScopeRoundTripsToItemId(harness: string | null, workItemId: string): boolean {
  return itemIdFromCheckpointScope(workItemCheckpointScope(harness, workItemId)) === workItemId;
}

/**
 * Which items carry a durable carry-note.
 *
 * Reads the workspace's work-item notes ONCE (a few thousand rows) and intersects in memory,
 * rather than sending one key per candidate item — the candidate set is the whole corpus here,
 * and the note population is three orders of magnitude smaller.
 */
async function defaultListCheckpointedItems(input: {
  harnessSlug?: string;
  workItemIds: string[];
}): Promise<string[]> {
  if (input.workItemIds.length === 0) return [];
  const { resolvePlanScope } = await import('./source');
  const { withWorkspace } = await import('@papercusp/db-org');
  const scope = await resolvePlanScope({ harnessSlug: input.harnessSlug });

  const rows = await withWorkspace(
    scope.workspaceId,
    async (tx) => tx<{ scope: string }[]>`
      SELECT c.scope
        FROM harness_shared.carry_notes c
       WHERE c.workspace_id = ${scope.workspaceId}
         AND c.scope LIKE 'workitem:%'
         AND coalesce(btrim(c.note), '') <> ''
    `,
  );

  const noted = new Set<string>();
  for (const r of rows) {
    const id = itemIdFromCheckpointScope(r.scope);
    if (id) noted.add(id);
  }
  return input.workItemIds.filter((id) => noted.has(id));
}

export { defaultListCheckpointedItems as listCheckpointedItems };

/**
 * Compute the repeated-failure rate partitioned by enforcement eligibility.
 *
 * Deps are injected so this is testable without a database, and so the reader types — not an
 * incidental SQL projection — define the fields this computation may read.
 */
export async function computeSpecEnforcementRepeatedApproach(
  deps: SpecEnforcementRepeatedApproachDeps = {},
  opts: { harnessSlug?: string; itemLimit?: number } = {},
): Promise<SpecEnforcementRepeatedApproachLedger> {
  const itemLimit = opts.itemLimit ?? LATENCY_ITEM_LIMIT;
  const readItems = deps.listWorkItemLifecycle ?? listWorkItemLifecycle;
  const readClaims = deps.listWonClaims ?? listWonClaimEnvelope;
  const readNotes = deps.listCheckpointedItems ?? defaultListCheckpointedItems;
  const readPlans = deps.listPlanAdoption ?? defaultListPlanAdoption;

  const read = await readItems({ harnessSlug: opts.harnessSlug, limit: itemLimit });
  const truncatedByItemLimit = read.rows.length >= itemLimit;
  const claimable = read.rows.filter((r) => r.lane !== 'observation');
  const ids = claimable.map((r) => r.workItemId);

  const [claims, planRows, checkpointed] = await Promise.all([
    readClaims({ harnessSlug: opts.harnessSlug, workItemIds: ids }),
    readPlans({ harnessSlug: opts.harnessSlug, limit: LATENCY_PLAN_LIMIT }),
    readNotes({ harnessSlug: opts.harnessSlug, workItemIds: ids }),
  ]);

  const claimByItem = new Map(claims.map((c) => [c.workItemId, c]));
  const hasNote = new Set(checkpointed);
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

  const lanes: Record<EnforcementBucket, RepeatedApproachLane> = {
    enforced: emptyLane(),
    'not-enforced': emptyLane(),
    unattributed: emptyLane(),
  };

  const rows: RepeatedApproachRow[] = [];
  let itemsOutsideLedgerReach = 0;
  let deepestChain = 0;

  for (const wi of claimable) {
    const claim = claimByItem.get(wi.workItemId);
    if (!claim) {
      // No ledger row, so a repeat here was never detectable. Counted as coverage and
      // deliberately kept OUT of the denominator.
      itemsOutsideLedgerReach += 1;
      continue;
    }

    const eligibility = wi.sourcePlanSlug ? (eligibilityByPlan.get(wi.sourcePlanSlug) ?? null) : null;
    const bucket: EnforcementBucket =
      eligibility == null ? 'unattributed' : eligibility.enforcing ? 'enforced' : 'not-enforced';
    const lane = lanes[bucket];

    const attempts = claim.wonClaimCount;
    const reattempts = Math.max(attempts - 1, 0);
    const repeatedFailures = Math.max(attempts - 2, 0);

    lane.detectableItems += 1;
    lane.reattempts += reattempts;
    lane.repeatedFailures += repeatedFailures;
    if (attempts > deepestChain) deepestChain = attempts;

    if (attempts > 1) {
      const unbriefable = !hasNote.has(wi.workItemId);
      lane.reattemptedItems += 1;
      if (unbriefable) lane.unbriefableReattemptedItems += 1;
      if (claim.distinctClaimants <= 1) lane.sameClaimantReattemptedItems += 1;

      if (repeatedFailures > 0) {
        rows.push({
          workItemId: wi.workItemId,
          planSlug: wi.sourcePlanSlug,
          bucket,
          attempts,
          reattempts,
          repeatedFailures,
          distinctClaimants: claim.distinctClaimants,
          unbriefable,
        });
      }
    }
  }

  const all = [lanes.enforced, lanes['not-enforced'], lanes.unattributed];
  const sum = (pick: (l: RepeatedApproachLane) => number) => all.reduce((acc, l) => acc + pick(l), 0);

  const detectableItems = sum((l) => l.detectableItems);
  const reattemptedItems = sum((l) => l.reattemptedItems);
  const reattempts = sum((l) => l.reattempts);
  const repeatedFailures = sum((l) => l.repeatedFailures);
  const unbriefableReattemptedItems = sum((l) => l.unbriefableReattemptedItems);
  const sameClaimantReattemptedItems = sum((l) => l.sameClaimantReattemptedItems);

  const repeatedFailuresPerThousand = reattempts === 0 ? null : (repeatedFailures / reattempts) * 1000;
  const unbriefablePerThousand =
    reattemptedItems === 0 ? null : (unbriefableReattemptedItems / reattemptedItems) * 1000;

  return {
    rows,
    rollup: {
      detectableItems,
      reattemptedItems,
      reattempts,
      repeatedFailures,
      repeatedFailuresPerThousand,
      unbriefableReattemptedItems,
      unbriefablePerThousand,
      sameClaimantReattemptedItems,
      deepestChain,
      byEnforcement: lanes,
      pairing: {
        metric: repeatedFailuresPerThousand ?? 0,
        pairedFailure: unbriefablePerThousand ?? 0,
        pairName: 'unbriefableReattemptRate',
      },
      coverage: {
        itemsRead: read.rows.length,
        observationsExcluded: read.observationsExcluded + (read.rows.length - claimable.length),
        itemsOutsideLedgerReach,
      },
      notDerivable: REPEATED_APPROACH_NOT_DERIVABLE,
      bounded: {
        itemLimit,
        truncatedByItemLimit,
        countsAreFloor: truncatedByItemLimit,
      },
    },
  };
}
