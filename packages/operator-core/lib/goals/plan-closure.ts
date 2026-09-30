/**
 * plan-closure.ts — the ONE definition of "this delegated plan actually CLOSED"
 * (goal-agent-behavior-feedback-2026-09-06 P-026, decision D-012).
 *
 * ── WHAT THIS ANSWERS THAT NOTHING ELSE DOES ────────────────────────────────
 *
 * `portfolio-acts.ts` answers "did this holder PLACE something". `activity.ts`
 * folds placement rate into a liveness verdict. Both read healthy for the
 * failure this module exists for, and `compileGoalPlanPlacement` used to settle
 * it outright: a plan was `terminal` — and so left the goal worklist — when its
 * administrative status said so, i.e.
 *
 *     status in {done, shipped, superseded}
 *       OR (items non-empty AND every item in {done, dropped})
 *
 * Nothing in that predicate observes whether the delegated execution produced
 * evidence. Measured 2026-09-22 on this harness: 258 unarchived plans satisfied
 * the item-status leg while NOT shipped and NOT superseded, 205 of them sitting
 * in `awaiting-acceptance` — the status that means, in as many words,
 * "implementation complete, acceptance NOT granted". Every one of them read as
 * finished work to a GOAL holder.
 *
 * ── WHY THIS IS A FOLD AND NOT AN ORACLE ────────────────────────────────────
 *
 * Every fact closure needs is already adjudicated by `evaluatePlanAcceptanceGate`:
 * item completion, the code-truth audit, spec proof, rubric vetting, INDEPENDENT
 * (non-implementer) grading, and the implementer's recorded acceptance verdict.
 * Re-deriving any of that here would be a second copy of a truth the acceptance
 * layer owns, and the second copy is always the one that drifts. So this module
 * holds no SQL, no clock and no policy of its own — it CLASSIFIES the gate's
 * verdict into the four legs P-026 names, and folds them honestly.
 *
 * The honesty is the point. `unknown` never collapses into `closed`: a leg the
 * gate could not measure is reported as unmeasured, because "we could not tell"
 * and "it closed" are the two readings this whole item exists to keep apart.
 */

import type { PlanAcceptanceGateCode, PlanAcceptanceGateVerdict } from '../plan-acceptance-gate';

/**
 * The four legs P-026 requires before a selected cohort counts as progress,
 * spelled in its own words:
 *
 *   "a selected cohort is only progress after delegated execution reaches
 *    terminal evidence, verification is read back, the independent evaluator
 *    regrades the same subject/window, and the holder reports measured effect,
 *    cost, uncertainty and residue."
 */
export const PLAN_CLOSURE_LEGS = [
  'terminalEvidence',
  'verificationReadBack',
  'independentRegrade',
  'measuredReport',
] as const;

export type PlanClosureLeg = (typeof PLAN_CLOSURE_LEGS)[number];

/**
 * `not-applicable` is NOT a quiet synonym for `pass`. It exists for the subjects
 * acceptance genuinely does not govern (a rubric template, a template instance),
 * where claiming a leg "passed" would assert evidence nobody ever produced.
 */
export type PlanClosureRating = 'pass' | 'fail' | 'unknown' | 'not-applicable';

/**
 * Which leg each acceptance-gate code falsifies, and whether it is a FINDING
 * (`fail`) or a failed MEASUREMENT (`unknown`).
 *
 * A `Record<PlanAcceptanceGateCode, …>` on purpose, exactly like
 * `GATE_CODE_OWNERSHIP` next door: adding a code to `PlanAcceptanceGateCode`
 * fails to COMPILE here until somebody says which leg it belongs to. A hand-kept
 * list would instead silently stop covering the newest code, and the leg it
 * belonged to would quietly start reading `pass`.
 */
export const GATE_CODE_CLOSURE_LEG: Record<
  PlanAcceptanceGateCode,
  { leg: PlanClosureLeg; rating: 'fail' | 'unknown' }
