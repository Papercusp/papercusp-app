/**
 * deprecate-learnings.ts — the Queen↔Scout loop's "a dead draft still produces
 * fuel" seam (queen-scout-feedback-loop-2026-06-20 P-006 / brief B10, D-002).
 *
 * When the loop concludes a routed DRAFT plan won't reach `ready`, it DEPRECATES
 * the draft (supersedes it) AND emits a structured, SOURCE-TAGGED *learnings*
 * OBSERVATION — what was tried / why it stalled / what's salvageable — into the
 * observation lane. That observation re-enters Scout's corpus-digest
 * (`readObservationItems` → `friction()` lane in corpus-digest-deps.ts), so a
 * future cycle can re-ideate a better-framed draft from the salvage instead of
 * hitting the same dead end. The loop stays CLOSED — no waste (D-002).
 *
 * REUSE-FIRST (agents-reuse-first-default-2026-06-20 + queen-scout D-001 "ride on
 * existing rails, no new table/mechanism"): a thin COMPOSER over the shared
 * observation writer {@link captureImprovement} (lane:'observation') and the
 * canonical {@link StructuredObservation} shape (rubric-driven-observations
 * P-001 / D-003, owned by observation-types.ts). It introduces no storage and no
 * schema — it only SHAPES the capture input. The builder is PURE (unit-testable
 * without PG); only {@link emitDeprecateLearnings} touches the writer (injectable).
 *
 * SOURCE-TAGGING rides the EXISTING axes:
 *  - `scope: 'harness:<sourceHive>'` is what `issueToCandidate` maps to
 *    `candidate.scope`, which the digest's per-Hive lens
 *    (`readObservationItems({ harnessScopes })`) already filters on; AND
 *  - `payload.observation.sourceHive` (camelCase) is the typed-column source for
 *    structured-observation v2 (B1) — written here NOW so B1's schema backfills
 *    from it (one coherent extension, not a fork — rubric D-002 convergence,
 *    casing confirmed camelCase with the schema owner).
 *
 * Free-text learnings stay FIRST-CLASS and the permanent fallback; the
 * rubric-graded fields (`rubricRef`/`ratings`) are an optional ADDITION
 * (queen-scout D-003 #6) and pass straight to the v2 evidence gate.
 */

import {
  captureImprovement,
  type CaptureImprovementInput,
  type CaptureImprovementResult,
} from './capture-core';
import {
  assertFact,
  resolveFactFederationSlug,
  FACT_BODY_MAX_CHARS,
  type AssertFactInput,
} from '../../agent-facts/store';
import type { ObservationRatings, StructuredObservation } from './observation-types';

/**
 * The free-text learnings salvaged from a deprecated draft — the three prose
 * fields P-006 names. Each is plain text (free-text is the default + permanent
 * fallback per queen-scout D-003 #6); a future rubric-graded addition rides the
 * optional `rubricRef`/`ratings` on {@link DeprecateLearningsInput}.
 */
export interface DeprecateLearnings {
  /** What approach / premise was attempted on the draft. */
  tried: string;
  /** Why it stalled — the reason it won't reach `ready`. */
  stalled: string;
  /** What's salvageable — the reusable signal a future cycle can re-ideate from. */
  salvageable: string;
}

/**
 * Who concluded the draft won't reach ready. Either party may deprecate
 * (queen-scout D-002): the Queen (the reviewer/gate) or the Scout (self-deprecate
 * mid-revision on a flawed premise). A manual/su deprecation acts as the owner.
 */
export type DeprecatedByRole = 'Queen' | 'Scout' | 'owner';

/** The `sourceRole` the observation is filed under (capture-core's vocabulary). */
function sourceRoleOf(by: DeprecatedByRole): 'Queen' | 'Scout' | 'human' {
  return by === 'owner' ? 'human' : by;
}

export interface DeprecateLearningsInput {
  /** The draft plan being deprecated (its slug). */
  planSlug: string;
  /** Who concluded the draft won't reach ready (D-002). */
  deprecatedBy: DeprecatedByRole;
  /** The free-text learnings (the default; D-003 #6). */
  learnings: DeprecateLearnings;
  /**
   * The SOURCE hive the draft belonged to — the source-tag (workspace-scoped
   * P-001 / rubric P-001). At the call site this defaults to the plan's harness
   * slug. Drives both `scope: 'harness:<sourceHive>'` and
   * `payload.observation.sourceHive`.
   */
  sourceHive: string;
  /**
   * Optional TARGET hive (`StructuredObservation.targetHive`) when the draft was
   * about a DIFFERENT hive than the one that produced it.
   */
  targetHive?: string;
  /**
   * Grounding refs for the observation (`StructuredObservation.refs`). The
   * deprecated plan ref is always prepended, so passing none still yields a
   * grounded observation.
   */
  evidence?: string[];
  /**
   * Forward-compat rubric-graded addition (queen-scout D-003 #6 — an ADDITION
   * once a fitting rubric exists, never a replacement for free-text). When
   * `ratings` is set, `rubricRef` is required + each rating must carry evidence
   * (the v2 evidence gate, enforced in capture-core).
   */
  rubricRef?: string;
  ratings?: ObservationRatings;
  /** Attribution — the ownerId of the deprecating agent (capture `createdBy`). */
  createdBy?: string;
}

