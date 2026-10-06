/** scorecards:evaluate — typed rubric skeleton + deterministic evidence delta. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { getRubricWithoutSeeding, readRubricPlanRevision } from '../../rubrics';
import {
  normalizeScorecardRatings,
  validateObservationRatings,
  validateScorecardCompleteness,
  validateScorecardRatingValues,
  validateScorecardPoorRatingDisposition,
  ObservationEvidenceError,
  type ObservationRatings,
} from '../../harness/improvements/observation-types';
import {
  listScorecards,
  evaluateScorecardInstrumentContract,
  resolveScorecardReleaseGateBinding,
  scorecardRatingsClaimPass,
  scorecardEvidenceFingerprint,
  validateRubricRatingContracts,
  computeWorkOnEverythingRollup,
  resolveScorecardInstrumentSnapshots,
  type ScorecardInstrumentSnapshot,
} from '../../scorecards';
import { activeWorkspaceId } from '../../workspace-registry';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { resolveAcceptanceGraderEligibility } from './grader-eligibility';
import { readAndEvaluateAcceptanceBarLifecycle } from '../../acceptance-bar-lifecycle-evaluator';

export const scorecardRatingEntrySchema = z
  .object({
    rating: z.string().min(1),
    evidence: z.string().min(1),
    evidenceRef: z.string().min(1).max(500).optional(),
    evidenceKind: z.string().min(1).max(80).optional(),
    positiveControlRef: z.string().min(1).max(500).optional(),
    absenceClaim: z.boolean().optional(),
    unknownReason: z
      .enum([
        'idle',
        'not-exercised',
        'instrument-unavailable',
        'retention-gap',
        'generation-mismatch',
        'external-capacity',
        'scope-mismatch',
        'other',
      ])
      .optional(),
    attribution: z.enum(['subject', 'system', 'instrument', 'environment', 'ambiguous']).optional(),
    nextEvidenceAction: z.string().min(1).max(1000).optional(),
    suggestion: z.string().min(1).max(2000).optional(),
    /** Poor-rating disposition (owner-directed 2026-08-31): the WI-/EI-/F- item a
     *  fail/severe/broken/degraded/partial rating's remediation is tracked by. */
    remediation: z.string().min(2).max(300).optional(),
    /** The explicit alternative: a reasoned decision NOT to act (≥10 chars). */
    disregard: z.string().min(10).max(600).optional(),
  })
  .strict();

export const scorecardInstrumentSnapshotSchema = z
  .object({
    verdict: z.enum(['pass', 'fail', 'unknown']),
    measuredAt: z.string().min(1),
    window: z.record(z.string(), z.unknown()).optional(),
    value: z.unknown().optional(),
    evidenceRef: z.string().min(1).max(500).optional(),
    provenance: z
      .enum(['self-reported', 'platform-computed'])
      .optional()
      .describe(
        "WHO measured this. Omitted means 'self-reported' — you derived and typed the number " +
          'yourself, which is what every snapshot on this path is today. Only a deterministic ' +
          "platform instrument may claim 'platform-computed'. The contract's verdict-mismatch " +
          'check compares your rating to THIS snapshot, so on a self-reported one it is testing ' +
          'you against yourself, not measuring anything.',
      ),
  })
  .strict();

export const scorecardTestedShaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,64}$/i)
  .describe(
    'Commit SHA the supplied ratings actually tested. Required when a releaseGating rubric contains any pass-like rating; evaluate proves it is both the fresh green pin and current staging HEAD.',
  );

export const scorecardEvaluateArgs = z
  .object({
    rubricRef: z.string().min(1).max(120),
    sourceHive: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Restrict to the hive that produced/filed the scorecard (normally the caller/grader hive), not the harness that owns the rubric subject plan. For cross-hive grading, use the grader/source hive here; scorecards:emit uses targetHive for the subject hive.',
      ),
    ratings: z.record(z.string().min(1), scorecardRatingEntrySchema).optional(),
    subject: z.object({
      kind: z.enum(['agent-run', 'session', 'work-item', 'plan', 'pot', 'rubric', 'scorecard']).optional(),
      ref: z.string().min(1).max(500),
      windowStart: z.string().min(1).max(64).optional(),
      windowEnd: z.string().min(1).max(64).optional(),
    }).strict().optional().describe('Exact subject/window for registered platform-computed instruments.'),
    instrumentSnapshots: z.record(z.string().min(1), scorecardInstrumentSnapshotSchema).optional(),
    testedSha: scorecardTestedShaSchema.optional(),
  })
  .strict();

