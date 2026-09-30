/**
 * The real replay ports for experiment:run (`experiment-registry-invocation-api`
 * P-031) — the replayed-continuation runner + the judge LLM client, built from the
 * same `llm-testing/llm-client` the frontier replay loops use (the `regret`
 * replay-adapter precedent). Lazy imports keep the llm-client graph out of module load.
 */
import type { ReplayBatteryDeps } from '../replay/battery';
import type { ReplayRunner } from '../replay/types';

/** One LLM call continuing from the cut — the replayed continuation under test. */
export function experimentReplayRunner(defaultModel = 'claude-sonnet-4-6', maxTokens = 1500): ReplayRunner {
  return async ({ systemPrompt, contextText, variant }) => {
    const { llmCall } = await import('../llm-testing/llm-client');
    // The arm's `model` knob (variant.policy.model) overrides the default — model-per-arm (P-063).
    const r = await llmCall({ model: variant.policy.model ?? defaultModel, system: systemPrompt, messages: [{ role: 'user', content: contextText }], maxTokens });
    return {
      outputText: r.text,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      replayed: true,
    };
  };
}

/** The frozen judge — the same llm-client the gym/replay batteries use. */
export async function experimentJudge(): Promise<ReplayBatteryDeps['llmCall']> {
  const { llmCall } = await import('../llm-testing/llm-client');
  return llmCall;
}
