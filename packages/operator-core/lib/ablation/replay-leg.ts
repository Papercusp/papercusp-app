/**
 * The replay-sample evidence leg (self-learning-frontier P-023 / FB-09, on
 * FB-06's lib/replay substrate) — the second leg of a shadow-ablation cycle:
 * besides the FORWARD scenario suite (synthetic user asks), replay a small
 * sample of REAL historical agent trajectories from a mid-trajectory point
 * under the full vs the ablated playbook and compare judged continuation
 * quality. A rule whose removal degrades replayed continuations is
 * load-bearing in practice, not just in simulation.
 *
 * Built on `runGovernedReplay`, so the replay spend rides the REPLAY loop's
 * own flag + governor budget (`frontier:replay-harness`, origin='replay' —
 * FB-06's gates), separate from the ablation loop's scenario-leg budget.
 * Until P-001 arms the replay harness, the leg records its refusal
 * (`{ skipped: 'replay-dark' | ... }`) and the scenario leg stands alone —
 * the cycle never fails for want of this leg.
 *
 * Variant design: THREE arms per case — the zero-cost historical echo
 * (REPLAY_BASELINE_VARIANT, the divergence anchor the battery's comparison
 * keys on), then `playbook-full` and `playbook-ablated`, both `systemReplace`
 * (the ReplayPolicy ablation mode) with the SAME framed snapshot the scenario
 * legs measured. The leg's delta = ablated meanComposite − full meanComposite.
 *
 * The continuation runner is a ONE-SHOT completion (no tools): the judge
 * scores the narrated continuation, which is what the replay rubric measures.
 * Transcript sampling reuses FB-07's store readers (spawned_agents ⋈
 * harness_run_output.jsonl_body) — most recent terminal spawns with persisted
 * transcripts, no badness scoring (ablation wants ORDINARY trajectories).
 */

import type { Sql } from 'postgres';

import { llmCall as liveLlmCall } from '../llm-testing/llm-client';
import { runGovernedReplay } from '../replay/governed';
import { REPLAY_BASELINE_VARIANT } from '../replay/battery';
import { readSelectionRows, readTranscriptBody } from '../replay/regret/store';
import { parseTranscriptJsonl } from '../replay/transcript';
import type { ReplayCase, ReplayRunner, ReplayVariant } from '../replay/types';
import { SU_PLAYBOOK_FRAMING } from '../llm-testing/targets/su';
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';
import type { AblationCycleDeps } from './runner';

export const ABLATION_FULL_VARIANT = 'playbook-full';
export const ABLATION_ABLATED_VARIANT = 'playbook-ablated';
export const DEFAULT_ABLATION_REPLAY_MODEL = LEARNING_MODEL_SPEC;

/** What lands in prompt_ablation_runs.replay_leg. */
export interface AblationReplayLegResult {
  batteryId: string;
  cases: number;
  /** Set when the governed run refused (replay-dark / unbudgeted / …). */
  skipped?: string;
  fullComposite?: number | null;
  ablatedComposite?: number | null;
  /** ablated − full (negative = the rule was load-bearing on real trajectories). */
  compositeDelta?: number | null;
  costUsd: number;
  budgetExhausted?: boolean;
}

export interface AblationReplayLegOptions {
  /** Historical trajectories sampled per cycle (default 2). */
  sampleSize?: number;
  /** Selection window over terminal spawns (default 14 days). */
  windowDays?: number;
  /** High-water replay spend per cycle (default $3; the governor still clamps). */
  maxSpendUsd?: number;
  /** Continuation model (default: the canonical learning policy). */
  model?: string;
}

export interface AblationReplayLegDeps {
  sql: Sql;
  readRows?: typeof readSelectionRows;
  readBody?: typeof readTranscriptBody;
  runReplay?: typeof runGovernedReplay;
  llmCall?: typeof liveLlmCall;
  nowMs?: () => number;
  log?: (msg: string) => void;
}

function continuationModel(opts: AblationReplayLegOptions): string {
  return opts.model ?? DEFAULT_ABLATION_REPLAY_MODEL;
}

