/**
 * dispatch-adoption-falsifier.ts — the pre-committed retirement test for
 * `coord:dispatch`.
 *
 * Plan `coordination-spec-adoption-2026-08-03`, P-013 (D-100 armed it, D-101
 * corrected it from a COUNT to a RATE).
 *
 * THE CLAIM UNDER TEST. D-100 kept `coord:dispatch` — 1 call in 30 days, from 1
 * agent — on the theory that its disuse is DELIVERY, not absent demand: it never
 * reached a trimmed tool surface, and this repo's own bash-routing audit measured
 * ~85% adoption for the one tool CLAUDE.md pointed at against ~1% for equally
 * capable tools nobody was pointed at. That is a claim about cause, and a claim
 * about cause with no way to be wrong is worth less than either decision it was
 * choosing between. P-011 (seeding) + P-012 (the handles) are the intervention;
 * this is its falsifier.
 *
 * WHY A RATE, NOT A COUNT. The original commitment was "retire if under 10 calls
 * from under 3 agents in 30 days". That is an absolute count, and this fleet's
 * activity swings by an order of magnitude — the state-plane report that prompted
 * D-101 records its OWN measurement blocked because the fleet went idle. A quiet
 * month would therefore have fired RETIRE on a delivery fix that actually worked,
 * silently and in the wrong direction. So the metric is normalised against the
 * denominator that moves with fleet activity: **`coord:dispatch` calls per 1,000
 * `coord:send` calls.**
 *
 * `coord:send` is the right denominator because it is the same act one level
 * down — an agent deciding to address a specific peer. Directed hand-off failing
 * while conversation is enormous IS the finding D-100 flagged as bigger than the
 * verb decision (send 3,724 / 186 agents against dispatch 1 / 1 agent). Holding
 * that ratio fixed asks the only question that matters: when an agent turns to a
 * peer, how often is it to hand over work rather than to talk about it?
 *
 * ⚠ THE DENOMINATOR IS NAMED AND PUBLISHED, per this plan's own D-003 — a ratio
 * whose denominator is unstated is not an adoption metric, it is a number that
 * will be quoted as one. `evaluate()` therefore refuses to return a verdict when
 * the denominator is too small to carry one, rather than dividing by a handful of
 * calls and reporting a confident rate.
 */

/**
 * Measured 2026-08-09, all tenants: 1 dispatch / 3,724 sends.
 *
 * ⚠ `windowDays` READS 14, AND THAT IS A CORRECTION OF THE LABEL, NOT A MOVED
 * GOALPOST. This constant was first recorded as a 30-day window. It never was
 * one: `harness_shared.tool_invocations` is pruned to **14 days**
 * (`DEFAULT_RETENTION_TARGETS`, telemetry-retention-action.ts), so the query
 * that produced these numbers asked for 30 days and got every row that existed
 * — about 14. Verified 2026-08-09: `interval '30 days'` and the whole table
 * return the same span (oldest row 14d 6h old), and this same `coord:send`
 * count fell 3,724 -> 3,106 within five hours as the prune ran.
 *
 * The COUNTS below are exactly as measured and are unchanged; only the window
 * they are attributed to is corrected. Nothing downstream shifts: `windowDays`
 * feeds no computation here, and `ratePerThousand` is a ratio of two figures
 * from the same window, so it is unaffected either way. The pre-committed
 * {@link DISPATCH_ADOPTION_FLOOR} is deliberately untouched.
 *
 * Leaving it at 30 would have published a denominator the data never supported
 * — the precise failure this plan's D-003 exists to prevent, reintroduced by
 * the falsifier's own baseline.
 */
export const DISPATCH_BASELINE = {
  measuredAt: '2026-08-09',
  windowDays: 14,
  dispatchCalls: 1,
  dispatchAgents: 1,
  sendCalls: 3_724,
  sendAgents: 186,
  /** 0.2685 dispatches per 1,000 sends. */
  ratePerThousand: 0.2685,
} as const;

/**
 * The bar. Crossing it means the delivery theory survived; missing it means it
 * was wrong and `coord:dispatch` is retired alongside `coord:handoff` (D-102
 * deferred handoff into this same measurement, so ONE result decides both doors).
 *
 * 3 per 1,000 is ~11x the baseline and still modest in absolute terms — at the
 * measured send volume it is roughly 11 dispatches a month. It is deliberately
 * not ambitious: the question is whether the verb gets used AT ALL once it is
 * reachable and pre-addressed, not whether it becomes popular.
 *
 * The agent floor is what stops one enthusiast (or one loop) from carrying the
 * verdict — the same defect the raw count had.
 */
