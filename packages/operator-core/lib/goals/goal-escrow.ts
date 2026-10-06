/**
 * Goal escrow evaluator — a READ-ONLY, pure settlement check for one goal.
 *
 * WHY: goal mode lets "implementation is done", "the grade says X", "spend is Y",
 * "tests are green" and "the owner was told" live in five different places, and
 * nothing asks whether they agree before a goal is called complete. This module
 * is the cheap experiment behind the goal-escrow proposal (WI-10004498): given a
 * plain-data SNAPSHOT of those existing records, it marks each of six required
 * deposits present / missing / stale / conflicting, derives an escrow verdict,
 * and compares that verdict with the goal's recorded status.
 *
 * It performs no I/O and writes nothing. Collecting the snapshot is
 * `goal-escrow-snapshot.ts`; this file only judges what it is handed, so every
 * rule below is unit-testable with literals.
 *
 * Deposit semantics (kept deliberately small so the experiment stays falsifiable):
 *   present      the record exists, is current, and agrees with the other deposits
 *   missing      no record (or no record that can carry the weight the deposit needs)
 *   stale        a record exists but predates the delivery it is meant to vouch for
 *   conflicting  a record exists and CONTRADICTS another record or itself
 *
 * Verdicts:
 *   close         the five evidence deposits are present and green
 *   block         the five are present but the tree carries a bounded no-go reason
 *   fail          the goal was killed/failed AND the closure verdict is recorded
 *   insufficient  anything else — a deposit is missing, stale, or conflicting
 */

export const GOAL_ESCROW_SCHEMA_VERSION = 'goal-escrow-eval-v1' as const;

export const GOAL_ESCROW_DEPOSIT_KEYS = [
  'implementation_delta',
  'green_proof_or_no_go_reason',
  'independent_grade',
  'spend_snapshot_with_timestamp',
  'owner_report_or_not_required',
  'closure_verdict',
] as const;
export type GoalEscrowDepositKey = (typeof GOAL_ESCROW_DEPOSIT_KEYS)[number];

export type GoalEscrowDepositState = 'present' | 'missing' | 'stale' | 'conflicting';
export type GoalEscrowVerdict = 'close' | 'block' | 'fail' | 'insufficient';

/** How the goal's recorded status relates to what the escrow can support. */
export type GoalEscrowAgreement =
  /** Status and escrow verdict are the same firm verdict. */
  | 'match'
  /** Status is a firm verdict the escrow cannot support (verdict is `insufficient`). */
  | 'unsupported'
  /** Status is firm and the escrow is firm, but they differ. */
  | 'divergent'
  /** Goal is still open and the escrow does not say close. Nothing to compare yet. */
  | 'in-progress'
  /** Goal is still open but every deposit already supports closing it. */
  | 'ready-unclosed';

/** Work-item statuses that count as DELIVERED work (vs abandoned or still open). */
const DELIVERED_ITEM_STATUSES: ReadonlySet<string> = new Set(['done', 'resolved', 'closed']);
const ABANDONED_ITEM_STATUSES: ReadonlySet<string> = new Set(['dropped']);

const SUCCESS_GOAL_STATUSES: ReadonlySet<string> = new Set(['achieved', 'done', 'completed']);
const FAIL_GOAL_STATUSES: ReadonlySet<string> = new Set(['killed', 'failed', 'abandoned', 'cancelled']);
const BLOCKED_GOAL_STATUSES: ReadonlySet<string> = new Set(['blocked']);

export interface EscrowWorkItem {
  id: string;
  /** Raw `work_items.status`. */
  status: string;
  /** `work_items.authority` — `committed` once the change is provably landed. */
  completionAuthority: string | null;
  /** Agents that did or claimed the work; used to decide who counts as independent. */
  assignee: string | null;
  takenBy: string | null;
  terminalOwner: string | null;
  /** Epoch ms the item reached a terminal status, when it did. */
  closedAtMs: number | null;
  /** True when the close carried `_completionEvidence` (or a terminal completion ref). */
  hasCompletionEvidence: boolean;
  /** `completion.testResult` normalised, or null when the close recorded none. */
  testResult: 'pass' | 'fail' | 'unknown' | null;
}

