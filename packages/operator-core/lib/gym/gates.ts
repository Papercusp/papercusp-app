/**
 * Accept gates (P-009) — the pure predicates the loop's accept/reject engine
 * (P-018) combines. A candidate is accepted iff ALL gates hold:
 *
 *   improvement · dev-anchor-no-regress · real-anchor-no-regress ·
 *   no-new-regressions · probe-caught · cost
 *
 * The judge composite is the reward; deterministic `regressions` + `planted_bug_caught`
 * are un-gameable guardrails. Pass-count is deliberately NOT a gate — the validator
 * is mutable and pass-count is gameable, so it stays observability only (D-011).
 *
 * `real-anchor-no-regress` (gym-real-fitness-signal-2026-07-27 P-002, owner ruling
 * D-004 condition 3: "a challenger may not be installed into harness_prompt_overrides
 * unless it holds the real-anchor pool"). The real-anchor pool is a set of REAL shipped
 * features replayed at their pre-implementation commit; before this gate existed it was
 * scored every cycle and then excluded from every aggregate, so a candidate could clear
 * every gate — win on train, hold the dev-anchor — while getting measurably WORSE at
 * real work, and be installed into the live prompt table on that basis. It is deliberately
 * fail-closed: an unmeasured real-anchor is `not-measured`, so a run that never exercised
 * the pool yields an INCONCLUSIVE verdict and promotes nothing. D-004 states the same
 * consequence in words — "until then promotion stays OFF even if cycles run in shadow".
 *
 * Thresholds (ε, δ, cost ceiling) are NOT guessed: ε/δ are derived from measured
 * judge variance at P-014; they are passed in here.
 *
 * The gate POLICY is a declarative `@papercusp/rules` table
 * (adopt-event-rules-engines D-003): each gate is a `DataCondition` over a
 * normalized `GateFacts`. The engine's operators test a value against a constant,
 * and these thresholds are *relative* (parent+ε, champion−δ, baseline×ceiling), so
 * the consumer folds each relative threshold into a pre-computed **margin**
 * (actual − threshold) the rule tests with `{ gte: 0 }`; the deterministic gates
 * test their evidence's STATUS directly. The pass/fail structure is now
 * inspectable data; only the human-readable `detail` stays imperative.
 *
 * P-003 — the deterministic guardrails are THREE-STATE, not boolean. A boolean
 * cannot distinguish "the run reported no regressions" from "the run never
 * reported the signal at all", so an un-collected guardrail read as a PASS and
 * a candidate could be promoted on evidence nobody gathered. Every deterministic
 * gate therefore consumes a `DeterministicEvidence` carrying its own status plus
 * the task coverage and trace artifacts that back it, and missing required
 * evidence resolves to `not-measured` → an INCONCLUSIVE verdict (never accept,
 * and never a reject either — nothing was measured, so nothing was disproved).
 */

import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';

/**
 * A deterministic gate's outcome. `not-measured` is a first-class result, NOT a
 * flavour of failure: it means the evidence required to judge this gate was never
 * collected, so neither accept nor reject is warranted.
 */
export type GateStatus = 'pass' | 'fail' | 'not-measured';

/**
 * One deterministic guardrail's evidence, with the provenance needed to audit it.
 *
 * `coverage` is what makes `not-measured` checkable rather than asserted: a signal
 * is only measured when every task that owes it actually reported it, and the tasks
 * that did not are named so a reader can go look. `artifacts` are the trace refs of
 * the runs that produced the evidence — the audit trail from verdict back to run.
 */
export interface DeterministicEvidence {
  status: GateStatus;
  /** Which tasks owed this signal, and how many actually reported it. */
  coverage: {
    /** Tasks that reported the signal on every repeat. */
    measured: number;
    /** Tasks that owed the signal. `0` required ⇒ nothing was measured, never a vacuous pass. */
    required: number;
    /** Tasks that owed the signal and did not report it on at least one repeat. */
    unmeasuredTaskIds: readonly string[];
  };
  /** Trace refs for the runs backing this evidence. */
  artifacts: readonly string[];
}

