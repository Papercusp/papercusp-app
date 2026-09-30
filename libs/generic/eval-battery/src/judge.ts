/**
 * The frozen LLM judge runner — the only grader of record (factored out of the gym's
 * `judge.ts` into the shared eval-battery engine, reconciliation D-001).
 *
 * It sits ABOVE a subject's own validator: it does NOT re-check literal spec
 * conformance, but reasons generically over a DISTILLED trace about intent/spec-gaps,
 * code quality, and process correctness, emitting per-dimension scores + a rationale.
 * The weighted composite is the reward.
 *
 * The LLM call is injected ({@link JudgeLlmCall}) so build → call → parse → composite
 * is unit-tested without the network; the wiring passes the real `llmCall`, which
 * routes opus-4-8 with extended thinking through the shared backend.
 */
import { tryParseJson } from './parse-json';
import { composite, parseJudgeOutput, rubricHash, type BatteryRubric, type DimensionWeights } from './scoring';

/** The injected LLM call (structurally the llm-testing `llmCall`). */
export interface JudgeLlmCall {
  (opts: {
    model: string;
    system?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    responseFormat?: 'text' | 'json';
    thinkingBudgetTokens?: number;
    maxTokens?: number;
  }): Promise<{ text: string; json?: unknown; costUsd: number; inputTokens: number; outputTokens: number }>;
}

/** How much of the judge's raw reply is inlined into the thrown error's `.message`. */
export const JUDGE_RAW_EXCERPT_CHARS = 400;

/** Default number of REPAIR re-asks after a contract violation (0 disables). */
export const DEFAULT_JUDGE_REPAIR_ATTEMPTS = 1;

/**
 * The judge violated its OUTPUT CONTRACT — it returned something that is not a
 * scoreable `{d1,d2,d3,rationale}` object, after every repair attempt.
 *
 * WHY THIS IS A TYPED ERROR CARRYING THE RAW REPLY (WI-35902): the previous
 * `new Error('battery judge produced no parseable JSON output')` DISCARDED the model's
 * output, so the only durable witness — `autoloop_state.last_status` — recorded a
 * sentence with no evidence in it. The papercusp gym-cycle sat wedged on exactly that
 * message from 2026-07-27 with literally nothing to debug from: no length, no excerpt,
 * no way to tell a truncated reply from a refusal from a prose-wrapped score. A failure
 * whose own report cannot distinguish its causes is not diagnosable at any later date,
 * so the evidence has to ride ON the error.
 *
 * `.message` therefore leads with the fixed-shape facts (they survive the 160–200 char
 * truncation every escalation surface applies) and only then quotes the reply.
 */
export class JudgeOutputContractError extends Error {
  override readonly name = 'JudgeOutputContractError';
  /** The judge's full raw reply — for a caller that wants to persist it. */
  readonly rawText: string;
  /** The bounded excerpt already inlined into `.message`. */
  readonly rawExcerpt: string;
  readonly textLength: number;
  /** Did the transport hand back structured JSON (vs. text needing recovery)? */
  readonly hadStructuredJson: boolean;
  /** Reply has an unclosed `{` — the signature of a maxTokens-truncated object. */
  readonly looksTruncated: boolean;
  readonly judgeModel: string;
  /** Total attempts made (1 = no repair was configured or none was reached). */
  readonly attempts: number;
  /** Why the LAST attempt failed: unparseable JSON, or parsed-but-invalid shape. */
  readonly reason: 'unparseable' | 'invalid-shape';
  /** The validator's complaint when `reason === 'invalid-shape'`. */
  readonly validationError?: string;

  constructor(fields: {
    rawText: string;
    hadStructuredJson: boolean;
    judgeModel: string;
    attempts: number;
    reason: 'unparseable' | 'invalid-shape';
    validationError?: string;
  }) {
    const raw = fields.rawText ?? '';
    const excerpt = raw.slice(0, JUDGE_RAW_EXCERPT_CHARS);
    const looksTruncated = raw.includes('{') && !raw.trimEnd().endsWith('}');
    const detail =
      fields.reason === 'invalid-shape'
        ? `invalid shape: ${fields.validationError ?? 'unknown'}`
        : 'no parseable JSON output';
    super(
      `battery judge produced ${detail} after ${fields.attempts} attempt(s) ` +
        `[model=${fields.judgeModel} chars=${raw.length} structuredJson=${fields.hadStructuredJson ? 'present' : 'absent'}` +
        `${looksTruncated ? ' truncated=likely' : ''}] — reply starts: ${JSON.stringify(excerpt)}`,
    );
    this.rawText = raw;
    this.rawExcerpt = excerpt;
    this.textLength = raw.length;
    this.hadStructuredJson = fields.hadStructuredJson;
    this.looksTruncated = looksTruncated;
    this.judgeModel = fields.judgeModel;
    this.attempts = fields.attempts;
    this.reason = fields.reason;
    if (fields.validationError !== undefined) this.validationError = fields.validationError;
  }
}

export interface JudgeInput {
  /** The high-level intent the work should have achieved. */
  intent: string;
  /** Project context (repo summary) the judge weighs spec-gaps against. */
  projectContext: string;
  /** The distilled trace of the subject's run (judge-sized). */
  distilledTrace: string;
  /** The frozen rubric (model + weights + temp + dimension defs + thinking budget). */
  rubric: BatteryRubric;
}

