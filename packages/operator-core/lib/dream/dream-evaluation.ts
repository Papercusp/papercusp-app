import { z } from 'zod';
import { capabilityHash } from './capability-contracts';
import { DEFAULT_DREAM_CYCLE_CONFIG, type DreamCycleConfig } from './dream-config';
import { DreamProblemContextSchema, scopeDreamProblems, type DreamProblemContext } from './capability-pass';

/** Protocol and evidence for the existing Dream/Blender experiment paths. No scheduler or spend switch. */
export const DREAM_EVALUATION_ARMS = ['blender', 'uniform-pair', 'structured-pair', 'structured-triple'] as const;
export type DreamEvaluationArm = (typeof DREAM_EVALUATION_ARMS)[number];
export const DREAM_EVALUATION_COSTS = [
  'indexing',
  'retrieval',
  'generation',
  'review',
  'verification',
  'experiment',
] as const;
export const DREAM_UTILITY_CONTRACT = {
  version: 'dream-utility-v1',
  qualified:
    'Unique behavioral family, source-verified contributions, concrete beneficiary, feasible independently reviewed falsifier; scoped novelty only.',
  outcome: 'Verified beneficial executed experiment; an unexecuted hypothesis is not a successful change.',
  leadingMetric: 'unique-qualified-families / fully-attributed-discovery-usd',
  outcomeMetric: 'verified-beneficial-experiments / (discovery-usd + experiment-usd)',
  time: 'Report engineer/reviewer minutes separately; do not invent a dollar conversion.',
  decision: 'inconclusive until replicated benefit; exploratory evidence never selects an automatic winner',
} as const;

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(1000);
export const DreamEvaluationProtocolSchema = z
  .object({
    version: z.literal('dream-evaluation-v1'),
    sourceSnapshot: sha,
    benchmarkHash: sha,
    oracleHash: sha,
    independentLabelsRef: text,
    // New comparisons explicitly freeze the shared problem input. Absence retains
    // the original pilot protocol byte-for-byte and its open-exploration behavior.
    comparison: z.object({
      manifestRevision: text,
      scope: z.object({ workspaceId: text, potSlug: text }).strict(),
      problemContext: DreamProblemContextSchema,
      inputHash: sha,
    }).strict().optional(),
    seed: text,
    models: z.object({ generator: text, reviewer: text }).strict(),
    arms: z.tuple([
      z.literal('blender'),
      z.literal('uniform-pair'),
      z.literal('structured-pair'),
      z.literal('structured-triple'),
    ]),
    utilityHash: sha,
    costPhases: z.tuple([
      z.literal('indexing'),
      z.literal('retrieval'),
      z.literal('generation'),
      z.literal('review'),
      z.literal('verification'),
      z.literal('experiment'),
    ]),
    limits: z
      .object({
        attempts: z.literal(200),
        attemptsPerArm: z.literal(50),
        discoveryUsd: z.number().finite().min(0),
        discoveryUsdPerArm: z.number().finite().min(0),
        cycleAttempts: z.literal(3),
        cycleUsd: z.number().finite().min(0),
        rollingDayUsd: z.number().finite().min(0),
        experimentMinutes: z.literal(60),
        experimentCount: z.literal(12),
        // Zero means unapproved. This protocol does not silently authorize downstream compute.
        experimentComputeUsd: z.number().finite().min(0),
      })
      .strict(),
    analysis: z
      .object({
        blocks: z.literal('source-snapshot/domain-coverage/model/run-window'),
        seedPolicy: z.literal('seed:arm:attempt; matched A/B subset holds pair fixed with and without C'),
        uncertainty: z.literal('cluster by source snapshot and proposal family; exploratory, not powered'),
        stop: z.literal('stop on provenance/budget fault; stop at first cap; insufficient evidence is inconclusive'),
        rejectionSample: z.literal('stratified blinded sample of rejected cases, same utility rubric'),
        ablations: z.literal('A-only/B-only; faceted/flat; paired with/without C; calibration disjoint from held-out'),
      })
      .strict(),
  })
  .strict();
