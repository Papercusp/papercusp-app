/**
 * run-core — the pure, injectable core of experiment:run (`experiment-registry-
 * invocation-api` P-031/P-040/P-041/P-063). The tool handler is a thin wrapper; this is
 * unit-tested with fakes ($0).
 *
 * Cost discipline (Phase 4): OFFLINE replay is the DEFAULT front door (`tier` defaults
 * to 'offline', P-040). The offline path rides the existing frontier:replay-harness
 * gates — it routes through `runGovernedReplay`, which preflights the replay flag + the
 * learning-governor budget (refusing — with NO spend — when dark/unbudgeted/exhausted)
 * and ledgers the spend origin='replay'. Escalating to a spending tier (shadow/live) is
 * gated by the fidelity-tier escalation discipline (P-041, `tier-escalation.ts`): only on
 * a positive offline signal or a written couldn't-isolate trigger, with whole-instance/
 * whole-Hive a further cost-exception. A live tier also fail-closes on the learning-
 * governor (D-008). So this verb inherits the rails rather than re-implementing them.
 *
 * The live tiers (gym/instance/hive) delegate to the descriptor's `run` with the
 * operator-bound ctx (P-063); gym is the reachable worked example (un-staged by injecting
 * `ctx.gym.abDeps`), instance/hive stay staged behind their own infra/loops (D-017).
 *
 * A winning arm is only ever a PROPOSAL — applying it to live prompts/policy rides
 * commit→reproject + the change ledger + trust graduation, never this verb (D-006).
 */
import { BASELINE_ID, type FidelityTier, requireTest, type TestDescriptor, type TestMetrics } from '@papercusp/eval-battery';
import { REPLAY_BASELINE_VARIANT, type ReplayBatteryDeps } from '../replay/battery';
import { runGovernedReplay, type ReplayGlueDeps } from '../replay/governed';
import type { ReplayCase, ReplayRunner, ReplayVariant } from '../replay/types';
import { armToReplayVariant, registerExperimentDescriptors, replayResultToExperimentResult } from './descriptors';
import { partitionArm, validateArm } from './knob-space';
import { evaluateTierEscalation, type TierEscalation } from './tier-escalation';
import type { ExperimentLedger } from './ledger';
import type { ExperimentRequest, ExperimentRunCtx, ExperimentRunResult } from './types';
import type { GovernorVerdict } from '../learning-governor/core';

export interface RunExperimentArm {
  id: string;
  label?: string;
  knobs: Record<string, unknown>;
}

/** A synthetic battery case (v1): a constructed context + the task intent the judge
 *  scores against. (Historical replay-by-ref is a follow-on.) */
export interface RunExperimentSyntheticCase {
  caseId: string;
  context: string;
  intent: string;
  projectContext?: string;
}

export interface RunExperimentInput {
  testId: string;
  batteryId: string;
  arms: RunExperimentArm[];
  cases: RunExperimentSyntheticCase[];
  repeats: number;
  /** The fidelity tier to run at — defaults to 'offline' (the cheap default front door,
   *  P-040/D-004). MUST match the resolved test's `fidelityTier`: a spending tier
   *  (shadow/live) cannot be reached by naming a testId alone, only by consciously
   *  declaring it here (and then it trips the escalation gate, P-041). */
  tier?: FidelityTier;
  /** The justification for leaving the offline tier (P-041) — required for shadow/live. */
  escalation?: TierEscalation;
  budgetUsd?: number;
  maxDistillChars?: number;
  /** Subject-specific battery input for the LIVE tiers (gym tasks / instance baseSpec+
   *  corpus / hive scenario). Opaque here — the descriptor casts it. The offline tier
   *  builds its battery from `cases`, so it ignores this. */
  payload?: unknown;
  /** Validate + expand the battery and return the plan WITHOUT spending (no substrate
   *  call, no ledger write). Lets you author + check an experiment before arming spend. */
  dryRun?: boolean;
}

