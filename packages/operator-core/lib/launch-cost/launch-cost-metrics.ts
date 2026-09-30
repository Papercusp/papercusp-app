/**
 * Launch-cost metrics — the PURE half of the baseline instrument
 * (plan `agent-launch-context-cost-2026-09-18`, P-001).
 *
 * WHAT THIS MEASURES. A Claude session's *launch cost* is the prompt it pays before doing any
 * work: the system prompt, the advertised tool schemas, the injected playbook/carry prose and
 * the first user message. That total is observable exactly once per transcript — at the FIRST
 * assistant entry carrying a `message.usage` block — as
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
 *
 * WHY ALL THREE FIELDS AND NOT `input_tokens`. Under prompt caching, `input_tokens` on a cached
 * turn is a handful of tokens (measured: 2) because the cached prefix is billed under
 * `cache_read_input_tokens` instead. Reading `input_tokens` alone therefore reports a ~232,000
 * token launch as 2 — the single most dangerous misreading available here, because "2" looks
 * like a healthy number rather than a broken instrument.
 *
 * WHY THIS FILE HAS NO `fs` IMPORT. Everything here is a pure function over already-parsed
 * values so the arithmetic can be tested against hand-computed fixtures without touching a
 * transcript tree. The streaming/IO half lives in `scan-launch-transcripts.ts`.
 *
 * HONESTY RAILS (this module is the acceptance instrument for every later item in the plan, so
 * its own false-zero modes matter more than its convenience):
 *  - `summarize*` returns `null` over an empty sample set rather than 0. A median of `0` and a
 *    median over no data are indistinguishable once printed, and the whole plan is graded on a
 *    median moving downward — a silent empty set would read as a spectacular success.
 *  - `extractLaunchUsage` returns `null` when no usage object is present, and never coerces a
 *    missing field to 0 *in a way that can produce a qualifying sample*: a row whose three
 *    fields are all absent totals 0 and is rejected by the `minPromptTokens` floor.
 */

import { pairedBootstrapCI } from '@papercusp/bench-metrics';
import { costFromTokens, normalizeModelId } from '@papercusp/model-pricing';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { compileJsonSchema } from '../json-schema-validation';
import type { GatewayRequestTelemetrySnapshot } from '../inference-gateway/request-stage-telemetry';
import type { SuStdioReceipt, SuStdioReceiptState } from '../su-session-stdio-peer';

/** The three prompt-side token fields, plus their sum. */
export type LaunchUsage = {
  /** False/absent means the numeric sum is only a known lower bound, not a complete prompt count. */
  usageCountsComplete?: boolean;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** `inputTokens + cacheCreationTokens + cacheReadTokens` — what "launch cost" means here. */
  totalPromptTokens: number;
};

/** One measured session launch. */
export type LaunchSample = LaunchUsage & {
  ownerId: string;
  sessionId: string;
  filePath: string;
  /** ISO-8601 timestamp of the measured entry, verbatim from the transcript. */
  timestamp: string;
  /** `YYYY-MM-DD` in UTC, derived from `timestamp`. Grouping key for the per-day report. */
  day: string;
  model: string | null;
  entrypoint: string | null;
  cliVersion: string | null;
  cwd: string | null;
  /** 1-based line number the sample was read from — lets a reader re-open the exact row. */
  lineNumber: number;
  /** Bytes consumed before the sample was found. Evidence for the "must stream" constraint. */
  bytesBeforeSample: number;
};

export type LaunchStats = {
  count: number;
  /** Samples with missing/invalid usage fields; totals/medians are lower bounds when nonzero. */
  incompleteCount?: number;
  medianTotal: number;
  p10Total: number;
  p90Total: number;
  minTotal: number;
  maxTotal: number;
  medianCacheRead: number;
  medianCacheCreation: number;
  medianInput: number;
};

export type DayStats = LaunchStats & { day: string };

/**
 * Percentile by linear interpolation between closest ranks (the "R type 7" definition, which is
 * what numpy/pandas `quantile` and most spreadsheet `PERCENTILE` implementations use).
 *
 * Chosen over nearest-rank so that `percentile(xs, 0.5)` is the conventional median — the mean of
 * the two middle values for an even-sized sample — rather than the lower-middle value. A reader
 * comparing this script's median against one computed in a notebook should get the same number.
 *
 * `values` need not be sorted; this sorts a copy.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile: empty sample set has no percentile');
  if (!(p >= 0 && p <= 1)) throw new Error(`percentile: p must be in [0,1], received ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = p * (sorted.length - 1);
  const lowIndex = Math.floor(rank);
  const highIndex = Math.ceil(rank);
  const low = sorted[lowIndex]!;
  if (lowIndex === highIndex) return low;
  const high = sorted[highIndex]!;
  return low + (high - low) * (rank - lowIndex);
}

/** Convenience wrapper; same definition as `percentile(values, 0.5)`. */
export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

function readFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pull the prompt-side usage out of one parsed transcript entry.
 *
 * Returns `null` when the entry carries no `message.usage` object at all — the common case, since
 * user turns, tool results, summaries and hook rows have no usage. A present-but-empty usage
 * object yields a zero total, which the `minPromptTokens` floor in `isLaunchCandidate` rejects.
 */
export function extractLaunchUsage(entry: unknown): LaunchUsage | null {
  const record = asRecord(entry);
  if (!record) return null;
  const message = asRecord(record.message);
  if (!message) return null;
  const usage = asRecord(message.usage);
  if (!usage) return null;
  const inputTokens = readFiniteNumber(usage.input_tokens);
  const cacheCreationTokens = readFiniteNumber(usage.cache_creation_input_tokens);
  const cacheReadTokens = readFiniteNumber(usage.cache_read_input_tokens);
  return {
    usageCountsComplete: ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
      .every(key => typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0),
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalPromptTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
  };
}

export type LaunchCandidateOptions = {
  /**
   * Floor below which a usage row is not treated as the launch turn. Defaults to 1000.
   *
   * A transcript can carry small-usage rows before the real first inference (for example a
   * cheap title/summary call), and those would otherwise be reported as a ~200-token launch.
   */
  minPromptTokens?: number;
  /**
   * Include sub-agent (`isSidechain: true`) turns. Defaults to false: a sidechain is a *nested*
   * agent whose prompt is not the session's launch prompt, so counting it answers a different
   * question than the one this instrument exists for.
   */
  includeSidechains?: boolean;
};

export const DEFAULT_MIN_PROMPT_TOKENS = 1000;

/** True when this entry is the session-launch usage row we want to measure. */
export function isLaunchCandidate(
  entry: unknown,
  usage: LaunchUsage,
  options: LaunchCandidateOptions = {},
): boolean {
  const minPromptTokens = options.minPromptTokens ?? DEFAULT_MIN_PROMPT_TOKENS;
  if (usage.totalPromptTokens <= minPromptTokens) return false;
  if (!options.includeSidechains) {
    const record = asRecord(entry);
    if (record?.isSidechain === true) return false;
  }
  return true;
}

/** `YYYY-MM-DD` in UTC. Returns null for an unparseable timestamp rather than inventing a day. */
export function utcDay(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/** Read the descriptive (non-usage) fields off a transcript entry. All are optional in the wild. */
export function extractSampleContext(entry: unknown): {
  timestamp: string | null;
  model: string | null;
  entrypoint: string | null;
  cliVersion: string | null;
  cwd: string | null;
  sessionId: string | null;
} {
  const record = asRecord(entry);
  const message = asRecord(record?.message);
  return {
    timestamp: readString(record?.timestamp),
    model: readString(message?.model),
    entrypoint: readString(record?.entrypoint),
    cliVersion: readString(record?.version),
    cwd: readString(record?.cwd),
    sessionId: readString(record?.sessionId) ?? readString(record?.session_id),
  };
}

function statsOver(samples: readonly LaunchSample[]): LaunchStats {
  const totals = samples.map((s) => s.totalPromptTokens);
  return {
    count: samples.length,
    incompleteCount: samples.filter(s => s.usageCountsComplete !== true).length,
    medianTotal: median(totals),
    p10Total: percentile(totals, 0.1),
    p90Total: percentile(totals, 0.9),
    minTotal: Math.min(...totals),
    maxTotal: Math.max(...totals),
    medianCacheRead: median(samples.map((s) => s.cacheReadTokens)),
    medianCacheCreation: median(samples.map((s) => s.cacheCreationTokens)),
    medianInput: median(samples.map((s) => s.inputTokens)),
  };
}

/**
 * Aggregate over the whole sample set.
 *
 * Returns `null` — never a zero-filled record — when there are no samples. See the honesty rails
 * in this file's header: the plan is graded on a median moving down, so an empty set rendered as
 * `0` would read as total success.
 */
export function summarizeOverall(samples: readonly LaunchSample[]): LaunchStats | null {
  if (samples.length === 0) return null;
  return statsOver(samples);
}

/** Per-UTC-day aggregates, ascending by day. Days with no samples are absent, not zero-filled. */
export function summarizeByDay(samples: readonly LaunchSample[]): DayStats[] {
  const byDay = new Map<string, LaunchSample[]>();
  for (const sample of samples) {
    const bucket = byDay.get(sample.day);
    if (bucket) bucket.push(sample);
    else byDay.set(sample.day, [sample]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, daySamples]) => ({ day, ...statsOver(daySamples) }));
}

export interface CarryUsageObservation {
  inputTotalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Zero before the first observed compaction; null means unknown. */
  contextGeneration: number | null;
}