export type DreamEvaluationProtocol = z.infer<typeof DreamEvaluationProtocolSchema>;

export function freezeDreamEvaluationProtocol(
  input: Pick<
    DreamEvaluationProtocol,
    'sourceSnapshot' | 'benchmarkHash' | 'oracleHash' | 'independentLabelsRef' | 'seed' | 'models' | 'comparison'
  > &
    Partial<
      Pick<
        DreamEvaluationProtocol['limits'],
        'discoveryUsd' | 'discoveryUsdPerArm' | 'cycleUsd' | 'rollingDayUsd' | 'experimentComputeUsd'
      >
    >,
) {
  const {
    discoveryUsd = 20,
    discoveryUsdPerArm = 5,
    cycleUsd = DEFAULT_DREAM_CYCLE_CONFIG.maxCostUsd,
    rollingDayUsd = DEFAULT_DREAM_CYCLE_CONFIG.rolling24hCostUsd,
    experimentComputeUsd = 0,
    ...pins
  } = input;
  const protocol = DreamEvaluationProtocolSchema.parse({
    ...pins,
    version: 'dream-evaluation-v1',
    arms: [...DREAM_EVALUATION_ARMS],
    utilityHash: capabilityHash(JSON.stringify(DREAM_UTILITY_CONTRACT)),
    costPhases: [...DREAM_EVALUATION_COSTS],
    limits: {
      attempts: 200,
      attemptsPerArm: 50,
      discoveryUsd,
      discoveryUsdPerArm,
      cycleAttempts: DEFAULT_DREAM_CYCLE_CONFIG.maxDreamsPerCycle,
      cycleUsd,
      rollingDayUsd,
      experimentMinutes: 60,
      experimentCount: 12,
      experimentComputeUsd,
    },
    analysis: {
      blocks: 'source-snapshot/domain-coverage/model/run-window',
      seedPolicy: 'seed:arm:attempt; matched A/B subset holds pair fixed with and without C',
      uncertainty: 'cluster by source snapshot and proposal family; exploratory, not powered',
      stop: 'stop on provenance/budget fault; stop at first cap; insufficient evidence is inconclusive',
      rejectionSample: 'stratified blinded sample of rejected cases, same utility rubric',
      ablations: 'A-only/B-only; faceted/flat; paired with/without C; calibration disjoint from held-out',
    },
  });
  return { protocol, pin: dreamEvaluationProtocolHash(protocol) };
}

export function dreamEvaluationProtocolHash(value: unknown): string {
  return capabilityHash(JSON.stringify(DreamEvaluationProtocolSchema.parse(value)));
}

/** Same evidence and attributed problem input for each arm. This does not imply
 * equal representations/prompts or certify the independentLabelsRef as human. */
export function dreamComparisonInputHash(input: {
  sourceSnapshot: string; manifestRevision: string;
  scope: { workspaceId: string; potSlug: string }; problemContext: DreamProblemContext;
}) {
  const context = DreamProblemContextSchema.parse(input.problemContext);
  const scoped = scopeDreamProblems(context.evidence, input.scope, context.mode);
  if (JSON.stringify(scoped.evidence) !== JSON.stringify(context.evidence) || scoped.mode !== context.mode)
    throw new Error('Comparable Dream input contains invalid or foreign problem evidence');
  return capabilityHash(JSON.stringify([input.sourceSnapshot, input.manifestRevision,
    input.scope.workspaceId, input.scope.potSlug, context.mode, context.evidence]));
}

export interface DreamPilotPin {
  protocol: unknown;
  pin: string;
  arm: DreamEvaluationArm;
  /** Shared assignment for the pair/triple ablation, separate from the unique attempt identity. */
  matchedPairIndex?: number;
}
export const DreamPilotPinSchema = z
  .object({
    protocol: DreamEvaluationProtocolSchema,
    pin: sha,
    arm: z.enum(DREAM_EVALUATION_ARMS),
    matchedPairIndex: z.number().int().min(0).max(49).optional(),
  })
  .strict();