export interface BatteryScore {
  d1: number;
  d2: number;
  d3: number;
  composite: number;
  rationale: string;
  judgeModel: string;
  rubricHash: string;
  judgeTemp: number;
  weights: DimensionWeights;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export function buildJudgePrompt(input: JudgeInput): { system: string; user: string } {
  const { dimensions } = input.rubric;
  const system = [
    'You are a FROZEN, independent evaluator of a coding harness’s work on one task.',
    'You sit ABOVE the harness’s own validator: do NOT re-check literal spec conformance',
    '(that is the harness’s job). Using your own judgment — not a rigid anchor table —',
    'score each dimension from 0 (worst) to 10 (best):',
    '',
    `D1 — ${dimensions.d1}`,
    `D2 — ${dimensions.d2}`,
    `D3 — ${dimensions.d3}`,
    '',
    'Reason carefully first, then output ONLY a single JSON object (no prose, no code fences):',
    '{"d1": <0-10 number>, "d2": <0-10 number>, "d3": <0-10 number>, "rationale": "<concise justification a prompt-optimizer will reflect on>"}',
  ].join('\n');

  const user = [
    '## Intent',
    input.intent,
    '',
    '## Project context',
    input.projectContext,
    '',
    '## Distilled trace of the harness run',
    input.distilledTrace,
  ].join('\n');

  return { system, user };
}

/**
 * The repair re-ask (WI-35902). A judge that reasons before answering sometimes wraps or
 * mangles its object; a single strict re-ask recovers it far more often than it fails.
 *
 * This does NOT relax the contract or synthesise a score — it re-asks the SAME frozen
 * rubric and accepts only the model's own numbers, so the grader of record stays the
 * grader of record. The alternative it replaces is worse in both directions: throwing
 * killed an entire gym cycle over one malformed reply, and scoring the cell 0 would have
 * fed an infrastructure failure to the prompt-optimizer as if it were a bad harness run.
 */
function buildRepairMessages(user: string, badReply: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  return [
    { role: 'user', content: user },
    { role: 'assistant', content: badReply.slice(0, 2_000) },
    {
      role: 'user',
      content:
        'That reply was not accepted: it must be a SINGLE JSON object and nothing else. ' +
        'Do not restate your reasoning, do not use code fences, do not add any prose before or after. ' +
        'Reply with exactly: {"d1": <0-10 number>, "d2": <0-10 number>, "d3": <0-10 number>, "rationale": "<concise justification>"}',
    },
  ];
}

export async function judgeBatteryRun(
  input: JudgeInput,
  deps: { llmCall: JudgeLlmCall; repairAttempts?: number },
): Promise<BatteryScore> {
  const { rubric } = input;
  const { system, user } = buildJudgePrompt(input);
  const repairAttempts = Math.max(0, deps.repairAttempts ?? DEFAULT_JUDGE_REPAIR_ATTEMPTS);

  // Cost/token accounting ACCUMULATES across attempts — a repaired judgement really did
  // spend both calls, and a budget that under-counts retries under-counts exactly when
  // the system is misbehaving.
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  let lastRawText = '';
  let lastHadStructuredJson = false;
  let lastReason: 'unparseable' | 'invalid-shape' = 'unparseable';
  let lastValidationError: string | undefined;

  for (let attempt = 0; attempt <= repairAttempts; attempt++) {
    const res = await deps.llmCall({
      model: rubric.model,
      system,
      messages: attempt === 0 ? [{ role: 'user', content: user }] : buildRepairMessages(user, lastRawText),
      responseFormat: 'json',
      thinkingBudgetTokens: rubric.thinkingBudgetTokens,
      // Anthropic requires max_tokens > thinking.budget_tokens; leave room for the output.
      maxTokens: rubric.thinkingBudgetTokens + 4096,
    });

    costUsd += res.costUsd;
    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
    lastRawText = res.text ?? '';
    lastHadStructuredJson = res.json != null;

    const rawJson = res.json ?? tryParseJson(res.text);
    if (rawJson == null) {
      lastReason = 'unparseable';
      lastValidationError = undefined;
      continue;
    }
    let parsed;
    try {
      parsed = parseJudgeOutput(rawJson);
    } catch (e) {
      // Parseable JSON of the WRONG SHAPE is the same contract violation, and equally
      // repairable — carry the validator's own complaint into the error if we run out.
      lastReason = 'invalid-shape';
      lastValidationError = e instanceof Error ? e.message : String(e);
      continue;
    }

    return {
      d1: parsed.d1,
      d2: parsed.d2,
      d3: parsed.d3,
      composite: composite(parsed, rubric.weights),
      rationale: parsed.rationale,
      judgeModel: rubric.model,
      rubricHash: rubricHash(rubric),
      judgeTemp: rubric.temperature,
      weights: rubric.weights,
      costUsd,
      inputTokens,
      outputTokens,
    };
  }

  throw new JudgeOutputContractError({
    rawText: lastRawText,
    hadStructuredJson: lastHadStructuredJson,
    judgeModel: rubric.model,
    attempts: repairAttempts + 1,
    reason: lastReason,
    ...(lastValidationError !== undefined ? { validationError: lastValidationError } : {}),
  });
}