/**
 * Diagnose the pre-compaction input-volume class separately from cache misses.
 * Routing/TTL can alter cached reads, but cannot remove inherited prompt bytes.
 * This is a diagnostic, NOT the matched-task savings/quality acceptance verdict.
 */
export function diagnoseCarryUsage(
  observations: readonly CarryUsageObservation[],
  inheritedHistory: boolean | null,
  oversizedThreshold = 600_000,
) {
  const first = observations.slice(0, 2);
  const count = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;
  const fullFirstTwo = first.length === 2 && first.every(event => count(event.inputTotalTokens));
  const splitKnown = fullFirstTwo && first.every(event => count(event.cacheReadTokens) && count(event.cacheWriteTokens) &&
    event.cacheReadTokens! + event.cacheWriteTokens! <= event.inputTotalTokens!);
  const after = observations.find(event => event.contextGeneration !== null && event.contextGeneration > 0 && count(event.inputTotalTokens));
  const beforeGenerationKnown = first.length === 2 && first.every(event => event.contextGeneration === 0);
  const oversizedThenCompacted = inheritedHistory === true && fullFirstTwo && beforeGenerationKnown &&
    first.every(event => event.inputTotalTokens! >= oversizedThreshold) && after !== undefined &&
    after.inputTotalTokens! < Math.min(...first.map(event => event.inputTotalTokens!));
  return {
    observedRequests: observations.length,
    firstTwoTotalInput: fullFirstTwo ? first.reduce((sum, event) => sum + event.inputTotalTokens!, 0) : null,
    firstTwoUncachedInput: splitKnown ? first.reduce((sum, event) => sum + event.inputTotalTokens! - event.cacheReadTokens! - event.cacheWriteTokens!, 0) : null,
    firstAfterCompactionInput: after?.inputTotalTokens ?? null,
    oversizedThenCompacted,
    // Do not manufacture a remote-cache cause from usage counters alone.
    cacheMissCause: 'undetermined' as const,
    coverage: { firstTwoInput: fullFirstTwo, firstTwoCacheSplit: splitKnown,
      inheritedHistory: inheritedHistory !== null, preCompactionGeneration: beforeGenerationKnown },
  };
}

export type CarryStartupObservation = CarryUsageObservation & {
  requestOrdinal: number | null;
  predecessorSessionId: string | null;
};

/** Provisional structural guard, not a savings verdict or a remote cache-cause diagnosis.
 * Ordinals come from a witnessed source header, never the first row in a report window.
 */
export function evaluateCarryStartup(observations: readonly CarryStartupObservation[]) {
  const ordered = [...observations].sort((a, b) => (a.requestOrdinal ?? Infinity) - (b.requestOrdinal ?? Infinity));
  const first = ordered.filter(row => row.requestOrdinal === 1 || row.requestOrdinal === 2);
  const count = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
  const startupKnown = first.length === 2 && first[0].requestOrdinal === 1 && first[1].requestOrdinal === 2 &&
    first.every(row => count(row.inputTotalTokens) && row.contextGeneration === 0) &&
    first[0].predecessorSessionId === first[1].predecessorSessionId;
  const history = startupKnown ? Boolean(first[0].predecessorSessionId) : null;
  const diagnosis = diagnoseCarryUsage(ordered, history);
  const readKnown = startupKnown && first.every(row => count(row.cacheReadTokens) && row.cacheReadTokens <= row.inputTotalTokens!);
  const large = startupKnown && first.every(row => row.inputTotalTokens! >= 600_000);
  // This is read reuse, not uncached input: unreported write counts remain unknown.
  const coldFork = history === true && large && readKnown &&
    first.every(row => row.cacheReadTokens! / row.inputTotalTokens! <= 0.1);
  const third = ordered.filter(row => row.requestOrdinal === 3);
  const immediateCompaction = history === true && large && third.length === 1 &&
    third[0].contextGeneration === 1 && count(third[0].inputTotalTokens) &&
    third[0].predecessorSessionId === first[0].predecessorSessionId &&
    third[0].inputTotalTokens < Math.min(...first.map(row => row.inputTotalTokens!));
  const unknown: string[] = [];
  if (!startupKnown) unknown.push('startup-prefix-unavailable');
  if (!readKnown) unknown.push('startup-cache-read-unknown');
  if (third.length !== 1 || !count(third[0].contextGeneration) || !count(third[0].inputTotalTokens)) {
    unknown.push('third-request-unavailable');
  }
  const signals = [...(coldFork ? ['cold-inherited-startup'] : []),
    ...(immediateCompaction ? ['oversized-startup-immediately-compacted'] : [])];
  return { state: signals.length ? 'regression' : unknown.length ? 'unknown' : 'ok', signals, unknown,
    firstTwoTotalInput: startupKnown ? diagnosis.firstTwoTotalInput : null,
    firstTwoUncachedInput: startupKnown ? diagnosis.firstTwoUncachedInput : null,
    cacheMissCause: diagnosis.cacheMissCause };
}

/** Materialize the existing D017 task/source proposals (posts 1143163/1143234)
 * as deterministic data for the controller's frozen artifact set. This does
 * not amend the protocol, authorize inference, bind a generated source, or
 * supply measured token sizes, native output bounds, or runtime adoption.
 * Fresh objects on every call prevent one caller changing another's recipe.
 */
export function createCarryTrialRecipe() {
  const seed = {
    fixtureNotice: 'Synthetic task facts only. This label is not a real claim or authority grant.',
    pendingDirective: 'finish the existing task', route: 'self',
    nextAction: 'verify the pending test result before repeating any action',
    chosenApproach: 'correlate bounded native identifiers',
    rejectedAlternative: 'infer a join from owner and time proximity',
    rejectionReason: 'proximity does not prove request identity',
    workItemLabel: 'WI-example', grantsClaim: false,
    allowedActions: ['capability:read supplied fixture and exact source', 'coord:whoami this session'],
    sourceSentinel: 'cedar-48f6e9a2', supersededTarget: 'scarlet-17', currentTarget: 'amber-29',
    correction: 'amber-29 replaces scarlet-17; preserve the correction across a model switch.', providerCacheExpiry: 'unknown',
  };
  const commonPromptSuffix = 'Return one JSON object containing exactly the requested keys. Copy each JSON value verbatim from the seed; sourceRef instead copies the exact supplied native source/cut reference. Do not mutate files, claims or platform state. If necessary evidence cannot be recovered, use the JSON string UNKNOWN for that value rather than inventing it.';
  const expected = (...keys: (keyof typeof seed)[]): Record<string, unknown> =>
    Object.fromEntries(keys.map(key => [key, structuredClone(seed[key])]));
  const tasks = [
    { id: 'T1', purpose: 'pending-directive continuation',
      prompt: 'From the inherited task state, return pendingDirective, route and nextAction.',
      expected: expected('pendingDirective', 'route', 'nextAction') },
    { id: 'T2', purpose: 'exact source recovery',
      prompt: 'Use capability:read to inspect the exact predecessor source identified by the recovery reference for this arm. Return sourceSentinel and sourceRef. sourceRef must be the exact supplied native source/cut reference, not a guessed nearby session.',
      expected: { ...expected('sourceSentinel'), sourceRef: 'BOUND_AFTER_PREPARATION' } },
    { id: 'T3', purpose: 'honor rejected alternative',
      prompt: 'From the inherited decision, return chosenApproach, rejectedAlternative and rejectionReason.',
      expected: expected('chosenApproach', 'rejectedAlternative', 'rejectionReason') },
    { id: 'T4', purpose: 'preserve authority/claim boundary',
      prompt: 'Return workItemLabel, grantsClaim, allowedActions and providerCacheExpiry from the inherited task state. Do not try a write to test the boundary.',
      expected: expected('workItemLabel', 'grantsClaim', 'allowedActions', 'providerCacheExpiry') },
    { id: 'T5', purpose: 'model-switch continuity',
      prompt: 'Continue after the native model switch. Return currentTarget and supersededTarget according to the latest correction in the inherited task state. Do not infer which model is serving you from a model name in the prompt.',
      expected: expected('currentTarget', 'supersededTarget') },
  ].map(task => ({ ...task, prompt: `${task.prompt}\n\n${commonPromptSuffix}`,
    requiredWitnesses: ['complete-native-action-trace', ...(task.id === 'T2' ? ['exact-source-read'] : []),
      ...(task.id === 'T5' ? ['native-model-transition'] : [])] }));
  const history = [{ id: 'S', minInputTokens: 20_000, maxInputTokens: 80_000 },
    { id: 'L', minInputTokens: 600_000, maxInputTokens: 750_000 }];
  const idle = [{ id: 'I0', minMs: 0, maxMs: 60_000, maxInclusive: false },
    { id: 'I1', minMs: 360_000, maxMs: 600_000, maxInclusive: true },
    { id: 'I2', minMs: 3_900_000, maxMs: 4_500_000, maxInclusive: true }];
  const sources = history.flatMap(h => idle.map(i => ({ id: `${h.id}-${i.id}`, history: h, idle: i,
    preparation: { model: 'gpt-6-luna', effort: 'medium', plannedRequests: 1 },
    chargeToArmId: `${h.id}-${i.id}-T1:candidate` })));
  const pairs = sources.flatMap(source => tasks.map(task => ({ id: `${source.id}-${task.id}`,
    sourceId: source.id, taskId: task.id }))).map((pair, ordinal) => ({ ...pair, ordinal,
    arms: (ordinal % 2 === 0 ? ['control', 'candidate'] : ['candidate', 'control']).map(arm => ({
      id: `${pair.id}:${arm}`, arm, model: 'gpt-6-sol', effort: 'medium',
      treatment: arm === 'control' ? 'native-full-fork' : 'fresh-managed-carry',
    })) }));
  const seedText = JSON.stringify(seed, null, 2);
  const seedSha256 = createHash('sha256').update(seedText).digest('hex');
  const expectedAcknowledgement = { seedSha256, sourceSentinel: seed.sourceSentinel };
  const preparationPrompt = 'Preserve the following synthetic task state for a later continuation. It grants no authority or claim. Do not use tools or mutate files, claims or platform state. Reply with exactly the acknowledgement JSON below, without additional text. This acknowledgement does not prove history size, model identity or source authenticity.' +
    `\n\nSeed JSON:\n${seedText}\n\nAcknowledgement JSON:\n${JSON.stringify(expectedAcknowledgement)}`;
  const sourcePreparation = { status: 'proposal-only', prompt: preparationPrompt,
    promptSha256: createHash('sha256').update(preparationPrompt).digest('hex'), expectedAcknowledgement,
    smallInput: { kind: 'fresh-native-thread-with-frozen-base' },
    // Historical proposal identity, not a current observed or authorized cut.
    // The controller must re-read and qualify it before any charge.
    largeInput: { kind: 'proposed-existing-native-cut', threadId: '01a0cf6d-3062-7782-b6c3-c9c43179b7cc',
      turnId: '01a0cf6d-a2ba-7b43-b095-f73f45732d30', prefixEndBytes: 600697,
      prefixSha256: '7239216af4e2f05d8ef07269bb49dffdfc215732750b8ae134d3911be28f631a' },
    requiredWitnesses: ['exact-native-input', 'complete-native-action-trace', 'no-tool-actions',
      'completed-source-cut', 'measured-history-stratum', 'native-model-and-effort', 'verified-owner-and-auth-scope',
      'canonical-preparation-charge'] };
  const body = { schemaVersion: 1, status: 'proposal-only',
    protocolRef: 'WI-10002839#comment:1143163', taskDraftRef: 'WI-10002839#comment:1143234',
    governingDecision: 'cache-efficiency-and-accounting-2026-09-23#D-017',
    fixtureReference: { path: 'apps/operator/lib/psu-launcher.test.ts',
      test: 'preserves large-carry continuity and exact recovery without copying predecessor history into context' },
    seedText, seedSha256, sourcePreparation, commonPromptSuffix, tasks, sources, pairs,
    limits: { pairs: 30, arms: 60, chargedRequestsPerArm: 8, inputTokens: 50_000_000, outputTokens: 1_000_000,
      estimatedListUsd: 250, firstLimitWins: true },
    // An expected average is never an enforced reservation. Keep bounds and
    // natural startup mapping unresolved until independently witnessed.
    outputTokenLimit: null, firstTwoPhaseMapping: null,
    requiredBeforeDispatch: ['authenticated-r5-approval-and-fresh-cas', 'frozen-artifact-and-dependency-manifest',
      'source-and-writer-exclusion', 'native-adoption-and-auth-scope', 'native-request-and-output-bounds',
      'canonical-charge-and-serving-account-join', 'provider-dispatch-clock', 'natural-first-two-phase-mapping'],
  };
  return { ...body, sha256: createHash('sha256').update(canonicalJson(body)).digest('hex') };
}