/** Called by the real Dream cycle before its first paid generation. A pin is proof of
 * reproducible configuration, not a grant of spending authority; the governor still admits every call. */
export function requireDreamPilotProtocol(
  input: DreamPilotPin,
  current: {
    sourceSnapshot: string;
    generator: string;
    reviewer: string;
    mode: string;
    samplerMode: string;
    arity: number | 'mixed';
    cycle: Pick<DreamCycleConfig, 'maxCostUsd' | 'rolling24hCostUsd'>;
    manifestRevision?: string;
    scope?: { workspaceId: string; potSlug: string };
  },
) {
  const protocol = DreamEvaluationProtocolSchema.parse(input.protocol);
  if (!sha.safeParse(input.pin).success || dreamEvaluationProtocolHash(protocol) !== input.pin)
    throw new Error('Dream pilot protocol is missing or changed');
  if (protocol.utilityHash !== capabilityHash(JSON.stringify(DREAM_UTILITY_CONTRACT)))
    throw new Error('Dream pilot utility contract changed');
  if (protocol.sourceSnapshot !== current.sourceSnapshot) throw new Error('Dream pilot source snapshot changed');
  if (protocol.comparison) {
    const comparison = protocol.comparison;
    if (current.manifestRevision !== comparison.manifestRevision ||
        current.scope?.workspaceId !== comparison.scope.workspaceId || current.scope.potSlug !== comparison.scope.potSlug ||
        dreamComparisonInputHash({ ...comparison, sourceSnapshot: current.sourceSnapshot }) !== comparison.inputHash)
      throw new Error('Comparable Dream source/problem input changed');
  }
  if (protocol.models.generator !== current.generator || protocol.models.reviewer !== current.reviewer)
    throw new Error('Dream pilot model configuration changed');
  if (current.mode !== 'manual') throw new Error('Dream pilot requires manual control');
  if (input.matchedPairIndex !== undefined &&
      (!Number.isInteger(input.matchedPairIndex) || input.matchedPairIndex < 0 || input.matchedPairIndex >= 50 ||
       !['structured-pair', 'structured-triple'].includes(input.arm)))
    throw new Error('Matched Dream assignment requires a structured arm and a bounded pair index');
  if (
    current.cycle.maxCostUsd !== protocol.limits.cycleUsd ||
    current.cycle.rolling24hCostUsd !== protocol.limits.rollingDayUsd
  )
    throw new Error('Dream pilot monetary configuration changed');
  const arm = input.arm;
  if (arm === 'blender' || !DREAM_EVALUATION_ARMS.includes(arm))
    throw new Error('The Blender arm must use the ordinary Blender experiment path');
  if (
    current.samplerMode !== (arm === 'uniform-pair' ? 'random-control' : 'structured') ||
    current.arity !== (arm === 'structured-triple' ? 3 : 2)
  )
    throw new Error('Dream pilot arm does not match sampler configuration');
  return protocol;
}

export interface DreamEvaluationCost {
  arm: DreamEvaluationArm;
  /** Every phase is explicit, including zero. null means unknown, never free. */
  phases: Record<(typeof DREAM_EVALUATION_COSTS)[number], number | null>;
  qualifiedFamilies: string[];
  verifiedBeneficialExperiments: number;
  engineerMinutes: number;
  /** Missing historical time remains unknown, rather than an invented zero. */
  reviewerMinutes?: number | null;
  maintenanceMinutes?: number | null;
  /** Receipt of the actual common input supplied to this arm, not its intended input. */
  inputHash?: string;
  spendCapUsd?: number;
}