> = {
  // --- leg 1: delegated execution reached terminal evidence -----------------
  plan_items_unfinished: { leg: 'terminalEvidence', rating: 'fail' },
  // A deliverable that exists only in a session-local surface is not terminal
  // evidence of anything — the execution left nothing durable behind.
  ephemeral_deliverable_unbacked: { leg: 'terminalEvidence', rating: 'fail' },

  // --- leg 2: verification was READ BACK against the code -------------------
  acceptance_unaudited: { leg: 'verificationReadBack', rating: 'fail' },
  audit_coverage_stale: { leg: 'verificationReadBack', rating: 'fail' },
  audit_citations_unresolved: { leg: 'verificationReadBack', rating: 'fail' },
  requirement_unrealized: { leg: 'verificationReadBack', rating: 'fail' },
  spec_proof_stale: { leg: 'verificationReadBack', rating: 'fail' },
  spec_clause_unproven: { leg: 'verificationReadBack', rating: 'fail' },
  design_evidence_unsatisfied: { leg: 'verificationReadBack', rating: 'fail' },
  // WI-10004135: the author declared delivery-plane evidence outstanding (no BAR contract).
  acceptance_pending_delivery: { leg: 'verificationReadBack', rating: 'fail' },
  // The census degraded rather than judged. Not a finding about the plan.
  design_evidence_unavailable: { leg: 'verificationReadBack', rating: 'unknown' },
  spec_coverage_unavailable: { leg: 'verificationReadBack', rating: 'unknown' },

  // --- leg 3: an INDEPENDENT evaluator regraded the current subject ---------
  acceptance_ungraded: { leg: 'independentRegrade', rating: 'fail' },
  self_graded_only: { leg: 'independentRegrade', rating: 'fail' },
  acceptance_rubric_missing: { leg: 'independentRegrade', rating: 'fail' },
  acceptance_rubric_ambiguous: { leg: 'independentRegrade', rating: 'fail' },
  acceptance_rubric_unvetted: { leg: 'independentRegrade', rating: 'fail' },
  acceptance_rubric_vetted_after_grading: { leg: 'independentRegrade', rating: 'fail' },
  acceptance_bar_not_met: { leg: 'independentRegrade', rating: 'fail' },
  acceptance_bar_contract_not_ready: { leg: 'independentRegrade', rating: 'fail' },
  acceptance_rejected: { leg: 'independentRegrade', rating: 'fail' },
  // Both of these are the gate failing to READ the grading lineage/revision, not
  // a verdict about it. Ranking them `fail` would send a holder to repair a plan
  // whose grading was never actually observed.
  acceptance_rubric_revision_unreadable: { leg: 'independentRegrade', rating: 'unknown' },
  acceptance_lineage_unreadable: { leg: 'independentRegrade', rating: 'unknown' },

  // --- leg 4: the holder reported measured effect/cost/uncertainty/residue --
  acceptance_not_recorded: { leg: 'measuredReport', rating: 'fail' },
};

/**
 * The headings the holder's per-plan closure report must carry. Deliberately the
 * four nouns P-026 names, and deliberately parsed rather than trusted as prose:
 * an unparsed paragraph cannot distinguish a measured effect from a claimed one.
 */
export const PLAN_CLOSURE_REPORT_FIELDS = ['effect', 'cost', 'uncertainty', 'residue'] as const;

export type PlanClosureReportField = (typeof PLAN_CLOSURE_REPORT_FIELDS)[number];

export interface PlanClosureReportParse {
  /** Whether anything report-shaped was found at all. */
  attempted: boolean;
  /** Every required field present with a non-empty value. */
  complete: boolean;
  fields: Partial<Record<PlanClosureReportField, string>>;
  missing: PlanClosureReportField[];
}

const CLOSURE_LABEL_TO_FIELD: Readonly<Record<string, PlanClosureReportField>> = Object.freeze({
  EFFECT: 'effect',
  COST: 'cost',
  UNCERTAINTY: 'uncertainty',
  RESIDUE: 'residue',
});

/** Strip the decoration a heading picks up in real prose (`**COST:**`, `## Effect —`). */
function closureHeading(raw: string): { field: PlanClosureReportField; remainder: string } | null {
  const line = raw.trim().replace(/^[#>*+\-\s]+/, '');
  const match = /^(\*\*|__)?\s*([A-Za-z][A-Za-z\- ]*?)\s*(\*\*|__)?\s*[:：—–-]\s*(.*)$/.exec(line);
  if (!match) return null;
  const label = (match[2] ?? '').replace(/[\s\-]/g, '').toUpperCase();
  const field = CLOSURE_LABEL_TO_FIELD[label];
  if (!field) return null;
  return { field, remainder: (match[4] ?? '').trim() };
}

/**
 * Parse the holder's closure report out of the implementer's recorded acceptance
 * `reasoning`. Reusing that already-durable field is the whole reason there is no
 * new store here: the acceptance verdict is written once, per plan, by the party
 * P-026 makes responsible for the report.
 *
 * Mirrors `goal-owner-report.ts`'s heading discipline; kept separate because the
 * two reports answer different questions (that one is per GOAL, this per PLAN)
 * and collapsing them would make one field set answer for both.
 */
export function parsePlanClosureReport(reasoning: string | null | undefined): PlanClosureReportParse {
  const fields: Partial<Record<PlanClosureReportField, string>> = {};
  const lines = (reasoning ?? '').split(/\r?\n/);
  let current: PlanClosureReportField | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!current) return;
    const value = buffer.join(' ').replace(/\s+/g, ' ').trim();
    // First heading wins: a later restatement cannot overwrite the measurement.
    if (value && fields[current] === undefined) fields[current] = value;
    current = null;
    buffer = [];
  };

  for (const line of lines) {
    const heading = closureHeading(line);
    if (heading) {
      flush();
      current = heading.field;
      buffer = heading.remainder ? [heading.remainder] : [];
      continue;
    }
    if (current) buffer.push(line.trim());
  }
  flush();

  const missing = PLAN_CLOSURE_REPORT_FIELDS.filter((field) => !fields[field]);
  return {
    attempted: Object.keys(fields).length > 0,
    complete: missing.length === 0,
    fields,
    missing: [...missing],
  };
}

