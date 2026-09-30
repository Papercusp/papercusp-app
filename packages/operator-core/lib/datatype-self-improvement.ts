/**
 * datatype-self-improvement — the REQUIRED self-improvement surface of a datatype
 * (reflexive-platform-extensibility-datatypes-2026-06-24 P-010, design D-001).
 *
 * D-001: model domains live ON the self-improvement substrate — a datatype is
 * "self-improvable BY CONSTRUCTION". To declare an AUTHORITATIVE datatype (one
 * Papercusp itself authors + improves) you must say three things up front:
 *
 *   1. improvements — the TAXONOMY of axes along which an instance can be improved
 *      (e.g. for `bet`: tighten-thesis, add-calibration, widen-evidence).
 *   2. scorecard   — the rubric of scored quality dimensions (e.g. thesis-clarity,
 *      evidence-count, calibration-accuracy).
 *   3. gym         — the self-improvement loop's training SIGNALS + the RUBRIC by
 *      which a proposed improvement is judged a win.
 *
 * This is the policy half of `meta:define-datatype` (declare.ts): a pure, exhaustively
 * unit-testable decider so the tool handler stays thin and the rule is provable without
 * a DB. The persisted shape is the validated object (stored as `self_improvement` JSONB
 * by datatype-registry-store).
 *
 * Server-or-bundle-safe: pure zod + types, no I/O.
 */
import { z } from 'zod';
import type { DatatypeTier } from './datatype-registry-store';

/** One axis along which an INSTANCE of the datatype can be improved (improvements taxonomy). */
export const ImprovementAxisSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .describe('stable kebab taxonomy key for the improvement axis (e.g. "tighten-thesis")'),
  description: z.string().min(1).max(500).describe('what improving along this axis does'),
});

/** One scored dimension of an instance's quality (the scorecard rubric). */
export const ScorecardMetricSchema = z.object({
  metric: z.string().min(1).max(80).describe('stable metric key (e.g. "thesis-clarity")'),
  description: z.string().min(1).max(500).describe('what this metric measures'),
  weight: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('relative weight 0..1 (optional; equal-weight when omitted)'),
});

/** The self-improvement GYM: the signals the improver trains on + how an attempt is judged. */
export const GymSchema = z.object({
  signals: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(32)
    .describe('the feedback signals the gym trains on (e.g. "realized P&L vs forecast")'),
  rubric: z
    .string()
    .min(1)
    .max(2000)
    .describe("how a proposed improvement is judged a win (the gym's evaluation rubric)"),
});

/**
 * The REQUIRED self-improvement surface (P-010). All three legs are mandatory once a
 * surface is supplied — a partial surface (e.g. a scorecard with no gym) is rejected, so
 * "self-improvable" can't be half-declared.
 */
export const SelfImprovementSurfaceSchema = z.object({
  improvements: z
    .array(ImprovementAxisSchema)
    .min(1)
    .max(64)
    .describe('the taxonomy of improvement axes for an instance (≥1)'),
  scorecard: z
    .array(ScorecardMetricSchema)
    .min(1)
    .max(64)
    .describe('the scored quality dimensions (≥1)'),
  gym: GymSchema,
});
export type SelfImprovementSurface = z.infer<typeof SelfImprovementSurfaceSchema>;

/**
 * Which tiers MUST carry a self-improvement surface. AUTHORITATIVE datatypes
 * (generic-kind, first-class) — the ones Papercusp itself authors and improves — are
 * required to be self-improvable by construction. A `projection` is read-only: an
 * EXTERNAL engine is its single writer (D-008), so Papercusp can't run an improvement
 * gym over it, and the surface is OPTIONAL there (a scorecard may still be supplied for
 * display/calibration, and is validated when present).
 */
export function requiresSelfImprovement(tier: DatatypeTier): boolean {
  return tier === 'generic-kind' || tier === 'first-class';
}

/** A compact, copy-pasteable hint of the expected shape, embedded in the error reply. */
export const SELF_IMPROVEMENT_EXPECTED_SHAPE = {
  improvements: [{ id: 'kebab-axis-key', description: 'what improving along this axis does' }],
  scorecard: [{ metric: 'metric-key', description: 'what it measures', weight: 0.5 }],
  gym: { signals: ['a feedback signal'], rubric: 'how a proposed improvement is judged a win' },
} as const;

export type SelfImprovementCheck =
  | { ok: true; value: Record<string, unknown> | null }
  | {
      ok: false;
      reason: 'self_improvement_required' | 'self_improvement_invalid';
      message: string;
      expectedShape: typeof SELF_IMPROVEMENT_EXPECTED_SHAPE;
      issues?: string[];
    };

/**
 * The pure declare-time policy for the self-improvement surface (P-010).
 *
 *   - A supplied surface (ANY tier) must be well-formed — a malformed/partial one is
 *     `self_improvement_invalid`.
 *   - An AUTHORITATIVE tier with NO surface is `self_improvement_required` — UNLESS this
 *     is an in-place update of a row that already has one (`existingValue`), which is
 *     PRESERVED (mirrors the store's keep-the-embedding-when-none-supplied rule, so a
 *     metadata-only re-declare needn't re-send the whole surface).
 *   - A `projection` with no surface is fine (value `null`).
 *
 * `value` is what the store should persist for `self_improvement` (validated new surface,
 * preserved existing surface, or null). Pure — no I/O.
 */
export function checkSelfImprovementForDeclare(
  tier: DatatypeTier,
  raw: unknown,
  existingValue?: Record<string, unknown> | null,
): SelfImprovementCheck {
  if (raw != null) {
    const parsed = SelfImprovementSurfaceSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      return {
        ok: false,
        reason: 'self_improvement_invalid',
        message: `the self-improvement surface is malformed — ${issues.join('; ')}`,
        expectedShape: SELF_IMPROVEMENT_EXPECTED_SHAPE,
        issues,
      };
    }
    return { ok: true, value: parsed.data };
  }
  // No surface supplied.
  if (existingValue != null) return { ok: true, value: existingValue }; // preserve on update
  if (requiresSelfImprovement(tier)) {
    return {
      ok: false,
      reason: 'self_improvement_required',
      message:
        `tier "${tier}" datatypes must declare a self-improvement surface (P-010): an improvements ` +
        'taxonomy + a scorecard + a gym (signals + rubric). A datatype is self-improvable by construction.',
      expectedShape: SELF_IMPROVEMENT_EXPECTED_SHAPE,
    };
  }
  return { ok: true, value: null };
}
