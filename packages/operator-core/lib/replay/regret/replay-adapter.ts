/**
 * replay-adapter.ts — the live RegretCounterfactualRunner over FB-06's replay
 * harness (self-learning-frontier-2026-06-12 P-021 / FB-07 ⇄ P-020 / FB-06).
 *
 * One finding = ONE governed battery: the historical case cut at the
 * divergence turn, one `systemOverlay` variant per candidate change, judged
 * against the zero-cost baseline echo (the original continuation). Scores
 * come back as (candidate − baseline) mean judge composite, normalized to
 * the 10-point rubric scale.
 *
 * Turn mapping: transcript-core groups by assistant MESSAGE (divergence
 * ordinals); lib/replay's parser emits flat block-level turns (text /
 * tool_use / tool_result). The bridge anchors on TOOL-CALL ORDER — both
 * models preserve every tool call exactly once, in order — falling back to
 * a text-prefix match, then a proportional cut. Exported for tests:
 * {@link mapDivergenceTurnToReplayIndex}.
 *
 * Spend: `runGovernedReplay` preflights the REPLAY substrate's own D-001
 * gates (flag `papercusp-replay-harness` + loop `frontier:replay-harness`) —
 * a refusal returns null so the finding stays pending. The substrate also
 * LEDGERS the spend (origin=replay, runRef=batteryId — `regret:<runId>`
 * keeps drill-down attribution), so regret-mining must NOT ledger again.
 */

import { BASELINE_ID } from '@papercusp/eval-battery';
import { LEARNING_MODEL_SPEC } from '../../learning/model-policy';
import { REPLAY_BASELINE_VARIANT } from '../battery';
import { runGovernedReplay, type ReplayGlueDeps } from '../governed';
import { parseTranscriptJsonl } from '../transcript';
import type { ReplayBatteryDeps } from '../battery';
import type { ReplayCase, ReplayRunner, ReplayTranscript, ReplayVariant } from '../types';
import { parseTranscript, type ParsedTranscript } from './transcript-core';
import type {
  CandidateReplayScore,
  RegretCounterfactualRunner,
  RegretPriceRequest,
  RegretPricing,
} from './counterfactual-core';

function clampIndex(i: number, max: number): number {
  return Math.max(1, Math.min(max, i));
}

/**
 * Map a transcript-core assistant-turn ordinal onto lib/replay's flat turn
 * index, so the cut re-enters the session at the divergence point.
 *
 *   1. Tool-call order (primary): count tool calls STRICTLY BEFORE the
 *      divergence turn in the message-grouped parse; the cut lands at the
 *      (count+1)-th flat tool_use turn, walked back over the contiguous
 *      assistant narration that precedes it (same message).
 *   2. Text prefix: the divergence turn's text starts with its message's
 *      first text block — find that flat assistant turn.
 *   3. Proportional position (last resort).
 */
export function mapDivergenceTurnToReplayIndex(
  mine: ParsedTranscript,
  divergenceTurn: number,
  theirs: ReplayTranscript,
): number {
  const lastIndex = theirs.turns.length - 1;
  if (lastIndex < 1) return 1;

  // 1. Tool-call order.
  const priorCalls = mine.turns
    .filter((t) => t.index < divergenceTurn)
    .reduce((sum, t) => sum + t.toolCalls.length, 0);
  const divergenceHasWork =
    (mine.turns[divergenceTurn]?.toolCalls.length ?? 0) > 0 ||
    mine.turns.some((t) => t.index > divergenceTurn && t.toolCalls.length > 0);
  if (divergenceHasWork) {
    const toolTurns = theirs.turns.filter((t) => t.role === 'tool_use');
    if (toolTurns.length > priorCalls) {
      let idx = toolTurns[priorCalls].index;
      // Walk back over the divergence turn's own leading narration.
      while (idx - 1 >= 1 && theirs.turns[idx - 1].role === 'assistant') idx -= 1;
      return clampIndex(idx, lastIndex);
    }
  }

  // 2. Text prefix.
  const myText = mine.turns[divergenceTurn]?.text ?? '';
  if (myText.length >= 12) {
    const hit = theirs.turns.find(
      (t) => t.index >= 1 && t.role === 'assistant' && t.text.length >= 12 && myText.startsWith(t.text.slice(0, 80)),
    );
    if (hit) return clampIndex(hit.index, lastIndex);
  }

  // 3. Proportional.
  const fraction = divergenceTurn / Math.max(1, mine.turns.length);
  return clampIndex(Math.round(fraction * theirs.turns.length), lastIndex);
}