/** Why closure could not be measured at all. Result-level, so a caller cannot miss it. */
export interface PlanClosureUnreadable {
  code: 'gate-unreadable' | 'gate-not-evaluated';
  detail: string;
}

export type PlanClosureState = 'closed' | 'open' | 'partial' | 'unknown';

export interface PlanClosureVerdict {
  planSlug: string;
  /**
   * THE HEADLINE. `closed` requires every leg to have passed (or to be genuinely
   * not-applicable). It is never reached by inference, and never by placement.
   */
  state: PlanClosureState;
  legs: Record<PlanClosureLeg, PlanClosureRating>;
  /**
   * The three EVIDENCE legs, folded for the one caller that needs them apart:
   * `compileGoalPlanPlacement` asks "does this plan still need an agent placed on
   * it?", and a missing holder REPORT is not answered by launching a fleet.
   */
  evidenceSatisfied: boolean;
  /** The gate code that produced the falsified leg, when there was one. */
  code: PlanAcceptanceGateCode | null;
  /** Human reason, carrying the gate's own message where it had one. */
  reason: string;
  /** Present only when the measurement itself failed. */
  unreadable?: PlanClosureUnreadable;
  /** The report parse, so a caller can name the missing headings rather than guess. */
  report: PlanClosureReportParse;
}

export type PlanClosureInput =
  | { planSlug: string; status: 'unreadable'; failure: PlanClosureUnreadable }
  | {
      planSlug: string;
      status: 'read';
      gate: Pick<PlanAcceptanceGateVerdict, 'satisfied' | 'code' | 'skipped' | 'message'>;
      /** The implementer's recorded acceptance reasoning, when the caller could read it. */
      acceptanceReasoning?: string | null;
    };

const EVIDENCE_LEGS: readonly PlanClosureLeg[] = ['terminalEvidence', 'verificationReadBack', 'independentRegrade'];

function allLegs(rating: PlanClosureRating): Record<PlanClosureLeg, PlanClosureRating> {
  return {
    terminalEvidence: rating,
    verificationReadBack: rating,
    independentRegrade: rating,
    measuredReport: rating,
  };
}

/**
 * Fold the leg ratings into the headline.
 *
 * The ordering is the whole contract, so it is stated rather than implied:
 *
 *  • `closed`  — every leg passed or is genuinely not-applicable. Nothing else.
 *  • `partial` — something closed AND something did not. The state P-026 asks to
 *                be PRESERVED rather than rounded to success.
 *  • `open`    — nothing closed, and at least one leg is a measured failure.
 *  • `unknown` — no leg was falsified, but at least one could not be measured.
 *                It is checked LAST among the non-closed branches on purpose: a
 *                real finding beside an unmeasured leg is still a finding, and
 *                reporting the pair as merely "unknown" would bury it.
 */
function foldClosureState(legs: Record<PlanClosureLeg, PlanClosureRating>): PlanClosureState {
  const ratings = PLAN_CLOSURE_LEGS.map((leg) => legs[leg]);
  const closedish = ratings.filter((r) => r === 'pass' || r === 'not-applicable').length;
  const failed = ratings.filter((r) => r === 'fail').length;

  if (closedish === ratings.length) return 'closed';
  if (failed > 0) return closedish > 0 || ratings.includes('unknown') ? 'partial' : 'open';
  return 'unknown';
}

/**
 * PURE: has this plan closed?
 *
 * ⚠ The gate reports ONE code, which names the FIRST leg it found unsatisfied —
 * it does not adjudicate the rest. So the legs this fold cannot see are rated
 * `unknown`, never `pass`. That is deliberately pessimistic in the only direction
 * that is safe here: over-reporting `unknown` costs a holder one more look, while
 * inferring `pass` from an unexamined leg is precisely the "declare success from
 * claims" failure P-026 names.
 */