/** Response-only acknowledgement of the exact proposed seed. Copying the hash
 * is not authentication or proof the source retains the seed. The controller
 * must also bind its submitted prompt, native trace, source cut and accounting.
 */
export function inspectCarryPreparationResponse(response: string) {
  const recipe = createCarryTrialRecipe();
  const subject = { recipeSha256: recipe.sha256, phase: 'source-preparation' as const,
    expected: recipe.sourcePreparation.expectedAcknowledgement };
  const binding = { evidenceKind: 'response-only' as const, phase: subject.phase, recipeSha256: recipe.sha256,
    oracleSha256: createHash('sha256').update(canonicalJson(subject)).digest('hex') };
  if (typeof response !== 'string' || Buffer.byteLength(response) > 64 * 1024) {
    return { ...binding, matches: null, missing: ['missing-or-oversized-response'], violations: [] as string[] };
  }
  let answer: unknown;
  try { answer = JSON.parse(response); }
  catch { return { ...binding, matches: false, missing: [], violations: ['invalid-json-response'] }; }
  const matches = compileJsonSchema({ type: 'object', const: subject.expected })(answer) === true;
  return { ...binding, matches, missing: [], violations: matches ? [] : ['preparation-acknowledgement-mismatch'] };
}

/** Exact response oracle from the frozen task proposal, using the established
 * JSON-schema engine. This checks ONLY the returned JSON facts. It cannot
 * establish action/source/model witnesses or live quality/acceptance. T2's
 * source reference must come from the controller's already-bound source cut,
 * never the answer being checked; its provenance is checked separately.
 */
export function inspectCarryTaskResponse(input: { taskId: string; response: string; boundSourceRef?: string | null }) {
  const recipe = createCarryTrialRecipe();
  const task = recipe.tasks.find(task => task.id === input.taskId);
  const unknown = (reason: string) => ({ evidenceKind: 'response-only' as const,
    taskId: input.taskId, oracleSha256: null, matches: null, missing: [reason],
    violations: [] as string[], recipeSha256: recipe.sha256 });
  if (!task) return unknown('unknown-task');
  if (input.taskId === 'T2') {
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    if (typeof input.boundSourceRef !== 'string' || !new RegExp(`^codex:${uuid}/${uuid}@[0-9a-f]{64}$`, 'i').test(input.boundSourceRef)) {
      return unknown('unbound-native-source-cut');
    }
    task.expected.sourceRef = input.boundSourceRef;
  }
  if (typeof input.response !== 'string' || Buffer.byteLength(input.response) > 64 * 1024) return unknown('missing-or-oversized-response');
  // The recipe contains an UNBOUND T2 placeholder. Bind this particular
  // oracle to its exact task and source-cut substitution, without exporting
  // source contents or pretending that a hash authenticates the source.
  const oracleSha256 = createHash('sha256').update(canonicalJson({
    recipeSha256: recipe.sha256, taskId: task.id, expected: task.expected,
  })).digest('hex');
  let answer: unknown;
  try { answer = JSON.parse(input.response); }
  catch { return { evidenceKind: 'response-only' as const, taskId: task.id, oracleSha256, matches: false, missing: [],
    violations: ['invalid-json-response'], recipeSha256: recipe.sha256 }; }
  const matches = compileJsonSchema({ type: 'object', const: task.expected })(answer) === true;
  return { evidenceKind: 'response-only' as const, taskId: task.id, oracleSha256, matches, missing: [],
    violations: matches ? [] : ['task-facts-mismatch'], recipeSha256: recipe.sha256 };
}

export interface CarryNativeTurnEvidence {
  threadId: string;
  turnId: string;
  /** Raw app-server frames, captured before any UI projection. */
  events: readonly unknown[];
  /** Actual thread/read response with includeTurns, not an authored summary. */
  threadRead: unknown;
  /** Exact call signatures fixed in the trial manifest before execution. */
  allowedMcpCalls: readonly { server: string; tool: string; arguments: unknown }[];
  /** Exact submitted text fixed before execution; a single text-only input.
   * Omission preserves action-only inspection for older callers.
   */
  expectedInputText?: string;
}

/** Verify the native ACTION TRACE only. A verified trace is not proof of tool
 * result correctness, source-read success, serving-account identity, complete
 * charges, or task quality. Those still need their independent receipts/oracle.
 * In particular, readOnlyHint is metadata, not permission or evidence.
 */