/** The machine-readable observation sub-kind (`payload.deprecateLearnings`). */
export const DEPRECATE_LEARNINGS_OBSERVATION_KIND = 'deprecate-learnings' as const;

/** Flatten whitespace + truncate to `n` chars with an ellipsis (for the title net). */
function oneLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/**
 * PURE: shape a {@link DeprecateLearningsInput} into the
 * {@link CaptureImprovementInput} for a structured, source-tagged learnings
 * observation. No PG, no I/O — exhaustively unit-testable.
 *
 * Invariants the tests pin:
 *  - `lane: 'observation'` + `scope: 'harness:<sourceHive>'` (source-tagged into
 *    the digest's per-Hive lens) + `origin: 'organic'`.
 *  - `force: true` — a deprecation's learnings must NEVER be suppressed as a
 *    near-duplicate (observations skip dedup anyway; belt-and-braces so the "no
 *    dead ends" guarantee holds even if the lane ever gains dedup).
 *  - title carries the stall reason so the digest CLUSTERS recurring dead-ends;
 *    body carries the three free-text fields the ideators read.
 *  - the v2 convergence fields ride `payload.observation` (the canonical
 *    {@link StructuredObservation}, camelCase) so B1's schema backfills its typed
 *    columns from `payload.observation.sourceHive` etc.; the deprecate-specific
 *    metadata rides a sibling `payload.deprecateLearnings` (no collision with the
 *    generic observation shape).
 */
export function buildDeprecateLearningsObservation(
  input: DeprecateLearningsInput,
): CaptureImprovementInput {
  const { planSlug, deprecatedBy, learnings, sourceHive, targetHive, rubricRef, ratings, createdBy } =
    input;
  const planRef = `plan:${planSlug}`;
  // Always ground the observation on the deprecated plan; de-dup the ref list.
  const refs = [planRef, ...(input.evidence ?? [])].filter((v, i, a) => a.indexOf(v) === i);

  const title = `Deprecated draft "${planSlug}": ${oneLine(learnings.stalled, 100)}`;

  const body = [
    `A Mug↔Scout draft plan was deprecated (it will not reach \`ready\`) — recording the`,
    `learnings so a future Scout cycle can re-ideate from the salvage instead of hitting the`,
    `same dead end (queen-scout-feedback-loop D-002, "a dead draft still produces fuel").`,
    ``,
    `- Deprecated plan: ${planSlug}`,
    `- Decided by: ${deprecatedBy}`,
    `- Source hive: ${sourceHive}`,
    ...(targetHive ? [`- Target hive: ${targetHive}`] : []),
    ``,
    `What was tried:`,
    learnings.tried.trim(),
    ``,
    `Why it stalled:`,
    learnings.stalled.trim(),
    ``,
    `What's salvageable:`,
    learnings.salvageable.trim(),
  ].join('\n');

  // The canonical v2 structured observation (observation-types.ts). All v2 fields
  // are camelCase + ride payload.observation (the schema owner's confirmed shape).
  const observation: StructuredObservation = {
    // A deprecated premise is a capability/idea GAP the loop learned about.
    kind: 'gap',
    scope: 'harness',
    confidence: 'med',
    refs,
    sourceHive,
    ...(targetHive ? { targetHive } : {}),
    ...(rubricRef ? { rubricRef } : {}),
    ...(ratings ? { ratings } : {}),
  };

  return {
    title,
    kind: 'change',
    body,
    severity: 'nit',
    scope: `harness:${sourceHive}`,
    lane: 'observation',
    origin: 'organic',
    force: true,
    sourceRole: sourceRoleOf(deprecatedBy),
    ...(createdBy ? { createdBy } : {}),
    payloadExtra: {
      observation,
      // Deprecate-specific metadata — a sibling of the generic observation shape,
      // for the Observations pane / future consumers (the digest clusters on
      // title/body/scope, not these).
      deprecateLearnings: {
        kind: DEPRECATE_LEARNINGS_OBSERVATION_KIND,
        planSlug,
        deprecatedBy,
        ...learnings,
      },
    },
  };
}

