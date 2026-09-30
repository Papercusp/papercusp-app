/**
 * Turn a {@link DecisionCallRecord} into an AUDIT ENTRY: everything an auditor
 * needs to explain a verdict, and none of the text that was judged.
 *
 * What an entry keeps (the audit checklist for a typed decision model):
 *  - which model ANSWERED (the id the provider returned, not the one requested);
 *  - which question set was asked (`questionsSchemaSha256`) and in which option
 *    order (`optionOrder`) — kept apart on purpose, so calls that differ ONLY in
 *    option order share a schema hash and an order-sensitivity check can group them;
 *  - the per-question probabilities and confidence (`answers`);
 *  - whether it answered at all, and if not, why (`outcome`, `inconclusiveReason`);
 *  - latency, attempts, tokens and (when the host supplies rates) cost;
 *  - `subjectIds` + `stateSha256`: WHAT was judged, by id and by hash.
 *
 * What it never keeps: the `state` itself, and any detail string that could echo
 * it. A provider's error body can quote the request back, so the detail is kept
 * only for reasons whose detail this library wrote itself.
 *
 * Pure and storage-free: the host decides where an entry goes.
 */
import { createHash } from 'node:crypto';
import type { Answer, DecisionCallRecord, Describable, InconclusiveReason, Question, QuestionMap } from './types.js';

/** Host-supplied token rates. Providers do not return a price, so cost is null without these. */
export interface DecisionPricing {
  readonly inputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
}

export interface DecisionLedgerEntry {
  readonly provider: string;
  readonly consumer: string | null;
  readonly requestedModel: string;
  /** The model id the provider says answered; null when nothing answered. */
  readonly returnedModel: string | null;
  /** Question ids in the order they were asked. */
  readonly questionIds: readonly string[];
  /** sha256 of the canonical (key-sorted) question set: order-INSENSITIVE by design. */
  readonly questionsSchemaSha256: string;
  /** Choice question id → option keys in the order they were SENT. */
  readonly optionOrder: Readonly<Record<string, readonly string[]>>;
  /** Question id → answer (probabilities + confidence); null unless answered. */
  readonly answers: Readonly<Record<string, Answer>> | null;
  readonly outcome: 'answered' | 'inconclusive';
  readonly inconclusiveReason: InconclusiveReason | null;
  /** Only for reasons whose detail this library generated; never a provider body. */
  readonly inconclusiveDetail: string | null;
  readonly httpStatus: number | null;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly subjectIds: readonly string[];
  /** sha256 of the canonical JSON encoding of `state`. Detects repeats; reveals nothing. */
  readonly stateSha256: string;
  readonly startedAt: Date;
}

/**
 * Reasons whose `detail` is written by this library (validation, parse and
 * transport messages). The HTTP-status reasons are absent: their detail is the
 * provider's response body, which can quote the judged state back.
 */
const LOCAL_DETAIL_REASONS: ReadonlySet<InconclusiveReason> = new Set<InconclusiveReason>([
  'not-configured',
  'no-key',
  'invalid-request',
  'timeout',
  'aborted',
  'network-error',
  'malformed-response',
]);

/**
 * Deterministic JSON: object keys sorted at every depth, array order kept,
 * `undefined` members dropped (as JSON.stringify does). Two values that are
 * equal as data always encode to the same string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${members.join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hash of what was judged. Same state → same hash, whatever its key order. */
export function stateSha256(state: Describable): string {
  return sha256Hex(canonicalJson(state));
}

/** Hash of the question set, insensitive to question and option order. */
export function questionsSchemaSha256(questions: QuestionMap): string {
  return sha256Hex(canonicalJson(questions));
}

/** The option keys of every choice question, in the order they were sent. */
export function optionOrderOf(questions: QuestionMap): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, q] of Object.entries(questions) as [string, Question][]) {
    if (q.type === 'choice') out[id] = Object.keys(q.options);
  }
  return out;
}

function costOf(pricing: DecisionPricing | undefined, input: number | null, output: number | null): number | null {
  if (!pricing || input === null || output === null) return null;
  const usd = (input * pricing.inputUsdPerMillionTokens + output * pricing.outputUsdPerMillionTokens) / 1_000_000;
  return Number.isFinite(usd) && usd >= 0 ? usd : null;
}

export interface DecisionLedgerOptions {
  readonly pricing?: DecisionPricing;
}

export function toDecisionLedgerEntry(record: DecisionCallRecord, options: DecisionLedgerOptions = {}): DecisionLedgerEntry {
  const { request, outcome } = record;
  const base = {
    provider: record.provider,
    consumer: record.consumer,
    requestedModel: record.requestedModel,
    questionIds: Object.keys(request.questions),
    questionsSchemaSha256: questionsSchemaSha256(request.questions),
    optionOrder: optionOrderOf(request.questions),
    attempts: outcome.attempts,
    latencyMs: Math.max(0, Math.round(outcome.latencyMs)),
    subjectIds: [...record.subjectIds],
    stateSha256: stateSha256(request.state),
    startedAt: record.startedAt,
  };

  if (outcome.kind === 'answered') {
    const { inputTokens, outputTokens } = outcome.usage;
    return {
      ...base,
      returnedModel: outcome.model,
      answers: outcome.answers as Readonly<Record<string, Answer>>,
      outcome: 'answered',
      inconclusiveReason: null,
      inconclusiveDetail: null,
      httpStatus: null,
      inputTokens,
      outputTokens,
      costUsd: costOf(options.pricing, inputTokens, outputTokens),
    };
  }

  return {
    ...base,
    returnedModel: null,
    answers: null,
    outcome: 'inconclusive',
    inconclusiveReason: outcome.reason,
    inconclusiveDetail: LOCAL_DETAIL_REASONS.has(outcome.reason) ? (outcome.detail ?? null) : null,
    httpStatus: outcome.status ?? null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}
