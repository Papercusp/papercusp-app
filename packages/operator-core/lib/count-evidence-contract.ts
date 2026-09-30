/**
 * A dependency-light identity for counts that may be quoted, persisted, or
 * compared outside the producer that measured them.
 *
 * The value is deliberately NOT part of the contract. Two observations may
 * differ in value and time while still measuring the same thing; every other
 * dimension below must match before a delta is meaningful.
 */
import { z } from 'zod';

export const COUNT_EVIDENCE_SCHEMA_VERSION = 'count-evidence-v1' as const;

export const COUNT_EVIDENCE_COMPARISON_RULE =
  'compare only identical metric, population, cutoff, status semantics, writer, unit, exactness, zero meaning, and scope; otherwise materialize a named reconciliation transform under one new common contract' as const;

const nonEmpty = z.string().trim().min(1);
const isoDateTime = z.string().datetime({ offset: true });
const nonNegativeInt = z.number().int().nonnegative();

export type CountContractDimension =
  | string
  | number
  | boolean
  | null
  | CountContractDimension[]
  | { [key: string]: CountContractDimension };

const countContractDimensionSchema: z.ZodType<CountContractDimension> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(countContractDimensionSchema),
    z.record(z.string(), countContractDimensionSchema),
  ]),
);

export const countCutoffSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('predicate'),
      field: nonEmpty,
      operator: z.enum(['<', '<=', '>', '>=', '=']),
      value: countContractDimensionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('fixed-set'),
      fingerprint: nonEmpty,
      size: nonNegativeInt,
    })
    .strict(),
  z
    .object({
      kind: z.literal('rolling-window'),
      field: nonEmpty,
      durationMs: z.number().int().positive(),
      end: z.literal('measuredAt'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('absolute-window'),
      field: nonEmpty,
      startAt: isoDateTime,
      endAt: isoDateTime,
      startInclusive: z.boolean(),
      endExclusive: z.boolean(),
    })
    .strict()
    .superRefine((window, ctx) => {
      if (Date.parse(window.endAt) <= Date.parse(window.startAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endAt'],
          message: 'absolute-window endAt must be after startAt',
        });
      }
    }),
]);

export const countExactnessSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('exact') }).strict(),
  z
    .object({
      status: z.literal('bounded'),
      bound: z.enum(['lower', 'upper']),
      limit: z.number().int().positive(),
      reason: nonEmpty,
    })
    .strict(),
  z.object({ status: z.literal('unknown'), reason: nonEmpty }).strict(),
]);

const namedSemanticSchema = z
  .object({
    id: nonEmpty,
    definition: nonEmpty,
  })
  .strict();

export const countEvidenceContractSchema = z
  .object({
    schemaVersion: z.literal(COUNT_EVIDENCE_SCHEMA_VERSION),
    metric: namedSemanticSchema,
    population: z
      .object({
        id: nonEmpty,
        selector: countContractDimensionSchema,
        definition: nonEmpty,
      })
      .strict(),
    cutoff: countCutoffSchema,
    status: namedSemanticSchema,
    writer: z
      .object({
        id: nonEmpty,
        revision: nonEmpty.optional(),
      })
      .strict(),
    unit: namedSemanticSchema,
    exactness: countExactnessSchema,
    zeroMeaning: nonEmpty,
    /**
     * Producer-specific identity that changes membership or semantics. Keep
     * presentation-only fields out: everything here participates in equality.
     */
    scope: z.record(z.string(), countContractDimensionSchema),
    measuredAt: isoDateTime,
    comparisonRule: z.literal(COUNT_EVIDENCE_COMPARISON_RULE),
  })
  .strict();

export const countEvidenceSchema = z
  .object({
    value: nonNegativeInt,
    contract: countEvidenceContractSchema,
  })
  .strict();