export const DISPATCH_ADOPTION_FLOOR = {
  ratePerThousand: 3.0,
  distinctAgents: 3,
  /** Do not judge on a window this thin — say UNDETERMINED instead. */
  minSendCalls: 500,
  /**
   * Earliest honest read: the interventions must be deployed for a full window.
   *
   * ⚠ MOVED 2026-09-08 -> 2026-09-16 ON 2026-09-02 (WI-2142095). This is the
   * SAME correction-of-the-label discipline as {@link DISPATCH_BASELINE}'s
   * window, NOT a moved goalpost — and the distinction is the whole point:
   * the BAR is untouched (`ratePerThousand` 3.0 and `distinctAgents` 3 are
   * pre-committed and stay exactly as agreed). What moved is this
   * PRECONDITION, whose contract is stated in the line above: deployed for a
   * FULL window.
   *
   * 2026-09-08 was chosen assuming both interventions landed together in late
   * August. P-012's handles did. P-011's seeding did NOT — `coord:dispatch`
   * sat only in the retired mug tier until it was seeded on 2026-09-02. A
   * 14-day window (`windowDays`) ending 2026-09-08 therefore spans 08-25 ->
   * 09-08, of which 8 of 14 days had the verb on no live surface at all.
   * Reading it then would divide real demand by a denominator that is mostly
   * pre-intervention and call the diluted result rejection — the exact
   * zero-call-count retirement this plan exists to prevent, reintroduced one
   * layer up from the gap it just fixed.
   *
   * 2026-09-02 + `windowDays` = 2026-09-16 is the first date on which the
   * window sits entirely after the intervention, which is what the contract
   * above already required. Note this guard is now load-bearing ALONE:
   * `DISPATCH_INTERVENTION_REACHABLE` flipped true the same day, so the
   * `!interventionReachable` branch below no longer fires and this date is the
   * only thing standing between a low rate and a `retire` verdict.
   */
  reEvaluateAfter: '2026-09-16',
} as const;

export interface DispatchAdoptionSample {
  dispatchCalls: number;
  dispatchAgents: number;
  sendCalls: number;
  windowDays: number;
  /** ISO date the sample was taken. */
  asOf: string;
  /**
   * Was the intervention under test actually REACHABLE by live agents across the
   * sampled window — i.e. did P-011 put `coord:dispatch` on a tool surface some
   * live role is seeded with?
   *
   * ⚠ REQUIRED ON PURPOSE, and deliberately NOT defaulted to `true`. This whole
   * falsifier asks whether disuse is DELIVERY or absent DEMAND; a sample that
   * cannot say whether the verb was even delivered cannot answer it. Defaulting
   * an unstated declaration to "reachable" would silently restore exactly the
   * conflation the field exists to prevent, so an omission must break the call
   * site and make someone measure it.
   */
  interventionReachable: boolean;
}

export type DispatchAdoptionVerdict =
  | {
      verdict: 'keep';
      ratePerThousand: number;
      liftVsBaseline: number;
      denominator: { sendCalls: number; windowDays: number };
      why: string;
    }
  | {
      verdict: 'retire';
      ratePerThousand: number;
      liftVsBaseline: number;
      denominator: { sendCalls: number; windowDays: number };
      why: string;
      alsoRetires: readonly string[];
      finding: string;
    }
  | {
      verdict: 'undetermined';
      denominator: { sendCalls: number; windowDays: number };
      why: string;
    };

/**
 * Judge a sample against the pre-committed bar. Pure.
 *
 * Note the asymmetry, which is deliberate: `undetermined` is returned whenever
 * the sample cannot carry a verdict, and is NEVER upgraded to `retire`. An
 * absent measurement must not read as absent demand — that conflation is the
 * exact error D-102 caught five times over in the retirement list this plan
 * started from.
 */