export interface EscrowGateReading {
  /** Raw `gate_health.lastVerdict`, e.g. `green` / `not-green`. Null when never recorded. */
  lastVerdict: string | null;
  observedAtMs: number | null;
  lastGreenAtMs: number | null;
}

export interface EscrowNoGoReason {
  text: string;
  observedAtMs: number;
}

export interface EscrowGrade {
  id: string;
  rubricRef: string;
  /** 0–10, or null when the card carries no score. */
  score10: number | null;
  gradedBy: string | null;
  createdAtMs: number;
  subjectRef: string | null;
}

export type EscrowOwnerReportDiagnosis =
  | 'complete'
  | 'wrong-goal'
  | 'unstamped-complete'
  | 'incomplete'
  | 'not-attempted'
  | 'unreadable-envelope';

export interface EscrowOwnerReport {
  diagnosis: EscrowOwnerReportDiagnosis;
  atMs: number;
}

export interface GoalEscrowSnapshot {
  /** When the records were read; every freshness rule is measured against this. */
  observedAtMs: number;
  goal: {
    id: string;
    status: string;
    standing: boolean;
    /** `metadata.disposition` — the wind-down verdict, when one was recorded. */
    disposition: string | null;
    dispositionAtMs: number | null;
    /** Free-text reason recorded with the closure, when any. */
    closureReason: string | null;
    killCriterion: string | null;
    budgetCents: number | null;
    updatedAtMs: number;
  };
  /**
   * How many scorecard subject reads FAILED while collecting `grades` (timeout, pool
   * exhaustion). Absent/0 means the grade read was complete. A non-zero count makes
   * "no grade found" a statement about the instrument, not about the goal — the
   * evaluator reports it as UNMEASURED rather than as a missing deposit.
   */
  gradeReadGaps?: number;
  /** Non-observation work-items linked to the goal. */
  workItems: readonly EscrowWorkItem[];
  /** Plans linked to the goal (slug + raw status). */
  plans: readonly { slug: string; status: string }[];
  gate: EscrowGateReading | null;
  noGoReason: EscrowNoGoReason | null;
  grades: readonly EscrowGrade[];
  spend: {
    spentCents: number | null;
    spentAtMs: number | null;
    /** The authoritative lineage figure, when the rollup recorded one. */
    lineageCents: number | null;
    unmeasuredReason: string | null;
  };
  ownerReports: readonly EscrowOwnerReport[];
  /** False for goals whose reporting runs on a cadence rail rather than at closure. */
  ownerReportRequired: boolean;
  ownerReportNotRequiredReason: string | null;
}

export interface GoalEscrowOptions {
  /** Active goals: a gate reading older than this is stale. Default 6h. */
  maxGateAgeMs?: number;
  /** Active goals: a spend snapshot older than this is stale. Default 30m. */
  maxSpendAgeMs?: number;
  /** Independent grades whose min score is below this contradict a delivery claim. Default 6. */
  passScore10?: number;
  /** Independent grades spreading wider than this disagree with each other. Default 4. */
  maxGradeSpread10?: number;
}

export interface GoalEscrowDeposit {
  key: GoalEscrowDepositKey;
  state: GoalEscrowDepositState;
  /** Why the state is what it is. Empty only for a plainly `present` deposit. */
  reasons: string[];
  /** Short record references the verdict leaned on (ids, counts). */
  evidence: string[];
  /** Green-proof only: the deposit is a bounded no-go reason, not a green reading. */
  noGo?: boolean;
  /**
   * The state rests on a read that did not complete. An unmeasured deposit is an
   * instrument gap, never a finding: it is excluded from `actionable` and blocks the
   * experiment's falsification test from concluding anything.
   */
  unmeasured?: boolean;
}

