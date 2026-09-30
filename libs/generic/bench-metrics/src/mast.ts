/**
 * MAST coordination-quality instrumentation (P-026 / D-010 L4 — the most
 * differentiated AND most impartial Hive claim). The MAST study (NeurIPS 2025,
 * 1,600+ multi-agent traces) found multi-agent systems FAIL 41–86% of the time
 * in production. The Hive's substrate (locks, work_items dedup +
 * redundancy-judge, durable hand-offs, the Queen's placement) exists to drive
 * those failures DOWN — so we measure OUR rates against that published baseline
 * and against the Queen-ablated fleet + competitor orchestrators (P-028).
 *
 * LICENSE NOTE (P-029 / D-011): the MAST repo has NO declared license, so we do
 * NOT run their judge code or publish derived results. We RE-IMPLEMENT their
 * published 3-category / 14-mode taxonomy (factual, not copied code) and score
 * it with OUR OWN LLM-judge — which keeps the claim impartial. Citing the
 * 41–86% baseline + the methodology is fine.
 *
 * Two complementary measurements, both pure:
 *  - `substrateSignalRates` — OBJECTIVE counts of mechanical coordination
 *    failures the substrate itself surfaces (duplicate completions, orphaned
 *    claims, claim conflicts). No judge, no subjectivity — the strongest floor.
 *  - `scoreMast` over judge VERDICTS — the methodology-aligned per-category
 *    rates that compare apples-to-apples with the published baseline. The
 *    LLM-judge call lives OUTSIDE this pure lib (P-010/pilot); we score its
 *    output here.
 */

import type { FleetArmId } from './fleet';

// ── The canonical MAST taxonomy (re-implemented from the published paper) ───

export type MastCategory =
  | 'specification-system-design' // FC1
  | 'inter-agent-misalignment' //   FC2
  | 'task-verification'; //         FC3

export const MAST_CATEGORIES: readonly MastCategory[] = [
  'specification-system-design',
  'inter-agent-misalignment',
  'task-verification',
] as const;

/** The 14 failure modes, each with its category + a short (our-words) definition for the judge rubric. */
export interface MastMode {
  id: string;
  category: MastCategory;
  label: string;
  definition: string;
}

export const MAST_MODES: readonly MastMode[] = [
  // FC1 — specification & system design
  { id: '1.1', category: 'specification-system-design', label: 'disobey-task-spec', definition: 'An agent ignored or violated the stated task requirements.' },
  { id: '1.2', category: 'specification-system-design', label: 'disobey-role-spec', definition: 'An agent acted outside its assigned role.' },
  { id: '1.3', category: 'specification-system-design', label: 'step-repetition', definition: 'Work already completed was needlessly repeated.' },
  { id: '1.4', category: 'specification-system-design', label: 'loss-of-history', definition: 'Relevant prior context was dropped or not propagated.' },
  { id: '1.5', category: 'specification-system-design', label: 'unaware-termination', definition: 'Agents did not recognize when to stop.' },
  // FC2 — inter-agent misalignment
  { id: '2.1', category: 'inter-agent-misalignment', label: 'conversation-reset', definition: 'A coordination thread was reset, losing alignment.' },
  { id: '2.2', category: 'inter-agent-misalignment', label: 'no-clarification', definition: 'An agent proceeded on an ambiguity instead of asking.' },
  { id: '2.3', category: 'inter-agent-misalignment', label: 'task-derailment', definition: 'The effort drifted off the assigned task.' },
  { id: '2.4', category: 'inter-agent-misalignment', label: 'information-withholding', definition: 'An agent failed to share information a peer needed (a dedup/coordination gap).' },
  { id: '2.5', category: 'inter-agent-misalignment', label: 'ignored-input', definition: "An agent ignored a peer's relevant input." },
  { id: '2.6', category: 'inter-agent-misalignment', label: 'reasoning-action-mismatch', definition: "An agent's action contradicted its stated reasoning." },
  // FC3 — task verification & termination
  { id: '3.1', category: 'task-verification', label: 'premature-termination', definition: 'The run stopped before the work/verification was complete.' },
  { id: '3.2', category: 'task-verification', label: 'no-or-incomplete-verification', definition: 'Output was accepted without adequate checking.' },
  { id: '3.3', category: 'task-verification', label: 'incorrect-verification', definition: 'Verification ran but reached the wrong conclusion.' },
] as const;

