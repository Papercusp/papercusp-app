/** P-012 scoring for the existing saturation benchmark: fixed IDs, full tails, per-class F2. */
import type { CodeIntelAnswer, SymbolSite } from './contracts';

export type ReplayClass = 'definition' | 'hot-references';
export type ReplayMode = ReplayClass | 'mixed';
export interface ReplayRequest {
  readonly id: string;
  readonly actorId: string;
  readonly sequence: number;
  readonly queryClass: ReplayClass;
}
export interface ReplayOracle {
  /** Frozen independent expected locations; never obtained from the subject's warmup answer. */
  readonly sites: readonly Pick<SymbolSite, 'path' | 'line1'>[];
  readonly sourceFingerprint: string;
  readonly oracleFingerprint: string;
  readonly staleSites?: readonly Pick<SymbolSite, 'path' | 'line1'>[];
}
export interface ReplaySample {
  readonly request: ReplayRequest;
  readonly issuedAtMs: number;
  readonly settledAtMs: number;
  /** Retained separately when the runtime supplies the actual durable terminal timestamp. */
  readonly clientSettledAtMs?: number;
  readonly answer: CodeIntelAnswer | null;
  readonly transportError: string | null;
}
export interface ReplayClassification {
  readonly usefulCorrect: boolean;
  readonly certifiedFalseEmpty: boolean;
  readonly certifiedStale: boolean;
  readonly reasons: readonly string[];
}
export interface ReplayClassReport {
  readonly issued: number;
  readonly settled: number;
  readonly usefulCorrect: number;
  readonly elapsedMs: number | null;
  readonly usefulPerSec: number | null;
  readonly p95Ms: number | null;
}
export interface ReplayReport {
  readonly schemaVersion: 'lsp-fleet-replay-v1';
  readonly concurrency: number;
  readonly mode: ReplayMode;
  readonly population: readonly ReplayRequest[];
  readonly samples: readonly ReplaySample[];
  readonly classes: Readonly<Record<ReplayClass, ReplayClassReport>>;
  readonly sourceFingerprint: string;
  readonly oracleFingerprint: string;
  readonly complete: boolean;
  readonly accountingErrors: readonly string[];
  readonly certifiedFalseEmpty: number;
  readonly certifiedStale: number;
  readonly failures: readonly { id: string; reasons: readonly string[] }[];
  readonly classesOverlap: boolean;
}
export const REPLAY_CLASSES: readonly ReplayClass[] = ['definition', 'hot-references'];
export const FLEET_REPLAY_LEVELS = [1, 8, 64, 256, 1000] as const;

/** Freeze 2:1 counts and class cohorts; solo offered actor counts match the mixed class. */
export function buildReplayTrace(concurrency: number, mode: ReplayMode, runId: string): ReplayRequest[] {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  if (!runId) throw new Error('runId is required');
  const hotActors = concurrency === 1 ? 0 : Math.max(1, Math.floor(concurrency / 3));
  const cheapActors = concurrency - hotActors;
  return Array.from({ length: concurrency }, (_, actor) => {
    const queryClass: ReplayClass = actor < cheapActors ? 'definition' : 'hot-references';
    const classIndex = queryClass === 'definition' ? actor : actor - cheapActors;
    const actors = queryClass === 'definition' ? cheapActors : hotActors;
    const count = queryClass === 'definition' ? 2 * concurrency : concurrency;
    const requests = Math.floor(count / actors) + Number(classIndex < count % actors);
    const classes: ReplayClass[] = concurrency === 1 ? ['definition', 'definition', 'hot-references'] : Array(requests).fill(queryClass);
    return classes.map((queryClass, sequence) => ({
      id: `${runId}/actor-${actor}/${sequence}/${queryClass}`,
      actorId: `${runId}/actor-${actor}`, sequence, queryClass,
    })).filter(request => mode === 'mixed' || request.queryClass === mode);
  }).flat();
}