export interface GoalEscrowResult {
  schemaVersion: typeof GOAL_ESCROW_SCHEMA_VERSION;
  goalId: string;
  goalStatus: string;
  observedAtMs: number;
  deposits: GoalEscrowDeposit[];
  verdict: GoalEscrowVerdict;
  verdictReasons: string[];
  /** What the recorded status claims, as a verdict. Null while the goal is open. */
  claimedVerdict: GoalEscrowVerdict | null;
  agreement: GoalEscrowAgreement;
  /** The recorded status says the goal is achieved but the escrow does not say close. */
  overclaimsClose: boolean;
  /** Deposits an operator would have to act on, `key:state` — the "actionable ambiguity". */
  actionable: string[];
  /** Deposits whose state rests on an incomplete read; NOT findings. */
  unmeasured: GoalEscrowDepositKey[];
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function lastDeliveredCloseMs(items: readonly EscrowWorkItem[]): number | null {
  let latest: number | null = null;
  for (const item of items) {
    if (!DELIVERED_ITEM_STATUSES.has(item.status) || item.closedAtMs === null) continue;
    if (latest === null || item.closedAtMs > latest) latest = item.closedAtMs;
  }
  return latest;
}

function isTerminalGoalStatus(status: string): boolean {
  return (
    SUCCESS_GOAL_STATUSES.has(status) || FAIL_GOAL_STATUSES.has(status) || BLOCKED_GOAL_STATUSES.has(status)
  );
}

function deposit(
  key: GoalEscrowDepositKey,
  state: GoalEscrowDepositState,
  reasons: string[] = [],
  evidence: string[] = [],
  extra: Partial<GoalEscrowDeposit> = {},
): GoalEscrowDeposit {
  return { key, state, reasons, evidence, ...extra };
}

function evaluateImplementationDelta(snap: GoalEscrowSnapshot): GoalEscrowDeposit {
  const key = 'implementation_delta' as const;
  const delivered = snap.workItems.filter((item) => DELIVERED_ITEM_STATUSES.has(item.status));
  const open = snap.workItems.filter(
    (item) => !DELIVERED_ITEM_STATUSES.has(item.status) && !ABANDONED_ITEM_STATUSES.has(item.status),
  );
  const evidence = [
    `workItems=${snap.workItems.length}`,
    `delivered=${delivered.length}`,
    `open=${open.length}`,
    `plans=${snap.plans.length}`,
  ];
  if (snap.workItems.length === 0 && snap.plans.length === 0) {
    return deposit(key, 'missing', ['no work-item or plan is linked to this goal'], evidence);
  }
  if (delivered.length === 0) {
    return deposit(key, 'missing', ['no linked work-item reached a delivered status'], evidence);
  }
  const unevidenced = delivered.filter((item) => !item.hasCompletionEvidence);
  if (unevidenced.length > 0) {
    return deposit(
      key,
      'conflicting',
      [`${unevidenced.length} delivered item(s) carry no completion evidence: ${unevidenced.map((i) => i.id).join(', ')}`],
      evidence,
    );
  }
  const uncommitted = delivered.filter((item) => item.completionAuthority !== 'committed');
  const reasons: string[] = [];
  if (uncommitted.length > 0) {
    reasons.push(
      `${uncommitted.length} delivered item(s) not yet at committed authority: ${uncommitted.map((i) => i.id).join(', ')}`,
    );
  }
  if (open.length > 0) reasons.push(`${open.length} linked item(s) are still open`);
  return reasons.length > 0 ? deposit(key, 'stale', reasons, evidence) : deposit(key, 'present', [], evidence);
}

function evaluateGreenProof(snap: GoalEscrowSnapshot, opts: Required<GoalEscrowOptions>): GoalEscrowDeposit {
  const key = 'green_proof_or_no_go_reason' as const;
  const delivered = snap.workItems.filter((item) => DELIVERED_ITEM_STATUSES.has(item.status));
  const failed = delivered.filter((item) => item.testResult === 'fail');
  const passed = delivered.filter((item) => item.testResult === 'pass');
  const evidence = [
    `deliveredItems=${delivered.length}`,
    `itemTestPass=${passed.length}`,
    `itemTestFail=${failed.length}`,
    `gate=${snap.gate?.lastVerdict ?? 'unknown'}`,
  ];
  if (failed.length > 0) {
    return deposit(
      key,
      'conflicting',
      [`delivered item(s) record a failing test result: ${failed.map((i) => i.id).join(', ')}`],
      evidence,
    );
  }
  if (delivered.length === 0) {
    return deposit(key, 'missing', ['nothing was delivered, so there is nothing for a green reading to vouch for'], evidence);
  }
  const gate = snap.gate;
  const gateGreen = gate?.lastVerdict === 'green';
  const gateRed = gate !== null && gate.lastVerdict !== null && gate.lastVerdict !== 'green';
  if (gateRed) {
    if (snap.noGoReason) {
      const age = snap.observedAtMs - snap.noGoReason.observedAtMs;
      if (!snap.goal.standing && !isTerminalGoalStatus(snap.goal.status) && age > opts.maxGateAgeMs) {
        return deposit(key, 'stale', [`current no-go reason is ${Math.round(age / HOUR_MS)}h old`], evidence, { noGo: true });
      }
      return deposit(key, 'present', [`bounded no-go reason: ${snap.noGoReason.text}`], evidence, { noGo: true });
    }
    return deposit(key, 'missing', ['gate is red and no bounded current_no_go_reason is recorded'], evidence);
  }
  if (passed.length === 0 && !gateGreen) {
    return deposit(key, 'missing', ['no per-item test result and no gate reading'], evidence);
  }
  if (!isTerminalGoalStatus(snap.goal.status) && gate?.observedAtMs != null) {
    const age = snap.observedAtMs - gate.observedAtMs;
    if (age > opts.maxGateAgeMs) {
      return deposit(key, 'stale', [`gate reading is ${Math.round(age / HOUR_MS)}h old`], evidence);
    }
  }
  const lastClose = lastDeliveredCloseMs(snap.workItems);
  if (passed.length === 0 && gate?.observedAtMs != null && lastClose !== null && gate.observedAtMs < lastClose) {
    return deposit(key, 'stale', ['gate reading predates the last delivered close'], evidence);
  }
  return deposit(key, 'present', passed.length === 0 ? ['gate reading only; no per-item test results'] : [], evidence);
}

function evaluateIndependentGrade(snap: GoalEscrowSnapshot, opts: Required<GoalEscrowOptions>): GoalEscrowDeposit {
  const key = 'independent_grade' as const;
  const implementers = new Set<string>();
  for (const item of snap.workItems) {
    for (const who of [item.assignee, item.takenBy, item.terminalOwner]) if (who) implementers.add(who);
  }
  const independent = snap.grades.filter((grade) => grade.gradedBy !== null && !implementers.has(grade.gradedBy));
  const scored = independent.filter((grade) => grade.score10 !== null);
  const gaps = snap.gradeReadGaps ?? 0;
  const evidence = [
    `grades=${snap.grades.length}`,
    `independent=${independent.length}`,
    `scored=${scored.length}`,
    `readGaps=${gaps}`,
  ];
  if (gaps > 0 && scored.length === 0) {
    // Absence of a grade is only established by a COMPLETE read. Report the gap.
    return deposit(
      key,
      'missing',
      [`UNMEASURED: ${gaps} scorecard read(s) failed, so the absence of a grade is not established`],
      evidence,
      { unmeasured: true },
    );
  }
  if (snap.grades.length === 0) return deposit(key, 'missing', ['no scorecard grades this goal or its linked items'], evidence);
  if (independent.length === 0) {
    return deposit(key, 'missing', ['every grade was emitted by an implementer (self-graded only)'], evidence);
  }
  if (scored.length === 0) return deposit(key, 'missing', ['independent grades carry no score'], evidence);
  const scores = scored.map((grade) => grade.score10 as number);
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  if (hi - lo > opts.maxGradeSpread10) {
    return deposit(key, 'conflicting', [`independent grades disagree: min ${lo} vs max ${hi}`], evidence);
  }
  if (lo < opts.passScore10) {
    return deposit(key, 'conflicting', [`independent grade ${lo} is below the pass bar ${opts.passScore10}`], evidence);
  }
  const lastClose = lastDeliveredCloseMs(snap.workItems);
  const newest = Math.max(...scored.map((grade) => grade.createdAtMs));
  if (lastClose !== null && newest < lastClose) {
    return deposit(key, 'stale', ['newest independent grade predates the last delivered close'], evidence);
  }
  return deposit(key, 'present', [], evidence);
}

function evaluateSpend(snap: GoalEscrowSnapshot, opts: Required<GoalEscrowOptions>): GoalEscrowDeposit {
  const key = 'spend_snapshot_with_timestamp' as const;
  const { spentCents, spentAtMs, lineageCents, unmeasuredReason } = snap.spend;
  const evidence = [
    `spentCents=${spentCents ?? 'null'}`,
    `lineageCents=${lineageCents ?? 'null'}`,
    `budgetCents=${snap.goal.budgetCents ?? 'null'}`,
  ];
  if (spentCents === null) {
    return deposit(key, 'missing', [unmeasuredReason ? `spend unmeasured: ${unmeasuredReason}` : 'no spend figure recorded'], evidence);
  }
  if (spentAtMs === null) return deposit(key, 'missing', ['spend figure carries no timestamp'], evidence);
  if (unmeasuredReason) {
    return deposit(key, 'conflicting', [`spend figure present but flagged unmeasured: ${unmeasuredReason}`], evidence);
  }
  if (lineageCents !== null && lineageCents !== spentCents) {
    return deposit(key, 'conflicting', [`spentCents ${spentCents} differs from authoritative lineage ${lineageCents}`], evidence);
  }
  if (snap.goal.budgetCents !== null && snap.goal.budgetCents > 0 && !snap.goal.standing && spentCents > snap.goal.budgetCents) {
    return deposit(key, 'conflicting', [`spend ${spentCents} exceeds the goal ceiling ${snap.goal.budgetCents}`], evidence);
  }
  const closureAt = snap.goal.dispositionAtMs ?? snap.goal.updatedAtMs;
  if (isTerminalGoalStatus(snap.goal.status)) {
    if (spentAtMs < closureAt - 5 * MINUTE_MS) {
      return deposit(key, 'stale', ['spend snapshot predates the closure'], evidence);
    }
  } else if (snap.observedAtMs - spentAtMs > opts.maxSpendAgeMs) {
    return deposit(key, 'stale', [`spend snapshot is ${Math.round((snap.observedAtMs - spentAtMs) / MINUTE_MS)}m old`], evidence);
  }
  return deposit(key, 'present', [], evidence);
}

function evaluateOwnerReport(snap: GoalEscrowSnapshot): GoalEscrowDeposit {
  const key = 'owner_report_or_not_required' as const;
  if (!snap.ownerReportRequired) {
    return deposit(key, 'present', [`not required: ${snap.ownerReportNotRequiredReason ?? 'no reason recorded'}`], ['required=false']);
  }
  const complete = snap.ownerReports.filter((report) => report.diagnosis === 'complete');
  const misdirected = snap.ownerReports.filter(
    (report) => report.diagnosis === 'wrong-goal' || report.diagnosis === 'unstamped-complete',
  );
  const evidence = [`reports=${snap.ownerReports.length}`, `complete=${complete.length}`, `misdirected=${misdirected.length}`];
  if (complete.length === 0) {
    if (misdirected.length > 0) {
      return deposit(key, 'conflicting', ['reports exist but none is vouched for as this goal\'s own'], evidence);
    }
    return deposit(key, 'missing', ['no complete owner report names this goal'], evidence);
  }
  const lastClose = lastDeliveredCloseMs(snap.workItems);
  const newest = Math.max(...complete.map((report) => report.atMs));
  if (lastClose !== null && newest < lastClose) {
    return deposit(key, 'stale', ['newest complete owner report predates the last delivered close'], evidence);
  }
  return deposit(key, 'present', [], evidence);
}

function evaluateClosure(snap: GoalEscrowSnapshot): GoalEscrowDeposit {
  const key = 'closure_verdict' as const;
  const { status, disposition, closureReason, dispositionAtMs } = snap.goal;
  const evidence = [`status=${status}`, `disposition=${disposition ?? 'null'}`];
  if (!isTerminalGoalStatus(status)) {
    return deposit(key, 'missing', ['goal is still open: no closure verdict recorded yet'], evidence);
  }
  const dispositionIsFail = disposition !== null && FAIL_GOAL_STATUSES.has(disposition);
  const dispositionIsSuccess = disposition !== null && SUCCESS_GOAL_STATUSES.has(disposition);
  if (SUCCESS_GOAL_STATUSES.has(status) && dispositionIsFail) {
    return deposit(key, 'conflicting', [`status ${status} but the recorded disposition is ${disposition}`], evidence);
  }
  if (FAIL_GOAL_STATUSES.has(status) && dispositionIsSuccess) {
    return deposit(key, 'conflicting', [`status ${status} but the recorded disposition is ${disposition}`], evidence);
  }
  if (disposition === null && !closureReason) {
    return deposit(key, 'missing', [`terminal status ${status} with no recorded disposition or reason`], evidence);
  }
  const lastClose = lastDeliveredCloseMs(snap.workItems);
  if (dispositionAtMs !== null && lastClose !== null && dispositionAtMs < lastClose) {
    return deposit(key, 'stale', ['work was delivered after the closure verdict was recorded'], evidence);
  }
  return deposit(key, 'present', [], evidence);
}

function claimedVerdictFor(status: string): GoalEscrowVerdict | null {
  if (SUCCESS_GOAL_STATUSES.has(status)) return 'close';
  if (FAIL_GOAL_STATUSES.has(status)) return 'fail';
  if (BLOCKED_GOAL_STATUSES.has(status)) return 'block';
  return null;
}

export function evaluateGoalEscrow(snapshot: GoalEscrowSnapshot, options: GoalEscrowOptions = {}): GoalEscrowResult {
  const opts: Required<GoalEscrowOptions> = {
    maxGateAgeMs: options.maxGateAgeMs ?? 6 * HOUR_MS,
    maxSpendAgeMs: options.maxSpendAgeMs ?? 30 * MINUTE_MS,
    passScore10: options.passScore10 ?? 6,
    maxGradeSpread10: options.maxGradeSpread10 ?? 4,
  };

  const deposits: GoalEscrowDeposit[] = [
    evaluateImplementationDelta(snapshot),
    evaluateGreenProof(snapshot, opts),
    evaluateIndependentGrade(snapshot, opts),
    evaluateSpend(snapshot, opts),
    evaluateOwnerReport(snapshot),
    evaluateClosure(snapshot),
  ];
  const byKey = new Map(deposits.map((d) => [d.key, d] as const));
  const evidenceKeys = GOAL_ESCROW_DEPOSIT_KEYS.filter((k) => k !== 'closure_verdict');
  const evidenceDeposits = evidenceKeys.map((k) => byKey.get(k) as GoalEscrowDeposit);
  const closure = byKey.get('closure_verdict') as GoalEscrowDeposit;

  const verdictReasons: string[] = [];
  let verdict: GoalEscrowVerdict;
  const conflicts = deposits.filter((d) => d.state === 'conflicting');
  if (FAIL_GOAL_STATUSES.has(snapshot.goal.status) && closure.state === 'present') {
    verdict = 'fail';
    verdictReasons.push(`goal status ${snapshot.goal.status} with a recorded closure verdict`);
  } else if (conflicts.length > 0) {
    verdict = 'insufficient';
    verdictReasons.push(...conflicts.map((d) => `${d.key} conflicting: ${d.reasons.join('; ')}`));
  } else if (evidenceDeposits.every((d) => d.state === 'present')) {
    const noGo = byKey.get('green_proof_or_no_go_reason')?.noGo === true;
    verdict = noGo ? 'block' : 'close';
    verdictReasons.push(noGo ? 'all evidence present, but the tree carries a bounded no-go reason' : 'all five evidence deposits are present');
  } else {
    verdict = 'insufficient';
    for (const d of evidenceDeposits.filter((x) => x.state !== 'present')) {
      verdictReasons.push(`${d.key} ${d.state}${d.reasons.length ? `: ${d.reasons.join('; ')}` : ''}`);
    }
  }

  const claimedVerdict = claimedVerdictFor(snapshot.goal.status);
  let agreement: GoalEscrowAgreement;
  if (claimedVerdict === null) agreement = verdict === 'close' ? 'ready-unclosed' : 'in-progress';
  else if (claimedVerdict === verdict) agreement = 'match';
  else if (verdict === 'insufficient') agreement = 'unsupported';
  else agreement = 'divergent';

  // A still-open goal is SUPPOSED to lack a closure verdict; flagging it would make
  // every active goal "ambiguous" and bury the real findings.
  const openGoal = claimedVerdict === null;
  const actionable = deposits
    .filter((d) => d.state !== 'present' && d.unmeasured !== true && !(openGoal && d.key === 'closure_verdict'))
    .map((d) => `${d.key}:${d.state}`);
  const unmeasured = deposits.filter((d) => d.unmeasured === true).map((d) => d.key);

  return {
    schemaVersion: GOAL_ESCROW_SCHEMA_VERSION,
    goalId: snapshot.goal.id,
    goalStatus: snapshot.goal.status,
    observedAtMs: snapshot.observedAtMs,
    deposits,
    verdict,
    verdictReasons,
    claimedVerdict,
    agreement,
    overclaimsClose: claimedVerdict === 'close' && verdict !== 'close',
    actionable,
    unmeasured,
  };
}

export interface GoalEscrowSampleSummary {
  goalsEvaluated: number;
  goalsWithActionable: number;
  byAgreement: Record<GoalEscrowAgreement, number>;
  byVerdict: Record<GoalEscrowVerdict, number>;
  overclaimsClose: number;
  /** Goals with at least one deposit resting on an incomplete read. Never counted as findings. */
  goalsWithUnmeasured: number;
  /** Goals whose status matches the escrow verdict AND have nothing actionable. */
  matchesWithoutAmbiguity: number;
  /** `key:state` -> number of goals showing it; the shape of what the sample revealed. */
  depositFindings: Record<string, number>;
  /**
   * The experiment's falsification test: the idea is wrong if the sample shows no
   * actionable deposit anywhere, or if every goal's verdict matches its status with
   * no ambiguity. False when the sample is empty (nothing was tested).
   */
  falsified: boolean;
  exemplars: { goalId: string; agreement: GoalEscrowAgreement; verdict: GoalEscrowVerdict; actionable: string[] }[];
}

export function summarizeGoalEscrowSample(results: readonly GoalEscrowResult[]): GoalEscrowSampleSummary {
  const byAgreement: Record<GoalEscrowAgreement, number> = {
    match: 0,
    unsupported: 0,
    divergent: 0,
    'in-progress': 0,
    'ready-unclosed': 0,
  };
  const byVerdict: Record<GoalEscrowVerdict, number> = { close: 0, block: 0, fail: 0, insufficient: 0 };
  const depositFindings: Record<string, number> = {};
  let goalsWithActionable = 0;
  let overclaimsClose = 0;
  let matchesWithoutAmbiguity = 0;
  let goalsWithUnmeasured = 0;
  for (const result of results) {
    byAgreement[result.agreement] += 1;
    byVerdict[result.verdict] += 1;
    if (result.unmeasured.length > 0) goalsWithUnmeasured += 1;
    if (result.actionable.length > 0) goalsWithActionable += 1;
    if (result.overclaimsClose) overclaimsClose += 1;
    if (result.agreement === 'match' && result.actionable.length === 0) matchesWithoutAmbiguity += 1;
    for (const finding of result.actionable) depositFindings[finding] = (depositFindings[finding] ?? 0) + 1;
  }
  const n = results.length;
  return {
    goalsEvaluated: n,
    goalsWithActionable,
    byAgreement,
    byVerdict,
    overclaimsClose,
    goalsWithUnmeasured,
    matchesWithoutAmbiguity,
    depositFindings,
    // An incomplete read can only HIDE findings, so it can never support "no findings":
    // falsification is withheld while any goal in the sample carried an unmeasured deposit.
    falsified: n > 0 && goalsWithUnmeasured === 0 && (goalsWithActionable === 0 || matchesWithoutAmbiguity === n),
    exemplars: results
      .filter((r) => r.agreement === 'unsupported' || r.agreement === 'divergent' || r.agreement === 'ready-unclosed')
      .map((r) => ({ goalId: r.goalId, agreement: r.agreement, verdict: r.verdict, actionable: r.actionable })),
  };
}
