/** Plan-level spec quality over the exact current first-class clause set (P-004). */
import { createHash } from 'node:crypto';
import type { SpecClauseRevision } from './spec-clauses-store';
import {
  computeSpecSetHash,
  normalizeSpecSemanticText,
  specBehaviorImplementationPresenceReason,
  specBehaviorNonAtomicReason,
  specBehaviorNonFalsifiableReason,
} from './spec-clause-compiler';
import { PLAN_CLASS_RUBRIC_REFS, type PlanClassRubricRef } from './spec-test-adequacy';

export const SPEC_QUALITY_RUBRIC_REF = 'spec-quality';

export const SPEC_QUALITY_CRITERIA = [
  'stable-revision-identity',
  'item-contract-coverage',
  'atomic-observable-behavior',
  'falsifiability',
  'implementation-independence',
  'explicit-non-behavioral-exemptions',
  'plan-class-specialization',
  'spec-set-freshness',
] as const;
export type SpecQualityCriterion = (typeof SPEC_QUALITY_CRITERIA)[number];
export type SpecQualityRating = 'pass' | 'fail' | 'unknown' | 'waived' | 'not-applicable';

export interface SpecQualityRatingEntry {
  rating: SpecQualityRating;
  evidence: string;
  suggestion?: string;
}

export interface PlanSpecQualityResult {
  planSlug: string;
  classRef: PlanClassRubricRef;
  specSetHash: string;
  clauseCount: number;
  planItemCount: number;
  ratings: Record<SpecQualityCriterion, SpecQualityRatingEntry>;
  verdict: 'pass' | 'fail' | 'unknown';
  wouldBlock: SpecQualityCriterion[];
  details: {
    uncoveredPlanItemIds: string[];
    invalidExemptionSpecIds: string[];
    draftSpecIds: string[];
    atomicityClauseDiagnostics: SpecQualityAtomicityClauseDiagnostic[];
  };
  scorecardDraft: {
    rubricRef: typeof SPEC_QUALITY_RUBRIC_REF;
    subject: { kind: 'plan'; ref: string };
    title: string;
    body: string;
    ratings: Record<SpecQualityCriterion, SpecQualityRatingEntry>;
    terminal: true;
  };
}

export type SpecQualityAtomicityClauseDiagnostic =
  | {
      specId: string;
      planItemId: string;
      behavior: string;
      disposition: 'evaluated';
      rating: 'pass';
      reason: null;
    }
  | {
      specId: string;
      planItemId: string;
      behavior: string;
      disposition: 'evaluated';
      rating: 'fail';
      reason: string;
    }
  | {
      specId: string;
      planItemId: string;
      behavior: string;
      disposition: 'excluded';
      rating: 'not-applicable';
      reason: string;
    };

const CONTRACT_STATUSES = new Set(['active', 'accepted']);
const CURRENT_SET_STATUSES = new Set(['draft', 'active', 'accepted', 'exempt']);

function pass(evidence: string): SpecQualityRatingEntry {
  return { rating: 'pass', evidence };
}

function fail(evidence: string, suggestion: string): SpecQualityRatingEntry {
  return { rating: 'fail', evidence, suggestion };
}

function unknown(evidence: string): SpecQualityRatingEntry {
  return { rating: 'unknown', evidence };
}

function notApplicable(evidence: string): SpecQualityRatingEntry {
  return { rating: 'not-applicable', evidence };
}

function rerunnableEvidence(
  input: { planSlug: string; harnessSlug: string; classRef: PlanClassRubricRef },
  criterion: SpecQualityCriterion,
  evidence: string,
  expectedSpecSetHash: string,
): string {
  const planArgs = `slug:${JSON.stringify(input.planSlug)}, harness:${JSON.stringify(input.harnessSlug)}`;
  const evaluationArgs = planArgs + ', classRef:' + JSON.stringify(input.classRef) +
    ', expectedSpecSetHash:' + JSON.stringify(expectedSpecSetHash);
  return (
    `Source store: plans:get-specs { ${planArgs} }. ` +
    `Re-run exactly: plans:evaluate-spec-quality { ${evaluationArgs} }; ` +
    `confirm the returned specSetHash equals ${JSON.stringify(expectedSpecSetHash)}; ` +
    `inspect ratings[${JSON.stringify(criterion)}]. ${evidence}`
  );
}