/** The stable fact-key prefix negative-result facts upsert under (F1-3). */
export const NEGATIVE_RESULT_FACT_PREFIX = 'negative-result/' as const;

/** Negative results should outlive the 7d fact default — a dead end stays dead.
 *  90d = the facts TTL ceiling; a re-deprecation re-asserts (refreshes) it. */
export const NEGATIVE_RESULT_FACT_TTL_SEC = 90 * 24 * 3600;

/**
 * PURE (F1-3, federated-scout-gym-learning-2026-07-02 P-005): shape the salvage
 * learnings into a SHAREABLE standing fact — the negative-result op that rides
 * the F1-1 agent_facts federation rail so the NETWORK stops re-trying this dead
 * end (D-001: negative results are the cheapest highest-leverage share).
 *
 * Deliberate choices the tests pin:
 *  - `shareable: true` — the one observation class that federates BY DEFAULT
 *    (owner-ratified D-006: a dead end leaks no capability, only a warning).
 *  - key `negative-result/<planSlug>` (≤120 chars) — re-deprecating the same
 *    draft refreshes ONE fact, never accretes duplicates.
 *  - body budgets tried/stalled/salvageable into the FACT_BODY_MAX_CHARS cap
 *    (stalled first — it is the "don't go here" signal peers act on). Named,
 *    never a literal: this comment said "500-char" and went stale when the cap
 *    moved to 1200, and the matching hardcoded 500 in the test reddened the
 *    green gate for the whole fleet (WI-5945).
 *  - `potHomeSlug` = the RESOLVED federation slug (member → hive home); the
 *    caller resolves (emit does it via {@link resolveFactFederationSlug}).
 */
export function buildNegativeResultFact(
  input: DeprecateLearningsInput,
  potHomeSlug: string | null,
): AssertFactInput {
  const { planSlug, learnings } = input;
  const key = `${NEGATIVE_RESULT_FACT_PREFIX}${planSlug}`.slice(0, 120);
  const head = `Dead end (deprecated draft ${planSlug}). `;
  // Budget the three prose fields into the fact cap, stall-reason first.
  const room = FACT_BODY_MAX_CHARS - head.length;
  const stalled = oneLine(learnings.stalled, Math.floor(room * 0.45));
  const tried = oneLine(learnings.tried, Math.floor(room * 0.25));
  const salvage = oneLine(learnings.salvageable, Math.floor(room * 0.25));
  const body = `${head}Stalled: ${stalled} Tried: ${tried} Salvage: ${salvage}`.slice(
    0,
    FACT_BODY_MAX_CHARS,
  );
  return {
    scope: 'harness',
    scopeRef: input.sourceHive,
    key,
    body,
    sourceRef: `plan:${planSlug}`,
    createdBy: input.createdBy ?? `deprecate:${input.deprecatedBy}`,
    ttlSec: NEGATIVE_RESULT_FACT_TTL_SEC,
    shareable: true,
    ...(potHomeSlug ? { potHomeSlug } : {}),
  };
}

/** Injectable writer seam — unit tests run the emit with a fake captureImprovement. */
export interface DeprecateLearningsDeps {
  captureImprovement: typeof captureImprovement;
  /** F1-3: the negative-result fact writer (the F1-1 federation rail). */
  assertFact: typeof assertFact;
  /** F1-3: member harness → hive home resolution for the fact's federation identity. */
  resolveFactFederationSlug: typeof resolveFactFederationSlug;
}

const defaultDeps: DeprecateLearningsDeps = {
  captureImprovement,
  assertFact,
  resolveFactFederationSlug,
};

/**
 * Emit the structured, source-tagged learnings observation for a deprecated
 * draft — AND (F1-3) the shareable negative-result FACT that federates the
 * dead end over the hive substrate. Thin: builds both inputs and hands them to
 * the shared writers. The fact leg is BEST-EFFORT: the observation (the local
 * "no dead ends" guarantee) must land even when the fact rail hiccups.
 * Callers: the deprecate handler (plans:set-plan-status's superseded path) and
 * a future Scout self-deprecate.
 */
export async function emitDeprecateLearnings(
  input: DeprecateLearningsInput,
  deps: DeprecateLearningsDeps = defaultDeps,
): Promise<CaptureImprovementResult> {
  const result = await deps.captureImprovement(buildDeprecateLearningsObservation(input));
  try {
    const potHomeSlug = await deps.resolveFactFederationSlug(input.sourceHive);
    await deps.assertFact(buildNegativeResultFact(input, potHomeSlug));
  } catch {
    /* best-effort — the observation already landed; the fact re-asserts on a
       future deprecate of the same draft (idempotent key). */
  }
  return result;
}