/** One-shot continuation runner: system = the (full|ablated) framed playbook. */
function makeContinuationRunner(call: typeof liveLlmCall, model: string): ReplayRunner {
  return async ({ systemPrompt, contextText }) => {
    const res = await call({
      model,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content:
            'You are resuming the agent session below mid-task. Continue the work from exactly ' +
            'this point: narrate your next steps, tool intentions, and their expected results as ' +
            'the continuation of the same trajectory.\n\n--- SESSION SO FAR ---\n' +
            contextText,
        },
      ],
      maxTokens: 2048,
    });
    return {
      outputText: res.text,
      costUsd: res.costUsd,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      replayed: true,
    };
  };
}

/**
 * Build the production replay leg for `runAblationCycle` deps. Everything is
 * injectable; the default wiring reads real spawns + calls the real governed
 * replay (which itself refuses until the replay harness arms at P-001).
 */
export function makeAblationReplayLeg(
  deps: AblationReplayLegDeps,
  opts: AblationReplayLegOptions = {},
): NonNullable<AblationCycleDeps['replayLeg']> {
  const readRows = deps.readRows ?? readSelectionRows;
  const readBody = deps.readBody ?? readTranscriptBody;
  const runReplay = deps.runReplay ?? runGovernedReplay;
  const call = deps.llmCall ?? liveLlmCall;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.log(`[prompt-ablation:replay-leg] ${m}`));
  const sampleSize = opts.sampleSize ?? 2;
  const windowDays = opts.windowDays ?? 14;

  return async ({ workspaceId, rule, body, ablatedBody }): Promise<AblationReplayLegResult | null> => {
    // 1. Sample: most recent terminal spawns with a persisted transcript.
    const rows = await readRows(deps.sql, workspaceId, windowDays);
    const recent = rows
      .filter((r) => (r.transcriptBytes ?? 0) > 500)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const cases: ReplayCase[] = [];
    for (const row of recent) {
      if (cases.length >= sampleSize) break;
      const jsonl = await readBody(deps.sql, row.runId);
      if (!jsonl) continue;
      const transcript = parseTranscriptJsonl(jsonl, `run:${row.runId}`);
      if (transcript.turns.length < 4) continue; // too short to cut meaningfully
      cases.push({
        kind: 'historical',
        caseId: `run:${row.runId}`,
        transcript,
        turnIndex: Math.max(1, Math.floor(transcript.turns.length / 2)),
      });
    }
    if (cases.length === 0) {
      log('no replayable historical transcripts in the window — leg skipped');
      return { batteryId: '', cases: 0, skipped: 'no-cases', costUsd: 0 };
    }

    // 2. Arms: historical echo (anchor) + full + ablated, same framed snapshot
    //    as the scenario legs.
    const variants: ReplayVariant[] = [
      REPLAY_BASELINE_VARIANT,
      {
        variantId: ABLATION_FULL_VARIANT,
        label: 'SU playbook (full snapshot)',
        policy: { systemReplace: SU_PLAYBOOK_FRAMING + body, note: 'shadow-ablation control arm' },
      },
      {
        variantId: ABLATION_ABLATED_VARIANT,
        label: `SU playbook minus ${rule.ruleKey}`,
        policy: {
          systemReplace: SU_PLAYBOOK_FRAMING + ablatedBody,
          note: `shadow ablation of '${rule.ruleKey}' (${rule.contentHash})`,
        },
      },
    ];

    const batteryId = `ablation:${rule.ruleKey}:${nowMs()}`;
    const { verdict, result } = await runReplay(
      {
        workspaceId,
        config: {
          batteryId,
          variants,
          cases,
          repeats: 1,
          maxSpendUsd: opts.maxSpendUsd ?? 3,
        },
      },
      {
        runner: makeContinuationRunner(call, continuationModel(opts)),
        llmCall: call,
        now: nowMs,
      },
    );

    if (!result) {
      log(`governed replay refused (${verdict.reason}) — scenario evidence stands alone this cycle`);
      return { batteryId, cases: cases.length, skipped: verdict.reason ?? 'refused', costUsd: 0 };
    }

    const byVariant = new Map(result.perVariant.map((v) => [v.variantId, v]));
    const full = byVariant.get(ABLATION_FULL_VARIANT)?.meanComposite ?? null;
    const ablated = byVariant.get(ABLATION_ABLATED_VARIANT)?.meanComposite ?? null;
    return {
      batteryId: result.batteryId,
      cases: cases.length,
      fullComposite: full,
      ablatedComposite: ablated,
      compositeDelta: full !== null && ablated !== null ? ablated - full : null,
      costUsd: result.totalCostUsd,
      budgetExhausted: result.budgetExhausted,
    };
  };
}