function trimmedField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validExplicitExemption(clause: SpecClauseRevision): boolean {
  if (clause.lifecycleStatus !== 'exempt' || clause.behaviorClass !== 'non-automated') return false;
  const exemption = clause.exemption;
  if (!exemption || typeof exemption !== 'object' || Array.isArray(exemption)) return false;
  return Boolean(trimmedField(exemption.justification) && trimmedField(exemption.provenance));
}

function implementationCouplingReason(behavior: string): string | null {
  const sourcePresence = specBehaviorImplementationPresenceReason(behavior);
  if (sourcePresence) return sourcePresence;
  if (/\.(?:[cm]?[jt]sx?|rs|py|sql|sh)\b/i.test(behavior)) return 'names an implementation file';
  const constructReference =
    /\b(?:function|class|method|variable|private field|implementation detail)\s+(`[^`]+`|'[^']+'|"[^"]+"|[A-Za-z_$][A-Za-z0-9_$]*)/gi;
  for (const match of behavior.matchAll(constructReference)) {
    const token = match[1];
    const explicitlyQuoted = new RegExp('^[`' + '\'"' + ']').test(token);
    const identifier = explicitlyQuoted ? token.slice(1, -1) : token;
    const identifierLooksLikeSymbol =
      /^[A-Z_$]/.test(identifier) || /[_$]/.test(identifier) || /[A-Z0-9]/.test(identifier.slice(1));
    if (explicitlyQuoted || identifierLooksLikeSymbol) {
      return 'names implementation construct ' + JSON.stringify(match[0]) + ' instead of an observable contract';
    }
  }
  return null;
}

function planClassFit(classRef: PlanClassRubricRef, clauses: SpecClauseRevision[]): { ok: boolean; evidence: string } {
  const classes = [...new Set(clauses.map((clause) => clause.behaviorClass))].sort();
  if (classRef === 'plan-class-feature-ship') {
    return {
      ok: clauses.length > 0,
      evidence: clauses.length
        ? `Feature plan has ${clauses.length} active behavioral clause(s): ${classes.join(', ')}.`
        : 'Feature plans require at least one active behavioral clause.',
    };
  }
  if (classRef === 'plan-class-bugfix') {
    const ok = clauses.some((clause) => clause.behaviorClass === 'failure' || clause.behaviorClass === 'boundary');
    return {
      ok,
      evidence: ok
        ? 'Bugfix plan includes an active failure/boundary regression contract.'
        : 'Bugfix plans require an active failure or boundary clause for the reproduced defect.',
    };
  }
  if (classRef === 'plan-class-migration') {
    const ok = clauses.some((clause) => clause.behaviorClass === 'migration-data-integrity');
    return {
      ok,
      evidence: ok
        ? 'Migration plan includes an active migration-data-integrity contract.'
        : 'Migration plans require an active migration-data-integrity clause.',
    };
  }
  const ok = clauses.some(
    (clause) => clause.behaviorClass === 'observability' || clause.behaviorClass === 'non-automated',
  );
  return {
    ok,
    evidence: ok
      ? 'Investigation plan includes an active observability/non-automated contract.'
      : 'Investigation plans require an observability or non-automated clause, or explicit item exemptions.',
  };
}

/** Stable, bounded scorecard subject for one plan/class/exact current spec set. */
export function specQualitySubjectRef(planSlug: string, classRef: PlanClassRubricRef, specSetHash: string): string {
  const planKey = createHash('sha256').update(planSlug).digest('hex').slice(0, 16);
  return `spec-set:${classRef}:${specSetHash}:${planKey}`;
}

