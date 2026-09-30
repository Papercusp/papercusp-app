/**
 * P-007 matched-cadence TTL comparison (plan cache-efficiency-and-accounting-2026-09-23, D-058).
 *
 * Compares the CURRENT retention policy (markers sent with an omitted ttl, which the shared
 * cache-policy module upgrades to 1h) against a MIXED candidate (explicit 1h on the stable system
 * prefix, explicit 5m on the changing message tail). cache-policy keeps explicit caller TTLs, so
 * the candidate is exercised without changing the gateway.
 *
 * Everything here is transport-agnostic: `runTtlCadenceTrial` takes an injected `send`, so the
 * same code runs against a loopback provider in tests and against the gateway in the live run.
 * Costs are priced at SOURCE-REPORTED tiers with @papercusp/model-pricing; uncertainty reuses
 * @papercusp/bench-metrics pairedBootstrapCI (10000 iterations, seed 12345 — D-058).
 */
import { pairedBootstrapCI, type PairedComparison } from '@papercusp/bench-metrics';
import { costFromTokens } from '@papercusp/model-pricing';

export type TrialArm = 'control' | 'candidate';
export type TrialStratum = 'A' | 'B' | 'C';

/** Inter-request gap per stratum (D-058): in-turn loop, just past 5m, the 10–60m band. */
export const STRATUM_GAP_MS: Readonly<Record<TrialStratum, number>> = { A: 30_000, B: 360_000, C: 900_000 };

/**
 * On a Claude Max subscription token the FIRST system block must be the Claude Code identifier,
 * or the request lands in a far stricter bucket and 429s (gateway.ts subscription-transport note).
 * It carries no marker, so it changes neither the marker budget nor arm parity.
 */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export interface TraceSpec {
  pairId: string;
  /** Unmarked first system block (the subscription-transport identity); omitted when empty. */
  systemPreamble?: string;
  stratum: TrialStratum;
  /** Unique per trace; leads the system prefix so no cache is shared across traces. */
  nonce: string;
  model: string;
  systemText: string;
  /** One user chunk per request; each contains `codeWords[i]`. */
  chunks: readonly string[];
  codeWords: readonly string[];
  maxTokens: number;
}

export interface CacheControl { type: 'ephemeral'; ttl?: '5m' | '1h' }
interface TextBlock { type: 'text'; text: string; cache_control?: CacheControl }
interface Message { role: 'user' | 'assistant'; content: TextBlock[] }
export interface TrialRequestBody {
  model: string;
  max_tokens: number;
  stream: true;
  system: TextBlock[];
  messages: Message[];
}

/**
 * Build request `seq` (0-based) of a trace. `replies[i]` is the assistant text returned by
 * request i (i < seq). Exactly two markers: system, and the LAST user message. The control
 * omits ttl (deployed policy decides); the candidate states 1h then 5m (long before short).
 */
export function buildTrialRequest(spec: TraceSpec, arm: TrialArm, seq: number, replies: readonly string[]): TrialRequestBody {
  if (seq < 0 || seq >= spec.chunks.length) throw new Error(`buildTrialRequest: seq ${seq} out of range`);
  if (replies.length < seq) throw new Error(`buildTrialRequest: need ${seq} prior replies, got ${replies.length}`);
  const marker = (ttl: '5m' | '1h'): CacheControl => (arm === 'candidate' ? { type: 'ephemeral', ttl } : { type: 'ephemeral' });
  const messages: Message[] = [];
  for (let i = 0; i <= seq; i++) {
    const last = i === seq;
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userTurnText(spec, i), ...(last ? { cache_control: marker('5m') } : {}) }],
    });
    if (!last) messages.push({ role: 'assistant', content: [{ type: 'text', text: replies[i] || '(no reply)' }] });
  }
  return {
    model: spec.model,
    max_tokens: spec.maxTokens,
    stream: true,
    system: [
      ...(spec.systemPreamble ? [{ type: 'text' as const, text: spec.systemPreamble }] : []),
      { type: 'text', text: `trace ${spec.nonce}\n\n${spec.systemText}`, cache_control: marker('1h') },
    ],
    messages,
  };
}

function userTurnText(spec: TraceSpec, i: number): string {
  return `Section ${i + 1}.\n${spec.chunks[i]}\n\nReply with only the code word stated in Section ${i + 1}.`;
}