export interface RunExperimentDeps {
  runGovernedReplay: typeof runGovernedReplay;
  replayRunner: ReplayRunner;
  judge: ReplayBatteryDeps['llmCall'];
  now?: () => number;
  glue?: ReplayGlueDeps;
  /** Cell-lifecycle store. Omit → the governed substrate uses PgReplayStore; an
   *  integration test (or a future ledger writer) injects its own. */
  store?: ReplayBatteryDeps['store'];
  /** The experiment ledger (P-050). When present, a finished run writes its
   *  run-level summary row (best-effort — a ledger failure never loses the result). */
  ledger?: ExperimentLedger;
  /** Fail-closed budget gate for the LIVE tiers (D-008 / P-041). Default = the real
   *  learning-governor preflight (lazy-loaded only on the live path). A test injects a
   *  fake; the offline path never calls it (it rides runGovernedReplay's own gate). */
  governorPreflight?: (q: { workspaceId: string; loopId: string; floorUsd?: number }) => Promise<GovernorVerdict>;
  /** The live-tier ctx dep slots (P-063). Absent in v1 ⇒ the live descriptors refuse
   *  (staged). The gym slot un-stages the gym tier when the owner arms it. */
  live?: {
    gym?: ExperimentRunCtx['gym'];
    instance?: ExperimentRunCtx['instance'];
    hive?: ExperimentRunCtx['hive'];
  };
  /** Optional sink for rubric-graded experiment result scorecards. Best-effort. */
  captureScorecard?: (input: ExperimentScorecardCapture) => Promise<unknown>;
}

export interface ExperimentScorecardCapture {
  workspaceId: string;
  batteryId: string;
  testId: string;
  tier: FidelityTier;
  rubricRef: string;
  ratings: Record<string, { rating: string; evidence: string }>;
}
type ExperimentScorecardDraft = Omit<ExperimentScorecardCapture, 'workspaceId'>;

/** The expansion a dry-run returns — what WOULD run, with no spend. */
export interface RunExperimentPlan {
  testId: string;
  tier: string;
  arms: { id: string; label: string; model: string | null }[];
  caseCount: number;
  repeats: number;
  /** variants × cases × repeats — the battery cell count. */
  totalCells: number;
}

export interface RunExperimentOutcome {
  ok: boolean;
  /** Set when the governed substrate / governor refused (flag off / unbudgeted /
   *  exhausted) — a refusal NEVER spends. */
  refused?: { reason?: string };
  error?: string;
  result?: ExperimentRunResult;
  /** Set on a dryRun: the validated battery plan, no spend. */
  plan?: RunExperimentPlan;
}

/** The first `model.<role>` value on an arm (null when none) — for the dry-run plan +
 *  tier-agnostic reporting. */
function armModel(arm: RunExperimentArm): string | null {
  if (Object.keys(arm.knobs).length === 0) return null;
  const { models } = partitionArm({ id: arm.id, knobs: arm.knobs });
  return Object.values(models)[0] ?? null;
}