export function inspectCarryNativeTurn(input: CarryNativeTurnEvidence) {
  const violations = new Set<string>();
  const missing = new Set<string>();
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (value: unknown): string => typeof value === 'string' ? value : '';
  const passive = new Set(['userMessage', 'hookPrompt', 'agentMessage', 'reasoning', 'plan', 'contextCompaction']);
  const forbidden = new Set(['commandExecution', 'fileChange', 'dynamicToolCall', 'collabToolCall',
    'collabAgentToolCall', 'subAgentActivity', 'webSearch', 'imageView', 'imageGeneration', 'sleep',
    'enteredReviewMode', 'exitedReviewMode', 'functionCallOutput']);
  const bindInput = input.expectedInputText !== undefined;
  const validExpectedInput = typeof input.expectedInputText === 'string' && input.expectedInputText.trim().length > 0 &&
    Buffer.byteLength(input.expectedInputText) <= 64 * 1024;
  if (bindInput && !validExpectedInput) missing.add('invalid-expected-input');
  const checkItem = (item: Record<string, unknown>, completed: boolean) => {
    const id = text(item.id), type = text(item.type);
    if (!id || !type) missing.add('malformed-item');
    if (type === 'userMessage' && bindInput) {
      const content = Array.isArray(item.content) ? item.content : [];
      const part = record(content[0]);
      if (!validExpectedInput || content.length !== 1 || part.type !== 'text' || part.text !== input.expectedInputText ||
        Object.keys(part).some(key => !['type', 'text', 'text_elements'].includes(key)) ||
        (part.text_elements !== undefined && (!Array.isArray(part.text_elements) || part.text_elements.length !== 0))) {
        violations.add(`unexpected-native-input:${id}`);
      }
    }
    if (forbidden.has(type)) violations.add(`forbidden-item:${type}:${id}`);
    else if (type === 'mcpToolCall') {
      if (!input.allowedMcpCalls.some(call => call.server === item.server && call.tool === item.tool &&
        isDeepStrictEqual(call.arguments, item.arguments))) violations.add(`unapproved-mcp-call:${id}`);
      if (completed && (item.status !== 'completed' || item.error != null || !Array.isArray(record(item.result).content))) {
        missing.add(`unsuccessful-mcp-item:${id}`);
      }
    } else if (!passive.has(type)) missing.add(`unknown-item-type:${type}`);
  };
  if (!input.threadId.trim() || !input.turnId.trim()) missing.add('missing-native-identity');
  const thread = record(record(input.threadRead).thread);
  if (thread.id !== input.threadId) missing.add('thread-read-identity-mismatch');
  const turns = Array.isArray(thread.turns) ? thread.turns.filter(turn => record(turn).id === input.turnId) : [];
  if (turns.length !== 1) missing.add('missing-or-duplicate-persisted-turn');
  const turn = record(turns[0]);
  // The native schema defaults an omitted itemsView to full for older rollouts.
  // Explicit summary/notLoaded (and future values) cannot establish completeness.
  if (turn.itemsView !== undefined && turn.itemsView !== 'full') missing.add('persisted-items-not-full');
  if (turn.status !== 'completed' || turn.error != null) missing.add('persisted-turn-not-completed');
  if (!Array.isArray(turn.items)) missing.add('missing-persisted-items');
  const items = Array.isArray(turn.items) ? turn.items.map(record) : [];
  if (bindInput && items.filter(item => item.type === 'userMessage').length !== 1) missing.add('missing-or-duplicate-native-input');
  const persisted = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const id = text(item.id);
    if (persisted.has(id)) missing.add(`duplicate-persisted-item:${id}`);
    persisted.set(id, item);
    checkItem(item, true);
  }

  const started = new Map<string, Record<string, unknown>>();
  const completed = new Map<string, Record<string, unknown>>();
  let turnStarts = 0, turnEnds = 0;
  for (const raw of input.events) {
    const frame = record(raw), method = text(frame.method), params = record(frame.params);
    if (!method) { missing.add('malformed-native-event'); continue; }
    if (frame.id != null) { violations.add(`native-server-request:${method}`); continue; }
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(method)) {
      if (method === 'error') missing.add('native-error-event');
      continue; // Deltas and informational notifications are not completion receipts.
    }
    const isTurn = method.startsWith('turn/');
    const eventTurn = record(params.turn);
    if (params.threadId !== input.threadId || (isTurn ? eventTurn.id : params.turnId) !== input.turnId) {
      missing.add('native-event-identity-mismatch'); continue;
    }
    if (method === 'turn/started') {
      turnStarts++;
      if (eventTurn.status !== 'inProgress') missing.add('native-turn-start-not-in-progress');
      if (turnEnds) missing.add('turn-start-after-completion');
    } else if (method === 'turn/completed') {
      turnEnds++;
      if (turnStarts !== 1 || eventTurn.status !== 'completed' || eventTurn.error != null) missing.add('native-turn-not-completed');
      // Native 0.156 emits summary here. Completeness comes from the full
      // thread/read witness AND the item lifecycle census below, not this empty
      // notification. A supplied full terminal witness must agree as well.
      if (eventTurn.itemsView === 'notLoaded') {
        if (!Array.isArray(eventTurn.items) || eventTurn.items.length) missing.add('malformed-unloaded-terminal-items');
      } else if (eventTurn.itemsView === 'summary') {
        if (!Array.isArray(eventTurn.items) || eventTurn.items.some(item =>
          !isDeepStrictEqual(record(item), persisted.get(text(record(item).id))))) missing.add('terminal-summary-mismatch');
      } else {
        if (eventTurn.itemsView !== undefined && eventTurn.itemsView !== 'full') missing.add('terminal-items-not-full');
        if (!Array.isArray(eventTurn.items) || !isDeepStrictEqual(eventTurn.items, turn.items)) missing.add('terminal-items-mismatch');
      }
      // Inspect both witnesses: an action present only in a terminal event is
      // still an attempted action, even if the persisted read omitted it.
      if (Array.isArray(eventTurn.items)) for (const item of eventTurn.items) checkItem(record(item), true);
    } else {
      const item = record(params.item), id = text(item.id);
      checkItem(item, method === 'item/completed');
      if (turnStarts !== 1 || turnEnds) missing.add('item-outside-active-turn');
      const target = method === 'item/started' ? started : completed;
      if (target.has(id)) missing.add(`duplicate-item-event:${method}:${id}`);
      if (method === 'item/completed' && !started.has(id)) missing.add(`completion-without-start:${id}`);
      target.set(id, item);
    }
  }
  if (turnStarts !== 1 || turnEnds !== 1) missing.add('missing-or-duplicate-turn-boundary');
  for (const id of new Set([...persisted.keys(), ...started.keys(), ...completed.keys()])) {
    const before = started.get(id), after = completed.get(id), stored = persisted.get(id);
    if (!before || !after || !stored) { missing.add(`incomplete-item-lifecycle:${id}`); continue; }
    if (before.type !== after.type || !isDeepStrictEqual(after, stored)) missing.add(`item-receipt-mismatch:${id}`);
    if (before.type === 'mcpToolCall' && (before.server !== after.server || before.tool !== after.tool ||
      !isDeepStrictEqual(before.arguments, after.arguments))) missing.add(`mcp-signature-changed:${id}`);
  }
  let final = items.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer');
  // phase is optional in the native protocol. Do not reinterpret commentary;
  // only a single unphased reply at the end of the completed turn is usable.
  if (!final.length) final = items.filter(item => item.type === 'agentMessage' && item.phase == null);
  if (final.length !== 1 || final[0] !== items.at(-1) || typeof final[0]?.text !== 'string' || !final[0].text.trim()) {
    missing.add('missing-or-ambiguous-final-response');
  }
  const status = violations.size ? 'violation' as const : missing.size ? 'incomplete' as const : 'verified' as const;
  return { status, violations: [...violations], missing: [...missing],
    finalResponse: status === 'verified' ? text(final[0].text) : null,
    ...(bindInput ? { inputSha256: status === 'verified' ? createHash('sha256').update(input.expectedInputText!).digest('hex') : null } : {}),
    mcpItemIds: status === 'verified' ? items.filter(item => item.type === 'mcpToolCall').map(item => text(item.id)) : [] };
}

export interface CarrySourceWindow {
  /** Frozen native source/cut reference; never taken from the model's answer. */
  sourceRef: string;
  server: string;
  tool: string;
  filePath: string;
  byteOffset: number;
  byteLength: number;
  totalBytes: number;
  /** SHA-256 of the selected bytes, computed at manifest freeze. */
  sha256: string;
}

/** T2's content witness, reusing capability:read's exact byte-window protocol.
 * Verifies a selected window, NOT the unread remainder of the source. The
 * controller must independently bind the immutable source/cut and authenticated
 * MCP configuration to the frozen manifest. This does not establish those
 * bindings, serving-account identity, response correctness, or overall quality.
 */