/**
 * Roll per-task statuses into one signal-level status.
 *
 * Precedence is deliberate: an observed FAIL outranks a gap, because a proven
 * regression is decisive evidence and must not be softened to "inconclusive" just
 * because a sibling task went unreported. Absent any fail, ANY gap (including the
 * zero-task case) is `not-measured` — the vacuous-pass hole P-003 closes.
 */
export function rollUpEvidenceStatus(perTask: readonly GateStatus[]): GateStatus {
  if (perTask.some((s) => s === 'fail')) return 'fail';
  if (perTask.length === 0 || perTask.some((s) => s === 'not-measured')) return 'not-measured';
  return 'pass';
}

/**
 * Fold the two sides of an anchor COMPARISON into one evidence record (P-002).
 *
 * A no-regression claim needs BOTH sides: a candidate's real-anchor aggregate says
 * nothing unless the incumbent it is compared against was measured on the same pool.
 * So a gap on EITHER side makes the comparison `not-measured` — never a pass (the
 * vacuous-pass hole P-003 closed for probes), and never a reject the candidate did
 * not earn. Coverage and artifacts are summed because the comparison genuinely owes
 * both sides' tasks; `rollUpEvidenceStatus` keeps a measured FAIL decisive.
 */
export function comparisonEvidence(
  candidate: DeterministicEvidence,
  incumbent: DeterministicEvidence,
): DeterministicEvidence {
  return {
    status: rollUpEvidenceStatus([candidate.status, incumbent.status]),
    coverage: {
      measured: candidate.coverage.measured + incumbent.coverage.measured,
      required: candidate.coverage.required + incumbent.coverage.required,
      unmeasuredTaskIds: [...candidate.coverage.unmeasuredTaskIds, ...incumbent.coverage.unmeasuredTaskIds],
    },
    artifacts: [...candidate.artifacts, ...incumbent.artifacts],
  };
}

/** Evidence for a signal nothing reported — the honest default when collection did not happen. */
export function unmeasuredEvidence(unmeasuredTaskIds: readonly string[] = []): DeterministicEvidence {
  return {
    status: 'not-measured',
    coverage: { measured: 0, required: unmeasuredTaskIds.length, unmeasuredTaskIds },
    artifacts: [],
  };
}

export interface GateInputs {
  /** Candidate's aggregate judge composite on the train pool (the reward). */
  candidateJudgeAgg: number;
  /** Parent's aggregate judge composite on the train pool. */
  parentJudgeAgg: number;
  /** Minimum train improvement margin (variance-derived, P-014). */
  epsilon: number;
  /** Candidate's aggregate on the FROZEN dev-anchor (apples-to-apples). */
  candidateDevAnchorAgg: number;
  /** Champion's aggregate on the frozen dev-anchor. */
  championDevAnchorAgg: number;
  /**
   * Allowed anchor regression slack (variance-derived, P-014). Shared by BOTH anchor
   * gates: dev-anchor and real-anchor are the same judge scoring the same rubric on a
   * held-out pool, so the same measured judge variance bounds both. A separate
   * real-anchor slack would be a second threshold asserting a variance nobody measured.
   */
  delta: number;
  /** Candidate's aggregate judge composite on the `real-anchor` pool (real shipped features). */
  candidateRealAnchorAgg: number;
  /** Champion's aggregate on the same real-anchor pool — the incumbent this is compared against. */
  championRealAnchorAgg: number;
  /**
   * Was the real-anchor comparison actually measured, on BOTH sides? Coverage-only
   * evidence (P-002): it never reports `fail` — a real regression is the margin's job —
   * it reports whether there is anything to compare at all. A run with no real-anchor
   * tasks is `not-measured`, exactly as a run with no probes is, and promotes nothing.
   */
  realAnchorEvidence: DeterministicEvidence;
  /** Did any candidate run break the repo's pre-existing tests? Three-state (P-003). */
  regressionEvidence: DeterministicEvidence;
  /** Were all planted bugs (probe runs) caught? Three-state (P-003). */
  probeEvidence: DeterministicEvidence;
  /** Candidate's mean cost per run. */
  candidateMeanCost: number;
  /** Baseline's mean cost per run. */
  baselineMeanCost: number;
  /** Cost guardrail multiplier (mean ≤ baseline × ceiling). */
  costCeiling: number;
}