/**
 * Who the caller is, for the acceptance-grader pre-flight. Optional: omitting it
 * yields `graderEligibility: null` (the pre-existing behaviour) rather than a
 * guess, so a non-agent caller is never told it is disqualified.
 */
export interface ScorecardEvaluateCaller {
  id: string;
  workspaceId?: string | null;
}

export type GraderEligibilityReport =
  | {
      role: 'acceptance-author' | 'independent-grader' | 'disqualified' | 'unknown';
      canEmitGrading: boolean;
      blocksEmit: boolean;
      implementer: string | null;
      principalImplementers: string[] | null;
      advice: string;
      refusal?: { code: string; error: string };
    }
  | null;

/**
 * EI-21974075442192005: this tool is the DOCUMENTED pre-flight before grading
 * (`evaluate -> fill skeleton -> evaluate -> emit`), which makes it the place a
 * would-be grader has to learn it is disqualified. The acceptance-grader rails
 * are pure identity facts, settled before any criterion is rated, yet they used
 * to be reachable only through the terminal `scorecards:emit` — so a launched
 * reviewer could complete an entire independent pass and only then be refused.
 *
 * Derived from the same module `scorecards:emit` refuses with; never a second
 * copy of the predicates. It reports rather than refuses: the skeleton is still
 * useful to a disqualified caller (handing it to the replacement grader), and a
 * read-only pre-flight that hard-failed would be a worse instrument than one
 * that answers.
 */
async function reportGraderEligibility(
  rubric: {
    rubricId: string;
    kind?: string | null;
    status?: string | null;
    workspaceId?: string | null;
    proposedBy?: string | null;
    createdBy?: string | null;
    barContract?: { meaningRevision?: number | null } | null;
  },
  caller: ScorecardEvaluateCaller | undefined,
): Promise<GraderEligibilityReport> {
  if (!caller || rubric.kind !== 'acceptance') return null;
  try {
    const verdict = await resolveAcceptanceGraderEligibility({
      rubric,
      callerId: caller.id,
      workspaceId: rubric.workspaceId || caller.workspaceId || activeWorkspaceId(),
    });
    if (verdict.refusal) {
      return {
        role: 'disqualified',
        canEmitGrading: false,
        blocksEmit: true,
        implementer: verdict.implementer,
        principalImplementers: verdict.principalImplementers,
        advice:
          `STOP — do not grade: scorecards:emit will refuse this card with '${verdict.refusal.code}' ` +
          `however complete it is. Report this to whoever assigned the review so a different ` +
          `independent grader is named; the ratings skeleton below is still useful to hand them.`,
        refusal: verdict.refusal,
      };
    }
    if (verdict.callerIsImplementer) {
      return {
        role: 'acceptance-author',
        canEmitGrading: false,
        blocksEmit: false,
        implementer: verdict.implementer,
        principalImplementers: verdict.principalImplementers,
        advice:
          'You authored this acceptance rubric. You record the acceptance verdict ' +
          "(acceptance:{ verdict, reasoning }) AFTER reading a non-implementer's independent grading — " +
          'emitting the grading ratings yourself is refused.',
      };
    }
    return {
      role: 'independent-grader',
      canEmitGrading: true,
      blocksEmit: false,
      implementer: verdict.implementer,
      principalImplementers: verdict.principalImplementers,
      advice:
        'Eligible to emit the independent grading (omit acceptance — that is the rubric author’s call). ' +
        'Identity rails only; the ratings/evidence rails are what this call validates.',
    };
  } catch (error) {
    // A pre-flight that cannot answer must say so, not imply clearance.
    return {
      role: 'unknown',
      canEmitGrading: false,
      blocksEmit: false,
      implementer: null,
      principalImplementers: null,
      advice:
        'Grader eligibility could not be resolved (' +
        `${error instanceof Error ? error.message : String(error)}` +
        ') — this is NOT a clearance; scorecards:emit re-checks the identity rails and may still refuse.',
    };
  }
}

