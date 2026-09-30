/**
 * Judge-model registry — Plan §6.3 + §13 Q2 + §9 cost-model.
 *
 * Resolution rule (per §13 Q2 + §9 envelope):
 *   - Default judge = same family as SUT (Sonnet/Sonnet, etc.).
 *   - On `criticality:'high'` scenarios, a SECOND-OPINION pass uses
 *     Opus (or whatever `secondOpinion` resolves to) so we can flag
 *     score disagreement >1pt between the two passes. This balances
 *     §6.3's "must differ" ideal against §9's budget envelope
 *     ("Sonnet judge default with Opus opt-in").
 *
 * Per-scenario overrides go through Scenario / RunnerOpts.judgeModel.
 * Env override: LLM_TEST_JUDGE_MODEL — used by CI matrices or local
 * cost-tuning. When set, the env wins.
 */

export interface JudgeRegistryEntry {
  /** Default judge to use against this SUT family. */
  judge: string;
  /** Second-opinion judge for criticality='high' (multi-pass §6.4). */
  secondOpinion?: string;
}

const SUT_PREFIXES: Array<{ match: RegExp; entry: JudgeRegistryEntry }> = [
  // SUT=Opus: judge with Sonnet by default (cheaper); high-criticality
  // adds an Opus second-opinion pass.
  { match: /^claude-opus/i,   entry: { judge: 'claude-sonnet-4-6', secondOpinion: 'claude-opus-4-7' } },
  // SUT=Sonnet: same-family default (Sonnet/Sonnet) per §13 Q2 cost
  // model; high-criticality bumps the second-opinion pass to Opus.
  { match: /^claude-sonnet/i, entry: { judge: 'claude-sonnet-4-6', secondOpinion: 'claude-opus-4-7' } },
  // SUT=Haiku: judge stepped up to Sonnet so the judge is meaningfully
  // smarter than the SUT.
  { match: /^claude-haiku/i,  entry: { judge: 'claude-sonnet-4-6', secondOpinion: 'claude-opus-4-7' } },
];

/**
 * Resolve the default judge model for a given SUT.
 * Falls back to claude-sonnet-4-6 for unknown SUT families.
 */
export function resolveJudgeModel(sutModel: string): JudgeRegistryEntry {
  for (const row of SUT_PREFIXES) {
    if (row.match.test(sutModel)) return row.entry;
  }
  return { judge: 'claude-sonnet-4-6' };
}

/**
 * True when SUT and judge would produce a self-grading risk.
 * The runner uses this to fix-up defaults; per-scenario explicit
 * overrides are trusted and not second-guessed.
 */
export function isSelfGradingPair(sutModel: string, judgeModel: string): boolean {
  return sutModel === judgeModel;
}