const siteKey = (site: Pick<SymbolSite, 'path' | 'line1'>) => JSON.stringify([site.path, site.line1]);
export function classifyReplayAnswer(answer: CodeIntelAnswer | null, oracle: ReplayOracle): ReplayClassification {
  if (!answer) return { usefulCorrect: false, certifiedFalseEmpty: false, certifiedStale: false, reasons: ['transport-failure'] };
  const reasons: string[] = [];
  const certified = answer.error === null && answer.freshness.health === 'healthy';
  const expected = new Set(oracle.sites.map(siteKey));
  const actual = new Set(answer.sites.map(siteKey));
  const certifiedFalseEmpty = certified && actual.size === 0 && expected.size > 0;
  const knownStale = new Set((oracle.staleSites ?? []).map(siteKey));
  const certifiedStale = certified && (answer.freshness.staleVsDisk === true || [...actual].some(site => knownStale.has(site)));
  if (answer.error !== null) reasons.push(`refusal: ${answer.error}`);
  if (answer.freshness.health !== 'healthy') reasons.push(`health:${answer.freshness.health}`);
  if (answer.freshness.staleVsDisk !== false) reasons.push('freshness-not-proven');
  if (certifiedFalseEmpty) reasons.push('certified-false-empty');
  if (certifiedStale) reasons.push('certified-stale');
  if (actual.size !== answer.sites.length) reasons.push('duplicate-sites');
  if ([...actual].some(site => !expected.has(site))) reasons.push('unexpected-site');
  // The current BAR requires exact complete site sets. Legitimate facade
  // truncation is still insufficient evidence; never infer its unseen tail.
  if (answer.truncation.truncated) {
    reasons.push('incomplete-site-set');
  } else if (actual.size !== expected.size || [...expected].some(site => !actual.has(site))) {
    reasons.push('missing-sites');
  }
  return { usefulCorrect: reasons.length === 0, certifiedFalseEmpty, certifiedStale, reasons };
}

export function replayPercentile(values: readonly number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length / 100) - 1))];
}

export function scoreReplay(
  concurrency: number, mode: ReplayMode, population: readonly ReplayRequest[], samples: readonly ReplaySample[],
  oracles: Readonly<Record<ReplayClass, ReplayOracle>>,
): ReplayReport {
  const expected = new Map(population.map(request => [request.id, request]));
  const accountingErrors: string[] = [];
  if (expected.size !== population.length) accountingErrors.push('duplicate-issued-id');
  const seen = new Set<string>();
  const accepted: ReplaySample[] = [];
  for (const sample of samples) {
    const request = expected.get(sample.request.id);
    if (!request) { accountingErrors.push(`unissued:${sample.request.id}`); continue; }
    if (seen.has(request.id)) { accountingErrors.push(`duplicate-terminal:${request.id}`); continue; }
    seen.add(request.id);
    if (JSON.stringify(request) !== JSON.stringify(sample.request)) { accountingErrors.push(`identity-mismatch:${request.id}`); continue; }
    if (!Number.isFinite(sample.issuedAtMs) || !Number.isFinite(sample.settledAtMs) || sample.settledAtMs < sample.issuedAtMs) {
      accountingErrors.push(`invalid-time:${request.id}`); continue;
    }
    accepted.push(sample);
  }
  for (const id of expected.keys()) if (!seen.has(id)) accountingErrors.push(`missing-terminal:${id}`);
  const classes = {} as Record<ReplayClass, ReplayClassReport>;
  const failures: { id: string; reasons: readonly string[] }[] = [];
  let certifiedFalseEmpty = 0;
  let certifiedStale = 0;
  for (const queryClass of REPLAY_CLASSES) {
    const rows = accepted.filter(sample => sample.request.queryClass === queryClass);
    let usefulCorrect = 0;
    for (const row of rows) {
      const result = classifyReplayAnswer(row.answer, oracles[queryClass]);
      const reasons = row.transportError ? [...result.reasons, row.transportError] : result.reasons;
      if (result.usefulCorrect && !row.transportError) usefulCorrect += 1;
      else failures.push({ id: row.request.id, reasons });
      certifiedFalseEmpty += Number(result.certifiedFalseEmpty);
      certifiedStale += Number(result.certifiedStale);
    }
    // The class's OWN complete tail is its denominator, never aggregate elapsed.
    const elapsedMs = rows.length ? Math.max(...rows.map(row => row.settledAtMs)) - Math.min(...rows.map(row => row.issuedAtMs)) : null;
    classes[queryClass] = {
      issued: population.filter(request => request.queryClass === queryClass).length, settled: rows.length, usefulCorrect,
      elapsedMs, usefulPerSec: elapsedMs !== null && elapsedMs > 0 ? usefulCorrect * 1000 / elapsedMs : null,
      p95Ms: replayPercentile(rows.map(row => row.settledAtMs - row.issuedAtMs), 95),
    };
  }
  const first = oracles.definition;
  if (first.sourceFingerprint !== oracles['hot-references'].sourceFingerprint) accountingErrors.push('oracle-source-mismatch');
  const definitions = accepted.filter(sample => sample.request.queryClass === 'definition');
  const references = accepted.filter(sample => sample.request.queryClass === 'hot-references');
  const classesOverlap = definitions.some(definition => references.some(reference =>
    Math.max(definition.issuedAtMs, reference.issuedAtMs) < Math.min(definition.settledAtMs, reference.settledAtMs)));
  return {
    schemaVersion: 'lsp-fleet-replay-v1', concurrency, mode, population, samples,
    classes, sourceFingerprint: first.sourceFingerprint,
    oracleFingerprint: JSON.stringify(REPLAY_CLASSES.map(queryClass => oracles[queryClass].oracleFingerprint)),
    complete: accountingErrors.length === 0 && accepted.length === population.length,
    accountingErrors, certifiedFalseEmpty, certifiedStale, failures, classesOverlap,
  };
}