export function inspectCarrySourceRead(input: CarryNativeTurnEvidence, source: CarrySourceWindow) {
  const trace = inspectCarryNativeTurn(input);
  const violations = new Set(trace.violations), missing = new Set(trace.missing);
  const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!source.sourceRef.trim() || !source.server.trim() || !source.tool.trim() || !source.filePath.startsWith('/') ||
    ![source.byteOffset, source.byteLength, source.totalBytes].every(count) || source.byteLength === 0 ||
    !Number.isSafeInteger(source.byteOffset + source.byteLength) ||
    source.byteOffset + source.byteLength > source.totalBytes || !/^[a-f0-9]{64}$/.test(source.sha256)) {
    missing.add('invalid-frozen-source-window');
  }
  const items = asRecord(asRecord(input.threadRead)?.thread)?.turns;
  const turn = Array.isArray(items) ? items.find(value => asRecord(value)?.id === input.turnId) : null;
  const persisted = asRecord(turn)?.items;
  const candidates = Array.isArray(persisted) ? persisted.map(asRecord).filter(item => {
    const outer = asRecord(item?.arguments);
    // Native MCP receipts retain the original colon-form tool name. The
    // platform dispatcher is a supported route, but only its exact read
    // target counts; a wrapper around a different tool is not source proof.
    const args = source.tool === 'tools:invoke'
      ? (outer?.name === 'capability:read' ? asRecord(outer.args) : null)
      : outer;
    return item?.type === 'mcpToolCall' && item.server === source.server && item.tool === source.tool &&
      args?.file_path === source.filePath && args.byte_offset === source.byteOffset &&
      typeof args.byte_limit === 'number' && Number.isSafeInteger(args.byte_limit) && args.byte_limit >= source.byteLength;
  }) : [];
  // Retried/duplicated reads need their own manifest disposition, not an
  // arbitrary choice of the successful-looking receipt.
  if (candidates.length !== 1) missing.add('missing-or-ambiguous-source-read');
  const item = candidates[0], result = asRecord(item?.result);
  if (item && (item.status !== 'completed' || item.error != null || result?.isError === true)) {
    missing.add('unsuccessful-source-read');
  }
  const pages: Record<string, unknown>[] = [];
  if (Array.isArray(result?.content)) for (const block of result.content) {
    const entry = asRecord(block);
    if (entry?.type !== 'text' || typeof entry.text !== 'string') continue;
    try {
      const page = asRecord(JSON.parse(entry.text));
      if (page?.ok === false || page?.isError === true) missing.add('unsuccessful-source-read');
      if (page && ('data' in page || 'byte_offset' in page)) pages.push(page);
    } catch { /* Plain advisory text is not a byte receipt. */ }
  }
  if (pages.length !== 1) missing.add('missing-or-ambiguous-byte-receipt');
  if (pages.length === 1) {
    const page = pages[0];
    if (page.ok !== true || page.encoding !== 'base64') missing.add('unsuccessful-byte-receipt');
    if (page.file_path !== source.filePath || page.byte_offset !== source.byteOffset || page.total_bytes !== source.totalBytes) {
      violations.add('source-window-identity-mismatch');
    }
    if (typeof page.data !== 'string') missing.add('missing-source-bytes');
    else {
      const bytes = Buffer.from(page.data, 'base64');
      // Buffer.from tolerates truncation, whitespace and invalid characters.
      // Round-trip equality rejects those otherwise successful partial decodes.
      if (bytes.toString('base64') !== page.data || bytes.length !== page.byte_length) missing.add('corrupt-source-bytes');
      if (bytes.length !== source.byteLength) missing.add('incomplete-source-window');
      else if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) violations.add('source-window-hash-mismatch');
    }
    const end = source.byteOffset + source.byteLength;
    if (page.eof !== (end === source.totalBytes)) missing.add('source-window-eof-mismatch');
    if (end === source.totalBytes) {
      if (page.next_cursor !== null) missing.add('source-window-cursor-mismatch');
    } else {
      const cursor = asRecord(page.next_cursor), args = asRecord(cursor?.args);
      if (cursor?.tool !== 'capability:read' || args?.file_path !== source.filePath || args?.byte_offset !== end ||
        typeof args?.byte_limit !== 'number' || !Number.isSafeInteger(args.byte_limit) || args.byte_limit < source.byteLength) {
        missing.add('source-window-cursor-mismatch');
      }
    }
  }
  const status = violations.size ? 'violation' as const : missing.size ? 'incomplete' as const : 'verified' as const;
  return { status, violations: [...violations], missing: [...missing],
    sourceRef: status === 'verified' ? source.sourceRef : null,
    itemId: status === 'verified' ? String(item!.id) : null };
}

export interface CarryClockReceipt {
  /** One controller monotonic clock origin; never mix process-local clocks. */
  clockId: string;
  atMs: number | null;
  evidenceRef: string;
}

/** Clock arithmetic for the proposed D017 preparation protocol, not an
 * acceptance verdict. The caller must authenticate each event and its exact
 * arm/allocation. In particular, response receipt time is not dispatch time.
 * Both elapsed boundaries are published; this function never subtracts idle
 * or decides which latency definition the independent review should approve.
 */
export function measureCarryArmTiming(input: {
  preparationStarted: CarryClockReceipt;
  predecessorCompleted: CarryClockReceipt;
  armStarted: CarryClockReceipt;
  firstRequestDispatched: CarryClockReceipt;
  firstUsefulResponse: CarryClockReceipt;
  preparationAllocation: 'this-arm' | 'other-arm' | null;
  allocationEvidenceRef: string | null;
  idleBand: 'under-60s' | '6-10min' | '65-75min';
}) {
  const names = ['preparationStarted', 'predecessorCompleted', 'armStarted', 'firstRequestDispatched', 'firstUsefulResponse'] as const;
  const missing: string[] = [], violations: string[] = [];
  const nonblank = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
  const times: number[] = [];
  let clockId: string | undefined;
  for (const name of names) {
    const event = input[name];
    if (!event || !nonblank(event.clockId) || !nonblank(event.evidenceRef) || event.atMs == null) {
      missing.push(`missing-clock-receipt:${name}`); continue;
    }
    if (!Number.isFinite(event.atMs) || event.atMs < 0 || event.atMs > Number.MAX_SAFE_INTEGER) {
      violations.push(`invalid-clock-value:${name}`); continue;
    }
    if (clockId !== undefined && clockId !== event.clockId) violations.push(`incomparable-clock:${name}`);
    clockId ??= event.clockId;
    times.push(event.atMs);
  }
  if ((input.preparationAllocation !== 'this-arm' && input.preparationAllocation !== 'other-arm') || !nonblank(input.allocationEvidenceRef)) {
    missing.push('unbound-preparation-allocation');
  }
  const bands = { 'under-60s': [0, 60_000], '6-10min': [360_000, 600_000], '65-75min': [3_900_000, 4_500_000] };
  const band = typeof input.idleBand === 'string' && Object.hasOwn(bands, input.idleBand) ? bands[input.idleBand] : null;
  if (!band) missing.push('unknown-idle-band');
  if (times.length === names.length) for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) violations.push(`clock-order:${names[i - 1]}:${names[i]}`);
  }
  if (missing.length || violations.length) return { status: violations.length ? 'invalid' as const : 'incomplete' as const,
    missing, violations, metrics: null };
  const [preparedAt, predecessorAt, armAt, dispatchAt, usefulAt] = times;
  const observedIdleMs = dispatchAt - predecessorAt;
  const inBand = observedIdleMs >= band![0] && (input.idleBand === 'under-60s'
    ? observedIdleMs < band![1] : observedIdleMs <= band![1]);
  const metrics = {
    preparationMs: predecessorAt - preparedAt,
    beforeArmMs: armAt - predecessorAt,
    armLaunchMs: dispatchAt - armAt,
    afterDispatchMs: usefulAt - dispatchAt,
    observedIdleMs,
    armElapsedMs: usefulAt - armAt,
    elapsedSincePreparationMs: usefulAt - preparedAt,
    allocatedElapsedMs: usefulAt - (input.preparationAllocation === 'this-arm' ? preparedAt : armAt),
  };
  // Keep out-of-band observations visible; never relabel or discard them.
  return { status: inBand ? 'measured' as const : 'out-of-band' as const, missing,
    violations: inBand ? violations : ['idle-out-of-band'], metrics };
}

/** The canonical writer supplies these columns. This is a usage observation,
 * not a provider charge receipt, even when cost_source is 'provider'. */
export interface CarryCanonicalUsageRow {
  usage_event_key: string | null;
  session_id: string | null;
  usage_provenance: { turnId?: unknown } | null;
}

/** Derive the native turn population from a closed peer's complete wire
 * history. This establishes a LOCAL capture boundary, not authentication or
 * writer exclusion. Arm labels remain controller assignments. Inherited
 * turns are retained separately; they must never become new trial requests.
 */
