/**
 * P-007 (plan gitnexus-selective-hardening-and-comparison-2026-09-13, R-6):
 * CONSUMER EVIDENCE for the existing acceptance BAR / rubric outcome.
 *
 * The problem this closes: a substantive change to a shared helper can look
 * "verified" because a graph tool was INVOKED, or because it returned NO callers.
 * Neither is evidence. An invocation says a question was asked; an empty graph
 * answer is a state report, not proof of absence (contracts.ts: isTrustworthyEmpty;
 * selective-assist.ts: `graph-empty`). This module defines the evidence a grader
 * must be able to see before the EXISTING acceptance outcome may stay passing, and
 * the pure rule that turns missing/failed evidence back into the EXISTING
 * non-passing vocabulary (rubric-template.ts: isUnknownRatingEquivalent /
 * isForbiddenMandatoryPassRating) — no new rating scale, no new outcome store.
 *
 * Reuse, not a parallel system:
 *   - the evidence is a plain record a grader attaches to the criterion's existing
 *     rating evidence; this module owns only its SHAPE and the rule over it;
 *   - the producer {@link buildConsumerEvidence} derives the graph-sourced half
 *     from the real `runSelectiveAssist` result (its source re-verification is the
 *     corroboration), so the record cannot disagree with what the assist did;
 *   - the nonpassing mapping is the accepted rating-vocabulary guard, imported.
 *
 * Pure: no I/O, no clock, no dispatch. Tested by consumer-evidence.test.ts (unit)
 * and consumer-evidence.integration.test.ts (real assist + real BAR contract).
 */
import { z } from 'zod';

import {
  isForbiddenMandatoryPassRating,
  isUnknownRatingEquivalent,
} from '../agent-tools/plans/rubric-template';
import { leadingScaleLabel } from '../rubric-rating-vocabulary';
import type { AssistIntent, AssistOutcome, AssistResult, FallbackRoute } from './selective-assist';

export const CONSUMER_EVIDENCE_SCHEMA_VERSION = 1 as const;

/** How a consumer was independently confirmed against CURRENT source (never the graph). */
export const CONSUMER_CORROBORATION_ROUTES = ['source-read', 'rg', 'lsp', 'test'] as const;
export type ConsumerCorroborationRoute = (typeof CONSUMER_CORROBORATION_ROUTES)[number];

const nonEmpty = z.string().trim().min(1).max(500);

