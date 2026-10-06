/**
 * The replay battery (P-020 / FB-06) — the replay harness as an eval-battery
 * subject (reconciliation D-001: ONE engine, swappable `Subject`; the gym's
 * `ab-runner.ts` is the sibling precedent).
 *
 * A cell = (variant × case × repeat): `run` produces the replayed continuation
 * via the injected {@link ReplayRunner}; `collectAndDistill` computes the
 * deterministic divergence signals against the historical continuation and
 * assembles the judge's distilled trace (context tail + replayed + original);
 * the engine's frozen judge scores it. The BASELINE variant of a historical
 * case never invokes the runner — the original continuation is echoed at zero
 * cost as the comparison anchor, scored by the same judge.
 *
 * Budget-capped by a high-water cutoff: once accumulated runner+judge spend
 * reaches `maxSpendUsd`, every remaining cell refuses BEFORE spending (the
 * engine records it `errored` — never aborting, never silently dropping).
 *
 * Pure orchestration with injected effects (runner, judge llmCall, store,
 * now) — unit-tested end-to-end with fakes, zero LLM/PG.
 */
import {
  BASELINE_ID,
  compareArms,
  runBattery,
  captureSourceHash,
  EVAL_BATTERY_SOURCE_HASHES,
  rubricHash,
  type BatteryCell,
  type BatteryRubric,
  type CompareArm,
  type CompareSelectResult,
  type JudgeLlmCall,
  type RatePauseDeps,
  type Subject,
} from '@papercusp/eval-battery';
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';
import { divergenceSignals, REPLAY_DIVERGENCE_SOURCE_HASH, type DivergenceSignals } from './divergence';
import { cutTranscript, intentFromTranscript, renderTurns, REPLAY_TRANSCRIPT_SOURCE_HASH } from './transcript';
import {
  replayCaseRef,
  type ReplayCase,
  type ReplayRunHandle,
  type ReplayRunInput,
  type ReplayRunner,
  type ReplayStore,
  type ReplayVariant,
} from './types';

/** Original native load receipt; unsupported or unobserved loaders stay unknown. */
export const REPLAY_BATTERY_SOURCE_HASH = captureSourceHash(import.meta.url);

/** The zero-cost historical anchor: echoes the original continuation. */
export const REPLAY_BASELINE_VARIANT: ReplayVariant = {
  variantId: BASELINE_ID,
  label: 'historical baseline',
  policy: {},
};

/** The frozen replay rubric (same canonical judge policy as the gym's V1). */
export const DEFAULT_REPLAY_RUBRIC: BatteryRubric = {
  version: 'replay-v1',
  model: LEARNING_MODEL_SPEC,
  temperature: 0,
  thinkingBudgetTokens: 32_000,
  weights: { d1: 0.5, d2: 0.3, d3: 0.2 },
  dimensions: {
    d1: 'Outcome: does this continuation achieve the task intent (correct, complete, verifiable work)?',
    d2: 'Process: efficient, well-sequenced next steps — no thrash, redundancy, or destructive actions.',
    d3: 'Divergence value: where this continuation departs from the original historical one, does the departure help rather than harm the task?',
  },
};

export const DEFAULT_REPLAY_SYSTEM = [
  'You are an agent resuming work mid-task. The conversation so far (possibly elided) is',
  'given below. Continue the work from exactly this point: decide and narrate your next',
  'steps and their results as the continuation of the same trajectory.',
].join('\n');

/** Assemble the replayed agent's system prompt from the variant's policy. */
export function buildReplaySystemPrompt(variant: ReplayVariant): string {
  if (variant.policy.systemReplace) return variant.policy.systemReplace;
  if (variant.policy.systemOverlay) {
    return `${DEFAULT_REPLAY_SYSTEM}\n\n## Policy under test\n${variant.policy.systemOverlay}`;
  }
  return DEFAULT_REPLAY_SYSTEM;
}

/** Deterministic context rendering for a case (tail survives the cap). */
export function contextTextForCase(replayCase: ReplayCase, maxChars: number): string {
  if (replayCase.kind === 'synthetic') {
    const c = replayCase.context;
    return c.length <= maxChars ? c : c.slice(c.length - maxChars);
  }
  const { context } = cutTranscript(replayCase.transcript, replayCase.turnIndex);
  return renderTurns(context, { maxChars, keep: 'tail' });
}