/** Same numerator, denominator and accounting for every arm, including ordinary Blender. */
export function summarizeDreamEvaluationCosts(rows: readonly DreamEvaluationCost[]) {
  if (rows.some((row) => !DREAM_EVALUATION_ARMS.includes(row.arm))) throw new Error('Unknown Dream evaluation arm');
  return DREAM_EVALUATION_ARMS.map((arm) => {
    const selected = rows.filter((r) => r.arm === arm);
    let discovery: number | null = 0,
      experiment: number | null = 0;
    const families = new Set<string>();
    const time = (key: 'reviewerMinutes' | 'maintenanceMinutes') => {
      if (!selected.length || selected.some(r => r[key] == null)) return null;
      return selected.reduce((n, r) => n + r[key]!, 0);
    };
    for (const row of selected) {
      if (row.spendCapUsd !== undefined && (!Number.isFinite(row.spendCapUsd) || row.spendCapUsd < 0))
        throw new Error('Invalid evaluation spend cap');
      for (const key of ['reviewerMinutes', 'maintenanceMinutes'] as const)
        if (row[key] != null && (!Number.isFinite(row[key]) || row[key]! < 0))
          throw new Error('Invalid evaluation time: ' + key);
      for (const phase of DREAM_EVALUATION_COSTS) {
        const cost = row.phases[phase];
        if (cost !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0))
          throw new Error('Invalid or omitted Dream cost phase: ' + phase);
        if (phase === 'experiment') experiment = cost === null || experiment === null ? null : experiment + cost;
        else discovery = cost === null || discovery === null ? null : discovery + cost;
      }
      if (
        !Number.isInteger(row.verifiedBeneficialExperiments) ||
        row.verifiedBeneficialExperiments < 0 ||
        !Number.isFinite(row.engineerMinutes) ||
        row.engineerMinutes < 0
      )
        throw new Error('Invalid experiment outcome');
      for (const family of row.qualifiedFamilies) {
        if (!family.trim()) throw new Error('Missing proposal family');
        families.add(family);
      }
    }
    const total = discovery === null || experiment === null ? null : discovery + experiment;
    const verified = selected.reduce((n, r) => n + r.verifiedBeneficialExperiments, 0);
    return {
      arm,
      attempts: selected.length,
      uniqueQualifiedFamilies: families.size,
      discoveryUsd: selected.length ? discovery : null,
      experimentUsd: selected.length ? experiment : null,
      qualifiedPerUsd: selected.length && discovery !== null && discovery > 0 ? families.size / discovery : null,
      verifiedBeneficialExperiments: verified,
      beneficialPerTotalUsd: total !== null && total > 0 ? verified / total : null,
      engineerMinutes: selected.reduce((n, r) => n + r.engineerMinutes, 0),
      reviewerMinutes: time('reviewerMinutes'),
      maintenanceMinutes: time('maintenanceMinutes'),
      verdict: 'inconclusive' as const,
    };
  });
}

/** Describe comparability before interpreting differences. Unmatched, absent or
 * uncalibrated arms cannot provide an effect estimate or an automatic winner. */
export function summarizeDreamComparison(input: {
  inputHash: string; rows: readonly DreamEvaluationCost[];
  humanCalibrationRef: string | null;
}) {
  sha.parse(input.inputHash);
  const arms = summarizeDreamEvaluationCosts(input.rows);
  const missingArms = arms.filter(a => !a.attempts).map(a => a.arm);
  const mismatchedInputAttempts = input.rows.filter(r => r.inputHash !== input.inputHash).length;
  return {
    arms, missingArms, mismatchedInputAttempts,
    commonInput: input.rows.length > 0 && mismatchedInputAttempts === 0,
    equalAttemptCounts: missingArms.length === 0 && new Set(arms.map(a => a.attempts)).size === 1,
    equalSpendCaps: missingArms.length === 0 && input.rows.every(r => r.spendCapUsd !== undefined) &&
      new Set(input.rows.map(r => r.spendCapUsd)).size === 1,
    costsComplete: missingArms.length === 0 && arms.every(a => a.discoveryUsd !== null && a.experimentUsd !== null),
    effortComplete: missingArms.length === 0 && arms.every(a => a.reviewerMinutes !== null && a.maintenanceMinutes !== null),
    humanCalibrationRef: input.humanCalibrationRef?.trim() || null,
    humanCalibration: input.humanCalibrationRef?.trim() ? 'referenced-not-independently-verified' as const : 'missing' as const,
    verdict: 'inconclusive' as const,
  };
}

