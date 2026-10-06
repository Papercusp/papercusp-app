/**
 * The live student-transfer test (P-022 / FB-08) — lib/replay's battery bound
 * to the {@link TransferReplayPort} the tick consumes.
 *
 * One lesson's test = ONE governed replay battery over the lesson's source
 * historical case:
 *
 *   variants — a fresh baseline student vs 'with-lesson' (the lesson as a systemOverlay —
 *     exactly the policy-delta shape lib/replay's types name for transfer
 *     lessons). The fresh student "given the lesson" is the overlay run.
 *   cut — the first acting turn (first non-system/user turn): the student
 *     re-attempts the task from the original ask under the same model, context
 *     and rubric, with and without the lesson in its system prompt.
 *   verdict — perVariant mean judge composites; gate.ts decides.
 *
 * Routed through runGovernedReplay (FB-06's unattended consumer entrypoint):
 * the replay flag + `frontier:replay-harness` budget gate the battery, and
 * THAT path ledgers the battery spend — the transfer loop ledgers only its
 * own distillation spend, so no battery dollar is ever double-counted.
 */
import { captureSourceHash, type JudgeLlmCall } from '@papercusp/eval-battery';
import { createHash } from 'node:crypto';
import { adaptTransferOutput } from '../experiment/lifecycle-adapter';
import type { LearningEvidence } from '../experiment/types';
import { transferLessonArtifactHash } from './store';
import {
  REPLAY_BATTERY_SOURCE_HASH,
  REPLAY_BASELINE_VARIANT,
  runGovernedReplay,
  type GovernedReplayResult,
  type ReplayBatteryConfig,
  type ReplayCase,
  type ReplayRunner,
  type ReplayTranscript,
  type ReplayVariant,
} from '../replay';
import { TRANSFER_LOOP_ID, type TransferLesson, type TransferReplayEvidence, type TransferReplayPort } from './types';

export const WITH_LESSON_VARIANT_ID = 'with-lesson';
const TRANSFER_ADAPTER_SOURCE_HASH = captureSourceHash(import.meta.url);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The cut point for a transfer case: the first ACTING turn (the student
 *  takes over where the original agent started acting). Clamped to the valid
 *  cut range; callers should pre-filter degenerate transcripts (distill.ts
 *  already skips < 4 turns). */
export function pickTransferCutIndex(transcript: ReplayTranscript): number {
  const idx = transcript.turns.findIndex((t) => t.role !== 'system' && t.role !== 'user');
  const fallback = Math.floor(transcript.turns.length / 2);
  const cut = idx >= 1 ? idx : fallback;
  return Math.min(Math.max(cut, 1), Math.max(transcript.turns.length - 1, 1));
}

/** The with-lesson policy delta (the "fresh student given the lesson"). */
export function withLessonVariant(lesson: Pick<TransferLesson, 'lessonText' | 'title'>): ReplayVariant {
  return {
    variantId: WITH_LESSON_VARIANT_ID,
    label: lesson.title ?? 'with lesson',
    policy: {
      systemOverlay:
        'A lesson distilled from previous work on tasks like this — apply it where relevant:\n' +
        lesson.lessonText,
      note: 'transfer-harness student-transfer test (P-022)',
    },
  };
}

export interface TransferReplayAdapterDeps {
  workspaceId: string;
  runner: ReplayRunner;
  llmCall: JudgeLlmCall;
  /** Injectable for tests (default: the real runGovernedReplay). */
  runGoverned?: (
    q: { workspaceId: string; config: ReplayBatteryConfig; potSlug?: string | null },
    deps: { runner: ReplayRunner; llmCall: JudgeLlmCall; now(): number },
  ) => Promise<GovernedReplayResult>;
  /** Per-test battery spend cap (the governor's remaining budget clamps it further). */
  maxSpendUsd?: number;
  now?: () => number;
}

