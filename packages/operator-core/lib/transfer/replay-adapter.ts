/**
 * The live student-transfer test (P-022 / FB-08) — lib/replay's battery bound
 * to the {@link TransferReplayPort} the tick consumes.
 *
 * One lesson's test = ONE governed replay battery over the lesson's source
 * historical case:
 *
 *   variants — the zero-cost BASELINE (the original continuation, judge-
 *     scored as the anchor) vs 'with-lesson' (the lesson as a systemOverlay —
 *     exactly the policy-delta shape lib/replay's types name for transfer
 *     lessons). The fresh student "given the lesson" is the overlay run.
 *   cut — the first acting turn (first non-system/user turn): the student
 *     re-attempts the task from the original ask, with and without the
 *     lesson in its system prompt.
 *   verdict — perVariant mean judge composites; gate.ts decides.
 *
 * Routed through runGovernedReplay (FB-06's unattended consumer entrypoint):
 * the replay flag + `frontier:replay-harness` budget gate the battery, and
 * THAT path ledgers the battery spend — the transfer loop ledgers only its
 * own distillation spend, so no battery dollar is ever double-counted.
 */
import type { JudgeLlmCall } from '@papercusp/eval-battery';
import {
  REPLAY_BASELINE_VARIANT,
  runGovernedReplay,
  type GovernedReplayResult,
  type ReplayBatteryConfig,
  type ReplayCase,
  type ReplayRunner,
  type ReplayTranscript,
  type ReplayVariant,
} from '../replay';
import type { TransferLesson, TransferReplayPort } from './types';

export const WITH_LESSON_VARIANT_ID = 'with-lesson';

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
    q: { workspaceId: string; config: ReplayBatteryConfig },
    deps: { runner: ReplayRunner; llmCall: JudgeLlmCall; now(): number },
  ) => Promise<GovernedReplayResult>;
  /** Per-test battery spend cap (the governor's remaining budget clamps it further). */
  maxSpendUsd?: number;
}

/** Bind lib/replay's battery as the tick's TransferReplayPort. */
export function transferReplayPort(deps: TransferReplayAdapterDeps): TransferReplayPort {
  const run = deps.runGoverned ?? runGovernedReplay;
  return async ({ lesson, transcript }) => {
    const replayCase: ReplayCase = {
      kind: 'historical',
      caseId: lesson.id,
      transcript,
      turnIndex: pickTransferCutIndex(transcript),
    };
    const config: ReplayBatteryConfig = {
      // Deterministic per test round: lesson id + how many tests it has had.
      batteryId: `transfer:${lesson.id}:t${lesson.testCount + 1}`,
      variants: [REPLAY_BASELINE_VARIANT, withLessonVariant(lesson)],
      cases: [replayCase],
      repeats: 1,
      ...(deps.maxSpendUsd !== undefined ? { maxSpendUsd: deps.maxSpendUsd } : {}),
    };
    const { verdict, result } = await run(
      { workspaceId: deps.workspaceId, config },
      { runner: deps.runner, llmCall: deps.llmCall, now: () => Date.now() },
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
    return {
      withComposite: withLesson.meanComposite,
      baselineComposite: baseline.meanComposite,
      batteryId: result.batteryId,
      costUsd: result.totalCostUsd,
    };
  };
}