export function resolvePlanClosure(input: PlanClosureInput): PlanClosureVerdict {
  if (input.status === 'unreadable') {
    return {
      planSlug: input.planSlug,
      state: 'unknown',
      legs: allLegs('unknown'),
      evidenceSatisfied: false,
      code: null,
      reason: input.failure.detail,
      unreadable: input.failure,
      report: parsePlanClosureReport(null),
    };
  }

  const { gate } = input;
  const report = parsePlanClosureReport(input.acceptanceReasoning);

  // A template plan (or a template instance) is not delegated work and acceptance
  // does not govern it. `not-applicable` rather than `pass` — see PlanClosureRating.
  if (gate.skipped === 'rubric-template-plan' || gate.skipped === 'template-instance') {
    const legs = allLegs('not-applicable');
    return {
      planSlug: input.planSlug,
      state: foldClosureState(legs),
      legs,
      evidenceSatisfied: true,
      code: null,
      reason: `acceptance does not govern this subject (${gate.skipped})`,
      report,
    };
  }

  // The gate did not run, so nothing about this plan was established. This is the
  // branch that must never read as healthy just because no finding came back.
  if (gate.skipped === 'flag-off') {
    const failure: PlanClosureUnreadable = {
      code: 'gate-not-evaluated',
      detail: 'the plan acceptance gate is disabled, so closure was never evaluated',
    };
    return {
      planSlug: input.planSlug,
      state: 'unknown',
      legs: allLegs('unknown'),
      evidenceSatisfied: false,
      code: null,
      reason: failure.detail,
      unreadable: failure,
      report,
    };
  }

  // Shipping is itself gated on the three evidence legs, so an already-shipped
  // plan HAS produced them. The report leg is still judged on its own evidence.
  if (gate.satisfied || gate.skipped === 'already-shipped') {
    const legs: Record<PlanClosureLeg, PlanClosureRating> = {
      terminalEvidence: 'pass',
      verificationReadBack: 'pass',
      independentRegrade: 'pass',
      measuredReport: report.complete ? 'pass' : report.attempted ? 'fail' : 'unknown',
    };
    return {
      planSlug: input.planSlug,
      state: foldClosureState(legs),
      legs,
      evidenceSatisfied: true,
      code: null,
      reason: report.complete
        ? 'terminal evidence, read-back verification and an independent grade are all recorded, with a complete measured report'
        : `acceptance is satisfied, but the measured closure report is ${
            report.attempted ? `missing ${report.missing.join(', ')}` : 'absent'
          }`,
      report,
    };
  }

  const code = gate.code ?? null;
  if (!code) {
    const failure: PlanClosureUnreadable = {
      code: 'gate-unreadable',
      detail: gate.message ?? 'the acceptance gate refused without naming a code',
    };
    return {
      planSlug: input.planSlug,
      state: 'unknown',
      legs: allLegs('unknown'),
      evidenceSatisfied: false,
      code: null,
      reason: failure.detail,
      unreadable: failure,
      report,
    };
  }

  const classified = GATE_CODE_CLOSURE_LEG[code];
  const legs = allLegs('unknown');
  legs[classified.leg] = classified.rating;
  if (report.complete) legs.measuredReport = 'pass';

  return {
    planSlug: input.planSlug,
    state: foldClosureState(legs),
    legs,
    evidenceSatisfied: EVIDENCE_LEGS.every((leg) => legs[leg] === 'pass' || legs[leg] === 'not-applicable'),
    code,
    reason: gate.message ?? `the acceptance gate reports ${code}`,
    report,
  };
}

/**
 * The one idempotent next move for a plan that has not closed — so a holder is
 * never left holding a verdict with no verb attached.
 *
 * A missing REPORT is not repaired by launching anything, which is why this is
 * keyed on the leg rather than on the state.
 */
export function planClosureNextAction(verdict: PlanClosureVerdict): {
  kind: 'inspect' | 'repair' | 'report';
  summary: string;
} | null {
  if (verdict.state === 'closed') return null;
  if (verdict.unreadable) {
    return {
      kind: 'inspect',
      summary: `re-read the acceptance gate for ${verdict.planSlug} before treating it as progress (${verdict.unreadable.code})`,
    };
  }
  if (verdict.legs.measuredReport !== 'pass' && verdict.evidenceSatisfied) {
    return {
      kind: 'report',
      summary:
        `record the measured closure report for ${verdict.planSlug} — ` +
        `${PLAN_CLOSURE_REPORT_FIELDS.join(', ')} — on the acceptance verdict`,
    };
  }
  return {
    kind: 'repair',
    summary: `close ${verdict.planSlug}: ${verdict.reason}`,
  };
}