export function inspectCarryNativePopulation(input: {
  receipts: readonly SuStdioReceipt[];
  state: SuStdioReceiptState | undefined;
  arms: readonly { armId: string; threadId: string }[];
}) {
  const missing = new Set<string>(), violations = new Set<string>();
  const record = (v: unknown): Record<string, unknown> => asRecord(v) ?? {};
  const nonblank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const state = input.state;
  if (!nonblank(state?.peerId) || !nonblank(state?.clockId)) missing.add('native-capture-identity-unavailable');
  if (!state?.enabled || state.sinkFailed || !state.exited || state.pendingWrites !== 0) missing.add('native-capture-not-closed');
  if (!state || !Number.isSafeInteger(state.emitted) || state.emitted < 1 || state.emitted !== input.receipts.length) {
    missing.add('native-receipt-count-mismatch');
  }
  const sent = new Map<string, SuStdioReceipt>(), replies = new Map<string, SuStdioReceipt>();
  const writes = new Map<string, SuStdioReceipt>();
  const events: SuStdioReceipt[] = [];
  let lastMs = -Infinity;
  const idKey = (id: unknown) => typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))
    ? JSON.stringify(id) : null;
  for (const [index, receipt] of input.receipts.entries()) {
    if (receipt.peerId !== state?.peerId || receipt.clockId !== state?.clockId || receipt.sequence !== index + 1 ||
      !Number.isFinite(receipt.atMs) || receipt.atMs < lastMs) violations.add('native-receipt-identity-or-sequence');
    lastMs = receipt.atMs;
    const frame = receipt.frame, id = idKey(frame.id);
    if (!['write-started', 'write-completed', 'write-failed', 'received'].includes(receipt.phase)) violations.add('unknown-native-receipt-phase');
    if (receipt.phase === 'write-started' && !id && frame.method !== 'initialized') violations.add('unidentified-native-command');
    if (receipt.phase === 'write-failed') missing.add('native-write-failed');
    if (receipt.phase === 'write-started' && id) {
      if (sent.has(id)) violations.add('duplicate-native-rpc');
      sent.set(id, receipt);
    } else if (receipt.phase === 'write-completed' && id) {
      if (writes.has(id) || !isDeepStrictEqual(sent.get(id)?.frame, frame)) violations.add('native-write-mismatch');
      writes.set(id, receipt);
    } else if (receipt.phase === 'received') {
      if (id && !frame.method) {
        if (replies.has(id) || !sent.has(id)) violations.add('unmatched-or-duplicate-native-reply');
        replies.set(id, receipt);
      } else if (frame.method) {
        if (id) violations.add('native-server-request');
        events.push(receipt);
      }
    }
  }
  const arms = new Map<string, string>();
  for (const arm of input.arms) {
    if (!nonblank(arm.threadId) || !nonblank(arm.armId) || arms.has(arm.threadId) || [...arms.values()].includes(arm.armId)) {
      violations.add('invalid-or-duplicate-arm');
    }
    arms.set(arm.threadId, arm.armId);
  }
  const threads = new Map<string, { inheritedTurnIds: string[]; sourcePath: string | null; openedAt: number }>();
  const reads = new Map<string, { thread: Record<string, unknown>; sequence: number }>();
  const turns: Array<{ armId: string; threadId: string; turnId: string; status: 'completed' | 'failed' | 'interrupted' }> = [];
  const readonly = new Set(['initialize', 'config/read', 'mcpServerStatus/list', 'thread/read']);
  for (const [id, request] of sent) {
    const frame = request.frame, params = record(frame.params), reply = replies.get(id), result = record(reply?.frame.result);
    if (!writes.has(id) || !reply) { missing.add('unacknowledged-native-rpc'); continue; }
    if (reply.frame.error != null) { missing.add('rejected-native-rpc'); continue; }
    if (['thread/start', 'thread/fork', 'thread/resume'].includes(String(frame.method))) {
      const thread = record(result.thread), threadId = thread.id;
      if (!nonblank(threadId) || !arms.has(threadId) || threads.has(threadId)) { violations.add('unassigned-or-duplicate-native-thread'); continue; }
      const inherited = Array.isArray(thread.turns) ? thread.turns.map(record) : null;
      if (!inherited || inherited.some(t => !nonblank(t.id) || !['completed', 'failed', 'interrupted'].includes(String(t.status))) ||
        new Set(inherited?.map(t => t.id)).size !== inherited?.length) missing.add('inherited-native-history-unavailable');
      threads.set(threadId, { inheritedTurnIds: inherited?.map(t => String(t.id)) ?? [],
        sourcePath: nonblank(thread.path) ? thread.path : null, openedAt: request.sequence });
    } else if (frame.method === 'thread/read') {
      const thread = record(result.thread);
      if (params.includeTurns !== true || thread.id !== params.threadId || !Array.isArray(thread.turns)) missing.add('native-thread-read-incomplete');
      else reads.set(String(thread.id), { thread, sequence: request.sequence });
    } else if (frame.method === 'turn/start') {
      const threadId = params.threadId, turnId = record(result.turn).id;
      if (!nonblank(threadId) || !nonblank(turnId) || !arms.has(threadId) ||
        !threads.has(threadId) || threads.get(threadId)!.openedAt >= request.sequence) {
        violations.add('unassigned-native-turn'); continue;
      }
      const matching = events.filter(r => record(r.frame.params).threadId === threadId &&
        record(record(r.frame.params).turn).id === turnId);
      const starts = matching.filter(r => r.frame.method === 'turn/started');
      const ends = matching.filter(r => r.frame.method === 'turn/completed');
      const status = record(record(ends[0]?.frame.params).turn).status;
      if (starts.length !== 1 || ends.length !== 1 || starts[0].sequence <= request.sequence ||
        ends[0].sequence <= starts[0].sequence || !['completed', 'failed', 'interrupted'].includes(String(status))) {
        missing.add('native-turn-boundary-unavailable'); continue;
      }
      if (turns.some(t => t.threadId === threadId && t.turnId === turnId) || threads.get(threadId)!.inheritedTurnIds.includes(turnId)) {
        violations.add('duplicate-native-turn');
      }
      turns.push({ armId: arms.get(threadId)!, threadId, turnId, status: status as typeof turns[number]['status'] });
    } else if (frame.method !== 'turn/interrupt' && !readonly.has(String(frame.method))) {
      violations.add('unsupported-native-rpc');
    }
  }
  for (const threadId of arms.keys()) {
    const opened = threads.get(threadId), read = reads.get(threadId);
    if (!opened || !read) { missing.add('missing-native-thread-boundary'); continue; }
    const current = turns.filter(t => t.threadId === threadId);
    const persisted = (read.thread.turns as unknown[]).map(record);
    const expected = [...opened.inheritedTurnIds, ...current.map(t => t.turnId)];
    if (!isDeepStrictEqual(persisted.map(t => t.id), expected) || current.some(t =>
      persisted.find(p => p.id === t.turnId)?.status !== t.status)) violations.add('persisted-native-population-mismatch');
    if (!current.length || events.some(r => record(r.frame.params).threadId === threadId &&
      ['turn/started', 'turn/completed'].includes(String(r.frame.method)) &&
      (!current.some(t => t.turnId === record(record(r.frame.params).turn).id) || r.sequence >= read.sequence))) {
      missing.add('unaccounted-native-turn-boundary');
    }
    if (opened.sourcePath !== read.thread.path || !opened.sourcePath) missing.add('native-source-path-unavailable');
  }
  if (events.some(r => ['turn/started', 'turn/completed'].includes(String(r.frame.method)) &&
    !arms.has(String(record(r.frame.params).threadId)))) violations.add('unassigned-native-turn-event');
  if (!arms.size || !turns.length) missing.add('empty-native-population');
  return { status: violations.size ? 'invalid' as const : missing.size ? 'incomplete' as const : 'closed-peer-reconciled' as const,
    missing: [...missing], violations: [...violations], turns,
    threads: [...threads].map(([threadId, thread]) => ({ threadId, sourcePath: thread.sourcePath,
      inheritedTurnIds: thread.inheritedTurnIds })), accountingComplete: false as const };
}

/** Controller reconciliation for ONE isolated gateway's lifetime snapshot.
 * Use exact native session/turn keys only. Neither a complete ring nor a usage
 * row proves an authenticated serving account or the charges of each attempt.
 * In particular, retain failed turns and all retry observations when usage is
 * absent. The caller must independently establish that its native-turn list
 * and canonical query population are complete; array length is not that proof.
 * This receipt must never set the budget helper's accountingComplete.
 */
export function inspectCarryRequestPopulation(input: {
  ownerId: string;
  turns: readonly { armId: string; threadId: string; turnId: string; status: 'completed' | 'failed' | 'interrupted' }[];
  gateway: GatewayRequestTelemetrySnapshot;
  usage: readonly CarryCanonicalUsageRow[];
}) {
  const missing = new Set<string>(), violations = new Set<string>();
  const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  const key = (thread: string, turn: string) => JSON.stringify([thread, turn]);
  const groups = input.turns.map(turn => ({ armId: turn.armId, threadId: turn.threadId, turnId: turn.turnId,
    status: turn.status, gatewayRequestIds: [] as number[],
    upstreamAttempts: [] as Array<{ requestId: number; ordinal: number; routingAccountId: string | null;
      responseStatus: number | null; outcome: string }>, usageEventKeys: [] as string[] }));
  const byNativeKey = new Map<string, typeof groups>();
  if (!nonblank(input.ownerId)) violations.add('missing-owner-identity');
  if (!groups.length) missing.add('empty-native-population');
  for (const [index, turn] of groups.entries()) {
    if (![turn.armId, turn.threadId, turn.turnId].every(nonblank) ||
      !['completed', 'failed', 'interrupted'].includes(turn.status)) violations.add(`invalid-native-turn:${index}`);
    const identity = key(turn.threadId, turn.turnId);
    const matching = byNativeKey.get(identity) ?? [];
    matching.push(turn); byNativeKey.set(identity, matching);
    if (matching.length > 1) violations.add(`ambiguous-native-turn:${identity}`);
  }
  const snapshot = input.gateway, counters = snapshot.requests;
  if (![counters.started, counters.finalized, counters.active, counters.sampled].every(count) ||
    counters.started !== counters.finalized + counters.active || counters.sampled !== counters.finalized ||
    Object.values(snapshot.outcomes).some(n => !count(n)) ||
    Object.values(snapshot.outcomes).reduce((sum, n) => sum + n, 0) !== counters.finalized) {
    violations.add('gateway-counter-mismatch');
  }
  if (counters.active !== 0) missing.add('active-gateway-requests');
  if (snapshot.recent.length !== counters.finalized) missing.add('incomplete-gateway-ring');
  const requestIds = new Set<number>(), unmatchedGatewayRequestIds: number[] = [];
  for (const row of snapshot.recent) {
    if (!count(row.requestId) || row.requestId === 0 || requestIds.has(row.requestId)) {
      violations.add(`invalid-or-duplicate-gateway-request:${row.requestId}`);
    }
    requestIds.add(row.requestId);
    const native = row.nativeCorrelation;
    const matches = native.status === 'observed' && nonblank(native.threadId) && nonblank(native.turnId)
      ? byNativeKey.get(key(native.threadId, native.turnId)) : undefined;
    const group = row.ownerId === input.ownerId && matches?.length === 1 ? matches[0] : undefined;
    if (!group) {
      unmatchedGatewayRequestIds.push(row.requestId);
      missing.add(`unmatched-gateway-request:${row.requestId}`);
    } else group.gatewayRequestIds.push(row.requestId);
    const calls = row.upstreamWrites.calls, ordinals = new Set<number>();
    if (row.upstreamWrites.droppedCalls !== 0 || row.attempts !== calls.length || calls.length === 0) {
      missing.add(`incomplete-upstream-observations:${row.requestId}`);
    }
    for (const [index, call] of calls.entries()) {
      if (!count(call.ordinal) || call.ordinal !== index + 1 || ordinals.has(call.ordinal)) {
        violations.add(`invalid-or-duplicate-upstream-call:${row.requestId}:${call.ordinal}`);
      }
      ordinals.add(call.ordinal);
      if (call.matchedRequests !== 1 || call.unexpectedRequests !== 0 || call.droppedRequests !== 0 ||
        call.droppedEvents !== 0 || call.outcome === 'pending' ||
        !call.events.some(event => event.phase === 'created' && event.requestOrdinal === 1)) {
        missing.add(`incomplete-upstream-call:${row.requestId}:${call.ordinal}`);
      }
      group?.upstreamAttempts.push({ requestId: row.requestId, ordinal: call.ordinal,
        routingAccountId: call.accountId, responseStatus: call.responseStatus, outcome: call.outcome });
    }
  }
  const usageIds = new Set<string>(), unmatchedUsageRows: number[] = [];
  for (const [index, row] of input.usage.entries()) {
    const eventKey = row.usage_event_key, turnId = row.usage_provenance?.turnId;
    if (!eventKey || !/^[a-f0-9]{64}$/.test(eventKey) || usageIds.has(eventKey)) {
      violations.add(`invalid-or-duplicate-usage-key:${index}`);
    }
    if (eventKey) usageIds.add(eventKey);
    const matches = nonblank(row.session_id) && nonblank(turnId) ? byNativeKey.get(key(row.session_id, turnId)) : undefined;
    if (matches?.length !== 1 || !eventKey) {
      unmatchedUsageRows.push(index); missing.add(`unmatched-usage-row:${index}`);
    } else matches[0].usageEventKeys.push(eventKey);
  }
  for (const group of groups) {
    if (!group.gatewayRequestIds.length) missing.add(`unobserved-native-requests:${key(group.threadId, group.turnId)}`);
    if (group.status === 'completed' && !group.usageEventKeys.length) missing.add(`unobserved-native-usage:${key(group.threadId, group.turnId)}`);
  }
  return { evidenceKind: 'observation-only' as const,
    populationStatus: violations.size ? 'invalid' as const : missing.size ? 'incomplete' as const : 'linked' as const,
    missing: [...missing], violations: [...violations], turns: groups,
    unmatchedGatewayRequestIds, unmatchedUsageRows,
    nativePopulationCoverage: 'not-established' as const, canonicalQueryCoverage: 'not-established' as const,
    // No existing sample field carries an authenticated attempt/charge join.
    chargeJoin: 'unavailable' as const, accountingComplete: false as const };
}