export const consumerEvidenceRecordSchema = z
  .object({
    schemaVersion: z.literal(CONSUMER_EVIDENCE_SCHEMA_VERSION),
    /** The shared symbol/change the acceptance outcome is about. */
    subject: z
      .object({ symbol: nonEmpty, path: nonEmpty.nullable(), change: nonEmpty })
      .strict(),
    /** The two identities the consumer list is only meaningful BETWEEN. */
    identity: z
      .object({ indexRevision: nonEmpty.nullable(), sourceRevision: nonEmpty.nullable() })
      .strict(),
    graph: z
      .object({
        invoked: z.boolean(),
        outcome: z.enum([
          'not-invoked',
          'skipped',
          'graph-used',
          'graph-uncorroborated',
          'graph-stale',
          'graph-failed',
          'graph-empty',
        ]),
        /** Graph sites that did NOT hold up against source — never counted as consumers. */
        unverifiedSiteCount: z.number().int().nonnegative().default(0),
      })
      .strict(),
    /** Resolved consumers, each with the non-graph route that confirmed it (null = graph-only). */
    consumers: z
      .array(
        z
          .object({
            path: nonEmpty,
            line1: z.number().int().positive().nullable(),
            corroboratedBy: z.enum(CONSUMER_CORROBORATION_ROUTES).nullable(),
          })
          .strict(),
      )
      .max(500),
    /** Independent non-graph sweeps — the only thing that can back a "no consumers" claim. */
    absenceSweeps: z
      .array(
        z
          .object({
            route: z.enum(['rg', 'lsp']),
            query: nonEmpty,
            matches: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(50),
    behavior: z
      .object({ checked: z.array(nonEmpty).max(200), notChecked: z.array(nonEmpty).max(200) })
      .strict(),
    tests: z
      .array(
        z
          .object({ path: nonEmpty, result: z.enum(['pass', 'fail', 'not-run']) })
          .strict(),
      )
      .max(200),
    fallback: z
      .object({
        route: z.enum(['rg', 'lsp']).nullable(),
        used: z.boolean(),
        reason: nonEmpty.nullable(),
      })
      .strict(),
  })
  .strict();

export type ConsumerEvidenceRecord = z.infer<typeof consumerEvidenceRecordSchema>;

export type ConsumerEvidenceGap =
  | 'record-invalid'
  | 'identity-unbound'
  | 'index-source-mismatch'
  | 'graph-invocation-only'
  | 'consumers-not-resolved'
  | 'consumers-uncorroborated'
  | 'sweep-contradicts-graph'
  | 'graph-unusable-uncompensated'
  | 'behavior-unchecked'
  | 'behavior-partially-unchecked'
  | 'tests-missing'
  | 'tests-not-run'
  | 'tests-failing'
  | 'fallback-undeclared';

/**
 * `verified`   — every required evidence element is present and consistent;
 * `unverified` — evidence is missing, partial, stale or contradicted (UNKNOWN);
 * `failed`     — evidence affirmatively shows the change is NOT acceptable.
 */
export type ConsumerEvidenceVerdict = 'verified' | 'unverified' | 'failed';

export interface ConsumerEvidenceGapFinding {
  readonly gap: ConsumerEvidenceGap;
  readonly detail: string;
}

export interface ConsumerEvidenceEvaluation {
  readonly verdict: ConsumerEvidenceVerdict;
  readonly gaps: readonly ConsumerEvidenceGapFinding[];
}

// Same prefix rule as selective-assist's (unexported) sameCommit: >= 7 hex chars.
function sameRevision(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
}

/**
 * The ONE rule. A graph invocation and an empty graph answer are NEVER sufficient;
 * every element below must hold for `verified`. Accepts `unknown` so a record read
 * back from stored evidence is validated, never trusted.
 */
export function evaluateConsumerEvidence(input: unknown): ConsumerEvidenceEvaluation {
  const parsed = consumerEvidenceRecordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      verdict: 'unverified',
      gaps: [
        {
          gap: 'record-invalid',
          detail: `the consumer-evidence record does not match schema v${CONSUMER_EVIDENCE_SCHEMA_VERSION}: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
            .join('; ')}`,
        },
      ],
    };
  }
  const r = parsed.data;
  const gaps: ConsumerEvidenceGapFinding[] = [];
  const add = (gap: ConsumerEvidenceGap, detail: string) => gaps.push({ gap, detail });

  const { indexRevision, sourceRevision } = r.identity;
  // An index revision exists only when the graph actually ANSWERED; a failed / never-invoked
  // graph has none to bind, and the existing route's evidence needs only the source revision.
  const graphAnswered = !['graph-failed', 'not-invoked', 'skipped'].includes(r.graph.outcome);
  if (!sourceRevision || (graphAnswered && !indexRevision)) {
    add(
      'identity-unbound',
      'source revision (and the index revision, when the graph answered) must be recorded: a consumer list is only meaningful bound to the revision it was read at',
    );
  } else if (graphAnswered && indexRevision && !sameRevision(indexRevision, sourceRevision)) {
    add(
      'index-source-mismatch',
      `index revision ${indexRevision.slice(0, 12)} is not source revision ${sourceRevision.slice(0, 12)}: the graph consumer list is stale evidence`,
    );
  }

  const corroborated = r.consumers.filter((c) => c.corroboratedBy !== null);
  const uncorroborated = r.consumers.filter((c) => c.corroboratedBy === null);
  const zeroSweeps = r.absenceSweeps.filter((s) => s.matches === 0);
  const hitSweeps = r.absenceSweeps.filter((s) => s.matches > 0);
  const independent = corroborated.length > 0 || zeroSweeps.length > 0;

  if (!independent) {
    if (r.graph.invoked) {
      add(
        'graph-invocation-only',
        'a graph tool was invoked but nothing independent backs the answer: an invocation, or an empty/uncorroborated graph answer, is not consumer evidence — corroborate each consumer against current source, or run an independent rg/lsp sweep',
      );
    } else {
      add('consumers-not-resolved', 'no consumer was resolved and no independent sweep was run');
    }
  }
  if (uncorroborated.length > 0) {
    add(
      'consumers-uncorroborated',
      `${uncorroborated.length} consumer(s) are graph-only and were not confirmed against current source (${uncorroborated
        .slice(0, 3)
        .map((c) => c.path)
        .join(', ')})`,
    );
  }
  if (r.consumers.length === 0 && hitSweeps.length > 0) {
    add(
      'sweep-contradicts-graph',
      `no consumer was listed but an independent sweep matched (${hitSweeps
        .slice(0, 3)
        .map((s) => `${s.route} \`${s.query}\` x${s.matches}`)
        .join('; ')}): the consumer set is incomplete`,
    );
  }

  const graphUnusable = r.graph.outcome === 'graph-failed' || r.graph.outcome === 'graph-stale';
  if (graphUnusable && !(r.fallback.used && r.fallback.route !== null)) {
    add(
      'graph-unusable-uncompensated',
      `the graph answered ${r.graph.outcome} and the existing route was not used to compensate`,
    );
  }

  if (r.behavior.checked.length === 0) {
    add('behavior-unchecked', 'no behavior is recorded as checked');
  }
  if (r.behavior.notChecked.length > 0) {
    add(
      'behavior-partially-unchecked',
      `${r.behavior.notChecked.length} behavior(s) are declared NOT checked (${r.behavior.notChecked
        .slice(0, 3)
        .join('; ')}): a mandatory outcome stays nonpassing while any is open`,
    );
  }

  const failing = r.tests.filter((t) => t.result === 'fail');
  const notRun = r.tests.filter((t) => t.result === 'not-run');
  if (r.tests.length === 0) add('tests-missing', 'no test is recorded as evidence');
  if (notRun.length > 0) add('tests-not-run', `${notRun.length} recorded test(s) were not run`);
  if (failing.length > 0) {
    add('tests-failing', `${failing.length} recorded test(s) failed: ${failing.slice(0, 3).map((t) => t.path).join(', ')}`);
  }

  if (r.fallback.route === null) {
    add('fallback-undeclared', 'the existing fallback route (rg / lsp) is not declared');
  }

  const verdict: ConsumerEvidenceVerdict = failing.length > 0 ? 'failed' : gaps.length > 0 ? 'unverified' : 'verified';
  return { verdict, gaps };
}

export interface ConsumerEvidenceBuildContext {
  /** Current source revision (git HEAD) the assist ran at. */
  readonly sourceRevision: string | null;
  readonly behavior: { readonly checked: readonly string[]; readonly notChecked: readonly string[] };
  readonly tests: ReadonlyArray<{ path: string; result: 'pass' | 'fail' | 'not-run' }>;
  /** Independent non-graph sweeps the caller ran. */
  readonly absenceSweeps?: ReadonlyArray<{ route: 'rg' | 'lsp'; query: string; matches: number }>;
  /** Whether the work route actually continued on the existing fallback. */
  readonly fallbackUsed?: boolean;
  readonly fallbackReason?: string | null;
}

/**
 * Derive the record from a REAL selective-assist result. Only sites that
 * `runSelectiveAssist` re-verified against current source become consumers, and
 * only for a consumer-bearing op (callers); a `symbol` lookup returns DEFINITION
 * sites, which are not consumers. Graph sites that failed re-verification are
 * counted, never listed. `skipped` means the graph was never invoked.
 */
export function buildConsumerEvidence(
  intent: AssistIntent,
  result: AssistResult,
  ctx: ConsumerEvidenceBuildContext,
): ConsumerEvidenceRecord {
  const op = result.decision.plan?.op ?? null;
  const consumerBearing = op !== null && op !== 'symbol';
  const consumers =
    result.outcome === 'graph-used' && consumerBearing
      ? result.verifiedSites.map((s) => ({
          path: s.path,
          line1: s.line1,
          corroboratedBy: 'source-read' as const,
        }))
      : [];
  const outcome: AssistOutcome | 'not-invoked' = result.decision.assist === 'none' ? 'not-invoked' : result.outcome;
  const fallbackRoute: FallbackRoute | null = result.decision.fallback ?? null;
  return consumerEvidenceRecordSchema.parse({
    schemaVersion: CONSUMER_EVIDENCE_SCHEMA_VERSION,
    subject:
      intent.kind === 'change'
        ? { symbol: intent.symbol, path: intent.path, change: intent.change }
        : { symbol: intent.query, path: null, change: 'navigate' },
    identity: {
      indexRevision: result.answer?.freshness.indexedCommit ?? null,
      sourceRevision: ctx.sourceRevision,
    },
    graph: {
      invoked: outcome !== 'not-invoked' && outcome !== 'skipped',
      outcome,
      unverifiedSiteCount: result.unverifiedSites.length,
    },
    consumers,
    absenceSweeps: [...(ctx.absenceSweeps ?? [])],
    behavior: { checked: [...ctx.behavior.checked], notChecked: [...ctx.behavior.notChecked] },
    tests: ctx.tests.map((t) => ({ path: t.path, result: t.result })),
    fallback: {
      route: fallbackRoute,
      used: ctx.fallbackUsed ?? false,
      reason: ctx.fallbackReason ?? null,
    },
  });
}

/** Failure labels in preference order: a hard failure outranks the partial "degraded". */
const FAILURE_TOKEN_ORDER = ['failed', 'fail', 'failing', 'broken', 'error', 'degraded'] as const;

function token(value: string): string {
  return leadingScaleLabel(value).replace(/[\s_]+/g, '-');
}

export interface ConsumerRatingGateInput {
  /** The rating the grader proposes for the consumer-evidence criterion. */
  readonly proposedRating: string;
  /** The criterion's declared satisfying labels (its passRatings). */
  readonly passRatings: readonly string[];
  /** The rubric's full ratingScale (entries may carry inline definitions). */
  readonly ratingScale: readonly string[];
  /** The stored consumer-evidence record (validated here, never trusted). */
  readonly record: unknown;
}

export interface ConsumerRatingGateResult {
  /** The rating that may stand. `null` = the scale has no honest nonpassing label: refuse the card. */
  readonly rating: string | null;
  readonly downgraded: boolean;
  readonly evaluation: ConsumerEvidenceEvaluation;
}

/**
 * Keeps the EXISTING acceptance outcome nonpassing when the evidence does not
 * support a pass. It only ever moves a rating DOWN: a proposed unknown/failing
 * rating is returned as-is, and `verified` evidence returns the proposal unchanged.
 * An unverified record maps to the scale's unknown-equivalent label; a failed one to
 * its failure label (else unknown). A mandatory failure/unknown can therefore never
 * satisfy the BAR because the label it lands on is one isForbiddenMandatoryPassRating
 * already refuses as a pass rating.
 */
export function gateConsumerRating(input: ConsumerRatingGateInput): ConsumerRatingGateResult {
  const evaluation = evaluateConsumerEvidence(input.record);
  const proposed = token(input.proposedRating);
  const isPass =
    input.passRatings.some((p) => token(p) === proposed) && !isForbiddenMandatoryPassRating(leadingScaleLabel(input.proposedRating));
  if (evaluation.verdict === 'verified' || !isPass) {
    return { rating: input.proposedRating, downgraded: false, evaluation };
  }
  const unknown = input.ratingScale.find((e) => isUnknownRatingEquivalent(e)) ?? null;
  let failure: string | null = null;
  for (const wanted of FAILURE_TOKEN_ORDER) {
    failure = input.ratingScale.find((e) => token(e) === wanted) ?? null;
    if (failure !== null) break;
  }
  const rating = evaluation.verdict === 'failed' ? (failure ?? unknown) : unknown;
  return { rating, downgraded: true, evaluation };
}

/**
 * Code-owned METHOD text for a BAR whose outcome is a substantive shared-code
 * change. Pinned to the record schema by tests so the prose cannot drift from the
 * rule it describes.
 */
export const CONSUMER_EVIDENCE_METHOD_TERMS = [
  'index revision',
  'source revision',
  'resolved consumers',
  'corroborat',
  'behavior checked',
  'behavior not checked',
  'tests',
  'fallback',
] as const;

export const CONSUMER_EVIDENCE_METHOD =
  'Attach a consumer-evidence record to the rating evidence: the index revision and source revision it was read at; ' +
  'the resolved consumers, each corroborated against current source (source-read/rg/lsp/test) — a graph-only consumer does not count; ' +
  'independent rg/lsp sweeps for any no-consumers claim; behavior checked and behavior not checked; the tests run with their results; ' +
  'and the fallback route used. A graph invocation, or zero callers from the graph alone, does not satisfy the outcome. ' +
  'Any missing, stale, contradicted or unchecked element keeps a mandatory outcome nonpassing (unknown); a failing test is failed.';