/**
 * Compact wire form for a producer that publishes several counts over one
 * snapshot. The population identity is carried once; each metric contributes
 * only the three semantic fields that legitimately differ. Materialize one
 * metric before comparison with {@link materializeCountEvidence}.
 */
export const countEvidenceContractBaseSchema = countEvidenceContractSchema.omit({
  metric: true,
  status: true,
  exactness: true,
  zeroMeaning: true,
});

export const countEvidenceMetricSchema = z
  .object({
    value: nonNegativeInt,
    metric: namedSemanticSchema,
    status: namedSemanticSchema,
    exactness: countExactnessSchema,
    zeroMeaning: nonEmpty,
  })
  .strict();

export const countEvidenceBundleSchema = z
  .object({
    contract: countEvidenceContractBaseSchema,
    metrics: z.record(z.string().min(1), countEvidenceMetricSchema),
  })
  .strict();

export type CountCutoff = z.infer<typeof countCutoffSchema>;
export type CountExactness = z.infer<typeof countExactnessSchema>;
export type CountEvidenceContract = z.infer<typeof countEvidenceContractSchema>;
export type CountEvidence = z.infer<typeof countEvidenceSchema>;
export type CountEvidenceContractBase = z.infer<typeof countEvidenceContractBaseSchema>;
export type CountEvidenceMetric = z.infer<typeof countEvidenceMetricSchema>;
export type CountEvidenceBundle = z.infer<typeof countEvidenceBundleSchema>;

export function materializeCountEvidence(bundle: unknown, metricKey: string): CountEvidence | null {
  // Producers may extend the bundle with interpretation metadata (for example,
  // burn_down.populationState). Compare only the canonical contract + metrics
  // instead of making every additive producer field part of this parser.
  if (!isRecord(bundle)) return null;
  const parsed = countEvidenceBundleSchema.safeParse({
    contract: bundle.contract,
    metrics: bundle.metrics,
  });
  if (!parsed.success) return null;
  const metric = parsed.data.metrics[metricKey];
  if (!metric) return null;
  return countEvidenceSchema.parse({
    value: metric.value,
    contract: {
      ...parsed.data.contract,
      metric: metric.metric,
      status: metric.status,
      exactness: metric.exactness,
      zeroMeaning: metric.zeroMeaning,
    },
  });
}

export interface CountContractMismatch {
  path: string;
  leftPresent: boolean;
  rightPresent: boolean;
  left: CountContractDimension | null;
  right: CountContractDimension | null;
}

export type CountContractComparison =
  | {
      comparable: true;
      mismatches: [];
      comparisonRule: typeof COUNT_EVIDENCE_COMPARISON_RULE;
    }
  | {
      comparable: false;
      mismatches: CountContractMismatch[];
      reason: string;
      recoverVia: string;
      comparisonRule: typeof COUNT_EVIDENCE_COMPARISON_RULE;
    };

export type CountEvidenceComparison =
  | (CountContractComparison & {
      comparable: true;
      from: { value: number; measuredAt: string };
      to: { value: number; measuredAt: string };
      delta: number;
    })
  | (CountContractComparison & {
      comparable: false;
      delta: null;
    });

const COMPARISON_DIMENSIONS = [
  'schemaVersion',
  'metric',
  'population',
  'cutoff',
  'status',
  'writer',
  'unit',
  'exactness',
  'zeroMeaning',
  'scope',
  'comparisonRule',
] as const satisfies readonly (keyof CountEvidenceContract)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asDimension(value: unknown): CountContractDimension | null {
  return value === undefined ? null : (value as CountContractDimension);
}