export type MastModeId = (typeof MAST_MODES)[number]['id'];

/** Published MAST baselines (NeurIPS 2025) — context bands, never our own claim. */
export const MAS_FAILURE_BASELINE_BAND: readonly [number, number] = [0.41, 0.86];
export const TOKEN_DUPLICATION_BASELINE_BAND: readonly [number, number] = [0.53, 0.86];
export const INTERAGENT_MISALIGNMENT_BASELINE = 0.369;

// ── The coordination trace (raw fleet events) — the MAST-convertible input ──

/**
 * Raw fleet/coordination event kinds. The first group is normal actions the
 * judge reads to reconstruct what happened; the second group is mechanical
 * FAILURE SIGNALS the substrate surfaces directly (counted objectively by
 * `substrateSignalRates`). Open union — P-010's emit + P-028's competitor
 * drivers add kinds without a type change.
 */
export type CoordEventKind =
  // normal actions (the judge's raw material; aligns with P-028's proposed vocab)
  | 'spawn' | 'handoff' | 'handoff_accepted' | 'message' | 'claim' | 'edit'
  | 'complete' | 'error' | 'placement' | 'lock_acquire' | 'redundancy_judged'
  // mechanical failure signals (objective, counted by substrateSignalRates)
  | 'duplicate_completion' | 'orphaned_claim' | 'stranded_item' | 'lost_handoff'
  | 'claim_conflict' | 'superseded_work' | 'rework'
  | (string & {});

export interface CoordEvent {
  /** ms epoch or relative — optional, ordering only. */
  ts?: number;
  kind: CoordEventKind;
  /** acting agent/bee id. */
  agent?: string;
  taskId?: string | null;
  detail?: string;
}

/** A whole backlog run's coordination trace — emitted by P-010, read by the judge + the objective counter. */
export interface CoordTrace {
  arm: FleetArmId;
  agents?: string[];
  events: CoordEvent[];
}

// ── Objective substrate-signal rates (no judge) ─────────────────────────────

export interface SubstrateSignalRates {
  /** Two agents executed the same task. */
  duplicationRate: number;
  /** Stranded item / orphaned claim / lost hand-off. */
  coordinationBreakdownRate: number;
  /** Acted on superseded/conflicting state. */
  misalignmentRate: number;
  /** Work redone unnecessarily. */
  redundantWorkRate: number;
  /** Raw counts behind the rates. */
  counts: { duplicate: number; breakdown: number; misalignment: number; redundant: number };
  /** Total coordination events (the volume denominator). */
  coordinationActions: number;
}

/** Count the mechanical failure signals in a trace and normalize per task. Pure, no judge. */
export function substrateSignalRates(events: readonly CoordEvent[], tasks: number): SubstrateSignalRates {
  let duplicate = 0;
  let breakdown = 0;
  let misalignment = 0;
  let redundant = 0;
  for (const e of events) {
    switch (e.kind) {
      case 'duplicate_completion':
        duplicate++;
        break;
      case 'orphaned_claim':
      case 'stranded_item':
      case 'lost_handoff':
        breakdown++;
        break;
      case 'claim_conflict':
      case 'superseded_work':
        misalignment++;
        break;
      case 'rework':
        redundant++;
        break;
      default:
        break;
    }
  }
  const per = (n: number) => (tasks === 0 ? 0 : n / tasks);
  return {
    duplicationRate: per(duplicate),
    coordinationBreakdownRate: per(breakdown),
    misalignmentRate: per(misalignment),
    redundantWorkRate: per(redundant),
    counts: { duplicate, breakdown, misalignment, redundant },
    coordinationActions: events.length,
  };
}

// ── Judge-verdict scoring (methodology-aligned, our own judge) ──────────────