export async function evaluateScorecard(
  args: z.infer<typeof scorecardEvaluateArgs>,
  caller?: ScorecardEvaluateCaller,
) {
  const rubric = await getRubricWithoutSeeding(args.rubricRef);
  if (!rubric) {
    // The seed-free lookup is intentionally fail-soft for read callers. Pair its null
    // with the revision-spine read so a transient DB/data-plane failure cannot
    // become a false authoritative "not found" during grading preflight.
    const revisionRead = await readRubricPlanRevision(args.rubricRef);
    if (!revisionRead.ok) {
      return {
        ok: false as const,
        error:
          `rubric '${args.rubricRef}' could not be resolved because the backing plan read failed; ` +
          'retry or verify independently before treating it as absent',
      };
    }
    return { ok: false as const, error: `rubric '${args.rubricRef}' not found` };
  }

  // Keep the documented read-only preflight aligned with scorecards:emit. An
  // adopted acceptance rubric can be individually resolvable while its BAR
  // snapshot is stale or incomplete; returning an apparently gradeable
  // skeleton in that state makes a grader spend the full pass only to have the
  // terminal emit refuse the same payload.
  if (rubric.kind === 'acceptance' && rubric.barContract?.adoptionEpoch != null && rubric.subjectPlan) {
    // Same harness scope as scorecards:emit: a plan slug is unique per harness, not per
    // workspace (WI-10005160).
    const lifecycle = await readAndEvaluateAcceptanceBarLifecycle(rubric.subjectPlan, 'pre-grading', {
      expectedApplicable: true,
      harnessSlug: rubric.subjectHarnessSlug,
    });
    if (!lifecycle.satisfied) {
      return {
        ok: false as const,
        code: 'acceptance_bar_contract_not_ready' as const,
        error: lifecycle.message ?? 'acceptance BAR contract is not ready for grading',
        lifecycle,
      };
    }
  }

  const graderEligibility = await reportGraderEligibility(rubric, caller);

  const skeleton = rubric.criteria.map((criterion) => ({
    key: criterion.key,
    title: criterion.title,
    instrumentKey: criterion.instrumentKey ?? null,
    // P-011 (D-006): the structured check, so a grader KNOWS a criterion is
    // deterministic before rating it — a kind:'tests' check is actually RUN by
    // scorecards:emit, and a pass-claiming rating a failing run contradicts is refused.
    check: criterion.check ?? null,
    allowedRatings: criterion.ratingScale ?? rubric.ratingScale,
    rating: null,
    evidence: null,
    required: true,
  }));
  const latest = (
    await listScorecards({ rubricRef: args.rubricRef, sourceHive: args.sourceHive, limit: 1 })
  )[0];

  // An empty ratings object is the natural discovery request for callers that
  // need the rubric's criterion keys and allowed values before grading. Treat
  // it like the skeleton-only form instead of flowing into the delta loop,
  // where a missing criterion entry would otherwise be dereferenced.
  if (!args.ratings || Object.keys(args.ratings).length === 0) {
    return {
      ok: true as const,
      graderEligibility,
      rubric: {
        rubricRef: rubric.rubricId,
        title: rubric.title,
        status: rubric.status,
        releaseGating: rubric.releaseGating ?? false,
        criteriaCount: rubric.criteria.length,
        ratingScale: rubric.ratingScale,
      },
      skeleton,
      latest: latest ?? null,
    };
  }

  try {
    const ratings = normalizeScorecardRatings(args.ratings as ObservationRatings, rubric);
    const observation = { rubricRef: args.rubricRef, ratings };
    validateObservationRatings(observation);
    validateScorecardCompleteness(observation, rubric.criteria.map((criterion) => criterion.key));
    validateScorecardRatingValues(observation, rubric);
    // Poor-rating disposition preflight (owner-directed 2026-08-31): teach the
    // grader BEFORE the terminal emit that a poor rating must route somewhere.
    validateScorecardPoorRatingDisposition(observation, rubric);
    try {
      validateRubricRatingContracts(args.rubricRef, ratings);
    } catch (error) {
      return {
        ok: false as const,
        graderEligibility,
        error: error instanceof Error ? error.message : String(error),
        canonicalRatings: ratings,
        latest: latest ?? null,
      };
    }
    const instrumentSnapshots = await resolveScorecardInstrumentSnapshots({
      rubric,
      subject: args.subject,
      supplied: args.instrumentSnapshots as Record<string, ScorecardInstrumentSnapshot> | undefined,
    });
    const unboundEvidenceFingerprint = scorecardEvidenceFingerprint({
      rubricRef: args.rubricRef,
      ratings,
      instrumentSnapshots,
    });
    const instrumentContract = evaluateScorecardInstrumentContract({
      rubric,
      ratings,
      instrumentSnapshots,
    });
    if (args.rubricRef === 'work-on-everything-stewardship-health' && instrumentContract.verdictMismatches.length) {
      return {
        ok: false as const,
        error: 'A registered platform measurement contradicts the claimed rating.',
        instrumentContract,
        instrumentSnapshots,
      };
    }
    if (rubric.releaseGating && !instrumentContract.valid) {
      return {
        ok: false as const,
        graderEligibility,
        error:
          `release-gating instrument contract invalid for '${args.rubricRef}' — ` +
          'inspect instrumentContract for missing/stale/window/verdict mismatches',
        skeleton,
        canonicalRatings: ratings,
        evidenceFingerprint: unboundEvidenceFingerprint,
        instrumentContract,
        latest: latest ?? null,
      };
    }
    const releaseGateBinding =
      rubric.releaseGating && scorecardRatingsClaimPass(ratings)
        ? await resolveScorecardReleaseGateBinding(args.testedSha)
        : undefined;
    if (releaseGateBinding?.status === 'stale-pass-blocked') {
      return {
        ok: false as const,
        code: 'stale_pass_blocked' as const,
        graderEligibility,
        error:
          `release-gating pass blocked for '${args.rubricRef}' — ${releaseGateBinding.reason}. ` +
          'Re-run the drill at the current staging commit after that same commit has a fresh green gate verdict, then pass testedSha.',
        skeleton,
        canonicalRatings: ratings,
        instrumentContract,
        releaseGateBinding,
        latest: latest ?? null,
      };
    }
    const boundTestedSha = releaseGateBinding?.status === 'bound'
      ? releaseGateBinding.testedSha ?? undefined
      : undefined;
    const evidenceFingerprint = boundTestedSha
      ? scorecardEvidenceFingerprint({
          rubricRef: args.rubricRef,
          ratings,
          instrumentSnapshots,
          testedSha: boundTestedSha,
        })
      : unboundEvidenceFingerprint;
    const latestFingerprint = latest
      ? latest.evidenceFingerprint ??
        scorecardEvidenceFingerprint({
          rubricRef: latest.rubricRef,
          ratings: latest.ratings,
          ...(latest.rerunRecipe ? { rerunRecipe: latest.rerunRecipe } : {}),
          ...(latest.testedSha ? { testedSha: latest.testedSha } : {}),
        })
      : null;
    const changedCriteria = rubric.criteria
      .map((criterion) => criterion.key)
      .filter((key) => {
        const before = latest?.ratings[key];
        const after = ratings[key];
        return !before || !after || before.rating !== after.rating || before.evidence !== after.evidence;
      });
    return {
      ok: true as const,
      graderEligibility,
      rubric: {
        rubricRef: rubric.rubricId,
        title: rubric.title,
        status: rubric.status,
        releaseGating: rubric.releaseGating ?? false,
        criteriaCount: rubric.criteria.length,
        ratingScale: rubric.ratingScale,
      },
      skeleton,
      canonicalRatings: ratings,
      evidenceFingerprint,
      instrumentContract,
      ...(computeWorkOnEverythingRollup(
        args.rubricRef,
        ratings,
        rubric.criteria.map((criterion) => criterion.key),
      )
        ? {
            rollup: computeWorkOnEverythingRollup(
              args.rubricRef,
              ratings,
              rubric.criteria.map((criterion) => criterion.key),
            ),
          }
        : {}),
      ...(releaseGateBinding ? { releaseGateBinding } : {}),
      changed: latestFingerprint !== evidenceFingerprint,
      delta: {
        previousIssueId: latest?.issueId ?? null,
        changedCriteria,
        instrumentSnapshotsChanged:
          Boolean(instrumentSnapshots) && latest?.evidenceFingerprint !== evidenceFingerprint,
      },
      latest: latest ?? null,
    };
  } catch (error) {
    if (error instanceof ObservationEvidenceError) {
      return {
        ok: false as const,
        graderEligibility,
        error: error.message,
        skeleton,
        latest: latest ?? null,
      };
    }
    throw error;
  }
}