/** Deterministic filler text (seeded LCG) so the workload is reproducible and repo-independent. */
export function syntheticText(seed: number, words: number): string {
  const vocab = ['ledger', 'cadence', 'prefix', 'marker', 'tail', 'budget', 'stratum', 'replay', 'window', 'anchor', 'record',
    'signal', 'buffer', 'cohort', 'harness', 'gateway', 'account', 'policy', 'region', 'vector', 'segment', 'kernel',
    'shard', 'bucket', 'stream', 'packet', 'socket', 'tensor', 'module', 'context'];
  let s = seed >>> 0 || 1;
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(`${vocab[s % vocab.length]}${(s >>> 8) % 97}`);
    if (i % 16 === 15) out.push('.\n');
  }
  return out.join(' ');
}

export function buildTraceSpec(opts: {
  pairId: string; stratum: TrialStratum; nonce: string; model: string; seed: number;
  systemWords: number; chunkWords: number; requests: number; maxTokens?: number; systemPreamble?: string;
}): TraceSpec {
  const chunks: string[] = [];
  const codeWords: string[] = [];
  for (let i = 0; i < opts.requests; i++) {
    const code = `CW${opts.seed.toString(36).toUpperCase()}X${i + 1}Q`;
    codeWords.push(code);
    const body = syntheticText(opts.seed * 31 + i + 1, opts.chunkWords);
    const mid = Math.floor(body.length / 2);
    chunks.push(`${body.slice(0, mid)}\nThe code word for this section is ${code}.\n${body.slice(mid)}`);
  }
  return {
    pairId: opts.pairId, stratum: opts.stratum, nonce: opts.nonce, model: opts.model,
    systemPreamble: opts.systemPreamble ?? CLAUDE_CODE_IDENTITY,
    // The system prefix is the SAME text for both arms of a pair; only the nonce differs.
    systemText: syntheticText(opts.seed, opts.systemWords), chunks, codeWords, maxTokens: opts.maxTokens ?? 32,
  };
}

export interface ReportedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cacheCreation5mTokens: number | null;
  cacheCreation1hTokens: number | null;
}

export interface TrialRequestRow {
  pairId: string;
  stratum: TrialStratum;
  arm: TrialArm;
  traceNonce: string;
  seq: number;
  /** 1-based attempt for this seq; every attempt is retained as its own row. */
  attempt?: number;
  model: string;
  startedAt: string;
  status: 'ok' | 'error';
  error?: string;
  httpStatus?: number;
  messageId?: string | null;
  gatewayRequestId?: string | null;
  routedAccount?: string | null;
  ttftMs?: number | null;
  totalMs?: number | null;
  replyText?: string;
  qualityOk?: boolean;
  usage?: ReportedUsage;
  /** Provider stop_reason from message_delta; null when the stream never delivered one. */
  stopReason?: string | null;
  /** content_block_start types in stream order (e.g. text, thinking). */
  contentBlockTypes?: string[];
  /** Type of an in-stream `error` event (the provider failed after answering HTTP 200). */
  streamError?: string | null;
}

/** True when the source reported every field needed to price the request at its actual tier. */
export function tiersKnown(u: ReportedUsage | undefined): boolean {
  if (!u) return false;
  const vals = [u.inputTokens, u.cacheReadTokens, u.cacheCreation5mTokens, u.cacheCreation1hTokens];
  if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) return false;
  if (u.cacheCreationTokens != null && u.cacheCreationTokens !== (u.cacheCreation5mTokens! + u.cacheCreation1hTokens!)) return false;
  return true;
}

/** Input-side USD at source-reported tiers; null when the tiers are not fully known. */
export function inputCostUsd(model: string, u: ReportedUsage | undefined): number | null {
  if (!tiersKnown(u)) return null;
  const c = costFromTokens(model, {
    inputTokens: u!.inputTokens!, outputTokens: 0, cacheReadTokens: u!.cacheReadTokens!,
    cacheCreation5mTokens: u!.cacheCreation5mTokens!, cacheCreation1hTokens: u!.cacheCreation1hTokens!,
    requestInputTokens: requestInputTokens(u!),
  });
  return c.priced ? c.usd : null;
}

