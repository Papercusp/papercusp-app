/**
 * Grader for **GDPval** (OpenAI, arXiv:2510.04374, 2025-09) — plan `benchmark-suite-gdpval-2026-06-17`.
 *
 * GDPval is NOT exact-match (GAIA) nor tests-pass (SWE-bench): each task is a real-world professional
 * **deliverable** (a doc / slide deck / spreadsheet / diagram …), and the canonical metric is a **blinded
 * pairwise comparison** of the model's deliverable against an industry-expert reference deliverable →
 * win / tie / loss → a **win-or-tie rate** (the headline; Claude Opus 4.1 ≈47.6% at launch). The gold-standard
 * grader is human experts; OpenAI also ships an experimental LLM-judge autograder (~66% agreement vs experts).
 * This file implements the AUTOGRADER (the cheap inner-loop) as a pairwise LLM judge — the human/hosted path
 * is a config swap (the same `JudgeFn` seam).
 *
 * FAITHFUL to the pairwise methodology, with the load-bearing rigor:
 *   - **Dual-order, position-bias-mitigated.** An LLM judge favors whichever deliverable it sees first, so we
 *     judge BOTH orderings (model-first AND reference-first) and combine. A robust win requires the judge to
 *     prefer the model in BOTH orders; a flip (prefers whoever's first) collapses to a tie. This is the single
 *     most important correctness property — a naive single-order judge over-credits the model by ~position bias.
 *   - **Rubric-grounded.** The judge scores against the task's `rubric` (GDPval ships a per-task rubric), not
 *     vibes — same criteria a human grader uses.
 *   - **Arm-blind + deterministic-given-the-judge.** The grader cannot tell which arm produced a deliverable
 *     (the two are presented as anonymous A/B); given the same judge outputs it produces the same verdict.
 *
 * The LLM judge ({@link JudgeFn}) is INJECTED, so all the scoring logic (verdict parse, dual-order combine,
 * win-rate aggregation) is unit-testable with a fake judge — no LLM spend.
 */

/* -------------------------------------------------------------------------- */
/* The pairwise judge seam                                                     */
/* -------------------------------------------------------------------------- */

/** One pairwise judging call: the judge sees the prompt + rubric + two anonymized deliverables (A and B). */
export interface JudgeRequest {
  /** The GDPval task prompt (what was asked of the professional). */
  prompt: string;
  /** The task's grading rubric (GDPval ships one per task); criteria the judge applies. */
  rubric: string;
  /** Deliverable A's text content (a bundle reduced to text/markdown for the judge). */
  deliverableA: string;
  /** Deliverable B's text content. */
  deliverableB: string;
}

/**
 * The injected LLM judge — returns its raw verdict text (the grader parses `WINNER: A|B|TIE` out of it).
 * In production this is an LLM call (the autograder) or the hosted GDPval grading service; in tests a fake.
 */
export type JudgeFn = (req: JudgeRequest) => Promise<string>;

/** The judge system prompt — pairwise, rubric-grounded, forces a parseable verdict line. */
export const GDPVAL_JUDGE_SYSTEM = [
  'You are an expert evaluator grading two candidate work deliverables (A and B) produced in response to a',
  "professional task. You do NOT know which deliverable came from a human expert vs an AI — judge ONLY on",
  'quality against the rubric. Consider correctness, completeness, professional quality, adherence to the',
  'request, and usefulness to the requester. Reason briefly, then finish with EXACTLY one line:',
  'WINNER: A   (if A is clearly better)',
  'WINNER: B   (if B is clearly better)',
  'WINNER: TIE (if they are of equivalent quality)',
].join('\n');