/** Bind lib/replay's battery as the tick's TransferReplayPort. */
export function transferReplayPort(deps: TransferReplayAdapterDeps): TransferReplayPort {
  const run = deps.runGoverned ?? runGovernedReplay;
  return async (input) => {
    // Caller objects and injected ports may change while the battery is awaited.
    // Keep the source artifact and the task used by both arms independent of them.
    const lesson = structuredClone(input.lesson);
    const transcript = structuredClone(input.transcript);
    if (lesson.workspaceId !== deps.workspaceId || lesson.sourceRef !== transcript.ref) {
      throw new Error('transfer replay source does not match the lesson workspace/transcript');
    }
    const now = deps.now ?? Date.now;
    const startedAt = new Date(now()).toISOString();
    const replayCase: ReplayCase = {
      kind: 'historical',
      caseId: lesson.id,
      transcript,
      turnIndex: pickTransferCutIndex(transcript),
    };
    const taskHash = hash(replayCase);
    const config: ReplayBatteryConfig = {
      // Deterministic per test round: lesson id + how many tests it has had.
      batteryId: `transfer:${lesson.id}:t${lesson.testCount + 1}`,
      variants: [{ ...REPLAY_BASELINE_VARIANT, label: 'matched baseline' }, withLessonVariant(lesson)],
      cases: [replayCase],
      repeats: 1,
      baselineMode: 'matched',
      ...(deps.maxSpendUsd !== undefined ? { maxSpendUsd: deps.maxSpendUsd } : {}),
    };
    const invocations: TransferReplayEvidence['invocations'][number][] = [];
    const judgeInvocations: Parameters<JudgeLlmCall>[0][] = [];
    const judgeExecutions: NonNullable<TransferReplayEvidence['judgeExecutions']>[number][] = [];
    const judgeResponses: NonNullable<TransferReplayEvidence['judgeResponses']>[number][] = [];
    const runner: ReplayRunner = async (input) => {
      const request = structuredClone(input);
      const handle = structuredClone(await deps.runner(structuredClone(request)));
      invocations.push({
        variantId: request.variant.variantId,
        systemPromptHash: hash(request.systemPrompt), contextHash: hash(request.contextText),
        model: handle.execution?.model ?? null, codeHash: handle.execution?.codeHash ?? null,
        ...(handle.execution?.loadedCode ? { loadedCode: structuredClone(handle.execution.loadedCode) } : {}),
        ...(handle.execution?.unresolved ? { unresolved: [...handle.execution.unresolved] } : {}),
        request, response: structuredClone(handle),
      });
      return handle;
    };
    const { verdict, result, reservation } = await run(
      { workspaceId: deps.workspaceId, config, potSlug: lesson.potSlug },
      { runner, llmCall: async (input) => {
        // Pin every actual judge attempt, including repair/retry prompts.
        judgeInvocations.push(structuredClone(input));
        const index = judgeExecutions.push(null) - 1;
        judgeResponses.push(null);
        const reply = structuredClone(await deps.llmCall(structuredClone(input)));
        judgeExecutions[index] = reply.execution ? structuredClone(reply.execution) : null;
        judgeResponses[index] = structuredClone(reply);
        return reply;
      }, now },
    );
    if (!result) {
      throw new Error(
        `governed replay refused (${verdict.reason ?? 'unknown'}) — ` +
          'the replay substrate is not armed (its flag + frontier:replay-harness budget are P-001 acts)',
      );
    }
    const baseline = result.perVariant.find((v) => v.variantId === REPLAY_BASELINE_VARIANT.variantId);
    const withLesson = result.perVariant.find((v) => v.variantId === WITH_LESSON_VARIANT_ID);
    if (baseline?.meanComposite == null || withLesson?.meanComposite == null) {
      throw new Error(
        `battery ${result.batteryId} produced no scored pair ` +
          `(baseline=${baseline?.meanComposite ?? 'none'}, with-lesson=${withLesson?.meanComposite ?? 'none'})`,
      );
    }
    const evaluation: TransferReplayEvidence = {
        source: { lesson: structuredClone(lesson), transcript: structuredClone(transcript) },
        costMeasured: result.costMeasured,
        experiment: {
          batteryId: result.batteryId, testId: 'replay',
          baselineId: REPLAY_BASELINE_VARIANT.variantId, challengerId: WITH_LESSON_VARIANT_ID,
          taskHash,
          modelHash: invocations.length === 2 && invocations.every((v) => v.model !== null) && judgeInvocations.length >= 2
            ? hash({ students: invocations.map((v) => ({ variantId: v.variantId, model: v.model })),
              judges: judgeInvocations.map((v, index) => ({ model: v.model,
                transportModel: judgeExecutions[index]?.model ?? null,
                thinkingBudgetTokens: v.thinkingBudgetTokens, maxTokens: v.maxTokens })) }) : null,
          promptHash: invocations.length === 2 && judgeInvocations.length >= 2
            ? hash({ students: invocations.map((v) => ({ variantId: v.variantId, systemPromptHash: v.systemPromptHash, contextHash: v.contextHash })),
              judges: judgeInvocations.map((v) => ({ system: v.system, messages: v.messages, responseFormat: v.responseFormat })) }) : null,
          rubricHash: result.rubricHash,
          // Per-module receipts measure the local evaluator and renderer, but
          // transport and imported dependencies remain incomplete.
          codeHash: null,
          repeats: config.repeats, startedAt, completedAt: new Date(now()).toISOString(),
        },
        reservation: reservation ?? null, outcomes: result.outcomes,
        budgetExhausted: result.budgetExhausted, invocations, judgeExecutions, judgeInvocations, judgeResponses,
        loadedCode: { adapter: TRANSFER_ADAPTER_SOURCE_HASH, battery: REPLAY_BATTERY_SOURCE_HASH,
          evaluator: result.loadedCode ? structuredClone(result.loadedCode) : null },
    };
    // A governed source evaluation is a common lifecycle receipt even when it
    // cannot authorize promotion. Keep unknown pins and unmeasured evidence;
    // the frozen judge's scores do not stand in for objective/regression tests.
    if (lesson.potSlug && reservation?.status === 'settled' && reservation.settledAt !== null &&
        reservation.workspaceId === lesson.workspaceId && reservation.potSlug === lesson.potSlug &&
        reservation.runRef === result.batteryId) {
      const recordedAt = evaluation.experiment.completedAt!;
      const refs = [`transfer:${lesson.id}`, ...result.outcomes.map((cell) => `replay-run:${cell.runId}`)];
      const paired = result.outcomes.length === 2 && result.outcomes.every((cell) =>
        cell.status === 'scored' && cell.replayed && cell.caseId === lesson.id && cell.repeat === 0 &&
        cell.caseRef === transcript.ref && Number.isFinite(cell.composite)) &&
        new Set(result.outcomes.map((cell) => cell.variantId)).size === 2 &&
        result.outcomes.every((cell) => [REPLAY_BASELINE_VARIANT.variantId, WITH_LESSON_VARIANT_ID].includes(cell.variantId));
      const evidence: LearningEvidence[] = (['objective', 'judgment', 'regression', 'probe', 'cost', 'rollback'] as const).map((kind) => {
        const measured = kind === 'judgment' ? paired : kind === 'cost' ? result.costMeasured : false;
        const passed = kind === 'judgment' ? withLesson.meanComposite! > baseline.meanComposite! :
          kind === 'cost' && !result.budgetExhausted &&
            Math.abs(reservation.usedUsd - result.totalCostUsd) < 1e-9 && reservation.usedUsd <= reservation.reservedUsd;
        return { id: `${result.batteryId}:${kind}`, kind,
          status: measured ? passed ? 'pass' : 'fail' : 'not-measured',
          coverage: { required: 1, measured: measured ? 1 : 0 },
          artifactRefs: kind === 'cost' ? [`learning-reservation:${reservation.id}`] : refs,
          recordedAt };
      });
      const actor = { kind: 'system' as const, id: TRANSFER_LOOP_ID, role: 'transfer' };
      const variantHash = transferLessonArtifactHash(lesson);
      evaluation.contract = adaptTransferOutput({
        candidate: { id: lesson.id, version: variantHash,
          parentVersion: hash({ baseline: config.variants[0], taskHash: evaluation.experiment.taskHash }),
          variantHash, actor, potScope: { workspaceId: lesson.workspaceId, potId: lesson.potSlug },
          createdAt: lesson.createdAt },
        experiment: evaluation.experiment,
        evidence, spend: { requestedUsd: reservation.requestedUsd, reservedUsd: reservation.reservedUsd,
          usedUsd: reservation.usedUsd, unsettledUsd: 0, settledAt: new Date(reservation.settledAt).toISOString() },
        verdict: 'inconclusive', authority: actor,
        reason: 'Source replay measured judgment and spend; complete execution pins and objective, regression, probe and rollback evidence are still required.',
        decidedAt: recordedAt,
      }).contract;
    }
    return {
      withComposite: withLesson.meanComposite,
      baselineComposite: baseline.meanComposite,
      batteryId: result.batteryId,
      costUsd: result.totalCostUsd,
      evaluation,
    };
  };
}
