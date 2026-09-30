/**
 * GAIA as a first-class {@link OfficialGrader} (plan benchmark-suite-gaia-2026-06-17) — so the GAIA arms
 * (su-independent / hive-realqueen) grade through the SAME arm-agnostic registry the SWE-bench family uses.
 *
 * Modality `qa` (M3): the arm hands a single FINAL ANSWER STRING (the {@link ArmSubmission} `qa` variant,
 * built by {@link qaSubmission}); we quasi-exact-match it against the gold answer carried in the task's
 * `graderMeta.finalAnswer`, using the SAME {@link gaiaQuestionScorer} the standalone grader uses. Pure +
 * deterministic + arm-blind — it cannot tell which arm produced the answer, the fairness invariant.
 *
 * `sub.answer` is whatever the agent wrote to `answer.txt`: we accept either the bare normalized answer OR a
 * full message ending in `FINAL ANSWER: …` ({@link extractFinalAnswer} pulls the latter; bare text falls back
 * to itself). The gold answer being absent is a corpus error → `graderError` (surfaced, not a silent fail).
 */
import type { ArmSubmission, BenchTask, GradeResult, OfficialGrader } from '../types';
import { extractFinalAnswer, gaiaQuestionScorer } from './gaia';

const GRADER_FAMILY = 'gaia';

export interface GaiaGraderConfig {
  /** Pinned grader version for pre-registration (e.g. 'gaia-quasi-exact-match@2026-06-17'). */
  version: string;
}

/** Build the GAIA OfficialGrader (modality 'qa'). Grades `qa` submissions; ignores diff/in-container. */
export function makeGaiaGrader(cfg: GaiaGraderConfig): OfficialGrader {
  return {
    family: GRADER_FAMILY,
    modality: 'qa',
    async grade(submissions: ArmSubmission[], tasks: BenchTask[]): Promise<GradeResult[]> {
      const taskById = new Map(tasks.map((t) => [t.instanceId, t]));
      const qaSubs = submissions.filter(
        (s): s is Extract<ArmSubmission, { modality: 'qa' }> => s.modality === 'qa',
      );
      return qaSubs.map((sub): GradeResult => {
        const task = taskById.get(sub.instanceId);
        const gold = String((task?.graderMeta?.finalAnswer ?? '') as string).trim();
        if (!task || gold === '') {
          return {
            instanceId: sub.instanceId,
            prefix: sub.prefix,
            resolved: false,
            rawGraderOutput: { answer: sub.answer, note: 'no gold answer in graderMeta.finalAnswer' },
            graderFamily: GRADER_FAMILY,
            graderVersion: cfg.version,
            graderError: 'GAIA task missing gold answer (graderMeta.finalAnswer) — cannot grade',
          };
        }
        const extracted = extractFinalAnswer(sub.answer) ?? sub.answer.trim();
        const resolved = extracted.length > 0 && gaiaQuestionScorer(extracted, gold);
        return {
          instanceId: sub.instanceId,
          prefix: sub.prefix,
          resolved,
          rawGraderOutput: { extractedAnswer: extracted, gold, level: task.graderMeta?.level },
          graderFamily: GRADER_FAMILY,
          graderVersion: cfg.version,
        };
      });
    },
  };
}