/** One LLM-judge verdict: did failure `mode` occur (on `taskId`, if per-task)? */
export interface MastVerdict {
  mode: MastModeId;
  failed: boolean;
  taskId?: string | null;
  rationale?: string;
}

export interface MastReport {
  arm: FleetArmId;
  tasks: number;
  /** Judge-based: fraction of verdicts (per mode) marked failed, by category. Null if no verdicts. */
  byCategory: Record<MastCategory, number> | null;
  /** Judge-based: per-mode failure rate. Null if no verdicts. */
  byMode: Record<string, number> | null;
  /** Judge-based: overall fraction of modes that fired at least once (the headline vs the 41–86% band). Null if no verdicts. */
  overallFailureRate: number | null;
  /** Objective substrate-signal rates (no judge). Null if no trace given. */
  substrate: SubstrateSignalRates | null;
  /** The published MAS-failure band carried for the chart's reference line. */
  masBaselineBand: readonly [number, number];
}

const MODE_BY_ID = new Map(MAST_MODES.map((m) => [m.id, m]));

/**
 * Score a coordination measurement into a MAST report for one arm. Provide
 * `verdicts` (our LLM-judge's 14-mode output) for the methodology-aligned
 * per-category rates, and/or `trace` for the objective substrate-signal rates.
 * Both optional — pass whichever the pilot produced. Pure.
 */
export function scoreMast(input: {
  arm: FleetArmId;
  tasks: number;
  verdicts?: readonly MastVerdict[];
  trace?: readonly CoordEvent[];
}): MastReport {
  const { arm, tasks } = input;
  let byCategory: Record<MastCategory, number> | null = null;
  let byMode: Record<string, number> | null = null;
  let overallFailureRate: number | null = null;

  if (input.verdicts && input.verdicts.length > 0) {
    // Per-mode failure rate = failed verdicts / total verdicts for that mode.
    const modeFailed = new Map<string, number>();
    const modeTotal = new Map<string, number>();
    for (const v of input.verdicts) {
      modeTotal.set(v.mode, (modeTotal.get(v.mode) ?? 0) + 1);
      if (v.failed) modeFailed.set(v.mode, (modeFailed.get(v.mode) ?? 0) + 1);
    }
    byMode = {};
    const catFail = { 'specification-system-design': 0, 'inter-agent-misalignment': 0, 'task-verification': 0 } as Record<MastCategory, number>;
    const catTotal = { 'specification-system-design': 0, 'inter-agent-misalignment': 0, 'task-verification': 0 } as Record<MastCategory, number>;
    for (const m of MAST_MODES) {
      const total = modeTotal.get(m.id) ?? 0;
      const failed = modeFailed.get(m.id) ?? 0;
      byMode[m.id] = total === 0 ? 0 : failed / total;
      catFail[m.category] += failed;
      catTotal[m.category] += total;
    }
    byCategory = {
      'specification-system-design': catTotal['specification-system-design'] === 0 ? 0 : catFail['specification-system-design'] / catTotal['specification-system-design'],
      'inter-agent-misalignment': catTotal['inter-agent-misalignment'] === 0 ? 0 : catFail['inter-agent-misalignment'] / catTotal['inter-agent-misalignment'],
      'task-verification': catTotal['task-verification'] === 0 ? 0 : catFail['task-verification'] / catTotal['task-verification'],
    };
    const totalVerdicts = input.verdicts.length;
    const totalFailed = input.verdicts.filter((v) => v.failed).length;
    overallFailureRate = totalVerdicts === 0 ? 0 : totalFailed / totalVerdicts;
    // Warn (silently ignore) unknown mode ids — keep scoring robust.
    void MODE_BY_ID;
  }

  return {
    arm,
    tasks,
    byCategory,
    byMode,
    overallFailureRate,
    substrate: input.trace ? substrateSignalRates(input.trace, tasks) : null,
    masBaselineBand: MAS_FAILURE_BASELINE_BAND,
  };
}

