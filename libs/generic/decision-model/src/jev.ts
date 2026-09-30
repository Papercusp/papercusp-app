/**
 * TypeSafe Jev adapter — the wire shape of `POST https://api.typesafe.ai/v1/systemone`
 * (contract read from https://docs.typesafe.ai/api.md, 2026-09-30).
 *
 * Request:  { model, state, questions: { <id>: { type, instructions, criteria? } } }
 *   - choice: criteria = { <option>: description|null }, 1..255 options
 *   - score:  criteria = [level0, level1, …], 2..10 levels
 *   - noul:   criteria = { true: …, false: … } (optional)
 * Response: { model, answers: { <id>: … }, usage: { input_tokens, output_tokens } }
 *   - choice: { type, choice, probabilities: {opt: p}, confidence }
 *   - score:  { type, score, legend, probabilities: {"0": p, …}, confidence }
 *   - noul:   { type, noul }
 *
 * The parser is strict on purpose: a 2xx body that does not answer EVERY asked
 * question with a well-formed answer of the asked type is `malformed`, never a
 * partial verdict.
 */
import type {
  Answer,
  DecisionProvider,
  DecisionRequest,
  DecisionUsage,
  ProviderHttpRequest,
  ProviderParseResult,
  Question,
} from './types.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * The pinned, versioned model id. Never `jev-latest`: that alias moves with every
 * TypeSafe release, so a silent upgrade would change every verdict without any
 * change on our side. Moving the pin is a deliberate act that re-runs the evaluation.
 */
export const JEV_PINNED_MODEL = 'jev-1.13.0';

export const JEV_MAX_CHOICE_OPTIONS = 255;
export const JEV_MIN_SCORE_LEVELS = 2;
export const JEV_MAX_SCORE_LEVELS = 10;

/** Probabilities are floats that sum to 1; allow rounding slack, not a missing option. */
const PROBABILITY_SUM_TOLERANCE = 0.02;

export interface JevProviderOptions {
  /** Override the pinned model (tests, or a deliberate evaluated pin move). */
  readonly model?: string;
  /** Override the endpoint (a proxy or a recorded-fixture server). */
  readonly endpoint?: string;
}

function toWireQuestion(q: Question): Record<string, unknown> {
  switch (q.type) {
    case 'choice':
      return { type: 'choice', instructions: q.instructions, criteria: q.options };
    case 'score':
      return { type: 'score', instructions: q.instructions, criteria: q.levels };
    case 'yesNo':
      return q.criteria
        ? { type: 'noul', instructions: q.instructions, criteria: { true: q.criteria.yes, false: q.criteria.no } }
        : { type: 'noul', instructions: q.instructions };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isUnitInterval(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function sumsToOne(values: readonly number[]): boolean {
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE;
}

function nonNegativeIntOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Parse one answer against the question that was asked; a string is the failure detail. */
function parseAnswer(id: string, q: Question, raw: unknown): Answer | string {
  if (!isRecord(raw)) return `answer '${id}' is not an object`;
  const wireType = q.type === 'yesNo' ? 'noul' : q.type;
  if (raw.type !== wireType) return `answer '${id}' has type ${JSON.stringify(raw.type)}, asked ${wireType}`;

  if (q.type === 'yesNo') {
    if (!isUnitInterval(raw.noul)) return `answer '${id}'.noul is not a probability`;
    return { type: 'yesNo', pYes: raw.noul };
  }

  if (!isUnitInterval(raw.confidence)) return `answer '${id}'.confidence is not in [0,1]`;
  if (!isRecord(raw.probabilities)) return `answer '${id}'.probabilities is not an object`;
  const probs = raw.probabilities;

  if (q.type === 'choice') {
    const options = Object.keys(q.options);
    const out: Record<string, number> = {};
    for (const opt of options) {
      const p = probs[opt];
      if (!isUnitInterval(p)) return `answer '${id}' has no probability for option '${opt}'`;
      out[opt] = p;
    }
    const extra = Object.keys(probs).filter((k) => !(k in q.options));
    if (extra.length > 0) return `answer '${id}' has probabilities for unasked options: ${extra.join(', ')}`;
    if (!sumsToOne(Object.values(out))) return `answer '${id}' probabilities do not sum to 1`;
    if (typeof raw.choice !== 'string' || !(raw.choice in q.options)) {
      return `answer '${id}'.choice ${JSON.stringify(raw.choice)} is not an asked option`;
    }
    return { type: 'choice', choice: raw.choice, probabilities: out, confidence: raw.confidence };
  }

  // score
  const levels = q.levels.length;
  const dist: number[] = [];
  for (let i = 0; i < levels; i++) {
    const p = probs[String(i)];
    if (!isUnitInterval(p)) return `answer '${id}' has no probability for level ${i}`;
    dist.push(p);
  }
  if (Object.keys(probs).length !== levels) return `answer '${id}' has probabilities for unasked levels`;
  if (!sumsToOne(dist)) return `answer '${id}' probabilities do not sum to 1`;
  const score = raw.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > levels - 1) {
    return `answer '${id}'.score is outside [0, ${levels - 1}]`;
  }
  return { type: 'score', score, probabilities: dist, confidence: raw.confidence };
}

export function createJevProvider(options: JevProviderOptions = {}): DecisionProvider {
  const model = options.model ?? JEV_PINNED_MODEL;
  const endpoint = options.endpoint ?? JEV_ENDPOINT;

  return {
    id: 'typesafe',
    model,

    validate(request: DecisionRequest): string | null {
      const entries = Object.entries(request.questions);
      if (entries.length === 0) return 'no questions asked';
      for (const [id, q] of entries) {
        if (q.type === 'choice') {
          const n = Object.keys(q.options).length;
          if (n < 1 || n > JEV_MAX_CHOICE_OPTIONS) return `question '${id}' has ${n} options (allowed 1..${JEV_MAX_CHOICE_OPTIONS})`;
        } else if (q.type === 'score') {
          const n = q.levels.length;
          if (n < JEV_MIN_SCORE_LEVELS || n > JEV_MAX_SCORE_LEVELS) {
            return `question '${id}' has ${n} levels (allowed ${JEV_MIN_SCORE_LEVELS}..${JEV_MAX_SCORE_LEVELS})`;
          }
        }
      }
      return null;
    },

    buildRequest(request: DecisionRequest, apiKey: string): ProviderHttpRequest {
      const questions: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(request.questions)) questions[id] = toWireQuestion(q);
      return {
        url: endpoint,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, state: request.state, questions }),
      };
    },

    parseResponse(body: unknown, request: DecisionRequest): ProviderParseResult {
      if (!isRecord(body)) return { ok: false, detail: 'response body is not an object' };
      if (typeof body.model !== 'string' || body.model.length === 0) return { ok: false, detail: 'response has no model id' };
      if (!isRecord(body.answers)) return { ok: false, detail: 'response has no answers object' };
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(request.questions)) {
        if (!(id in body.answers)) return { ok: false, detail: `question '${id}' was not answered` };
        const parsed = parseAnswer(id, q, body.answers[id]);
        if (typeof parsed === 'string') return { ok: false, detail: parsed };
        answers[id] = parsed;
      }
      const usageRaw = isRecord(body.usage) ? body.usage : {};
      const usage: DecisionUsage = {
        inputTokens: nonNegativeIntOrNull(usageRaw.input_tokens),
        outputTokens: nonNegativeIntOrNull(usageRaw.output_tokens),
      };
      return { ok: true, model: body.model, answers, usage };
    },
  };
}