export function evaluateDispatchAdoption(
  sample: DispatchAdoptionSample,
  floor: typeof DISPATCH_ADOPTION_FLOOR = DISPATCH_ADOPTION_FLOOR,
): DispatchAdoptionVerdict {
  const denominator = { sendCalls: sample.sendCalls, windowDays: sample.windowDays };

  if (sample.sendCalls < floor.minSendCalls) {
    return {
      verdict: 'undetermined',
      denominator,
      why: `only ${sample.sendCalls} coord:send calls in ${sample.windowDays}d (floor ${floor.minSendCalls}) — the fleet was too quiet for this ratio to mean anything. Re-measure over a busier window; do NOT read this as evidence against coord:dispatch.`,
    };
  }
  if (sample.asOf < floor.reEvaluateAfter) {
    return {
      verdict: 'undetermined',
      denominator,
      why: `sampled ${sample.asOf}, before the agreed ${floor.reEvaluateAfter} — the seeding (P-011) and handles (P-012) need a full window in front of agents before their effect can be read.`,
    };
  }

  const rate = (sample.dispatchCalls / sample.sendCalls) * 1_000;
  const lift = rate / DISPATCH_BASELINE.ratePerThousand;
  const passRate = rate >= floor.ratePerThousand;
  const passAgents = sample.dispatchAgents >= floor.distinctAgents;

  if (passRate && passAgents) {
    return {
      verdict: 'keep',
      ratePerThousand: rate,
      liftVsBaseline: lift,
      denominator,
      why: `${rate.toFixed(2)}/1k sends across ${sample.dispatchAgents} agents — ${lift.toFixed(1)}x the ${DISPATCH_BASELINE.ratePerThousand}/1k baseline, clearing the ${floor.ratePerThousand}/1k + ${floor.distinctAgents}-agent bar. The delivery theory held: the verb was unreachable, not unwanted.`,
    };
  }

  // ⚠ THE RETIRE BRANCH ASSERTS ITS OWN PRECONDITION — check it before firing.
  //
  // The `why` below states, as settled fact, that `coord:dispatch` "was seeded
  // onto the live surface AND handed to agents pre-addressed". That sentence is
  // the entire warrant for reading a low rate as falsified DEMAND rather than
  // failed DELIVERY. Measured 2026-09-02 (WI-2142095), it was false: the verb is
  // seeded ONLY into QUEEN_MCP_TOOL_NAMES (invoke.ts:809), the retired mug tier,
  // so no live role could reach it — and the rate over such a window is an
  // artifact of the delivery gap, not a measurement of demand.
  //
  // Note this gates the DESTRUCTIVE direction only, mirroring the asymmetry
  // documented above: `undetermined` is never upgraded to `retire`, and now an
  // undelivered intervention is never downgraded to a falsified one. A passing
  // rate still returns `keep` — calls that happened are their own proof of
  // reachability, so the precondition cannot suppress a genuine survival.
  if (!sample.interventionReachable) {
    return {
      verdict: 'undetermined',
      denominator,
      why: `sampled over a window in which the intervention was NOT REACHABLE — coord:dispatch was not on any live role's seeded tool surface, so ${sample.dispatchCalls} call(s) measures the delivery gap, not demand. This is the falsifier's own premise failing, not a verdict against the verb: re-measure only after seeding actually lands (WI-2142095). Do NOT read this as evidence for retirement.`,
    };
  }

  const missed = [
    passRate ? null : `rate ${rate.toFixed(2)}/1k < ${floor.ratePerThousand}/1k`,
    passAgents ? null : `${sample.dispatchAgents} agent(s) < ${floor.distinctAgents}`,
  ]
    .filter(Boolean)
    .join('; ');

  return {
    verdict: 'retire',
    ratePerThousand: rate,
    liftVsBaseline: lift,
    denominator,
    why: `${missed}. coord:dispatch was seeded onto the live surface AND handed to agents pre-addressed inside coord:presence and plan_items:release, and still was not reached for. The delivery theory is FALSIFIED.`,
    alsoRetires: ['coord:dispatch', 'coord:handoff'],
    finding:
      'This fleet does not hand off lanes. Directed work-handoff was near-zero across EVERY door (dispatch 1, handoff 0, fleet:place_batch 1, coord:wake 18) while conversation was enormous (coord:send 3,724 / 186 agents). Having removed delivery as the explanation, what remains is a property of the coordination model — agents self-claim from the queue and talk about it — not a tooling gap. Record that and stop building handoff doors.',
  };
}