export function requestInputTokens(u: ReportedUsage): number {
  return (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheCreation5mTokens ?? 0) + (u.cacheCreation1hTokens ?? 0);
}

export interface ParsedMessagesSse {
  usage: ReportedUsage;
  text: string;
  messageId: string | null;
  stopReason: string | null;
  contentBlockTypes: string[];
  /** Type of an in-stream `error` event, e.g. overloaded_error. */
  streamError: string | null;
  /** True only when message_stop arrived: a stream cut short is not a complete answer. */
  complete: boolean;
}

/** Parse an Anthropic Messages SSE stream body into usage, reply text, message id and stream outcome. */
export function parseMessagesSse(raw: string): ParsedMessagesSse {
  const usage: ReportedUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, cacheCreation5mTokens: null, cacheCreation1hTokens: null };
  let text = '';
  let messageId: string | null = null;
  let stopReason: string | null = null;
  let streamError: string | null = null;
  let complete = false;
  const contentBlockTypes: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>; } catch { continue; }
    if (ev.type === 'message_start' && isRec(ev.message)) {
      messageId = typeof ev.message.id === 'string' ? ev.message.id : null;
      if (isRec(ev.message.usage)) applyUsage(usage, ev.message.usage);
    } else if (ev.type === 'content_block_start' && isRec(ev.content_block) && typeof ev.content_block.type === 'string') {
      contentBlockTypes.push(ev.content_block.type);
    } else if (ev.type === 'content_block_delta' && isRec(ev.delta) && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
      text += ev.delta.text;
    } else if (ev.type === 'message_delta') {
      if (isRec(ev.usage)) applyUsage(usage, ev.usage);
      if (isRec(ev.delta) && typeof ev.delta.stop_reason === 'string') stopReason = ev.delta.stop_reason;
    } else if (ev.type === 'message_stop') {
      complete = true;
    } else if (ev.type === 'error') {
      streamError = isRec(ev.error) && typeof ev.error.type === 'string' ? ev.error.type : 'error';
    }
  }
  return { usage, text, messageId, stopReason, contentBlockTypes, streamError, complete: complete && streamError === null };
}

