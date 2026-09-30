/**
 * Re-judge-from-cache (P-010).
 *
 * Re-scores a cached DISTILLED trace under a (possibly new) rubric WITHOUT re-running
 * the multi-hour pipeline — the cheap path for a rubric change or a rubric sweep.
 * Keyed on rubric_hash: if a score already exists for the run under that hash it's a
 * no-op; otherwise load the cached trace, judge, and store. All effects injected so
 * the orchestration is unit-tested without PG/files/network.
 */
import { rubricHash, type GymJudgeRubric } from './judge-scoring';
import type { GymJudgeInput, GymScore } from './judge';

export interface ReJudgeDeps {
  /** rubric_hashes already scored for this run. */
  existingScoreHashes(runId: string): Promise<string[]>;
  /** Load the cached distilled trace + its judging context. */
  loadDistilledTrace(runId: string): Promise<{ intent: string; projectContext: string; distilledTrace: string }>;
  /** The judge (judgeGymRun bound to a real or fake llmCall). */
  judge(input: GymJudgeInput): Promise<GymScore>;
  /** Persist the new score (gym_scores, keyed run_id + rubric_hash). */
  saveScore(runId: string, score: GymScore): Promise<void>;
}

export interface ReJudgeResult {
  action: 'cached' | 'judged';
  rubricHash: string;
  score?: GymScore;
}

export async function reJudgeFromCache(
  input: { runId: string; rubric: GymJudgeRubric },
  deps: ReJudgeDeps,
): Promise<ReJudgeResult> {
  const hash = rubricHash(input.rubric);
  const existing = await deps.existingScoreHashes(input.runId);
  if (existing.includes(hash)) {
    return { action: 'cached', rubricHash: hash };
  }
  const trace = await deps.loadDistilledTrace(input.runId);
  const score = await deps.judge({ ...trace, rubric: input.rubric });
  await deps.saveScore(input.runId, score);
  return { action: 'judged', rubricHash: hash, score };
}