export default defineTool({
  name: 'scorecards:evaluate',
  profile: 'engineer',
  description:
    'Return the exact typed grading skeleton for a rubric. Optionally validate + canonicalize a complete ratings map, resolve registered instrument snapshots for the exact subject/window, bind positive release-gating ratings to the tested green SHA, compute its evidence fingerprint, and show the criterion delta from the latest scorecard. Read-only; acceptance, vetting links, terminal, and force remain emit-only metadata. Use scorecards:emit to file the validated result.',
  guidance: {
    when:
      'Before grading/emitting a rubric scorecard, especially in GRADE mode. This eliminates criterion-key, rating-case, evidence, and nested-schema guessing. For an acceptance rubric it also returns `graderEligibility` — whether YOU may file the grading at all; read it BEFORE doing the grading work, not after. Pass the same `subject` and observation window to evaluate and emit so registered instruments measure the same run.',
    notWhen: 'Reading scorecard history only — scorecards:list. Filing the validated scorecard — scorecards:emit.',
    chaining:
      'scorecards:evaluate { rubricRef } → fill the returned skeleton → scorecards:evaluate { rubricRef, subject, ratings, instrumentSnapshots, testedSha } → scorecards:emit with the same subject/window and canonical ratings. Registered instruments execute on both calls; caller snapshots cannot assert platform provenance. `testedSha` is required when a releaseGating rubric has a pass-like rating.',
    returns:
      'Top level: { ok, code, skeleton, rubric, graderEligibility, latest, canonicalRatings, evidenceFingerprint, instrumentContract, releaseGateBinding, changed, delta, error }. `skeleton` is an ARRAY of criterion rows — NOT an object keyed by criterion, so index it positionally or by `.key`; each row carries key, title, instrumentKey, check and allowedRatings beside the null rating/evidence you fill in. `rubric` summarises the rubric incl. criteriaCount; `graderEligibility` is null unless the rubric is kind acceptance and then includes the acceptance-author `implementer` plus `principalImplementers` from its subject plan; a positive releaseGating evaluation returns a bound `releaseGateBinding` or refuses with code `stale_pass_blocked` and the current gate reason/failing tests. `latest` is the newest ScorecardRow or null, and its `ratings`, `gradedGeneration` and `generationFreshness` are nested OBJECTS rather than scalars — `generationFreshness` only when the row carries a `gradedGeneration` — so a flat/CSV projection over a row fails on them. `canonicalRatings`, `evidenceFingerprint`, `instrumentContract`, `changed` and `delta.changedCriteria` appear only when you pass `ratings`.',
    seeAlso: ['scorecards:emit', 'scorecards:list', 'rubrics:get'],
  },
  // EI-21228209276284649: this is a correctness payload, not a browseable list.
  // A trimmed MCP session used the framework's generic bounded projection on a
  // 29,746-char, 26-criterion result before the result door saw it. The door's
  // otherwise-lossless spill therefore contained only 12 skeleton rows plus a
  // truncation marker and six canonical ratings while `criteriaCount` still
  // truthfully said 26. Ignore only the AMBIENT session tier so the door receives
  // the complete validation result and can spill it losslessly; an explicit
  // caller `payloadTier:'trimmed'` still wins, and the 30k hard ceiling remains.
  ignoreSessionPayloadTier: true,
  capability: 'coord:read',
  requirePrincipal: false,
  // The dedicated acceptance judge validates ratings and instrument evidence;
  // keep its admission local to this read-only tool rather than widening
  // COORD_ROLES (which would expose unrelated coordination writes).
  agentRoles: [...COORD_ROLES, 'judge'],
  args: scorecardEvaluateArgs,
  // WI-2141200: the `outputJsonSchema` that guidance-output-schema-live-guard
  // resolves an authored `guidance.returns` against is DERIVED from this `result:`
  // declaration — there is no direct declaration site — so the prose above is only
  // enforceable because this exists. Every field is optional: the branches differ
  // (skeleton-only, validated, and the two error shapes). Nested payloads stay
  // loose so the encoder never reshapes a correctness result the way the
  // `ignoreSessionPayloadTier` declaration above exists to prevent.
  result: z
    .object({
      ok: z.boolean().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      graderEligibility: z.record(z.string(), z.unknown()).nullable().optional(),
      rubric: z.record(z.string(), z.unknown()).optional(),
      skeleton: z.array(z.unknown()).optional(),
      canonicalRatings: z.record(z.string(), z.unknown()).optional(),
      evidenceFingerprint: z.string().optional(),
      instrumentContract: z.record(z.string(), z.unknown()).optional(),
      releaseGateBinding: z.record(z.string(), z.unknown()).optional(),
      changed: z.boolean().optional(),
      delta: z.record(z.string(), z.unknown()).optional(),
      latest: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    // EI-21974075442192005: this identity used to be resolved and discarded, which
    // is why the pre-flight could not answer the one question that costs a whole
    // grading pass to get wrong. Pass it through.
    const identity = resolveAgentIdentity(ctx);
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => ({
      data: await evaluateScorecard(args, {
        id: identity.ownerId,
        workspaceId: identity.workspaceId,
      }),
    }));
  },
});