function applyUsage(target: ReportedUsage, u: Record<string, unknown>): void {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (num(u.input_tokens) != null) target.inputTokens = num(u.input_tokens);
  if (num(u.output_tokens) != null) target.outputTokens = num(u.output_tokens);
  if (num(u.cache_read_input_tokens) != null) target.cacheReadTokens = num(u.cache_read_input_tokens);
  if (num(u.cache_creation_input_tokens) != null) target.cacheCreationTokens = num(u.cache_creation_input_tokens);
  if (isRec(u.cache_creation)) {
    if (num(u.cache_creation.ephemeral_5m_input_tokens) != null) target.cacheCreation5mTokens = num(u.cache_creation.ephemeral_5m_input_tokens);
    if (num(u.cache_creation.ephemeral_1h_input_tokens) != null) target.cacheCreation1hTokens = num(u.cache_creation.ephemeral_1h_input_tokens);
  }
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Budget (D-058) ────────────────────────────────────────────────────────────

export interface TrialBudget { maxChargedRequests: number; maxInputTokens: number; maxOutputTokens: number; maxUsd: number }
export const D058_BUDGET: TrialBudget = { maxChargedRequests: 330, maxInputTokens: 16_000_000, maxOutputTokens: 40_000, maxUsd: 60 };

export interface BudgetSpend { chargedRequests: number; inputTokens: number; outputTokens: number; usd: number }

/**
 * Conservative projection for one trace: every request writes its WHOLE prompt at the 1h rate
 * (the most expensive input tier) and emits max_tokens. `approxTokensPerWord` over-estimates.
 */
export function projectTrace(spec: TraceSpec, approxTokensPerWord: number, rates: { inPerM: number; outPerM: number }): BudgetSpend {
  const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
  const sys = words(spec.systemText) + 4;
  let prompt = sys;
  let inputTokens = 0;
  for (let i = 0; i < spec.chunks.length; i++) {
    prompt += words(spec.chunks[i]) + 16 + spec.maxTokens;
    inputTokens += Math.ceil(prompt * approxTokensPerWord);
  }
  const outputTokens = spec.chunks.length * spec.maxTokens;
  return {
    chargedRequests: spec.chunks.length,
    inputTokens,
    outputTokens,
    usd: (inputTokens * rates.inPerM * 2 + outputTokens * rates.outPerM) / 1_000_000,
  };
}

export function budgetAdmits(spent: BudgetSpend, next: BudgetSpend, budget: TrialBudget): { ok: boolean; axis?: keyof TrialBudget } {
  if (spent.chargedRequests + next.chargedRequests > budget.maxChargedRequests) return { ok: false, axis: 'maxChargedRequests' };
  if (spent.inputTokens + next.inputTokens > budget.maxInputTokens) return { ok: false, axis: 'maxInputTokens' };
  if (spent.outputTokens + next.outputTokens > budget.maxOutputTokens) return { ok: false, axis: 'maxOutputTokens' };
  if (spent.usd + next.usd > budget.maxUsd) return { ok: false, axis: 'maxUsd' };
  return { ok: true };
}

/** Actual spend of recorded rows (errors count as charged requests; unknown tokens count as 0). */
export function actualSpend(rows: readonly TrialRequestRow[]): BudgetSpend {
  let inputTokens = 0, outputTokens = 0, usd = 0;
  for (const r of rows) {
    if (r.usage) {
      inputTokens += requestInputTokens(r.usage);
      outputTokens += r.usage.outputTokens ?? 0;
      const c = costFromTokens(r.model, {
        inputTokens: r.usage.inputTokens ?? 0, outputTokens: r.usage.outputTokens ?? 0, cacheReadTokens: r.usage.cacheReadTokens ?? 0,
        cacheCreation5mTokens: r.usage.cacheCreation5mTokens ?? 0, cacheCreation1hTokens: r.usage.cacheCreation1hTokens ?? 0,
        requestInputTokens: requestInputTokens(r.usage),
      });
      usd += c.usd;
    }
  }
  return { chargedRequests: rows.length, inputTokens, outputTokens, usd };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export interface SendResult {
  httpStatus: number;
  /** Full SSE body (or error body). */
  body: string;
  ttftMs: number | null;
  totalMs: number;
  headers: { routedAccount: string | null; gatewayRequestId: string | null };
}
export type TrialSend = (body: TrialRequestBody, ctx: { pairId: string; arm: TrialArm; seq: number }) => Promise<SendResult>;

export interface RunTraceDeps {
  send: TrialSend;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  onRow: (row: TrialRequestRow) => void | Promise<void>;
  /** Attempts per request (default 1). Only capacity refusals are retried (see isRetryable). */
  maxAttempts?: number;
  /** Delay before retry `attempt` (1-based count of failures so far). */
  retryDelayMs?: (failures: number) => number;
}

/**
 * Capacity refusals (429/503/529) and transport errors carry no provider charge and say nothing
 * about the policy, so they are retried. Every other status (e.g. a 400 rejecting a marker) is
 * a finding and ends the trace.
 */
export function isRetryable(row: TrialRequestRow): boolean {
  if (row.status === 'ok') return false;
  if (row.httpStatus === undefined) return true; // thrown transport error
  // HTTP 200 whose stream then failed or was cut short: a capacity/transport failure, not a
  // verdict on the request. Anything but a capacity-shaped in-stream error ends the trace.
  if (row.httpStatus === 200) return row.streamError == null || /overloaded|rate_limit|api_error/.test(row.streamError);
  return row.httpStatus === 429 || row.httpStatus === 503 || row.httpStatus === 529;
}

/** Run one arm of one trace: requests in order, `gapMs` apart (measured start-to-start). */
export async function runTrace(spec: TraceSpec, arm: TrialArm, gapMs: number, deps: RunTraceDeps): Promise<TrialRequestRow[]> {
  const rows: TrialRequestRow[] = [];
  const replies: string[] = [];
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 1);
  for (let seq = 0; seq < spec.chunks.length; seq++) {
    const started = deps.now();
    let row!: TrialRequestRow;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      row = await attemptRequest(spec, arm, seq, attempt, replies, deps);
      rows.push(row);
      await deps.onRow(row);
      if (!isRetryable(row) || attempt === maxAttempts) break;
      await deps.sleep(deps.retryDelayMs?.(attempt) ?? 30_000);
    }
    // A failed request leaves the trace unpaired; stop it rather than continue on a broken history.
    if (row.status !== 'ok') break;
    replies.push(row.replyText ?? '');
    if (seq < spec.chunks.length - 1) {
      const elapsed = deps.now().getTime() - started.getTime();
      await deps.sleep(Math.max(0, gapMs - elapsed));
    }
  }
  return rows;
}