/** Each actor executes its frozen sequence; rejection is terminal evidence, never dropped. */
export async function runReplay(options: {
  concurrency: number; mode: ReplayMode; runId: string;
  oracles: Readonly<Record<ReplayClass, ReplayOracle>>;
  execute: (request: ReplayRequest) => Promise<CodeIntelAnswer>;
  now?: () => number;
}): Promise<ReplayReport> {
  const now = options.now ?? (() => performance.now());
  const population = buildReplayTrace(options.concurrency, options.mode, options.runId);
  const actors = new Map<string, ReplayRequest[]>();
  for (const request of population) {
    const queue = actors.get(request.actorId) ?? [];
    queue.push(request); actors.set(request.actorId, queue);
  }
  const samples: ReplaySample[] = [];
  await Promise.all([...actors.values()].map(async requests => {
    for (const request of requests) {
      const issuedAtMs = now();
      let answer: CodeIntelAnswer | null = null;
      let transportError: string | null = null;
      try { answer = await options.execute(request); }
      catch (error) { transportError = error instanceof Error ? error.message : String(error); }
      samples.push({ request, issuedAtMs, settledAtMs: now(), answer, transportError });
    }
  }));
  return scoreReplay(options.concurrency, options.mode, population, samples, options.oracles);
}

export interface ReplayTriplet {
  readonly trialId: string;
  readonly definition: ReplayReport;
  readonly references: ReplayReport;
  readonly mixed: ReplayReport;
  /** Runtime/binary/config/fixture qualification must come from the runner, not be inferred from speed. */
  readonly qualification: { readonly qualified: boolean; readonly fingerprint: string; readonly reasons: readonly string[] };
}
export function evaluateReplayTriplet(triplet: ReplayTriplet) {
  const { definition, references, mixed, qualification } = triplet;
  const unknown: string[] = [...qualification.reasons];
  const broken: string[] = [];
  const reports = [definition, references, mixed];
  if (!qualification.qualified || !qualification.fingerprint) unknown.push('unqualified-runtime');
  if (definition.mode !== 'definition' || references.mode !== 'hot-references' || mixed.mode !== 'mixed') unknown.push('invalid-triplet-modes');
  if (reports.some(report => report.concurrency !== mixed.concurrency || report.sourceFingerprint !== mixed.sourceFingerprint ||
      report.oracleFingerprint !== mixed.oracleFingerprint)) unknown.push('unmatched-triplet');
  if (reports.some(report => !report.complete)) unknown.push('unfinished-or-invalid-accounting');
  if ([definition, references].some(report => report.failures.length)) unknown.push('failed-solo-baseline');
  if (mixed.failures.length) broken.push('incorrect-expected-success');
  if (reports.some(report => report.certifiedFalseEmpty || report.certifiedStale)) broken.push('certified-safety-failure');
  if (!triplet.trialId) unknown.push('missing-trial-identity');
  if (mixed.concurrency > 1 && !mixed.classesOverlap) unknown.push('no-class-overlap');
  const cheap = mixed.classes.definition;
  const cheapSolo = definition.classes.definition;
  const hot = mixed.classes['hot-references'];
  const hotSolo = references.classes['hot-references'];
  if (cheap.issued !== cheapSolo.issued || hot.issued !== hotSolo.issued || cheap.issued !== mixed.concurrency * 2 || hot.issued !== mixed.concurrency)
    unknown.push('unmatched-fixed-counts');
  const measurable = [cheap, cheapSolo, hot, hotSolo].every(report => report.usefulPerSec !== null && report.p95Ms !== null);
  if (!measurable) unknown.push('unmeasured-class-rate-or-tail');
  const cheapRateFactor = measurable ? cheap.usefulPerSec! / cheapSolo.usefulPerSec! : null;
  const hotRateFactor = measurable ? hot.usefulPerSec! / hotSolo.usefulPerSec! : null;
  const cheapLatencyFactor = measurable && cheapSolo.p95Ms! > 0 ? cheap.p95Ms! / cheapSolo.p95Ms! : null;
  if (cheapLatencyFactor === null) unknown.push('unmeasured-cheap-tail-factor');
  const violations = [
    ...(cheapRateFactor !== null && cheapRateFactor < 0.5 ? ['cheap-rate'] : []),
    ...(hotRateFactor !== null && hotRateFactor < 0.5 ? ['hot-rate'] : []),
    ...(cheapLatencyFactor !== null && cheapLatencyFactor > 2 ? ['cheap-tail'] : []),
  ];
  return { concurrency: mixed.concurrency, control: mixed.concurrency === 1,
    qualified: unknown.length === 0, unknown, broken, violations,
    cheapRateFactor, hotRateFactor, cheapLatencyFactor };
}