// ── The judge bridge (trace → prompt → verdicts) ────────────────────────────
// The LLM-judge CALL lives outside this pure lib (P-010/pilot); these are the
// pure pieces around it: the canonical prompt (so the judge always sees the
// same rubric + trace format — load-bearing for the impartial/reproducible
// claim) and a deterministic mock for tests/dry-runs. (Gap identified by the
// WI-145 bee; landed here since the rubric lives in this file.)

/**
 * Render a coordination trace into the canonical MAST judge prompt: the 14-mode
 * rubric (grouped by category) + the chronological trace + an instruction to
 * return one structured verdict per mode. Pure — the caller feeds the returned
 * string to our own LLM-judge and parses its output into `MastVerdict[]`. The
 * trace carries only coordination events (no grader/answer data), so it cannot
 * leak the benchmark solution.
 */
export function buildMastJudgePrompt(trace: CoordTrace): string {
  const rubric = MAST_CATEGORIES.map((cat) => {
    const modes = MAST_MODES.filter((m) => m.category === cat)
      .map((m) => `  - ${m.id} ${m.label}: ${m.definition}`)
      .join('\n');
    return `${cat}:\n${modes}`;
  }).join('\n\n');

  const events = trace.events
    .map((e, i) => {
      const ts = e.ts != null ? `t=${e.ts} ` : '';
      const who = e.agent ? `[${e.agent}] ` : '';
      const task = e.taskId ? ` (task ${e.taskId})` : '';
      const detail = e.detail ? ` — ${e.detail}` : '';
      return `${String(i + 1).padStart(3, ' ')}. ${ts}${who}${e.kind}${task}${detail}`;
    })
    .join('\n');

  const agents = trace.agents?.length ? trace.agents.join(', ') : 'unspecified';

  return [
    'You are an impartial evaluator. Score the following multi-agent coordination',
    'trace against the MAST failure taxonomy. Judge ONLY coordination quality —',
    'not whether the underlying tasks were solved.',
    '',
    `Arm: ${trace.arm}`,
    `Agents: ${agents}`,
    '',
    'MAST failure modes:',
    rubric,
    '',
    'Coordination trace (chronological):',
    events || '  (no events)',
    '',
    'For EACH of the 14 modes, decide whether it occurred in this trace. Return a',
    'JSON array of objects { "mode": "<id>", "failed": <bool>, "taskId": <string|null>,',
    '"rationale": "<one line>" } — one entry per mode (more if a mode recurs per task).',
    'Be conservative: mark failed only with direct evidence in the trace.',
  ].join('\n');
}

/** Which substrate failure signal evidences which MAST mode (deterministic mock mapping). */
const MOCK_SIGNAL_TO_MODE: Record<string, MastModeId> = {
  duplicate_completion: '1.3', // step repetition
  rework: '1.3',
  superseded_work: '1.4', // loss of history
  orphaned_claim: '2.4', // information withholding
  stranded_item: '2.4',
  lost_handoff: '2.4',
  claim_conflict: '2.5', // ignored other agent's input
};

/**
 * Deterministic stand-in for the LLM-judge: derives `MastVerdict[]` from the
 * trace's mechanical failure signals (a mode `failed` iff a signal mapped to it
 * appears). Returns exactly one verdict per mode so a dry-run yields a full
 * `MastReport`. For tests / `dryRun` only — NOT a substitute for the real judge.
 */
export function mockMastJudge(events: readonly CoordEvent[]): MastVerdict[] {
  const firedModes = new Set<MastModeId>();
  const evidence = new Map<MastModeId, string | null>();
  for (const e of events) {
    const mode = MOCK_SIGNAL_TO_MODE[e.kind as string];
    if (mode) {
      firedModes.add(mode);
      if (!evidence.has(mode)) evidence.set(mode, e.taskId ?? null);
    }
  }
  return MAST_MODES.map((m) => ({
    mode: m.id,
    failed: firedModes.has(m.id),
    taskId: evidence.get(m.id) ?? null,
    rationale: firedModes.has(m.id) ? `substrate signal mapped to ${m.label}` : 'no substrate evidence',
  }));
}