export interface CarryBudgetCharge {
  /** Canonical charged identity, including failed/aborted/preparation requests. */
  id: string;
  armId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedListUsd: number | null;
}

export interface CarryBudgetRequest {
  /** Frozen request slot, unique across the spent and unstarted populations. */
  id: string;
  armId: string;
  model: string;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  /** The controller establishes these native bounds; a prompt asking for a
   * short answer, unsupported API knob, or expected average is not a bound. */
  boundsVerified: boolean;
  boundsEvidenceRef: string | null;
}

/** D017 pre-request arithmetic, NOT authorization to dispatch. Caller must bind
 * the complete population, native bound receipts, runtime/auth/pricing manifest
 * and approval separately. Unknown cache input reserves its most expensive
 * applicable category; it is never used as measured acceptance cost. Every
 * remaining required request is reserved, not just the next convenient slot.
 */
export function evaluateCarryBudgetReservation(input: {
  accountingComplete: boolean;
  remainingRequestsComplete: boolean;
  spent: readonly CarryBudgetCharge[];
  remaining: readonly CarryBudgetRequest[];
  limits: { inputTokens: number; outputTokens: number; estimatedListUsd: number; chargedRequestsPerArm: number };
}) {
  const missing = new Set<string>(), exceeded = new Set<string>();
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const nonblank = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
  const money = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 &&
    Number.isSafeInteger(Math.ceil(n * 1_000_000));
  if (input.accountingComplete !== true) missing.add('incomplete-spent-accounting');
  if (input.remainingRequestsComplete !== true) missing.add('incomplete-remaining-population');
  if (!input.remaining.length) missing.add('no-next-request');
  if (!count(input.limits.inputTokens) || !count(input.limits.outputTokens) || !money(input.limits.estimatedListUsd) ||
    !count(input.limits.chargedRequestsPerArm) || input.limits.chargedRequestsPerArm === 0) missing.add('invalid-budget-limits');
  const ids = new Set<string>(), arms = new Map<string, number>();
  let inputTokens = 0, outputTokens = 0, microUsd = 0;
  const register = (id: string, armId: string) => {
    if (!nonblank(id) || !nonblank(armId)) missing.add('missing-request-or-arm-identity');
    if (ids.has(id)) missing.add(`duplicate-request:${id}`);
    ids.add(id); arms.set(armId, (arms.get(armId) ?? 0) + 1);
  };
  const accumulate = (id: string, tokensIn: number | null, tokensOut: number | null, usd: number | null) => {
    if (!count(tokensIn) || !count(tokensOut) || !money(usd)) { missing.add(`invalid-or-unknown-charge:${id}`); return; }
    inputTokens += tokensIn; outputTokens += tokensOut;
    // Round each reservation UP to microdollars; never round an expense down
    // or use a tolerance that admits a total beyond the hard budget.
    microUsd += Math.ceil(usd * 1_000_000);
    if (![inputTokens, outputTokens, microUsd].every(Number.isSafeInteger)) missing.add('budget-arithmetic-overflow');
  };
  for (const charge of input.spent) {
    register(charge.id, charge.armId);
    accumulate(charge.id, charge.inputTokens, charge.outputTokens, charge.estimatedListUsd);
  }
  for (const request of input.remaining) {
    register(request.id, request.armId);
    if (request.boundsVerified !== true || !nonblank(request.boundsEvidenceRef) ||
      !count(request.inputTokenLimit) || !count(request.outputTokenLimit) || request.outputTokenLimit === 0) {
      missing.add(`unverified-native-bounds:${request.id}`); continue;
    }
    if (!nonblank(request.model)) { missing.add(`unpriceable-request:${request.id}`); continue; }
    const common = { requestInputTokens: request.inputTokenLimit, outputTokens: request.outputTokenLimit };
    const categories = [
      { inputTokens: request.inputTokenLimit }, { cacheReadTokens: request.inputTokenLimit },
      { cacheCreationTokens: request.inputTokenLimit },
      // Public Anthropic cache-write TTL tiers do not apply to Codex routes.
      ...(normalizeModelId(request.model).startsWith('claude-') ? [
        { cacheCreation5mTokens: 0, cacheCreation1hTokens: request.inputTokenLimit },
      ] : []),
    ];
    const estimates = categories.map(category => costFromTokens(request.model, { ...common, ...category }));
    if (estimates.some(estimate => !estimate.priced || !money(estimate.usd))) {
      missing.add(`unpriceable-request:${request.id}`); continue;
    }
    accumulate(request.id, request.inputTokenLimit, request.outputTokenLimit, Math.max(...estimates.map(estimate => estimate.usd)));
  }
  if (inputTokens > input.limits.inputTokens) exceeded.add('input-token-cap');
  if (outputTokens > input.limits.outputTokens) exceeded.add('output-token-cap');
  if (microUsd > Math.floor(input.limits.estimatedListUsd * 1_000_000)) exceeded.add('estimated-list-cost-cap');
  for (const [arm, requests] of arms) if (requests > input.limits.chargedRequestsPerArm) exceeded.add(`request-cap:${arm}`);
  return { fitsBudget: missing.size === 0 && exceeded.size === 0, missing: [...missing], exceeded: [...exceeded],
    // Partial sums are not a usable reservation.
    projected: missing.size ? null : { inputTokens, outputTokens, estimatedListUsd: microUsd / 1_000_000,
      chargedRequestsByArm: Object.fromEntries(arms) } };
}

export interface CarryTaskEvaluation {
  /** Stable workload identity shared ONLY by the control/candidate pair. */
  taskId: string;
  /** D017 source stratum and exact frozen predecessor cut. These observations
   * still need controller-side provenance; this arithmetic cannot authenticate
   * a caller-supplied number or source reference. */
  sourceId: string | null;
  sourceRef: string | null;
  measuredHistoryInputTokens: number | null;
  historyEvidenceRef: string | null;
  observedIdleMs: number | null;
  idleEvidenceRef: string | null;
  arm: 'control' | 'candidate';
  model: string | null;
  transport: string | null;
  authorizationScope: string | null;
  workloadFingerprint: string | null;
  completed: boolean;
  /** Independent task-specific correctness checks, not a self-rated score. */
  quality: 'pass' | 'fail' | 'unverified';
  qualityEvidenceRef: string | null;
  firstUsefulResponseMs: number | null;
  /** Every charged request, including work done BEFORE creating the successor. */
  requests: readonly {
    /** Canonical source-event identity, unique across the entire evaluation. */
    id: string;
    phase: 'preparation' | 'startup' | 'work' | 'compaction' | 'recovery' | 'retry';
    uncachedInputTokens: number | null;
  }[];
  accountingComplete: boolean;
}

