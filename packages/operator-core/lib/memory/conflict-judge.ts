/**
 * Which memory conflict judge runs, if any (plan jev-decision-model-integration-2026-09-29,
 * P-009, decisions D-015 and D-016).
 *
 * Preference: Jev when a Jev key is stored (it met the D-015 bar, D-016), else the
 * Anthropic judge when ANTHROPIC_API_KEY resolves, else NO judge, reported as
 * such. The old factory returned a no-op judge whose `{ conflicts: [] }` was
 * byte-identical to a healthy "nothing found", which is how a default-ON
 * contradiction guard sat inert (EI-18746586784230719). Callers now receive
 * `{ available: false, reason }` and must say so instead of pretending to check.
 *
 * Deliberately NOT gated on the Jev memory-injection mode (Off / Log only / On):
 * that setting chooses what gets added to a turn. Storing the key is what opts in
 * to TypeSafe, and the Settings card says the key is also used here.
 */
import { conflictJudgeAvailable, createAnthropicJudge } from './anthropic-judge';
import type { LlmJudge } from './conflict-check';
import { createJevConflictJudge } from './jev-conflict-judge';
import { ensureJevDecisionClient, readJevApiKey } from './jev-settings';

export type ConflictJudgeBackend = 'jev' | 'anthropic';

export type ConflictJudgeResolution =
  | { readonly available: true; readonly backend: ConflictJudgeBackend; readonly judge: LlmJudge }
  | { readonly available: false; readonly reason: string };

export const CONFLICT_JUDGE_UNAVAILABLE_REASON =
  'no Jev key is stored (Settings > Memory) and no ANTHROPIC_API_KEY resolves in this process';

export interface ConflictJudgeDeps {
  readonly readJevKey: () => Promise<string | null>;
  readonly anthropicAvailable: () => boolean;
  readonly jevJudge: () => LlmJudge;
  readonly anthropicJudge: () => LlmJudge;
}

const defaultDeps: ConflictJudgeDeps = {
  readJevKey: readJevApiKey,
  anthropicAvailable: () => conflictJudgeAvailable(),
  jevJudge: () => createJevConflictJudge({ client: ensureJevDecisionClient }),
  anthropicJudge: () => createAnthropicJudge(),
};

export async function resolveConflictJudge(deps: ConflictJudgeDeps = defaultDeps): Promise<ConflictJudgeResolution> {
  let jevKey: string | null = null;
  try {
    jevKey = await deps.readJevKey();
  } catch {
    jevKey = null;
  }
  if (jevKey) return { available: true, backend: 'jev', judge: deps.jevJudge() };
  if (deps.anthropicAvailable()) return { available: true, backend: 'anthropic', judge: deps.anthropicJudge() };
  return { available: false, reason: CONFLICT_JUDGE_UNAVAILABLE_REASON };
}