export type DreamBenchmarkVerdict = 'accept' | 'reject' | 'unverified';
export interface DreamBenchmarkLabel {
  id: string;
  split: 'calibration' | 'held-out';
  expected: DreamBenchmarkVerdict;
  class: string;
  evidence: string;
}
export interface DreamBenchmarkJudgment {
  id: string;
  verdict: DreamBenchmarkVerdict;
  evidence: string;
}

/** Descriptive binomial interval. Curated fixtures are not a random population sample. */
export function dreamBenchmarkFraction(numerator: number, denominator: number) {
  if (denominator === 0) return { numerator, denominator, value: null, wilson95: null };
  const value = numerator / denominator,
    z2 = 1.959963984540054 ** 2;
  const scale = 1 + z2 / denominator;
  const center = (value + z2 / (2 * denominator)) / scale;
  const radius = Math.sqrt(z2 * ((value * (1 - value)) / denominator + z2 / (4 * denominator ** 2))) / scale;
  return { numerator, denominator, value, wilson95: [Math.max(0, center - radius), Math.min(1, center + radius)] };
}

/** A receipt is keyed to the frozen case. Missing/unverified cases stay in the denominator.
 * Labels never enter the reviewer callback; callers pass its independent receipts here afterwards. */
export function dreamReviewerConfusion(
  labels: readonly DreamBenchmarkLabel[],
  judgments: readonly DreamBenchmarkJudgment[],
  split: DreamBenchmarkLabel['split'],
) {
  const ids = new Set(labels.map((r) => r.id));
  if (ids.size !== labels.length) throw new Error('Duplicate benchmark labels');
  const byId = new Map<string, DreamBenchmarkJudgment>();
  for (const row of judgments) {
    if (
      !ids.has(row.id) ||
      byId.has(row.id) ||
      !row.evidence.trim() ||
      !['accept', 'reject', 'unverified'].includes(row.verdict)
    )
      throw new Error('Unknown, duplicated or unsupported reviewer receipt');
    byId.set(row.id, row);
  }
  const cases = labels
    .filter((r) => r.split === split)
    .map((label) => {
      if (!label.evidence.trim()) throw new Error('Benchmark label lacks source evidence');
      const judgment = byId.get(label.id);
      return {
        id: label.id,
        class: label.class,
        expected: label.expected,
        observed: judgment?.verdict ?? 'missing',
        correct: judgment?.verdict === label.expected,
        evidence: judgment?.evidence ?? 'No reviewer receipt',
      };
    });
  const positive = cases.filter((c) => c.expected === 'accept');
  const negative = cases.filter((c) => c.expected !== 'accept');
  const fraction = dreamBenchmarkFraction;
  return {
    split,
    cases,
    total: cases.length,
    missing: cases.filter((c) => c.observed === 'missing').length,
    unverified: cases.filter((c) => c.observed === 'unverified').length,
    falseAccept: fraction(negative.filter((c) => c.observed === 'accept').length, negative.length),
    falseReject: fraction(positive.filter((c) => c.observed === 'reject').length, positive.length),
    positiveUnresolved: fraction(
      positive.filter((c) => c.observed === 'missing' || c.observed === 'unverified').length,
      positive.length,
    ),
    exactAgreement: fraction(cases.filter((c) => c.correct).length, cases.length),
    scope: 'curated offline cases; not a population estimate or production-model quality certification',
  };
}