async function attemptRequest(
  spec: TraceSpec, arm: TrialArm, seq: number, attempt: number, replies: readonly string[], deps: RunTraceDeps,
): Promise<TrialRequestRow> {
  const started = deps.now();
  const body = buildTrialRequest(spec, arm, seq, replies);
  const base = { pairId: spec.pairId, stratum: spec.stratum, arm, traceNonce: spec.nonce, seq, attempt, model: spec.model, startedAt: started.toISOString() };
  try {
    const res = await deps.send(body, { pairId: spec.pairId, arm, seq });
    if (res.httpStatus !== 200) {
      return { ...base, status: 'error', httpStatus: res.httpStatus, error: res.body.slice(0, 500), totalMs: res.totalMs,
        routedAccount: res.headers.routedAccount, gatewayRequestId: res.headers.gatewayRequestId };
    }
    const parsed = parseMessagesSse(res.body);
    const outcome = { stopReason: parsed.stopReason, contentBlockTypes: parsed.contentBlockTypes, streamError: parsed.streamError };
    if (!parsed.complete) {
      // Retain what the stream did report (message id, start-of-message usage): the attempt may be
      // charged, so it stays in the budget and the charged-id census.
      return { ...base, status: 'error', httpStatus: 200, error: `stream ${parsed.streamError ?? 'incomplete: no message_stop'}`,
        messageId: parsed.messageId, gatewayRequestId: res.headers.gatewayRequestId, routedAccount: res.headers.routedAccount,
        totalMs: res.totalMs, usage: parsed.usage, ...outcome };
    }
    return {
      ...base, status: 'ok', httpStatus: 200, messageId: parsed.messageId, gatewayRequestId: res.headers.gatewayRequestId,
      routedAccount: res.headers.routedAccount, ttftMs: res.ttftMs, totalMs: res.totalMs, replyText: parsed.text,
      qualityOk: parsed.text.includes(spec.codeWords[seq]), usage: parsed.usage, ...outcome,
    };
  } catch (err) {
    return { ...base, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/** The final attempt per seq, in seq order (retried capacity refusals are superseded, not dropped). */
export function finalAttempts(rows: readonly TrialRequestRow[]): TrialRequestRow[] {
  const bySeq = new Map<number, TrialRequestRow>();
  for (const r of rows) {
    const prev = bySeq.get(r.seq);
    if (!prev || (r.attempt ?? 1) >= (prev.attempt ?? 1)) bySeq.set(r.seq, r);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// ── Analysis ──────────────────────────────────────────────────────────────────

export interface PairResult {
  pairId: string;
  stratum: TrialStratum;
  complete: boolean;
  controlInputUsd: number | null;
  candidateInputUsd: number | null;
  qualityControl: number;
  qualityCandidate: number;
}

export interface StratumWeights { A: number; B: number; C: number }

export interface TrialSummary {
  /**
   * attempts = every recorded attempt (budget counts them all, conservatively); ok = attempts the
   * provider answered (the charged population); coverage = ok attempts with fully known tiers / ok.
   */
  requests: { attempts: number; ok: number; errors: number; tiersKnown: number; coverage: number };
  uniqueChargedIds: { total: number; unique: number; duplicates: string[] };
  pairs: PairResult[];
  excludedPairs: { pairId: string; reason: string }[];
  byStratum: Partial<Record<TrialStratum, PairedComparison & { pairs: number; tierMix: TierMix }>>;
  weights: StratumWeights;
  weighted: WeightedComparison | null;
  /** p95 values are gap-weighted (see summarizeTrial); p50 values are unweighted pooled. */
  latency: { controlP95: number | null; candidateP95: number | null; ratio: number | null; controlP50: number | null; candidateP50: number | null };
  latencyByStratum: Partial<Record<TrialStratum, { controlP50: number | null; candidateP50: number | null; controlP95: number | null; candidateP95: number | null }>>;
  quality: { control: number; candidate: number; regression: boolean };
  /**
   * Disclosure only — never a decision input (D-058 fixed the decision rule before collection).
   * Answered requests whose reply had no text, and traces that kept going after one: every later
   * request in such a trace carries a placeholder assistant turn, so its pair is no longer
   * content-matched and its later quality misses are not independent observations.
   */
  anomalies: {
    emptyReplies: {
      pairId: string; arm: TrialArm; seq: number; outputTokens: number | null;
      stopReason: string | null; contentBlockTypes: string[] | null;
      /** False for rows written before the runner recorded stream outcome: the cause is unknown. */
      causeRecorded: boolean;
    }[];
    emptyRepliesByArm: Record<TrialArm, number>;
    cascadedTraces: { pairId: string; arm: TrialArm; fromSeq: number; laterRequests: number; laterEmpty: number }[];
    /** Code-word match rate over answered requests up to and including each trace's first empty reply. */
    qualityBeforeCascade: { control: number; candidate: number };
    streamErrors: number;
  };
  spend: BudgetSpend;
  decision: { adoptCandidate: boolean; reasons: string[] };
}

export interface TierMix { control: TierTotals; candidate: TierTotals }
interface TierTotals { uncached: number; read: number; write5m: number; write1h: number }

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/**
 * Weighted percentile: each value carries a weight (weights need not sum to 1). Returns the
 * smallest value whose cumulative weight reaches p% of the total. Zero-weight values never
 * decide the result.
 */
export function weightedPercentile(items: readonly { value: number; weight: number }[], p: number): number | null {
  const xs = items.filter((x) => Number.isFinite(x.value) && x.weight > 0).sort((a, b) => a.value - b.value);
  const total = xs.reduce((a, x) => a + x.weight, 0);
  if (!xs.length || !(total > 0)) return null;
  const target = (p / 100) * total;
  let acc = 0;
  for (const x of xs) { acc += x.weight; if (acc >= target - 1e-12) return x.value; }
  return xs[xs.length - 1].value;
}

export function summarizeTrial(rows: readonly TrialRequestRow[], opts: { requestsPerTrace: number; weights: StratumWeights }): TrialSummary {
  const ok = rows.filter((r) => r.status === 'ok');
  const known = ok.filter((r) => tiersKnown(r.usage));
  const ids = ok.map((r) => r.messageId ?? r.gatewayRequestId ?? '').filter(Boolean);
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const id of ids) { if (seen.has(id)) duplicates.push(id); seen.add(id); }

  const byPair = new Map<string, TrialRequestRow[]>();
  for (const r of rows) byPair.set(r.pairId, [...(byPair.get(r.pairId) ?? []), r]);
  const pairs: PairResult[] = [];
  const excludedPairs: { pairId: string; reason: string }[] = [];
  for (const pairId of [...byPair.keys()].sort()) {
    const pr = byPair.get(pairId)!;
    const arm = (a: TrialArm) => finalAttempts(pr.filter((r) => r.arm === a));
    const c = arm('control');
    const k = arm('candidate');
    const armComplete = (xs: TrialRequestRow[]) => xs.length === opts.requestsPerTrace && xs.every((r) => r.status === 'ok' && tiersKnown(r.usage));
    const complete = armComplete(c) && armComplete(k);
    const sumCost = (xs: TrialRequestRow[]) => xs.reduce((acc, r) => acc + (inputCostUsd(r.model, r.usage) ?? 0), 0);
    const q = (xs: TrialRequestRow[]) => (xs.length ? xs.filter((r) => r.qualityOk).length / xs.length : 0);
    pairs.push({ pairId, stratum: pr[0].stratum, complete, controlInputUsd: complete ? sumCost(c) : null, candidateInputUsd: complete ? sumCost(k) : null,
      qualityControl: q(c), qualityCandidate: q(k) });
    if (!complete) excludedPairs.push({ pairId, reason: 'an arm has a failed final attempt, missing request or unknown tier (rows retained)' });
  }

  const complete = pairs.filter((p) => p.complete);
  const byStratum: TrialSummary['byStratum'] = {};
  for (const s of ['A', 'B', 'C'] as TrialStratum[]) {
    const ps = complete.filter((p) => p.stratum === s);
    if (!ps.length) continue;
    const cmp = pairedBootstrapCI(ps.map((p) => p.controlInputUsd!), ps.map((p) => p.candidateInputUsd!), { iterations: 10_000, seed: 12345 });
    byStratum[s] = { ...cmp, pairs: ps.length, tierMix: tierMix(ok.filter((r) => r.stratum === s && ps.some((p) => p.pairId === r.pairId))) };
  }

  const weighted = combineStrata(byStratum, opts.weights);

  // Latency is weighted like cost: each request carries w_s / (requests of that arm in stratum s),
  // so the trial's stratum mix (1/3 each) does not stand in for the production gap mix.
  const ttftRows = (arm: TrialArm) => ok.filter((r) => r.arm === arm && typeof r.ttftMs === 'number');
  const ttft = (arm: TrialArm) => ttftRows(arm).map((r) => r.ttftMs!);
  const weightedTtft = (arm: TrialArm) => {
    const rs = ttftRows(arm);
    const count = (s: TrialStratum) => rs.filter((r) => r.stratum === s).length;
    return rs.map((r) => ({ value: r.ttftMs!, weight: Math.max(0, opts.weights[r.stratum]) / count(r.stratum) }));
  };
  const controlP95 = weightedPercentile(weightedTtft('control'), 95);
  const candidateP95 = weightedPercentile(weightedTtft('candidate'), 95);
  const ratio = controlP95 && candidateP95 != null ? candidateP95 / controlP95 : null;
  const latencyByStratum: TrialSummary['latencyByStratum'] = {};
  for (const s of ['A', 'B', 'C'] as TrialStratum[]) {
    const v = (arm: TrialArm) => ttftRows(arm).filter((r) => r.stratum === s).map((r) => r.ttftMs!);
    if (!v('control').length && !v('candidate').length) continue;
    latencyByStratum[s] = { controlP50: percentile(v('control'), 50), candidateP50: percentile(v('candidate'), 50),
      controlP95: percentile(v('control'), 95), candidateP95: percentile(v('candidate'), 95) };
  }
  const qArm = (arm: TrialArm) => { const xs = ok.filter((r) => r.arm === arm); return xs.length ? xs.filter((r) => r.qualityOk).length / xs.length : 0; };
  const quality = { control: qArm('control'), candidate: qArm('candidate'), regression: qArm('candidate') < qArm('control') };
  const anomalies = traceAnomalies(rows);

  const reasons: string[] = [];
  if (!weighted) reasons.push('weighted comparison unavailable: not every stratum has a complete pair');
  else if (!(weighted.upper < 0)) reasons.push(`weighted input-cost delta CI upper bound ${weighted.upper.toFixed(4)} is not below 0`);
  if (quality.regression) reasons.push('candidate quality below control');
  if (ratio == null) reasons.push('latency ratio unavailable');
  else if (ratio > 1.1) reasons.push(`candidate p95 TTFT ${(ratio * 100 - 100).toFixed(1)}% above control (bound 10%)`);
  const coverage = ok.length ? known.length / ok.length : 0;
  if (coverage < 0.9) reasons.push(`tier coverage ${(coverage * 100).toFixed(1)}% below 90%`);
  if (duplicates.length) reasons.push(`${duplicates.length} duplicate charged request id(s)`);

  return {
    requests: { attempts: rows.length, ok: ok.length, errors: rows.length - ok.length, tiersKnown: known.length, coverage },
    uniqueChargedIds: { total: ids.length, unique: seen.size, duplicates },
    pairs, excludedPairs, byStratum, weights: opts.weights, weighted,
    latency: { controlP95, candidateP95, ratio, controlP50: percentile(ttft('control'), 50), candidateP50: percentile(ttft('candidate'), 50) },
    latencyByStratum,
    quality, anomalies, spend: actualSpend(rows),
    decision: { adoptCandidate: reasons.length === 0, reasons },
  };
}

function traceAnomalies(rows: readonly TrialRequestRow[]): TrialSummary['anomalies'] {
  const emptyReplies: TrialSummary['anomalies']['emptyReplies'] = [];
  const cascadedTraces: TrialSummary['anomalies']['cascadedTraces'] = [];
  const before = { control: { hit: 0, n: 0 }, candidate: { hit: 0, n: 0 } };
  const traces = new Map<string, TrialRequestRow[]>();
  for (const r of rows) traces.set(`${r.pairId}\u0000${r.arm}`, [...(traces.get(`${r.pairId}\u0000${r.arm}`) ?? []), r]);
  for (const trace of traces.values()) {
    const answered = finalAttempts(trace).filter((r) => r.status === 'ok');
    let firstEmpty: number | null = null;
    for (const r of answered) {
      const empty = (r.replyText ?? '') === '';
      if (empty) {
        emptyReplies.push({ pairId: r.pairId, arm: r.arm, seq: r.seq, outputTokens: r.usage?.outputTokens ?? null,
          stopReason: r.stopReason ?? null, contentBlockTypes: r.contentBlockTypes ?? null, causeRecorded: r.stopReason !== undefined });
      }
      if (firstEmpty === null) {
        before[r.arm].n++;
        if (r.qualityOk) before[r.arm].hit++;
        if (empty) firstEmpty = r.seq;
      }
    }
    if (firstEmpty !== null) {
      const later = answered.filter((r) => r.seq > firstEmpty!);
      if (later.length) {
        cascadedTraces.push({ pairId: answered[0].pairId, arm: answered[0].arm, fromSeq: firstEmpty, laterRequests: later.length,
          laterEmpty: later.filter((r) => (r.replyText ?? '') === '').length });
      }
    }
  }
  const byKey = (a: { pairId: string; arm: string; seq?: number }, b: { pairId: string; arm: string; seq?: number }) =>
    a.pairId.localeCompare(b.pairId) || a.arm.localeCompare(b.arm) || (a.seq ?? 0) - (b.seq ?? 0);
  const rate = (x: { hit: number; n: number }) => (x.n ? x.hit / x.n : 0);
  return {
    emptyReplies: emptyReplies.sort(byKey),
    emptyRepliesByArm: { control: emptyReplies.filter((e) => e.arm === 'control').length, candidate: emptyReplies.filter((e) => e.arm === 'candidate').length },
    cascadedTraces: cascadedTraces.sort(byKey),
    qualityBeforeCascade: { control: rate(before.control), candidate: rate(before.candidate) },
    streamErrors: rows.filter((r) => r.streamError != null || (r.status === 'error' && r.httpStatus === 200)).length,
  };
}

export interface WeightedComparison {
  /** Σ w_s · δ_s with weights normalised over the strata present. */
  point: number;
  lower: number;
  upper: number;
  method: 'stratified-normal-combination-of-paired-bootstrap-intervals';
}

/**
 * Population-weighted candidate−control delta. Each stratum keeps its own paired bootstrap
 * interval; the combined interval treats each stratum's half-width as 1.96·SE and adds the
 * weighted variances (strata are independent). This avoids resampling pairs across strata,
 * which lets zero-weight pairs dominate a resample and pins the bound at 0.
 */
export function combineStrata(
  byStratum: Partial<Record<TrialStratum, PairedComparison>>,
  weights: StratumWeights,
): WeightedComparison | null {
  const strata = (['A', 'B', 'C'] as TrialStratum[]);
  if (!strata.every((s) => byStratum[s])) return null;
  const wsum = strata.reduce((a, s) => a + Math.max(0, weights[s]), 0);
  if (!(wsum > 0)) return null;
  let point = 0;
  let variance = 0;
  for (const s of strata) {
    const w = Math.max(0, weights[s]) / wsum;
    const c = byStratum[s]!;
    const se = (c.delta.upper - c.delta.lower) / 2 / 1.959964;
    point += w * c.delta.point;
    variance += w * w * se * se;
  }
  const half = 1.959964 * Math.sqrt(variance);
  return { point, lower: point - half, upper: point + half, method: 'stratified-normal-combination-of-paired-bootstrap-intervals' };
}

function tierMix(rows: readonly TrialRequestRow[]): TierMix {
  const t = (arm: TrialArm): TierTotals => {
    const acc: TierTotals = { uncached: 0, read: 0, write5m: 0, write1h: 0 };
    for (const r of rows) {
      if (r.arm !== arm || !r.usage) continue;
      acc.uncached += r.usage.inputTokens ?? 0;
      acc.read += r.usage.cacheReadTokens ?? 0;
      acc.write5m += r.usage.cacheCreation5mTokens ?? 0;
      acc.write1h += r.usage.cacheCreation1hTokens ?? 0;
    }
    return acc;
  };
  return { control: t('control'), candidate: t('candidate') };
}
