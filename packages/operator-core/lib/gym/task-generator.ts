/**
 * Intent-first synthetic task generator (P-005, D-004).
 *
 * Generates the high-level INTENT first, then derives a deliberately-realistic,
 * mildly-underspecified spec — so spec-gaps exist for the judge's D1 to find.
 * Generator and judge remain separate calls with separate prompts and provenance;
 * the owner-directed uniform learning-model policy permits the same model on both.
 * LLM injected so build → call → parse → assemble is unit-tested without the network.
 */
import { tryParseJson } from './parse-json';

export interface GymLlmCall {
  (opts: {
    model: string;
    system?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    responseFormat?: 'text' | 'json';
    thinkingBudgetTokens?: number;
    maxTokens?: number;
    priority?: string;
  }): Promise<{ text: string; json?: unknown; costUsd: number; inputTokens: number; outputTokens: number;
    costUsdMeasurementMissing?: boolean; unreportedFrames?: number }>;
}

export type GymTaskPool = 'train' | 'dev-anchor' | 'monitor' | 'probe' | 'real-anchor';

export interface GenerateTaskInput {
  taskId: string;
  pool: GymTaskPool;
  repoUrl: string;
  repoCommit: string;
  /** A grounding summary of the substrate repo (what it is, key surfaces). */
  repoContext: string;
  /** Model that generates the task. */
  generatorModel: string;
  /** The frozen judge model, retained in the input for provenance. */
  judgeModel: string;
  /** Optional steer toward a part of the repo. */
  focusArea?: string;
}

export interface GeneratedTaskRecord {
  taskId: string;
  pool: GymTaskPool;
  repoUrl: string;
  repoCommit: string;
  intent: string;
  spec: string;
  generatedBy: string;
}

export function buildTaskGenPrompt(input: GenerateTaskInput): { system: string; user: string } {
  const system = [
    'You design ONE realistic synthetic feature request for a coding-agent harness to attempt,',
    'grounded in the given repository. Work INTENT-FIRST:',
    '',
    '1. First decide a high-level INTENT — the underlying goal a stakeholder actually wants',
    '   (one or two sentences, outcome-oriented, not an implementation).',
    '2. THEN write a SPEC for that intent that is deliberately REALISTIC and mildly',
    '   UNDERSPECIFIED — the kind a busy human files: it leaves some decisions implicit and',
    '   has small GAPS or ambiguities, so a good implementer must infer intent. Do NOT make it',
    '   exhaustive or unambiguous, and do NOT restate the intent verbatim.',
    '',
    'Output ONLY a single JSON object (no prose, no code fences):',
    '{"intent": "<the high-level intent>", "spec": "<the mildly-underspecified spec>"}',
  ].join('\n');

  const user = [
    '## Repository',
    input.repoContext,
    ...(input.focusArea ? ['', '## Focus area', input.focusArea] : []),
  ].join('\n');

  return { system, user };
}

export interface ParsedGeneratedTask {
  intent: string;
  spec: string;
}

export function parseGeneratedTask(raw: unknown): ParsedGeneratedTask {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`generated task must be a JSON object, got: ${typeof raw}`);
  }
  const o = raw as Record<string, unknown>;
  const intent = typeof o.intent === 'string' ? o.intent.trim() : '';
  const spec = typeof o.spec === 'string' ? o.spec.trim() : '';
  if (!intent) throw new Error('generated task is missing a non-empty "intent"');
  if (!spec) throw new Error('generated task is missing a non-empty "spec"');
  return { intent, spec };
}

export async function generateGymTask(
  input: GenerateTaskInput,
  deps: { llmCall: GymLlmCall },
): Promise<GeneratedTaskRecord> {
  const { system, user } = buildTaskGenPrompt(input);
  const res = await deps.llmCall({
    model: input.generatorModel,
    system,
    messages: [{ role: 'user', content: user }],
    responseFormat: 'json',
  });
  const parsed = parseGeneratedTask(res.json ?? tryParseJson(res.text));
  return {
    taskId: input.taskId,
    pool: input.pool,
    repoUrl: input.repoUrl,
    repoCommit: input.repoCommit,
    intent: parsed.intent,
    spec: parsed.spec,
    generatedBy: input.generatorModel,
  };
}
