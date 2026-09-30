/**
 * GDPval as a first-class {@link OfficialGrader} (plan benchmark-suite-gdpval-2026-06-17) — so the GDPval arms
 * grade through the SAME arm-agnostic registry the SWE-bench / GAIA families use.
 *
 * Modality `deliverable-bundle` (M4): the arm hands a deliverable reduced to text (the {@link ArmSubmission}
 * `deliverable-bundle` variant, via {@link deliverableSubmission}); we run the BLINDED PAIRWISE judge
 * ({@link gradeGdpvalTask}, dual-order position-bias-mitigated) against the expert reference deliverable carried
 * in the task's `graderMeta.referenceDeliverableText`, returning `resolved = win-or-tie` and `score` = the
 * win=1/tie=.5/loss=0 value (the suite headline is the mean of `score` = the win-rate).
 *
 * The reference deliverable is a FILE bundle in the dataset; the RUNNER resolves it to text (fetch + extract
 * the `referenceDeliverableUrls`) into `graderMeta.referenceDeliverableText` before grading — a missing one is
 * a `graderError` (surfaced, excluded), never a silent loss. The LLM judge is INJECTED via cfg (the autograder
 * by default; the hosted GDPval service / human-expert path is the same seam).
 */
import type { ArmSubmission, BenchTask, GradeResult, OfficialGrader } from '../types';
import { gradeGdpvalTask, type JudgeFn } from './gdpval';

const GRADER_FAMILY = 'gdpval';

export interface GdpvalGraderConfig {
  /** Pinned grader version for pre-registration (e.g. 'gdpval-autograder@2026-06-17 / judge=opus-4.8'). */
  version: string;
  /** The pairwise judge — the LLM autograder, or a wrapper over the hosted GDPval grading service. */
  judge: JudgeFn;
}

/** Build the GDPval OfficialGrader (modality 'deliverable-bundle'). Grades deliverable-bundle submissions only. */
export function makeGdpvalGrader(cfg: GdpvalGraderConfig): OfficialGrader {
  return {
    family: GRADER_FAMILY,
    modality: 'deliverable-bundle',
    async grade(submissions: ArmSubmission[], tasks: BenchTask[]): Promise<GradeResult[]> {
      const taskById = new Map(tasks.map((t) => [t.instanceId, t]));
      const subs = submissions.filter(
        (s): s is Extract<ArmSubmission, { modality: 'deliverable-bundle' }> => s.modality === 'deliverable-bundle',
      );
      const out: GradeResult[] = [];
      for (const sub of subs) {
        const task = taskById.get(sub.instanceId);
        const gm = (task?.graderMeta ?? {}) as Record<string, unknown>;
        const referenceText = String(gm.referenceDeliverableText ?? '').trim();
        if (!task || !referenceText) {
          out.push({
            instanceId: sub.instanceId,
            prefix: sub.prefix,
            resolved: false,
            score: null,
            rawGraderOutput: { deliverable: sub.deliverable.slice(0, 200), note: 'no resolved referenceDeliverableText' },
            graderFamily: GRADER_FAMILY,
            graderVersion: cfg.version,
            graderError: 'GDPval task missing reference deliverable text — the runner must resolve it before grading',
          });
          continue;
        }
        const grade = await gradeGdpvalTask(
          {
            taskId: sub.instanceId,
            occupation: String(gm.occupation ?? 'unknown'),
            sector: String(gm.sector ?? 'unknown'),
            prompt: task.problemStatement,
            rubric: String(gm.rubric ?? ''),
            modelDeliverable: sub.deliverable,
            referenceDeliverable: referenceText,
          },
          { judge: cfg.judge },
        );
        out.push({
          instanceId: sub.instanceId,
          prefix: sub.prefix,
          // resolved = win-or-tie (the model's deliverable rated ≥ the expert reference).
          resolved: grade.outcome !== 'loss',
          // score = win=1 / tie=0.5 / loss=0 → the mean over rows IS the win-rate.
          score: grade.score,
          rawGraderOutput: { outcome: grade.outcome, verdicts: grade.verdicts, occupation: grade.occupation, sector: grade.sector },
          graderFamily: GRADER_FAMILY,
          graderVersion: cfg.version,
        });
      }
      return out;
    },
  };
}