/** Build the user content for one pairwise judging call. */
export function buildJudgeUserPrompt(req: JudgeRequest): string {
  return [
    `# Task prompt\n${req.prompt}`,
    `\n# Grading rubric\n${req.rubric || '(no explicit rubric — judge on professional quality + adherence to the prompt)'}`,
    `\n# Deliverable A\n${req.deliverableA || '(empty)'}`,
    `\n# Deliverable B\n${req.deliverableB || '(empty)'}`,
    '\nWhich deliverable is better? Finish with exactly one line: WINNER: A | WINNER: B | WINNER: TIE.',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Verdict parsing + dual-order combination                                    */
/* -------------------------------------------------------------------------- */

/** A single-order judge verdict: which presented side (A/B) won, or a tie. */
export type SideVerdict = 'A' | 'B' | 'tie';

/** Extract the `WINNER: A|B|TIE` from the judge's raw text (last marker wins; tolerant of spacing/case). */
export function parseJudgeVerdict(text: string): SideVerdict | null {
  const re = /winner\s*:\s*(a|b|tie)/gi;
  let last: SideVerdict | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = m[1].toLowerCase();
    last = v === 'a' ? 'A' : v === 'b' ? 'B' : 'tie';
  }
  return last;
}

/** The model-perspective outcome of ONE pairwise comparison. */
export type PairOutcome = 'win' | 'tie' | 'loss';

/** Numeric score for a model outcome (win=1, tie=0.5, loss=0) — the win-rate counts ties as half. */
export function outcomeScore(o: PairOutcome): number {
  return o === 'win' ? 1 : o === 'tie' ? 0.5 : 0;
}

/**
 * Combine the two position-swapped judgements into ONE model-perspective verdict (position-bias mitigation).
 * `v1` is the verdict when the MODEL was shown as A (reference as B); `v2` when the model was shown as B.
 * Per-order model score (win=1/tie=.5/loss=0) is averaged; >0.5 → win, <0.5 → loss, ==0.5 → tie. So a judge
 * that flips with position (model wins as A, loses as B) correctly collapses to a TIE, not a win.
 */
export function combineDualOrder(v1: SideVerdict, v2: SideVerdict): PairOutcome {
  // order 1: model = A → model wins iff judge said A.
  const s1 = v1 === 'A' ? 1 : v1 === 'B' ? 0 : 0.5;
  // order 2: model = B → model wins iff judge said B.
  const s2 = v2 === 'B' ? 1 : v2 === 'A' ? 0 : 0.5;
  const avg = (s1 + s2) / 2;
  return avg > 0.5 ? 'win' : avg < 0.5 ? 'loss' : 'tie';
}

/* -------------------------------------------------------------------------- */
/* Grading one task + aggregating                                              */
/* -------------------------------------------------------------------------- */

/** One GDPval prediction to grade: the model's deliverable vs the gold reference, with task metadata. */
export interface GdpvalPrediction {
  taskId: string;
  occupation: string;
  sector: string;
  prompt: string;
  rubric: string;
  /** The model's deliverable, reduced to text/markdown for the judge. */
  modelDeliverable: string;
  /** The expert reference deliverable, reduced to text/markdown. */
  referenceDeliverable: string;
  /**
   * Mark a task excluded from scoring (e.g. a deliverable the autograder can't read — binary CAD/video —
   * or a generation infra failure). Surfaced separately, not counted as a loss (METR discipline).
   */
  excludeReason?: string;
}

/** Per-task grade. `outcome` is the model-perspective win/tie/loss; `score` is win=1/tie=.5/loss=0. */
export interface GdpvalTaskGrade {
  taskId: string;
  occupation: string;
  sector: string;
  outcome: PairOutcome;
  /** win=1 / tie=0.5 / loss=0. */
  score: number;
  /** The two position-swapped judge verdicts (for audit/repro). */
  verdicts: { modelFirst: SideVerdict; referenceFirst: SideVerdict };
  excludeReason?: string;
}

/** A win-rate breakdown over a group (overall / per occupation / per sector). */
export interface GdpvalGroupReport {
  group: string;
  scored: number;
  wins: number;
  ties: number;
  losses: number;
  /** (wins + 0.5·ties) / scored — the GDPval headline win-rate (ties count half). */
  winRate: number;
  /** (wins + ties) / scored — the "win-or-tie rate" (model ≥ reference). */
  winOrTieRate: number;
}

/** The full GDPval report: overall + per-occupation + per-sector + the per-task grades. */
export interface GdpvalReport {
  overall: GdpvalGroupReport;
  byOccupation: GdpvalGroupReport[];
  bySector: GdpvalGroupReport[];
  excluded: number;
  grades: GdpvalTaskGrade[];
}

/**
 * Grade ONE prediction via the injected dual-order judge. Two judging calls (model-first, reference-first);
 * a verdict that can't be parsed defaults to a TIE for that order (conservative — doesn't over-credit the
 * model). Returns the model-perspective outcome + the audit verdicts.
 */
export async function gradeGdpvalTask(pred: GdpvalPrediction, deps: { judge: JudgeFn }): Promise<GdpvalTaskGrade> {
  if (pred.excludeReason) {
    return {
      taskId: pred.taskId,
      occupation: pred.occupation,
      sector: pred.sector,
      outcome: 'loss',
      score: 0,
      verdicts: { modelFirst: 'tie', referenceFirst: 'tie' },
      excludeReason: pred.excludeReason,
    };
  }
  const base = { prompt: pred.prompt, rubric: pred.rubric };
  // Order 1: model = A, reference = B.
  const t1 = await deps.judge({ ...base, deliverableA: pred.modelDeliverable, deliverableB: pred.referenceDeliverable });
  // Order 2: reference = A, model = B (swapped).
  const t2 = await deps.judge({ ...base, deliverableA: pred.referenceDeliverable, deliverableB: pred.modelDeliverable });
  const modelFirst = parseJudgeVerdict(t1) ?? 'tie';
  const referenceFirst = parseJudgeVerdict(t2) ?? 'tie';
  const outcome = combineDualOrder(modelFirst, referenceFirst);
  return {
    taskId: pred.taskId,
    occupation: pred.occupation,
    sector: pred.sector,
    outcome,
    score: outcomeScore(outcome),
    verdicts: { modelFirst, referenceFirst },
  };
}

/** Roll a set of grades into one group report (counts + win-rate + win-or-tie rate). Excluded rows skipped. */
function groupReport(group: string, grades: GdpvalTaskGrade[]): GdpvalGroupReport {
  const scoredRows = grades.filter((g) => !g.excludeReason);
  const wins = scoredRows.filter((g) => g.outcome === 'win').length;
  const ties = scoredRows.filter((g) => g.outcome === 'tie').length;
  const losses = scoredRows.filter((g) => g.outcome === 'loss').length;
  const scored = scoredRows.length;
  return {
    group,
    scored,
    wins,
    ties,
    losses,
    winRate: scored > 0 ? (wins + 0.5 * ties) / scored : 0,
    winOrTieRate: scored > 0 ? (wins + ties) / scored : 0,
  };
}

/** Grade a batch of predictions → the per-occupation/sector + overall win-rate {@link GdpvalReport}. */
export async function gradeGdpval(predictions: GdpvalPrediction[], deps: { judge: JudgeFn }): Promise<GdpvalReport> {
  const grades: GdpvalTaskGrade[] = [];
  for (const p of predictions) grades.push(await gradeGdpvalTask(p, deps));

  const byKey = (key: (g: GdpvalTaskGrade) => string): GdpvalGroupReport[] => {
    const groups = new Map<string, GdpvalTaskGrade[]>();
    for (const g of grades) {
      const k = key(g);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(g);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, gs]) => groupReport(k, gs));
  };

  return {
    overall: groupReport('overall', grades),
    byOccupation: byKey((g) => g.occupation),
    bySector: byKey((g) => g.sector),
    excluded: grades.filter((g) => g.excludeReason).length,
    grades,
  };
}