export interface GateResult {
  gate: string;
  /**
   * DERIVED — `status === 'pass'`, never assigned independently. Kept because every
   * consumer that only asks "did this gate hold?" stays correct through the
   * three-state change: a `not-measured` gate is not a pass, so an accept path
   * reading this field alone remains fail-closed.
   */
  pass: boolean;
  /** The three-state outcome. Read THIS to tell a gap apart from a failure. */
  status: GateStatus;
  detail: string;
  /** Coverage + artifacts, present on gates backed by deterministic evidence. */
  evidence?: DeterministicEvidence;
}

export interface GatesVerdict {
  /** DERIVED — `outcome === 'accept'`. An inconclusive verdict is not an accept. */
  accept: boolean;
  /**
   * Three-state: `inconclusive` when any gate is `not-measured`, so a candidate is
   * never promoted on evidence nobody collected — and never recorded as REJECTED
   * on it either, which would libel a candidate that was simply not measured.
   */
  outcome: 'accept' | 'reject' | 'inconclusive';
  results: GateResult[];
}

/** Normalized facts the declarative gate conditions test (relative thresholds folded into margins). */
interface GateFacts {
  /** candidateJudgeAgg − (parentJudgeAgg + ε); ≥ 0 ⇔ the improvement gate holds. */
  improvementMargin: number;
  /** candidateDevAnchorAgg − (championDevAnchorAgg − δ); ≥ 0 ⇔ no dev-anchor regression. */
  devAnchorMargin: number;
  /** candidateRealAnchorAgg − (championRealAnchorAgg − δ); ≥ 0 ⇔ no real-anchor regression. */
  realAnchorMargin: number;
  regressionStatus: GateStatus;
  probeStatus: GateStatus;
  /** baselineMeanCost × ceiling − candidateMeanCost; ≥ 0 ⇔ within the cost ceiling. */
  costMargin: number;
}

/** How a task-coverage summary reads in a gate's human-readable detail. */
function coverageDetail(e: DeterministicEvidence): string {
  const unmeasured = e.coverage.unmeasuredTaskIds.length
    ? `; unmeasured: ${e.coverage.unmeasuredTaskIds.join(', ')}`
    : '';
  return `${e.coverage.measured}/${e.coverage.required} tasks measured, ${e.artifacts.length} artifact(s)${unmeasured}`;
}

/**
 * The accept-gate policy: each gate's `cond` is a serializable `DataCondition`; `detail`
 * is the human trail. `evidence` marks the deterministic gates — those carry a three-state
 * status straight from their evidence rather than collapsing to the condition's boolean,
 * which is what lets `not-measured` survive all the way to the verdict.
 */
