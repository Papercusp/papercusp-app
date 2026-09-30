/** Data-backed context-headroom decision for prior-attempt claim enrichment (P-015/D-011). */

export interface PriorAttemptMeasurementSample {
  estimatedTokens: number;
  serializedChars: number;
  latencyMs: number;
  omittedRecords: number;
  authorityRefs: number;
  expectedAuthorityRefs: number;
  residueRefs: number;
  expectedResidueRefs: number;
}

export interface PriorAttemptMeasurementOptions {
  fleetMemberLimit: number;
  inputPerMtokUsd: number;
  cacheReadPerMtokUsd: number;
  /** Minimum average share of the current member limit that warrants changing
   * a fleet-wide role cap. Default 5%; also subject to a 10k absolute floor. */
  materialShare?: number;
}

export interface PriorAttemptMeasurement {
  sampleCount: number;
  averageTokens: number;
  p95Tokens: number;
  maxTokens: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  truncationRate: number;
  averageOmittedRecords: number;
  authorityRefFidelity: number;
  residueRefFidelity: number;
  averageCompactionPressure: number;
  p95CompactionPressure: number;
  inputCostUsdPerClaim: number;
  cacheReadCostUsdPerClaim: number;
  recommendation:
    | { action: 'keep'; currentLimit: number; materialThresholdTokens: number; reason: string }
    | { action: 'increase'; currentLimit: number; increaseTokens: number; proposedLimit: number; materialThresholdTokens: number; reason: string };
}

function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Quantify claim-context growth and decide whether it is large enough to alter
 * the fleet-member role cap.  D-011's example maps an observed average +40k to
 * approximately +40k; this rounds a material average up to the next 10k.  A
 * sub-5%/sub-10k average stays within the existing runway rather than quietly
 * raising every member's per-turn cache spend.
 */
export function measurePriorAttemptContext(
  samples: readonly PriorAttemptMeasurementSample[],
  options: PriorAttemptMeasurementOptions,
): PriorAttemptMeasurement {
  const count = samples.length;
  const average = (field: keyof PriorAttemptMeasurementSample): number =>
    count ? samples.reduce((sum, sample) => sum + sample[field], 0) / count : 0;
  const averageTokens = Math.round(average('estimatedTokens'));
  const p95Tokens = percentile(samples.map((sample) => sample.estimatedTokens), 0.95);
  const maxTokens = Math.max(0, ...samples.map((sample) => sample.estimatedTokens));
  const averageLatencyMs = Math.round(average('latencyMs'));
  const p95LatencyMs = percentile(samples.map((sample) => sample.latencyMs), 0.95);
  const materialThresholdTokens = Math.max(
    10_000,
    Math.ceil((options.fleetMemberLimit * (options.materialShare ?? 0.05)) / 1_000) * 1_000,
  );
  const material = averageTokens >= materialThresholdTokens;
  const increaseTokens = Math.ceil(averageTokens / 10_000) * 10_000;
  return {
    sampleCount: count,
    averageTokens,
    p95Tokens,
    maxTokens,
    averageLatencyMs,
    p95LatencyMs,
    truncationRate: ratio(samples.filter((sample) => sample.omittedRecords > 0).length, count),
    averageOmittedRecords: Number(average('omittedRecords').toFixed(2)),
    authorityRefFidelity: ratio(
      samples.reduce((sum, sample) => sum + sample.authorityRefs, 0),
      samples.reduce((sum, sample) => sum + sample.expectedAuthorityRefs, 0),
    ),
    residueRefFidelity: ratio(
      samples.reduce((sum, sample) => sum + sample.residueRefs, 0),
      samples.reduce((sum, sample) => sum + sample.expectedResidueRefs, 0),
    ),
    averageCompactionPressure: ratio(averageTokens, options.fleetMemberLimit),
    p95CompactionPressure: ratio(p95Tokens, options.fleetMemberLimit),
    inputCostUsdPerClaim: (averageTokens / 1_000_000) * options.inputPerMtokUsd,
    cacheReadCostUsdPerClaim: (averageTokens / 1_000_000) * options.cacheReadPerMtokUsd,
    recommendation: material
      ? {
          action: 'increase',
          currentLimit: options.fleetMemberLimit,
          increaseTokens,
          proposedLimit: options.fleetMemberLimit + increaseTokens,
          materialThresholdTokens,
          reason: `average incremental context ${averageTokens} tokens meets the ${materialThresholdTokens}-token materiality threshold`,
        }
      : {
          action: 'keep',
          currentLimit: options.fleetMemberLimit,
          materialThresholdTokens,
          reason: `average incremental context ${averageTokens} tokens is below the ${materialThresholdTokens}-token materiality threshold`,
        },
  };
}