/** The original continuation (divergence anchor); null for synthetic cases. */
export function continuationTextForCase(replayCase: ReplayCase, maxChars: number): string | null {
  if (replayCase.kind === 'synthetic') return null;
  const { continuation } = cutTranscript(replayCase.transcript, replayCase.turnIndex);
  return renderTurns(continuation, { maxChars, keep: 'head' });
}

function judgeIntent(replayCase: ReplayCase): string {
  if (replayCase.intent) return replayCase.intent;
  return replayCase.kind === 'historical' ? intentFromTranscript(replayCase.transcript) : '';
}

/** Thrown by the budget guard; the engine records the cell `errored`. */
export class ReplayBudgetExceededError extends Error {
  constructor(spentUsd: number, maxSpendUsd: number) {
    super(`replay budget cap reached: spent $${spentUsd.toFixed(4)} of $${maxSpendUsd.toFixed(4)} — cell refused before spending`);
    this.name = 'ReplayBudgetExceededError';
  }
}

export interface ReplayBatteryConfig {
  /** Groups this invocation's cells in the store. */
  batteryId: string;
  /** Order is run order; put {@link REPLAY_BASELINE_VARIANT} first so the
   *  anchor lands before any budget cutoff. */
  variants: ReplayVariant[];
  cases: ReplayCase[];
  repeats: number;
  /** Historical echo is the default. Matched comparisons re-run the baseline
   * through the same student as challengers, with the same context and rubric. */
  baselineMode?: 'historical' | 'matched';
  rubric?: BatteryRubric;
  /** Judge-trace budget (default 24_000 chars). */
  maxDistillChars?: number;
  /** Context handed to the runner (default 24_000 chars). */
  maxContextChars?: number;
  /** High-water spend cutoff across runner + judge (omit = uncapped here —
   *  the governor's budget still gates unattended runs upstream). */
  maxSpendUsd?: number;
}

export interface ReplayBatteryDeps {
  runner: ReplayRunner;
  llmCall: JudgeLlmCall;
  store?: ReplayStore;
  now(): number;
  /** Default: `${batteryId}:${variantId}:${caseId}:r${repeat}` (deterministic). */
  newRunId?(variantId: string, caseId: string, repeat: number): string;
  sleep?(ms: number): Promise<void>;
  ratePauseHooks?: Pick<RatePauseDeps, 'onPause' | 'onReset'>;
}

export interface ReplayOutcome {
  runId: string;
  variantId: string;
  caseId: string;
  caseRef: string;
  repeat: number;
  status: 'scored' | 'rate_limited' | 'errored';
  d1: number;
  d2: number;
  d3: number;
  composite: number;
  divergence: DivergenceSignals | null;
  /** Runner spend (0 for the baseline echo). */
  runUsd: number;
  judgeUsd: number;
  replayed: boolean;
  error?: string;
}

export interface ReplayVariantAggregate {
  variantId: string;
  label: string;
  cells: number;
  scored: number;
  meanComposite: number | null;
  meanTokenJaccard: number | null;
  costUsd: number;
}

export interface ReplayBatteryResult {
  batteryId: string;
  /** Modules reported by the battery that actually ran, not its caller's
   * imported default. A custom battery may omit its execution receipt. */
  loadedCode?: Readonly<Record<string, string | null>>;
  outcomes: ReplayOutcome[];
  perVariant: ReplayVariantAggregate[];
  /** Baseline-vs-candidates ranking (compareArms semantics); null when the
   *  config carries no baseline variant or no candidates. */
  comparison: Omit<CompareSelectResult, 'scenarioId'> | null;
  totalCostUsd: number;
  /** False means totalCostUsd is only the known lower bound; do not settle it as complete spend. */
  costMeasured: boolean;
  rubricHash: string;
  /** True when the spend cap refused at least one cell. */
  budgetExhausted: boolean;
}

interface ReplaySignals {
  divergence: DivergenceSignals | null;
  replayed: boolean;
}