export async function runExperiment(
  input: RunExperimentInput,
  ctx: { workspaceId: string },
  deps: RunExperimentDeps,
): Promise<RunExperimentOutcome> {
  registerExperimentDescriptors();

  let descriptor: TestDescriptor;
  try {
    descriptor = requireTest(input.testId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // P-040 — offline is the default front door. The requested tier defaults to 'offline'
  // and MUST match the test's own fidelity tier: you cannot reach a spending tier by
  // naming a testId alone (e.g. `testId:'gym'` without `tier:'live'`) — that is a refusal
  // that points you at the cheap default, so spend is always a conscious declaration.
  const requestedTier: FidelityTier = input.tier ?? 'offline';
  if (requestedTier !== descriptor.fidelityTier) {
    return {
      ok: false,
      error:
        `the "${input.testId}" test runs at the ${descriptor.fidelityTier} tier, but tier="${requestedTier}" was requested. ` +
        `Offline replay is the default front door (P-040/D-004) — screen knob changes there first; ` +
        `set tier:"${descriptor.fidelityTier}" to consciously run this test's tier` +
        (descriptor.fidelityTier !== 'offline' ? ` (a spending tier — it also requires escalation justification, P-041).` : `.`),
    };
  }

  // Slice + safety check BEFORE any spend (P-021) — also before the dry-run return.
  for (const arm of input.arms) {
    const v = validateArm({ id: arm.id, knobs: arm.knobs }, descriptor.knobSlice);
    if (!v.ok) {
      const bad = [...v.outOfSlice, ...v.excluded.map((x) => `${x} (safety-excluded)`)].join(', ');
      return { ok: false, error: `arm "${arm.id}" has knobs outside the "${input.testId}" slice: ${bad}` };
    }
  }

  // Dry-run: descriptor resolution + tier match + arm validation have run — return the
  // tier-agnostic battery plan with NO escalation/governor gate (a dry-run never spends,
  // so authoring/planning a live experiment is free) and NO substrate call. (P-064)
  if (input.dryRun) {
    const planArms = input.arms.map((a) => ({ id: a.id, label: a.label ?? a.id, model: armModel(a) }));
    if (!planArms.some((a) => a.id === BASELINE_ID)) planArms.unshift({ id: BASELINE_ID, label: 'baseline', model: null });
    return {
      ok: true,
      plan: {
        testId: input.testId,
        tier: descriptor.fidelityTier,
        arms: planArms,
        caseCount: input.cases.length,
        repeats: input.repeats,
        totalCells: planArms.length * input.cases.length * input.repeats,
      },
    };
  }

  // P-041 — the fidelity-tier escalation discipline. Offline is free; a spending tier
  // needs a positive offline signal or a written couldn't-isolate trigger, and the
  // whole-instance/whole-Hive kinds are the further gated cost-exception (D-002).
  const esc = evaluateTierEscalation({ requestedTier, kind: descriptor.kind, ...(input.escalation ? { escalation: input.escalation } : {}) });
  if (!esc.ok) return { ok: false, refused: { reason: esc.reason } };

  // ---- offline (replay) tier — the workhorse, rides the governed replay substrate ----
  if (descriptor.fidelityTier === 'offline') {
    const variants: ReplayVariant[] = input.arms.map((a) =>
      armToReplayVariant({ id: a.id, ...(a.label !== undefined ? { label: a.label } : {}), knobs: a.knobs }),
    );
    // compareArms needs the baseline anchor — prepend it when the caller gave only candidates.
    if (!variants.some((v) => v.variantId === BASELINE_ID)) variants.unshift(REPLAY_BASELINE_VARIANT);

    const cases: ReplayCase[] = input.cases.map((c) => ({
      kind: 'synthetic',
      caseId: c.caseId,
      context: c.context,
      intent: c.intent,
      ...(c.projectContext !== undefined ? { projectContext: c.projectContext } : {}),
    }));

    const { verdict, result } = await deps.runGovernedReplay(
      {
        workspaceId: ctx.workspaceId,
        config: {
          batteryId: input.batteryId,
          variants,
          cases,
          repeats: input.repeats,
          ...(input.budgetUsd !== undefined ? { maxSpendUsd: input.budgetUsd } : {}),
          ...(input.maxDistillChars !== undefined ? { maxDistillChars: input.maxDistillChars } : {}),
        },
      },
      {
        runner: deps.replayRunner,
        llmCall: deps.judge,
        now: deps.now ?? (() => Date.now()),
        ...(deps.store ? { store: deps.store } : {}),
      },
      deps.glue,
    );

    if (!result) return { ok: false, refused: { reason: verdict.reason } };
    return await writeLedgerAndReturn(replayResultToExperimentResult(result), input, ctx, deps, descriptor.metrics);
  }

  // ---- live tiers (gym/instance/hive) — fail-closed governor gate, then delegate ----
  // The governor is the upstream budget rail (D-008): a live experiment must have an
  // armed `experiment:<testId>` budget, else it refuses with NO spend. (Completes the
  // non-offline half P-033 deferred.) The descriptor itself then refuses if its live
  // deps are unbound (gym needs ctx.gym.abDeps; instance/hive are staged, D-017).
  const preflight = deps.governorPreflight ?? (await defaultGovernorPreflight());
  const verdict = await preflight({ workspaceId: ctx.workspaceId, loopId: `experiment:${input.testId}` });
  if (!verdict.allow) return { ok: false, refused: { reason: verdict.reason ?? 'governor-refused' } };

  const request: ExperimentRequest = {
    batteryId: input.batteryId,
    arms: input.arms.map((a) => ({ id: a.id, ...(a.label !== undefined ? { label: a.label } : {}), knobs: a.knobs })),
    repeats: input.repeats,
    ...(input.maxDistillChars !== undefined ? { maxDistillChars: input.maxDistillChars } : {}),
    ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
    payload: input.payload,
  };
  const runCtx: ExperimentRunCtx = {
    workspaceId: ctx.workspaceId,
    now: deps.now ?? (() => Date.now()),
    llmCall: deps.judge,
    replayRunner: deps.replayRunner,
    ...(deps.live?.gym ? { gym: deps.live.gym } : {}),
    ...(deps.live?.instance ? { instance: deps.live.instance } : {}),
    ...(deps.live?.hive ? { hive: deps.live.hive } : {}),
  };
  let result: ExperimentRunResult;
  try {
    result = (await descriptor.run(request, runCtx)) as ExperimentRunResult;
  } catch (e) {
    // A staged descriptor (gym without abDeps; instance/hive) refuses here — no spend.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return await writeLedgerAndReturn(result, input, ctx, deps, descriptor.metrics);
}

/** Lazy-load the real governor preflight only when a live run reaches it. */
async function defaultGovernorPreflight() {
  const { learningGovernorPreflight } = await import('../learning-governor/registrants');
  return learningGovernorPreflight;
}

/** Best-effort ledger write (P-050) — a ledger failure never loses a finished result. */
async function writeLedgerAndReturn(
  normalized: ExperimentRunResult,
  input: RunExperimentInput,
  ctx: { workspaceId: string },
  deps: RunExperimentDeps,
  metrics?: TestMetrics,
): Promise<RunExperimentOutcome> {
  if (deps.ledger) {
    try {
      await deps.ledger.record({
        workspaceId: ctx.workspaceId,
        batteryId: input.batteryId,
        testId: normalized.testId,
        tier: normalized.tier,
        arms: normalized.arms,
        baselineId: normalized.baselineId,
        winner: normalized.winner,
        comparison: normalized.comparison,
        totalCostUsd: normalized.totalCostUsd,
        budgetExhausted: normalized.budgetExhausted,
      });
    } catch {
      // Best-effort: never lose a finished experiment result to a ledger write.
    }
  }
  if (normalized.costMeasured !== false && !normalized.arms.some((arm) => arm.costMeasured === false)) {
    await emitScorecard(normalized, input, ctx, deps, metrics);
  }
  return { ok: true, result: normalized };
}

function normalizedJudgeScore(score: number | null | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  return score >= 0 && score <= 1 ? score * 10 : score;
}

function ratingForScore(score: number | null | undefined): string {
  const s = normalizedJudgeScore(score);
  if (s === null) return 'unknown';
  if (s >= 7) return 'healthy';
  if (s >= 4) return 'degraded';
  return 'broken';
}

function evidenceForScore(input: {
  batteryId: string;
  result: ExperimentRunResult;
  dimension: string;
  selectedArmId: string | null;
  score: number | null | undefined;
}): string {
  const selected = input.selectedArmId ? input.result.arms.find((a) => a.id === input.selectedArmId) : undefined;
  const baseline = input.result.arms.find((a) => a.id === input.result.baselineId);
  const score = normalizedJudgeScore(input.score);
  const scoreText = score === null ? 'no per-dimension score available' : `mean judge score ${score.toFixed(2)}/10`;
  const selectedText = selected
    ? `selected arm ${selected.id} (${selected.scored}/${selected.cells} scored, mean=${selected.meanScore ?? 'null'})`
    : 'no selected arm';
  const baselineText = baseline ? `baseline ${baseline.id} mean=${baseline.meanScore ?? 'null'}` : 'baseline missing';
  return [
    `experiment ${input.result.testId}/${input.batteryId} dimension ${input.dimension}: ${scoreText}`,
    selectedText,
    baselineText,
    `winner=${input.result.winner ?? 'none'} totalCostUsd=${input.result.totalCostUsd}`,
  ].join('; ');
}

function buildExperimentScorecard(
  normalized: ExperimentRunResult,
  input: RunExperimentInput,
  metrics?: TestMetrics,
): ExperimentScorecardDraft | null {
  const rubricRef = metrics?.rubricRef;
  const dimensions = metrics?.rubricDimensions ?? [];
  if (!rubricRef || dimensions.length === 0) return null;
  const selectedArmId = normalized.winner ?? normalized.comparison?.selected ?? normalized.baselineId ?? null;
  const selected = selectedArmId ? normalized.arms.find((a) => a.id === selectedArmId) : undefined;
  const ratings: Record<string, { rating: string; evidence: string }> = {};
  for (const dimension of dimensions) {
    const score = normalized.scorecardScores?.[dimension] ?? selected?.meanScore ?? null;
    ratings[dimension] = {
      rating: ratingForScore(score),
      evidence: evidenceForScore({ batteryId: input.batteryId, result: normalized, dimension, selectedArmId, score }),
    };
  }
  return {
    batteryId: input.batteryId,
    testId: normalized.testId,
    tier: normalized.tier,
    rubricRef,
    ratings,
  };
}

async function emitScorecard(
  normalized: ExperimentRunResult,
  input: RunExperimentInput,
  ctx: { workspaceId: string },
  deps: RunExperimentDeps,
  metrics?: TestMetrics,
): Promise<void> {
  if (!deps.captureScorecard) return;
  const scorecard = buildExperimentScorecard(normalized, input, metrics);
  if (!scorecard) return;
  try {
    await deps.captureScorecard({ workspaceId: ctx.workspaceId, ...scorecard });
  } catch {
    // Best-effort: never lose or fail an experiment verdict because its observation
    // scorecard could not be written.
  }
}