function collectMismatches(
  left: unknown,
  right: unknown,
  path: string,
  out: CountContractMismatch[],
): void {
  if (Object.is(left, right)) return;

  if (Array.isArray(left) && Array.isArray(right)) {
    const size = Math.max(left.length, right.length);
    for (let index = 0; index < size; index += 1) {
      collectMismatches(left[index], right[index], `${path}[${index}]`, out);
    }
    return;
  }

  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      collectMismatches(left[key], right[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }

  out.push({
    path,
    leftPresent: left !== undefined,
    rightPresent: right !== undefined,
    left: asDimension(left),
    right: asDimension(right),
  });
}

function validationMismatches(
  side: 'left' | 'right',
  issues: readonly z.ZodIssue[],
): CountContractMismatch[] {
  return issues.map((issue) => ({
    path: `${side}.${issue.path.map(String).join('.') || '$'}`,
    leftPresent: side === 'left',
    rightPresent: side === 'right',
    left: side === 'left' ? issue.message : null,
    right: side === 'right' ? issue.message : null,
  }));
}

/**
 * Compare only the semantic identity of two count contracts. `measuredAt` is
 * intentionally excluded: it orders observations but does not define their
 * population. Invalid input refuses comparison rather than throwing or
 * degrading to an equality guess.
 */
export function compareCountContracts(left: unknown, right: unknown): CountContractComparison {
  const parsedLeft = countEvidenceContractSchema.safeParse(left);
  const parsedRight = countEvidenceContractSchema.safeParse(right);
  if (!parsedLeft.success || !parsedRight.success) {
    const mismatches = [
      ...(!parsedLeft.success ? validationMismatches('left', parsedLeft.error.issues) : []),
      ...(!parsedRight.success ? validationMismatches('right', parsedRight.error.issues) : []),
    ];
    return {
      comparable: false,
      mismatches,
      reason: 'one or both count contracts are invalid; comparison is refused',
      recoverVia: 're-measure both values through count-contract producers before comparing them',
      comparisonRule: COUNT_EVIDENCE_COMPARISON_RULE,
    };
  }

  const mismatches: CountContractMismatch[] = [];
  for (const field of COMPARISON_DIMENSIONS) {
    collectMismatches(parsedLeft.data[field], parsedRight.data[field], field, mismatches);
  }
  if (mismatches.length > 0) {
    return {
      comparable: false,
      mismatches,
      reason: `count contracts differ on ${mismatches.map((item) => item.path).join(', ')}`,
      recoverVia:
        'apply a named reconciliation transform, re-measure both values under the resulting common contract, then compare those new observations',
      comparisonRule: COUNT_EVIDENCE_COMPARISON_RULE,
    };
  }
  return {
    comparable: true,
    mismatches: [],
    comparisonRule: COUNT_EVIDENCE_COMPARISON_RULE,
  };
}

/** Return a numeric delta only after the contracts pass the fail-closed guard. */
export function compareCountEvidence(left: unknown, right: unknown): CountEvidenceComparison {
  const parsedLeft = countEvidenceSchema.safeParse(left);
  const parsedRight = countEvidenceSchema.safeParse(right);
  if (!parsedLeft.success || !parsedRight.success) {
    const mismatches = [
      ...(!parsedLeft.success ? validationMismatches('left', parsedLeft.error.issues) : []),
      ...(!parsedRight.success ? validationMismatches('right', parsedRight.error.issues) : []),
    ];
    return {
      comparable: false,
      delta: null,
      mismatches,
      reason: 'one or both count observations are invalid; comparison is refused',
      recoverVia: 're-measure both values through count-contract producers before comparing them',
      comparisonRule: COUNT_EVIDENCE_COMPARISON_RULE,
    };
  }

  const contractComparison = compareCountContracts(parsedLeft.data.contract, parsedRight.data.contract);
  if (!contractComparison.comparable) return { ...contractComparison, delta: null };

  return {
    ...contractComparison,
    from: {
      value: parsedLeft.data.value,
      measuredAt: parsedLeft.data.contract.measuredAt,
    },
    to: {
      value: parsedRight.data.value,
      measuredAt: parsedRight.data.contract.measuredAt,
    },
    delta: parsedRight.data.value - parsedLeft.data.value,
  };
}