/**
 * The plan items that owe a spec contract: every item except a deliberately
 * dropped one. A dropped item is a recorded departure (`plans:set-status
 * { status:'dropped', note }`), so demanding a clause or exemption for it forced
 * authors to file fake exemptions just to start a plan (WI-10006208). Every
 * caller that feeds `planItemIds` to the spec-quality evaluator or gate builds
 * the list through this one function so the rule cannot drift between them.
 */
export function specQualityPlanItemIds(
  items: ReadonlyArray<{ id: string; storedStatus?: string | null }>,
): string[] {
  return items.filter((item) => item.storedStatus !== 'dropped').map((item) => item.id);
}

/**
 * Grade one exact current set. Every plan item must either own an active behavior
 * clause or an explicit non-automated exemption; absence is never inferred as
 * non-behavioral.
 */
export function evaluatePlanSpecQuality(input: {
  planSlug: string;
  harnessSlug: string;
  planItemIds: readonly string[];
  clauses: readonly SpecClauseRevision[];
  classRef: PlanClassRubricRef;
  expectedSpecSetHash?: string;
}): PlanSpecQualityResult {
  const planItemIds = [...new Set(input.planItemIds)].sort();
  const currentSet = input.clauses
    .filter((clause) => CURRENT_SET_STATUSES.has(clause.lifecycleStatus))
    .slice()
    .sort((a, b) => a.specId.localeCompare(b.specId));
  const behavioral = currentSet.filter((clause) => CONTRACT_STATUSES.has(clause.lifecycleStatus));
  const exemptions = currentSet.filter((clause) => clause.lifecycleStatus === 'exempt');
  const validExemptions = exemptions.filter(validExplicitExemption);
  const specSetHash = computeSpecSetHash(currentSet);
  const ratings = {} as Record<SpecQualityCriterion, SpecQualityRatingEntry>;

  const seenSpecIds = new Set<string>();
  const seenAliases = new Set<string>();
  const identityFailures: string[] = [];
  for (const clause of currentSet) {
    if (seenSpecIds.has(clause.specId)) identityFailures.push(`${clause.specId}:duplicate-spec-id`);
    seenSpecIds.add(clause.specId);
    if (clause.sourceValId) {
      if (seenAliases.has(clause.sourceValId)) identityFailures.push(`${clause.sourceValId}:duplicate-source-alias`);
      seenAliases.add(clause.sourceValId);
    }
    if (clause.revision !== clause.currentRevision) identityFailures.push(`${clause.specId}:not-current-revision`);
    if (!clause.contentHash.trim()) identityFailures.push(`${clause.specId}:missing-content-hash`);
    if (CONTRACT_STATUSES.has(clause.lifecycleStatus) && (!clause.acceptedBy || !clause.acceptanceRef)) {
      identityFailures.push(`${clause.specId}:missing-acceptance-provenance`);
    }
  }
  const provenanceBearingClauses = currentSet.filter((clause) => CONTRACT_STATUSES.has(clause.lifecycleStatus));
  const draftClauses = currentSet.filter((clause) => clause.lifecycleStatus === 'draft');
  const exemptClauses = currentSet.filter((clause) => clause.lifecycleStatus === 'exempt');
  const provenanceEvidence = [
    // Evidence participates in the audited card fingerprint. The original wording
    // is truthful for an all-active/accepted set; do not churn its settled cards
    // when correcting the distinct draft/exempt populations (EI-22759986393772535).
    `${provenanceBearingClauses.length} ${provenanceBearingClauses.length === currentSet.length ? 'current' : 'active/accepted current'} clause(s) have unique identities, content hashes, and acceptance provenance.`,
    draftClauses.length
      ? `${draftClauses.length} draft current clause(s) are present and excluded from the acceptance-provenance count.`
      : null,
    exemptClauses.length
      ? `${exemptClauses.length} exempt current clause(s) are present and do not require acceptance provenance.`
      : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(' ');
  ratings['stable-revision-identity'] = identityFailures.length
    ? fail(
        `Revision/identity failures: ${identityFailures.join(', ')}.`,
        'Repair duplicate identities, select only current revisions, and record acceptance provenance.',
      )
    : pass(provenanceEvidence);

  const behaviorGroups = new Map<string, SpecClauseRevision[]>();
  for (const clause of behavioral) {
    const key = normalizeSpecSemanticText(clause.behavior);
    const group = behaviorGroups.get(key) ?? [];
    group.push(clause);
    behaviorGroups.set(key, group);
  }
  // A sourceBar pin makes this clause a projection of the canonical acceptance
  // BAR, repeated once for each mapped plan item. It is not an independently
  // authored item contract. Require item coverage and grade behavior quality on
  // unpinned clauses; the canonical rubric remains the source of BAR meaning.
  const isProjectedBar = (clause: SpecClauseRevision) => clause.sourceBar != null;
  const isUnpinnedAutoBar = (clause: SpecClauseRevision) =>
    !clause.sourceBar && clause.specId.startsWith('AUTO-BAR-');
  const itemBehavioral = behavioral.filter((clause) => !isProjectedBar(clause));
  const independentItemBehavioral = itemBehavioral.filter((clause) => !isUnpinnedAutoBar(clause));
  const barPinMismatches = [...behaviorGroups.values()]
    .filter((group) => new Set(group.map((clause) => clause.planItemId)).size > 1)
    .filter((group) => group.some((clause) => isProjectedBar(clause) || isUnpinnedAutoBar(clause)))
    .filter((group) => {
      const pin = group[0]?.sourceBar;
      return !pin || group.some((clause) => {
        const source = clause.sourceBar;
        return (
          source == null ||
          source.rubricSlug !== pin.rubricSlug ||
          source.barKey !== pin.barKey ||
          source.barHash !== pin.barHash ||
          source.barSetHash !== pin.barSetHash ||
          source.evidencePlane !== pin.evidencePlane
        );
      });
    })
    .map((group) => {
      const specIds = [...new Set(group.map((clause) => clause.specId))].sort();
      return 'projected specs ' + specIds.join(', ') + ' do not share one identical source BAR pin';
    });
  const itemBehaviorGroups = new Map<string, SpecClauseRevision[]>();
  for (const clause of itemBehavioral) {
    const key = normalizeSpecSemanticText(clause.behavior);
    const group = itemBehaviorGroups.get(key) ?? [];
    group.push(clause);
    itemBehaviorGroups.set(key, group);
  }
  const duplicateBehaviorReuse = [...itemBehaviorGroups.values()]
    .filter((group) => new Set(group.map((clause) => clause.planItemId)).size > 1)
    .map((group) => {
      const specIds = [...new Set(group.map((clause) => clause.specId))].sort();
      const itemIds = [...new Set(group.map((clause) => clause.planItemId))].sort();
      return 'specs ' + specIds.join(', ') + ' reuse the same behavior text across plan items ' + itemIds.join(', ');
    });
  const unpinnedAutoBarIds = itemBehavioral.filter(isUnpinnedAutoBar).map((clause) => clause.specId).sort();
  const coveredItems = new Set([...independentItemBehavioral, ...validExemptions].map((clause) => clause.planItemId));
  const uncoveredPlanItemIds = planItemIds.filter((itemId) => !coveredItems.has(itemId));
  const projectionEvidence = behavioral.some((clause) => clause.sourceBar)
    ? ` ${behavioral.filter((clause) => clause.sourceBar).length} sourceBar-pinned projection(s) remain linked to their canonical acceptance BAR and do not substitute for item contracts.`
    : '';
  ratings['item-contract-coverage'] = uncoveredPlanItemIds.length
    ? fail(
        `Plan item(s) lack an active clause or valid explicit exemption: ${uncoveredPlanItemIds.join(', ')}.`,
        'Add at least one active behavioral clause per item, or an explicit non-automated exemption with justification and provenance.',
      )
    : barPinMismatches.length || duplicateBehaviorReuse.length || unpinnedAutoBarIds.length
      ? unknown(
        'Potential contract coverage issue: ' +
            [
              ...barPinMismatches,
              ...(unpinnedAutoBarIds.length
                ? ['AUTO-BAR specs lack a trusted source BAR pin: ' + unpinnedAutoBarIds.join(', ')]
                : []),
              ...duplicateBehaviorReuse,
            ].join('; ') +
            '. Review whether these clauses represent independent item contracts.',
        )
      : pass(`All ${planItemIds.length} plan item(s) are covered by active item clauses or explicit exemptions.${projectionEvidence}`);

  const atomicityEvaluation = behavioral.map((clause) => {
    let diagnostic: SpecQualityAtomicityClauseDiagnostic;
    if (isProjectedBar(clause)) {
      diagnostic = {
        specId: clause.specId,
        planItemId: clause.planItemId,
        behavior: clause.behavior,
        disposition: 'excluded',
        rating: 'not-applicable',
        reason: 'sourceBar-pinned BAR projection is not an independent item behavior clause.',
      };
    } else {
      const reason = specBehaviorNonAtomicReason(clause.behavior);
      diagnostic = reason === null
        ? {
            specId: clause.specId,
            planItemId: clause.planItemId,
            behavior: clause.behavior,
            disposition: 'evaluated',
            rating: 'pass',
            reason: null,
          }
        : {
            specId: clause.specId,
            planItemId: clause.planItemId,
            behavior: clause.behavior,
            disposition: 'evaluated',
            rating: 'fail',
            reason,
          };
    }
    return { clause, diagnostic };
  });
  const atomicityClauseDiagnostics = atomicityEvaluation.map(({ diagnostic }) => diagnostic);
  const atomicityFailures = atomicityEvaluation.flatMap(({ clause, diagnostic }) => {
    if (diagnostic.disposition !== 'evaluated' || diagnostic.rating !== 'fail') return [];
    return [{ clause, reason: diagnostic.reason }];
  });
  ratings['atomic-observable-behavior'] =
    behavioral.length === 0
      ? notApplicable('0 behavioral clause(s) are available for structural atomicity evaluation.')
      : itemBehavioral.length === 0
        ? notApplicable('Only AUTO-BAR projections are present; they are not independent item contracts.')
      : atomicityFailures.length
        ? fail(
            atomicityFailures.map(({ clause, reason }) => `${clause.specId}:${reason}`).join('; '),
            'Split compound outcomes into atomic clauses with one observable behavior each.',
          )
        : pass(`${itemBehavioral.length} independent item behavior clause(s) are structurally atomic.${projectionEvidence}`);

  const falsifiabilityFailures = itemBehavioral
    .map((clause) => ({ clause, reason: specBehaviorNonFalsifiableReason(clause.behavior) }))
    .filter((entry): entry is { clause: SpecClauseRevision; reason: string } => Boolean(entry.reason));
  ratings.falsifiability =
    behavioral.length === 0
      ? notApplicable('0 behavioral clause(s) are available for falsifiability evaluation.')
      : itemBehavioral.length === 0
        ? notApplicable('Only AUTO-BAR projections are present; they are not independent item contracts.')
      : falsifiabilityFailures.length
        ? fail(
            falsifiabilityFailures.map(({ clause, reason }) => `${clause.specId}:${reason}`).join('; '),
            'Rewrite vague or discretionary text as a concrete outcome that can be shown false.',
          )
        : pass(`${itemBehavioral.length} independent item behavior clause(s) state falsifiable outcomes.${projectionEvidence}`);

  const couplingFailures = itemBehavioral
    .map((clause) => ({ clause, reason: implementationCouplingReason(clause.behavior) }))
    .filter((entry): entry is { clause: SpecClauseRevision; reason: string } => Boolean(entry.reason));
  ratings['implementation-independence'] =
    behavioral.length === 0
      ? notApplicable('0 behavioral clause(s) are available for implementation-independence evaluation.')
      : itemBehavioral.length === 0
        ? notApplicable('Only AUTO-BAR projections are present; they are not independent item contracts.')
      : couplingFailures.length
        ? fail(
            couplingFailures.map(({ clause, reason }) => `${clause.specId}:${reason}`).join('; '),
            'Describe externally observable behavior instead of filenames or internal constructs.',
          )
        : pass(`No independent item clause is coupled to an obvious implementation filename or construct.${projectionEvidence}`);

  const invalidExemptionSpecIds = exemptions
    .filter((clause) => !validExplicitExemption(clause))
    .map((clause) => clause.specId);
  ratings['explicit-non-behavioral-exemptions'] = invalidExemptionSpecIds.length
    ? fail(
        `Invalid exemption(s): ${invalidExemptionSpecIds.join(', ')}.`,
        'Use lifecycleStatus=exempt, behaviorClass=non-automated, and non-empty justification + provenance.',
      )
    : exemptions.length
      ? pass(`${exemptions.length} non-behavioral exemption(s) carry explicit justification and provenance.`)
      : { rating: 'not-applicable', evidence: 'No clause claims a non-behavioral exemption.' };

  const classFit = planClassFit(input.classRef, itemBehavioral);
  const everyItemExplicitlyExempt =
    planItemIds.length > 0 &&
    planItemIds.every((itemId) => validExemptions.some((clause) => clause.planItemId === itemId));
  ratings['plan-class-specialization'] =
    classFit.ok || (input.classRef === 'plan-class-investigation' && everyItemExplicitlyExempt)
      ? pass(
          classFit.ok
            ? classFit.evidence
            : 'Every investigation item is explicitly non-behavioral and exempt with provenance.',
        )
      : fail(
          classFit.evidence,
          `Evaluate against the correct class (${PLAN_CLASS_RUBRIC_REFS.join(', ')}) or add its required behavior class.`,
        );

  ratings['spec-set-freshness'] =
    input.expectedSpecSetHash && input.expectedSpecSetHash !== specSetHash
      ? unknown(
          'Expected specSetHash ' +
            input.expectedSpecSetHash +
            ', but the current clauses hash to ' +
            specSetHash +
            '; the replayed probe describes a different clause set.',
        )
      : pass(
          'Verdict is pinned to exact current specSetHash ' +
            specSetHash +
            ' over ' +
            currentSet.length +
            ' clause(s).',
        );

  // The start gate pins the exact ratings fingerprint, so the evaluator itself
  // must emit evidence that a non-author can execute verbatim. Otherwise a
  // grading-integrity repair changes the fingerprint and can never satisfy both
  // gates. Keep the raw finding, but prefix its source store, full probe args,
  // and exact result field for every criterion.
  for (const criterion of SPEC_QUALITY_CRITERIA) {
    const entry = ratings[criterion];
    ratings[criterion] = {
      ...entry,
      evidence: rerunnableEvidence(input, criterion, entry.evidence, specSetHash),
    };
  }

  const wouldBlock = SPEC_QUALITY_CRITERIA.filter((key) => ['fail', 'unknown'].includes(ratings[key].rating));
  const verdict = wouldBlock.some((key) => ratings[key].rating === 'fail')
    ? 'fail'
    : wouldBlock.length
      ? 'unknown'
      : 'pass';
  const subjectRef = specQualitySubjectRef(input.planSlug, input.classRef, specSetHash);
  const draftSpecIds = currentSet.filter((clause) => clause.lifecycleStatus === 'draft').map((clause) => clause.specId);
  return {
    planSlug: input.planSlug,
    classRef: input.classRef,
    specSetHash,
    clauseCount: currentSet.length,
    planItemCount: planItemIds.length,
    ratings,
    verdict,
    wouldBlock,
    details: {
      uncoveredPlanItemIds,
      invalidExemptionSpecIds,
      draftSpecIds,
      atomicityClauseDiagnostics,
    },
    scorecardDraft: {
      rubricRef: SPEC_QUALITY_RUBRIC_REF,
      subject: { kind: 'plan', ref: subjectRef },
      title: `${input.planSlug} spec quality (${input.classRef})`,
      body: `Plan ${input.planSlug}; class ${input.classRef}; exact current specSetHash ${specSetHash}; ${currentSet.length} current clause(s), ${planItemIds.length} plan item(s).`,
      ratings,
      terminal: true,
    },
  };
}