export interface GovernedRegretRunnerOptions {
  /** Model for the replayed continuation. Defaults to the canonical learning policy. */
  replayModel?: string;
  /** Output cap per replayed continuation. Default 1500. */
  maxOutputTokens?: number;
  /** Repeats per cell. Default 1 (regret prices many candidates cheaply). */
  repeats?: number;
  /** Battery deps overrides — tests inject runner/llmCall/store/now. */
  batteryDeps?: Partial<ReplayBatteryDeps>;
  /** Governed-glue overrides — tests inject flag/preflight/spend fakes. */
  glue?: ReplayGlueDeps;
  log?: (message: string) => void;
}

export const DEFAULT_REGRET_REPLAY_MODEL = LEARNING_MODEL_SPEC;

/** The replayed-continuation runner: one LLM call continuing from the cut. */
function llmReplayRunner(model: string, maxTokens: number): ReplayRunner {
  return async ({ systemPrompt, contextText }) => {
    // Lazy: the llm-client graph must not load at module import
    // (the gym's ab-run precedent).
    const { llmCall } = await import('../../llm-testing/llm-client');
    const result = await llmCall({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: contextText }],
      maxTokens,
    });
    return {
      outputText: result.text,
      costUsd: result.costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      replayed: true,
    };
  };
}

/** Live judge — the same llm-client the gym's batteries use. */
async function liveJudge(): Promise<ReplayBatteryDeps['llmCall']> {
  const { llmCall } = await import('../../llm-testing/llm-client');
  return llmCall;
}

export function governedRegretRunner(options: GovernedRegretRunnerOptions = {}): RegretCounterfactualRunner {
  const log = options.log ?? ((m: string) => console.log(`[regret-mine] ${m}`));
  return {
    async priceFinding(req: RegretPriceRequest): Promise<RegretPricing | null> {
      const ref = `pg:harness_run_output/${req.runId}`;
      const theirs = parseTranscriptJsonl(req.jsonlBody, ref);
      if (theirs.turns.length < 2) {
        // Nothing replayable — consume the finding with no scores (it will
        // never clear the filing bar; re-pricing would never improve).
        log(`"${req.runId}" has no replayable turns — recording empty pricing`);
        return { scores: [], costUsd: 0 };
      }

      const mine = parseTranscript(req.jsonlBody);
      const turnIndex = mapDivergenceTurnToReplayIndex(mine, req.divergenceTurn, theirs);

      const replayCase: ReplayCase = {
        kind: 'historical',
        caseId: `regret:${req.runId}`,
        transcript: theirs,
        turnIndex,
      };
      const variants: ReplayVariant[] = [
        REPLAY_BASELINE_VARIANT, // first — the anchor lands before any budget cutoff
        ...req.changes.map((change) => ({
          variantId: change.id,
          label: change.title,
          policy: { systemOverlay: change.promptDelta, note: change.rationale },
        })),
      ];

      const deps: ReplayBatteryDeps = {
        runner:
          options.batteryDeps?.runner ??
          llmReplayRunner(options.replayModel ?? DEFAULT_REGRET_REPLAY_MODEL, options.maxOutputTokens ?? 1500),
        llmCall: options.batteryDeps?.llmCall ?? (await liveJudge()),
        now: options.batteryDeps?.now ?? (() => Date.now()),
        ...(options.batteryDeps?.store ? { store: options.batteryDeps.store } : {}),
        ...(options.batteryDeps?.newRunId ? { newRunId: options.batteryDeps.newRunId } : {}),
        ...(options.batteryDeps?.sleep ? { sleep: options.batteryDeps.sleep } : {}),
      };

      const { verdict, result } = await runGovernedReplay(
        {
          workspaceId: req.workspaceId,
          config: {
            batteryId: `regret:${req.runId}`,
            variants,
            cases: [replayCase],
            repeats: options.repeats ?? 1,
            maxSpendUsd: req.budgetUsd,
          },
        },
        deps,
        options.glue,
      );
      if (result === null) {
        log(`replay substrate refused (${verdict.reason}) for "${req.runId}" — finding stays pending`);
        return null;
      }

      const baseline = result.perVariant.find((v) => v.variantId === BASELINE_ID);
      const scores: CandidateReplayScore[] = [];
      if (baseline?.meanComposite == null) {
        log(`baseline unscored for "${req.runId}" — no improvement claims possible`);
      } else {
        for (const change of req.changes) {
          const agg = result.perVariant.find((v) => v.variantId === change.id);
          if (agg?.meanComposite == null) continue;
          const improvementScore = Math.max(0, Math.min(1, (agg.meanComposite - baseline.meanComposite) / 10));
          scores.push({
            candidateId: change.id,
            improvementScore,
            summary:
              `judge composite μ${agg.meanComposite.toFixed(2)} vs baseline μ${baseline.meanComposite.toFixed(2)} ` +
              `(${agg.scored}/${agg.cells} cell(s), cut at flat turn ${turnIndex})`,
            costUsd: agg.costUsd,
          });
        }
      }
      return { scores, costUsd: result.totalCostUsd };
    },
  };
}