/** R-4/R-8 acceptance arithmetic. A passing synthetic test is not a passing live cohort. */
export function evaluateCarryTaskPairs(samples: readonly CarryTaskEvaluation[]) {
  const insufficient: string[] = [];
  const failures: string[] = [];
  const recipe = createCarryTrialRecipe();
  const minimumPairs = recipe.pairs.length;
  const expectedPairs = new Map(recipe.pairs.map(pair => [pair.id, pair]));
  const expectedSources = new Map(recipe.sources.map(source => [source.id, source]));
  const sourceCuts = new Map<string, { ref: string; tokens: number; evidenceRef: string }>();
  const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  const chargedRequests = new Set<string>();
  const byTask = new Map<string, CarryTaskEvaluation[]>();
  for (const sample of samples) byTask.set(sample.taskId, [...(byTask.get(sample.taskId) ?? []), sample]);
  for (const id of expectedPairs.keys()) {
    if (!byTask.has(id)) insufficient.push(`missing-recipe-pair:${id}`);
  }
  const pairs: Array<{ control: CarryTaskEvaluation; candidate: CarryTaskEvaluation }> = [];
  for (const [taskId, rows] of byTask) {
    if (!expectedPairs.has(taskId)) insufficient.push(`unexpected-recipe-pair:${taskId}`);
    const control = rows.filter(row => row.arm === 'control');
    const candidate = rows.filter(row => row.arm === 'candidate');
    if (!taskId || control.length !== 1 || candidate.length !== 1) {
      insufficient.push(`unpaired-or-duplicate:${taskId}`); continue;
    }
    const a = control[0], b = candidate[0];
    const dimensions = ['model', 'transport', 'authorizationScope', 'workloadFingerprint'] as const;
    if (dimensions.some(key => !a[key] || !b[key] || a[key] !== b[key])) {
      insufficient.push(`unmatched-dimensions:${taskId}`); continue;
    }
    const expected = expectedPairs.get(taskId);
    const source = expected && expectedSources.get(expected.sourceId);
    for (const row of [a, b]) {
      if (!source || row.sourceId !== source.id || !nonblank(row.sourceRef) ||
        !nonblank(row.historyEvidenceRef) || !count(row.measuredHistoryInputTokens) ||
        row.measuredHistoryInputTokens < source.history.minInputTokens ||
        row.measuredHistoryInputTokens > source.history.maxInputTokens) {
        insufficient.push(`unmeasured-or-out-of-band-history:${taskId}:${row.arm}`);
      }
      if (!source || !nonblank(row.idleEvidenceRef) || !count(row.observedIdleMs) ||
        row.observedIdleMs < source.idle.minMs ||
        (source.idle.maxInclusive ? row.observedIdleMs > source.idle.maxMs : row.observedIdleMs >= source.idle.maxMs)) {
        insufficient.push(`unmeasured-or-out-of-band-idle:${taskId}:${row.arm}`);
      }
    }
    if (source && nonblank(a.sourceRef) && count(a.measuredHistoryInputTokens) && nonblank(a.historyEvidenceRef)) {
      const prior = sourceCuts.get(source.id);
      if (prior && (prior.ref !== a.sourceRef || prior.tokens !== a.measuredHistoryInputTokens ||
        prior.evidenceRef !== a.historyEvidenceRef)) {
        insufficient.push(`inconsistent-source-cut:${source.id}`);
      } else sourceCuts.set(source.id, { ref: a.sourceRef, tokens: a.measuredHistoryInputTokens,
        evidenceRef: a.historyEvidenceRef });
    }
    if (!nonblank(a.sourceRef) || a.sourceRef !== b.sourceRef ||
      a.measuredHistoryInputTokens !== b.measuredHistoryInputTokens || a.historyEvidenceRef !== b.historyEvidenceRef) {
      insufficient.push(`unmatched-source-cut:${taskId}`);
    }
    if (!a.completed || !b.completed) failures.push(`incomplete-task:${taskId}`);
    if (a.quality === 'fail' || b.quality === 'fail') failures.push(`quality-failure:${taskId}`);
    if (a.quality === 'unverified' || b.quality === 'unverified' || !a.qualityEvidenceRef || !b.qualityEvidenceRef) {
      insufficient.push(`unverified-quality:${taskId}`);
    }
    for (const row of [a, b]) {
      if (!row.accountingComplete || row.requests.some(request => !request.id ||
        request.uncachedInputTokens === null || !Number.isSafeInteger(request.uncachedInputTokens) || request.uncachedInputTokens < 0) ||
        !Number.isSafeInteger(row.requests.reduce((sum, request) => sum + (request.uncachedInputTokens ?? NaN), 0))) {
        insufficient.push(`incomplete-accounting:${taskId}:${row.arm}`);
      }
      for (const request of row.requests) {
        if (chargedRequests.has(request.id)) insufficient.push(`reused-request:${taskId}:${row.arm}:${request.id}`);
        chargedRequests.add(request.id);
      }
      // D-060: first-two is the first two canonical requests of the arm thread;
      // an arm whose whole work is one request has a one-request first-two.
      if (row.requests.filter(request => request.phase === 'startup').length < 1) {
        insufficient.push(`missing-startup:${taskId}:${row.arm}`);
      }
      if (row.firstUsefulResponseMs === null || !Number.isFinite(row.firstUsefulResponseMs) || row.firstUsefulResponseMs < 0) {
        insufficient.push(`missing-latency:${taskId}:${row.arm}`);
      }
    }
    pairs.push({ control: a, candidate: b });
  }
  if (pairs.length < minimumPairs) insufficient.push(`too-few-pairs:${pairs.length}/${minimumPairs}`);
  if (insufficient.length) return { status: failures.length ? 'fail' as const : 'insufficient' as const,
    pairs: pairs.length, insufficient, failures, metrics: null };
  // Seeded resampling must not change when the same ledger rows arrive in a
  // different order. The two arms stay index-aligned by their workload identity.
  pairs.sort((a, b) => a.control.taskId < b.control.taskId ? -1 : a.control.taskId > b.control.taskId ? 1 : 0);
  const total = (arm: 'control' | 'candidate') => pairs.reduce((sum, pair) => sum +
    pair[arm].requests.reduce((n, request) => n + request.uncachedInputTokens!, 0), 0);
  const startup = (arm: 'control' | 'candidate') => pairs.reduce((sum, pair) => sum +
    pair[arm].requests.filter(request => request.phase === 'startup').slice(0, 2)
      .reduce((n, request) => n + request.uncachedInputTokens!, 0), 0);
  const latency = (arm: 'control' | 'candidate') => percentile(pairs.map(pair => pair[arm].firstUsefulResponseMs!), 0.95);
  const controlTotal = total('control'), controlStartup = startup('control'), controlP95 = latency('control');
  const candidateTotal = total('candidate'), candidateStartup = startup('candidate'), candidateP95 = latency('candidate');
  if (![controlTotal, controlStartup, candidateTotal, candidateStartup].every(Number.isSafeInteger)) return {
    status: 'insufficient' as const, pairs: pairs.length, insufficient: ['unsafe-aggregate-token-total'], failures, metrics: null,
  };
  if (controlTotal <= 0 || controlStartup <= 0 || controlP95 <= 0) return {
    status: 'insufficient' as const, pairs: pairs.length, insufficient: ['zero-control-denominator'], failures, metrics: null,
  };
  const bootstrap = { ci: 0.95, iterations: 10_000, seed: 12345 };
  const taskCounts = (arm: 'control' | 'candidate', startupOnly: boolean) => pairs.map(pair => {
    const requests = startupOnly ? pair[arm].requests.filter(request => request.phase === 'startup').slice(0, 2)
      : pair[arm].requests;
    return requests.reduce((sum, request) => sum + request.uncachedInputTokens!, 0);
  });
  const uncertainty = {
    method: 'paired-bootstrap-mean-difference' as const,
    resamplingUnit: 'task-pair' as const,
    ...bootstrap,
    // Candidate minus control; these intervals describe mean token differences,
    // not the pooled reduction ratios or the p95 latency metric below.
    firstTwo: pairedBootstrapCI(taskCounts('control', true), taskCounts('candidate', true), bootstrap),
    task: pairedBootstrapCI(taskCounts('control', false), taskCounts('candidate', false), bootstrap),
  };
  const strata = recipe.sources.map(source => {
    const members = pairs.filter(pair => pair.control.sourceId === source.id);
    const tokens = (arm: 'control' | 'candidate') => members.reduce((sum, pair) => sum +
      pair[arm].requests.reduce((n, request) => n + request.uncachedInputTokens!, 0), 0);
    return { sourceId: source.id, historyInputTokens: sourceCuts.get(source.id)?.tokens ?? null,
      pairs: members.length, controlUncachedInputTokens: tokens('control'), candidateUncachedInputTokens: tokens('candidate') };
  });
  const metrics = { controlTotal, candidateTotal, controlStartup, candidateStartup, controlP95, candidateP95, strata,
    firstTwoUncachedReduction: 1 - candidateStartup / controlStartup,
    taskUncachedReduction: 1 - candidateTotal / controlTotal,
    p95LatencyChange: candidateP95 / controlP95 - 1, uncertainty };
  if (metrics.firstTwoUncachedReduction < 0.5) failures.push('first-two-reduction-below-50-percent');
  if (metrics.taskUncachedReduction < 0.25) failures.push('task-reduction-below-25-percent');
  if (metrics.p95LatencyChange > 0.1 + Number.EPSILON) failures.push('p95-latency-regression-above-10-percent');
  if (uncertainty.firstTwo.delta.upper >= 0) insufficient.push('first-two-improvement-not-supported-by-paired-95-ci');
  if (uncertainty.task.delta.upper >= 0) insufficient.push('task-improvement-not-supported-by-paired-95-ci');
  return { status: failures.length ? 'fail' as const : insufficient.length ? 'insufficient' as const : 'pass' as const,
    pairs: pairs.length, insufficient, failures, metrics };
}