const GATE_RULES: {
  gate: string;
  cond: DataCondition;
  detail: (g: GateInputs) => string;
  evidence?: (g: GateInputs) => DeterministicEvidence;
}[] = [
  {
    gate: 'improvement',
    cond: { improvementMargin: { gte: 0 } },
    detail: (g) => `train ${g.candidateJudgeAgg.toFixed(3)} vs parent ${g.parentJudgeAgg.toFixed(3)} + ε ${g.epsilon}`,
  },
  {
    gate: 'dev-anchor-no-regress',
    cond: { devAnchorMargin: { gte: 0 } },
    detail: (g) => `dev-anchor ${g.candidateDevAnchorAgg.toFixed(3)} vs champion ${g.championDevAnchorAgg.toFixed(3)} − δ ${g.delta}`,
  },
  {
    // P-002 / D-004(3). Coverage evidence gates the comparison; the margin decides it.
    gate: 'real-anchor-no-regress',
    cond: { realAnchorMargin: { gte: 0 } },
    evidence: (g) => g.realAnchorEvidence,
    detail: (g) =>
      g.realAnchorEvidence.status === 'pass'
        ? `real-anchor ${g.candidateRealAnchorAgg.toFixed(3)} vs champion ${g.championRealAnchorAgg.toFixed(3)} − δ ${g.delta} (${coverageDetail(g.realAnchorEvidence)})`
        : `real-anchor NOT MEASURED — no comparable real-anchor score for this candidate and the champion, so a real-work regression could not be ruled out (${coverageDetail(g.realAnchorEvidence)})`,
  },
  {
    gate: 'no-new-regressions',
    cond: { regressionStatus: { equals: 'pass' } },
    evidence: (g) => g.regressionEvidence,
    detail: (g) => {
      const head =
        g.regressionEvidence.status === 'fail'
          ? 'a candidate run broke pre-existing tests'
          : g.regressionEvidence.status === 'pass'
            ? 'no new regressions'
            : 'regression signal NOT MEASURED — no candidate run reported it';
      return `${head} (${coverageDetail(g.regressionEvidence)})`;
    },
  },
  {
    gate: 'probe-caught',
    cond: { probeStatus: { equals: 'pass' } },
    evidence: (g) => g.probeEvidence,
    detail: (g) => {
      const head =
        g.probeEvidence.status === 'fail'
          ? 'a planted bug was missed'
          : g.probeEvidence.status === 'pass'
            ? 'all planted bugs caught'
            : g.probeEvidence.coverage.required === 0
              ? 'probe signal NOT MEASURED — the candidate ran against no probe tasks'
              : 'probe signal NOT MEASURED — a probe run did not report planted_bug_caught';
      return `${head} (${coverageDetail(g.probeEvidence)})`;
    },
  },
  {
    gate: 'cost',
    cond: { costMargin: { gte: 0 } },
    detail: (g) => `mean ${g.candidateMeanCost.toFixed(3)} vs baseline ${g.baselineMeanCost.toFixed(3)} × ${g.costCeiling}`,
  },
];

function gateFacts(g: GateInputs): GateFacts {
  return {
    improvementMargin: g.candidateJudgeAgg - (g.parentJudgeAgg + g.epsilon),
    devAnchorMargin: g.candidateDevAnchorAgg - (g.championDevAnchorAgg - g.delta),
    realAnchorMargin: g.candidateRealAnchorAgg - (g.championRealAnchorAgg - g.delta),
    regressionStatus: g.regressionEvidence.status,
    probeStatus: g.probeEvidence.status,
    costMargin: g.baselineMeanCost * g.costCeiling - g.candidateMeanCost,
  };
}

export function evaluateGates(g: GateInputs): GatesVerdict {
  const facts = gateFacts(g);
  const results: GateResult[] = GATE_RULES.map((r) => {
    const evidence = r.evidence?.(g);
    // An evidence-backed gate reports a GAP (or a measured failure) straight from its
    // evidence, so `not-measured` reaches the verdict intact. Once the evidence says the
    // signal WAS collected, the gate's own condition decides pass/fail — which is what
    // lets coverage-only evidence ("was the real-anchor pool comparable at all?") sit in
    // front of a threshold comparison. For the two signal gates whose condition merely
    // re-reads their own evidence status (`regressionStatus`/`probeStatus` ARE that
    // status in `GateFacts`), evaluating the condition after a `pass` returns `pass`, so
    // this is byte-for-byte the previous behaviour — pinned by a test.
    // A threshold gate declares no evidence, so its condition IS its status.
    const status: GateStatus =
      evidence && evidence.status !== 'pass'
        ? evidence.status
        : evaluateDataCondition(r.cond, facts)
          ? 'pass'
          : 'fail';
    return {
      gate: r.gate,
      pass: status === 'pass',
      status,
      detail: r.detail(g),
      ...(evidence ? { evidence } : {}),
    };
  });
  // Missing evidence is inconclusive, not a rejection — but a real FAIL still rejects
  // even alongside a gap, because a failure that WAS measured is decisive.
  const outcome: GatesVerdict['outcome'] = results.some((r) => r.status === 'fail')
    ? 'reject'
    : results.some((r) => r.status === 'not-measured')
      ? 'inconclusive'
      : 'accept';
  return { accept: outcome === 'accept', outcome, results };
}