/** A factor violation in two qualified trials breaks a level; one is degraded. */
export function evaluateReplayLadder(triplets: readonly ReplayTriplet[], levels: readonly number[] = FLEET_REPLAY_LEVELS) {
  const results = triplets.map(evaluateReplayTriplet);
  const unknown: string[] = [];
  const broken: string[] = [];
  const degraded: string[] = [];
  if (!levels.includes(1000)) unknown.push('missing-1000-level');
  if (new Set(levels).size !== levels.length) unknown.push('duplicate-level');
  if (new Set(triplets.map(triplet => triplet.trialId)).size !== triplets.length) unknown.push('reused-trial');
  const runIds = triplets.flatMap(triplet => [triplet.definition, triplet.references, triplet.mixed])
    .map(report => report.population[0]?.id);
  if (new Set(runIds).size !== runIds.length) unknown.push('reused-run');
  for (const level of levels) {
    const trials = results.filter(result => result.concurrency === level);
    if (trials.length !== 3 || trials.some(trial => !trial.qualified)) unknown.push(`unqualified-triplets:${level}`);
    if (trials.some(trial => trial.broken.length)) broken.push(`incorrect-outcomes:${level}`);
    if (level === 1) continue;
    const rateViolations = trials.filter(trial => trial.qualified && trial.violations.some(violation => violation !== 'cheap-tail')).length;
    if (rateViolations >= 2) broken.push(`factor-failure:${level}`);
    else if (trials.some(trial => trial.qualified && trial.violations.length)) degraded.push(`factor-violation:${level}`);
  }
  for (const result of results) if (!levels.includes(result.concurrency)) unknown.push(`unexpected-level:${result.concurrency}`);
  return { rating: broken.length ? 'broken' : unknown.length ? 'unknown' : degraded.length ? 'degraded' : 'healthy',
    unknown, broken, degraded, results };
}