export async function runReplayBattery(
  config: ReplayBatteryConfig,
  deps: ReplayBatteryDeps,
): Promise<ReplayBatteryResult> {
  const rubric = config.rubric ?? DEFAULT_REPLAY_RUBRIC;
  const maxDistillChars = config.maxDistillChars ?? 24_000;
  const maxContextChars = config.maxContextChars ?? 24_000;
  const newRunId =
    deps.newRunId ?? ((variantId: string, caseId: string, repeat: number) => `${config.batteryId}:${variantId}:${caseId}:r${repeat}`);

  // High-water budget guard: refuses BEFORE invoking the runner once the
  // accumulated runner+judge spend reaches the cap (one in-flight cell may
  // overshoot it — a cutoff, not a precise limiter).
  let spentUsd = 0;
  let judgeChargeUnknown = false;
  const guard = () => {
    if (judgeChargeUnknown) throw new Error('replay judge charge unmeasured — remaining cells refused before spending');
    if (config.maxSpendUsd !== undefined && spentUsd >= config.maxSpendUsd) {
      throw new ReplayBudgetExceededError(spentUsd, config.maxSpendUsd);
    }
  };

  const subject: Subject<ReplayRunInput, ReplayRunHandle, ReplaySignals> = {
    async run(cell) {
      guard();
      // The historical baseline is the original continuation, echoed at zero
      // cost — the judge scores what actually happened as the anchor.
      if (config.baselineMode !== 'matched' && cell.variant.variantId === BASELINE_ID && cell.replayCase.kind === 'historical') {
        return {
          outputText: continuationTextForCase(cell.replayCase, maxDistillChars) ?? '',
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          replayed: false,
        };
      }
      const handle = await deps.runner({
        systemPrompt: buildReplaySystemPrompt(cell.variant),
        contextText: contextTextForCase(cell.replayCase, maxContextChars),
        replayCase: cell.replayCase,
        variant: cell.variant,
      });
      spentUsd += handle.costUsd;
      return handle;
    },
    async collectAndDistill({ handle, cell, maxChars }) {
      const original = continuationTextForCase(cell.replayCase, Math.floor(maxChars / 4));
      const divergence = original !== null ? divergenceSignals(original, handle.outputText) : null;
      const contextTail = contextTextForCase(cell.replayCase, Math.floor(maxChars / 4));
      const replayedCap = Math.max(1000, Math.floor(maxChars / 2));
      const sections = [
        `## Context before the replay point\n${contextTail}`,
        `## Continuation under evaluation (variant: ${cell.variant.label})\n${handle.outputText.slice(0, replayedCap)}`,
        ...(original !== null && handle.replayed ? [`## Original historical continuation\n${original}`] : []),
        ...(divergence ? [`## Deterministic divergence signals\n${JSON.stringify(divergence)}`] : []),
      ];
      return {
        distilledTrace: sections.join('\n\n').slice(0, maxChars),
        traceRef: replayCaseRef(cell.replayCase),
        rawSignals: { divergence, replayed: handle.replayed },
        signals: { divergence, replayed: handle.replayed },
      };
    },
    judgeInput(cell) {
      return { intent: judgeIntent(cell.replayCase), projectContext: cell.replayCase.projectContext ?? '' };
    },
  };

  // Variant-major expansion (the gym's order); caller puts baseline first.
  const cells: BatteryCell<ReplayRunInput>[] = [];
  for (const variant of config.variants) {
    for (const replayCase of config.cases) {
      for (let repeat = 0; repeat < config.repeats; repeat++) {
        cells.push({
          runId: newRunId(variant.variantId, replayCase.caseId, repeat),
          cell: { variant, replayCase, repeat },
        });
      }
    }
  }

  const divergenceByRun = new Map<string, DivergenceSignals | null>();

  const results = await runBattery<ReplayRunInput, ReplayRunHandle, ReplaySignals>(
    { cells, rubric, maxDistillChars },
    {
      subject,
      llmCall: async (opts) => {
        let reply;
        try {
          reply = await deps.llmCall(opts);
        } catch (error) {
          const cost = (error as { costUsd?: unknown } | null)?.costUsd;
          if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) spentUsd += cost;
          else judgeChargeUnknown = true;
          throw error;
        }
        if (Number.isFinite(reply.costUsd) && reply.costUsd >= 0) spentUsd += reply.costUsd;
        else judgeChargeUnknown = true;
        return reply;
      },
      now: deps.now,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.ratePauseHooks ? { ratePauseHooks: deps.ratePauseHooks } : {}),
      hooks: {
        onStart: ({ runId, cell }) =>
          deps.store?.startRun({
            runId,
            batteryId: config.batteryId,
            variant: cell.variant,
            replayCase: cell.replayCase,
            repeat: cell.repeat,
          }),
        onFinish: ({ runId, handle, distilled, elapsedMs }) => {
          const signals = distilled.signals?.divergence ?? null;
          divergenceByRun.set(runId, signals);
          return deps.store?.finishRun(runId, {
            divergence: distilled.rawSignals,
            costUsd: handle.costUsd,
            elapsedMs,
          });
        },
        onScore: ({ runId, score }) => {
          return deps.store?.recordScore(runId, {
            d1: score.d1,
            d2: score.d2,
            d3: score.d3,
            composite: score.composite,
            rationale: score.rationale,
            rubricHash: score.rubricHash,
            costUsd: score.costUsd,
          });
        },
      },
    },
  );

  // Failed cells: the engine records them in results only — persist them.
  let budgetExhausted = false;
  for (const r of results) {
    if (r.status === 'scored') continue;
    if (r.error?.includes('replay budget cap reached')) budgetExhausted = true;
    await deps.store?.markFailed(r.runId, {
      status: r.status,
      error: r.error ?? 'unknown',
      elapsedMs: r.elapsedMs,
    });
  }

  const outcomes: ReplayOutcome[] = results.map((r) => {
    const base = {
      runId: r.runId,
      variantId: r.cell.variant.variantId,
      caseId: r.cell.replayCase.caseId,
      caseRef: replayCaseRef(r.cell.replayCase),
      repeat: r.cell.repeat,
      divergence: divergenceByRun.get(r.runId) ?? null,
      runUsd: r.handle?.costUsd ?? 0,
      replayed: r.handle?.replayed ?? false,
    };
    if (r.status === 'scored' && r.score) {
      return {
        ...base,
        status: 'scored' as const,
        d1: r.score.d1,
        d2: r.score.d2,
        d3: r.score.d3,
        composite: r.score.composite,
        judgeUsd: r.judgeCostUsd,
      };
    }
    return {
      ...base,
      status: r.status,
      d1: 0,
      d2: 0,
      d3: 0,
      composite: 0,
      judgeUsd: r.judgeCostUsd,
      ...(r.error !== undefined ? { error: r.error } : {}),
    };
  });

  const perVariant: ReplayVariantAggregate[] = config.variants.map((variant) => {
    const mine = outcomes.filter((o) => o.variantId === variant.variantId);
    const scored = mine.filter((o) => o.status === 'scored');
    const withDivergence = scored.filter((o) => o.divergence !== null);
    const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
    return {
      variantId: variant.variantId,
      label: variant.label,
      cells: mine.length,
      scored: scored.length,
      meanComposite: mean(scored.map((o) => o.composite)),
      meanTokenJaccard: mean(withDivergence.map((o) => o.divergence!.tokenJaccard)),
      costUsd: mine.reduce((s, o) => s + o.runUsd + o.judgeUsd, 0),
    };
  });

  // Baseline-vs-candidates ranking on the judge composite (compareArms is the
  // shared diff/rank/select math — testing-shell semantics verbatim).
  const baselineAgg = perVariant.find((v) => v.variantId === BASELINE_ID);
  const candidateAggs = perVariant.filter((v) => v.variantId !== BASELINE_ID);
  let comparison: ReplayBatteryResult['comparison'] = null;
  if (baselineAgg && candidateAggs.length > 0) {
    const toArm = (v: ReplayVariantAggregate): CompareArm => ({
      variantId: v.variantId,
      metrics: { composite: v.meanComposite ?? undefined },
      ...(v.scored === 0 ? { error: 'no scored cells' } : {}),
    });
    comparison = compareArms({
      baseline: toArm(baselineAgg),
      candidates: candidateAggs.map(toArm),
      scorers: [{ id: 'composite', direction: 'higher-better' }],
      primary: 'composite',
    });
  }

  return {
    batteryId: config.batteryId,
    outcomes,
    perVariant,
    comparison,
    totalCostUsd: outcomes.reduce((s, o) => s + o.runUsd + o.judgeUsd, 0),
    costMeasured: results.every((r) => r.judgeCostMeasured &&
      (r.handle != null ? Number.isFinite(r.handle.costUsd) && r.handle.costUsd >= 0
        : r.error?.includes('replay budget cap reached') === true)),
    rubricHash: rubricHash(rubric),
    budgetExhausted,
    loadedCode: { replayBattery: REPLAY_BATTERY_SOURCE_HASH,
      transcript: REPLAY_TRANSCRIPT_SOURCE_HASH, divergence: REPLAY_DIVERGENCE_SOURCE_HASH,
      ...EVAL_BATTERY_SOURCE_HASHES },
  };
}
