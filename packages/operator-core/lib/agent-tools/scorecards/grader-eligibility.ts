/**
 * grader-eligibility — the ONE answer to "may agent X emit the independent
 * acceptance grading for rubric R?", shared by the surface that REFUSES
 * (`scorecards:emit`) and the surface that PRE-FLIGHTS (`scorecards:evaluate`).
 *
 * EI-21974075442192005: every rail below is a pure IDENTITY fact — knowable
 * before a single criterion is rated — but all of them were reachable only
 * through the terminal `scorecards:emit` call. A launched independent reviewer
 * therefore completed a full grading pass (re-running both bound suites,
 * verifying every claimed repair, tracing four degraded-value branches, writing
 * evidence strings for seven criteria) and only then learned it could never
 * file the result. `scorecards:evaluate` is ALREADY the documented pre-flight
 * for grading (`evaluate -> fill skeleton -> evaluate -> emit`); it resolved the
 * caller's identity and threw the value away.
 *
 * Both surfaces now derive their verdict HERE. That is the point of the module:
 * a pre-flight that re-implements the refusal it predicts is a pre-flight that
 * silently drifts out of agreement with it, and this file already exists
 * because of one such drift — WI-905074 widened the sole-critic REFUSAL from
 * `critics.length === 1` to "no recorded critic is independent of the grader",
 * and the D-031 advisory that warns about that refusal was left on the old
 * narrow test. Keep every predicate in this module and give each surface a
 * projection of it; do not copy one out.
 */
import {
  classifyRubricEvidenceCurrentness,
  readRubricPlanRevision,
  META_ACCEPTANCE_RUBRIC_ID,
} from '../../rubrics';
import { listScorecards } from '../../scorecards';
import {
  areAcceptanceLineageRelated,
  isAcceptanceAuthorIdentity,
  resolvePlanImplementerIdentities,
} from '../../acceptance-author-identity';

/** Refusal codes emitted by the acceptance lifecycle/grader rails, verbatim from `scorecards:emit`. */
export type GraderEligibilityCode =
  | 'retired_acceptance_rubric'
  | 'grader_in_implementer_lineage'
  | 'grader_is_sole_vetting_critic_revision_unreadable'
  | 'grader_is_sole_vetting_critic';

export interface GraderEligibilityRefusal {
  code: GraderEligibilityCode;
  error: string;
  /**
   * The concrete route by which THIS refusal can be satisfied, structured so a
   * caller can act on it without parsing prose.
   *
   * Present on refusals that are genuinely escapable. `grader_is_sole_vetting
   * _critic` is the one that most needs it: paired with the vetting gate on the
   * other side (`bar_snapshot_vetting_stale`), it reads as a two-party
   * reciprocal deadlock — vet first and you are disqualified from grading, grade
   * first and the vetting attestation does not yet exist. It is not actually a
   * deadlock, but the way out lived only in this module's control flow, so an
   * agent hitting it at the END of the ceremony had no way to learn it existed
   * short of reading the implementation.
   */
  remedy?: {
    /** One-line statement of what would satisfy the rail. */
    summary: string;
    /** Ordered, concrete actions. */
    steps: string[];
    /** Routes that LOOK like the escape but do not work, and why. */
    doesNotWork?: string[];
    /** Agent-facing doc carrying the long form. */
    docRef?: string;
  };
}

export interface GraderEligibility {
  /** The rubric's implementer (its acceptance author), or null when unresolvable. */
  implementer: string | null;
  /**
   * Principal implementation identities recorded by the rubric's subject plan.
   * These are independent-grader exclusion identities only; acceptance authority
   * remains with `implementer` and audited seat succession.
   */
  principalImplementers: string[];
  /** True when the caller IS the implementer — they record acceptance, not ratings. */
  callerIsImplementer: boolean;
  /**
   * The refusal this caller would receive from `scorecards:emit`, or null when
   * the identity rails permit them to grade. `null` is NOT a promise that the
   * emit will succeed: the ratings/evidence/instrument rails run separately and
   * are what `scorecards:evaluate` already validated.
   */
  refusal: GraderEligibilityRefusal | null;
}

export interface GraderEligibilityDeps {
  sameAcceptanceAuthor?: typeof isAcceptanceAuthorIdentity;
  lineageRelated?: typeof areAcceptanceLineageRelated;
  resolvePlanImplementerIdentities?: typeof resolvePlanImplementerIdentities;
}

/** The identity fields the rails read — a structural subset of `Rubric`. */
export interface GraderEligibilityRubric {
  rubricId: string;
  criteriaHash?: string | null;
  barContract?: { meaningRevision?: number | null } | null;
  status?: string | null;
  proposedBy?: string | null;
  createdBy?: string | null;
  subjectPlan?: string | null;
}

/** The lifecycle refusal shared by the terminal writer and its pre-flight. */
export function retiredAcceptanceRubricRefusal(
  rubric: Pick<GraderEligibilityRubric, 'rubricId'>,
): GraderEligibilityRefusal {
  return {
    code: 'retired_acceptance_rubric',
    error:
      `acceptance rubric '${rubric.rubricId}' is retired with its terminal subject plan — ` +
      'no new grading or acceptance verdict may be emitted. Read the existing scorecards; ' +
      're-propose a new active rubric revision if genuinely new review work is required.',
  };
}

/**
 * A vetting scorecard restricted to the fields the aggregation below reads —
 * a structural subset of `ScorecardRow` (avoids importing the full row type
 * into this identity-only module).
 */
export interface VettingScorecardLike {
  rubricResolved: boolean;
  missingKeys: readonly unknown[];
  synthesized: boolean;
  vetting?: {
    consultId?: string | null;
    workItemId?: string | null;
    rubricRevision?: number | string | null;
    rubricMeaningRevision?: number | null;
    criteriaHash?: string | null;
    critics?: readonly string[];
  } | null;
}

/**
 * Union the DISTINCT critic identities recorded across EVERY current-revision
 * vetting attestation for `rubricId` — regardless of which channel (consult or
 * work-item) each one cited.
 *
 * EI-22182364716054326: `scorecards:emit` accepts exactly one vetting channel
 * per attestation (WI-41477 — "pass EXACTLY ONE of vettingConsult /
 * vettingWorkItem"), so two independent critics who vetted through DIFFERENT
 * channels land in two SEPARATE scorecards. The old caller here used
 * `vettingCards.find(...)` — the FIRST matching card — and read only ITS
 * `.critics`, so a rubric vetted twice (once per channel) was judged solely on
 * whichever one attestation happened to sort first, misreporting a genuine
 * two-critic vetting as sole-critic and barring an independent critic from
 * grading on the strength of a field that could not represent what happened.
 * The rail this feeds ("is grading self-sealing?") is a fact about the WORLD's
 * critic population, not about which one channel a caller happened to read —
 * so read every matching card and union their critics instead of picking one.
 */
export async function resolveAggregatedVettingCritics(
  rubricId: string,
  currentRevision: number | string | null | undefined,
  currentCriteriaHash?: string | null,
  currentMeaningRevision?: number | null,
): Promise<{ critics: string[]; cardsConsidered: number }> {
  const vettingCards = (await listScorecards({
    rubricRef: META_ACCEPTANCE_RUBRIC_ID,
    subjectRef: rubricId,
    limit: 50,
  })) as VettingScorecardLike[];
  const matching = vettingCards.filter(
    (card) =>
      card.rubricResolved &&
      card.missingKeys.length === 0 &&
      !card.synthesized &&
      (card.vetting?.consultId != null || card.vetting?.workItemId != null) &&
      classifyRubricEvidenceCurrentness(
        {
          revision: card.vetting?.rubricRevision,
          criteriaHash: card.vetting?.criteriaHash,
          meaningRevision: card.vetting?.rubricMeaningRevision,
        },
        {
          revision: currentRevision,
          criteriaHash: currentCriteriaHash,
          meaningRevision: currentMeaningRevision,
        },
      ).state === 'current',
  );
  const seen = new Set<string>();
  const critics: string[] = [];
  for (const card of matching) {
    for (const critic of card.vetting?.critics ?? []) {
      if (!seen.has(critic)) {
        seen.add(critic);
        critics.push(critic);
      }
    }
  }
  return { critics, cardsConsidered: matching.length };
}

/**
 * Collapse a recorded vetting-critic list to the SINGLE party it represents, or
 * null when it names two or more genuinely independent parties.
 *
 * This is the predicate behind the sole-vetting-critic refusal, stated without
 * reference to a grader — which is what the vetting-attestation advisory needs,
 * since at attestation time no grader exists yet. `critics.length === 1` is the
 * degenerate case (a lone critic trivially collapses to itself); a list whose
 * members all resolve to one lineage is the same situation wearing a longer
 * list, and is exactly what WI-905074 found sailing through the old test.
 */
export async function collapseCriticsToSoleParty(
  critics: readonly string[],
  options: { workspaceId: string; lineageRelated?: typeof areAcceptanceLineageRelated },
): Promise<string | null> {
  if (critics.length === 0) return null;
  const [first, ...rest] = critics;
  if (rest.length === 0) return first;
  const lineageRelated = options.lineageRelated ?? areAcceptanceLineageRelated;
  const related = await Promise.all(
    rest.map((critic) => lineageRelated(critic, first, { workspaceId: options.workspaceId })),
  );
  return related.every(Boolean) ? first : null;
}

/**
 * Resolve whether `callerId` may emit the independent grading for an acceptance
 * rubric. Call ONLY for `kind: 'acceptance'` rubrics; other kinds have no
 * implementer/grader split and no rails to answer for.
 *
 * The rails are evaluated in the same order `scorecards:emit` returns them, so
 * a pre-flight reports the FIRST refusal a caller would actually receive rather
 * than an arbitrary one.
 */
export async function resolveAcceptanceGraderEligibility(params: {
  rubric: GraderEligibilityRubric;
  callerId: string;
  workspaceId: string;
  /**
   * WI-2141007: WHICH question the caller is asking. Every rail below except
   * `retired_acceptance_rubric` exists to protect the INDEPENDENCE of a grading
   * — so applying them to an author-side verdict answers a question the caller
   * did not ask.
   *
   * The reported symptom: a session in the dead author's lineage supplied
   * `acceptance:{...}` (an AUTHOR verdict) and was refused
   * `grader_in_implementer_lineage`, whose remedy text reads "recruit an
   * unrelated live session" — advice for a problem that plan did not have,
   * since its independent grading already existed and was recorded. Following
   * it wastes a grader boot. Worse than the message: the refusal returns before
   * seat succession is ever considered, so the party most likely to be the
   * legitimate successor (the leader that launched the dead author, hence in its
   * lineage) could never inherit the seat at all.
   *
   * Defaults to 'grading', so `scorecards:evaluate`'s pre-flight and every
   * existing caller keep their exact behaviour.
   */
  intent?: 'grading' | 'acceptance';
  deps?: GraderEligibilityDeps;
}): Promise<GraderEligibility> {
  const { rubric, callerId, workspaceId } = params;
  const intent = params.intent ?? 'grading';
  const deps = params.deps ?? {};
  const sameAcceptanceAuthor = deps.sameAcceptanceAuthor ?? isAcceptanceAuthorIdentity;
  const lineageRelated = deps.lineageRelated ?? areAcceptanceLineageRelated;
  const resolvePlanImplementers =
    deps.resolvePlanImplementerIdentities ?? resolvePlanImplementerIdentities;

  // `createdBy` is the acceptance-author of record. `proposedBy` identifies
  // who authored the latest revision and must not silently transfer the right
  // to issue the plan verdict; retain it only as a legacy fallback when the
  // original creator is unavailable.
  const implementer = rubric.createdBy ?? rubric.proposedBy ?? null;
  if (rubric.status === 'retired') {
    return {
      implementer,
      principalImplementers: [],
      callerIsImplementer: false,
      refusal: retiredAcceptanceRubricRefusal(rubric),
    };
  }

  const principalImplementers = [
    ...new Set(
      (await resolvePlanImplementers(rubric.subjectPlan, { workspaceId }))
        .map((identity) => identity.trim())
        .filter(Boolean),
    ),
  ];
  const callerIsImplementer =
    implementer != null && (await sameAcceptanceAuthor(implementer, callerId, { workspaceId }));

  // The implementer's own rails (they must supply acceptance, must not supersede,
  // must follow an independent grading) are about the CARD's shape, not about
  // eligibility, and stay with the writer.
  if (callerIsImplementer) {
    return { implementer, principalImplementers, callerIsImplementer: true, refusal: null };
  }

  // An AUTHOR-side verdict is not an offer of independent grading, so neither
  // the lineage rail nor the sole-vetting-critic rail below can speak to it.
  // The author-authority question is answered by the caller (`scorecards:emit`),
  // which checks identity and then seat succession.
  if (intent === 'acceptance') {
    return { implementer, principalImplementers, callerIsImplementer: false, refusal: null };
  }

  const lineageSources = [implementer, ...principalImplementers].filter(
    (identity): identity is string => identity != null && identity.trim() !== '',
  );
  const relatedSources = await Promise.all(
    lineageSources.map((identity) => lineageRelated(identity, callerId, { workspaceId })),
  );
  const relatedSource = lineageSources.find((_identity, index) => relatedSources[index]);
  if (relatedSource) {
    const sourceLabel =
      implementer != null && relatedSource === implementer
        ? `acceptance-rubric author '${implementer}'`
        : `plan implementer '${relatedSource}'`;
    return {
      implementer,
      principalImplementers,
      callerIsImplementer: false,
      refusal: {
        code: 'grader_in_implementer_lineage',
        error:
          `grader '${callerId}' is in ${sourceLabel}'s spawn/rebind lineage — ` +
          'a related session cannot supply the independent grading. Do not recruit a grader yourself: ' +
          "plans:set-plan-status { slug:<the rubric's subject plan>, status:'shipped' } routes the grading " +
          "request through the relevance router, which excludes the implementer's lineage and mints a " +
          'lineage-safe judge when no eligible peer answers. Never launch a grader from this lineage',
        remedy: {
          summary:
            "Let the plan ship recruiter route the grading: plans:set-plan-status → 'shipped' on the " +
            "rubric's subject plan picks an independent grader for you.",
          steps: [
            "Call plans:set-plan-status { slug:<the rubric's subject plan>, status:'shipped' }. Its " +
              'acceptance_ungraded / self_graded_only refusal IS the recruiter: it routes the grading request ' +
              "through the relevance router, excludes the implementer's spawn/rebind lineage, cascades past a " +
              'decline and mints a lineage-safe judge when no eligible peer answers.',
            'If that call refuses with any other code (for example acceptance_bar_contract_not_ready), repair ' +
              'that first — recruitment fires only once grading is reachable — then call it again.',
            "Wait for the routed grader's scorecard; grade nothing from this lineage.",
          ],
          doesNotWork: [
            'Picking a peer yourself and messaging or assigning them the grading: it skips the router’s ' +
              'lineage screen, decline cascade and fresh-judge fallback, and a peer inside the lineage is ' +
              'refused only after a full boot.',
            'Launching a fresh grader session yourself: a session you spawn is in your lineage and is ' +
              'refused with this same code.',
          ],
          docRef: 'agent-insights/acceptance-rubrics-on-every-plan-runbook',
        },
      },
    };
  }

  // EI-21461866696604065: an acceptance rubric's sole vetting critic cannot also
  // be its independent grader. That collapses the intended three-party chain
  // (author -> critic -> grader) into two parties and makes the result
  // self-sealing: the grader is least able to notice the omissions in their own
  // critique. Read the same canonical meta-scorecards the acceptance gate trusts,
  // restricted to the current rubric revision.
  //
  // EI-21828643965337454: a failed revision read must not be flattened into "no
  // revision". The latter is a valid unversioned rubric; the former would make
  // the current-revision filter vacuously true and let the sole vetting critic
  // grade their own rubric. Refuse before reading scorecards so the failure
  // cannot be mistaken for an unvetted/empty history.
  const revisionRead = await readRubricPlanRevision(rubric.rubricId);
  if (!revisionRead.ok) {
    return {
      implementer,
      principalImplementers,
      callerIsImplementer: false,
      refusal: {
        code: 'grader_is_sole_vetting_critic_revision_unreadable',
        error:
          `acceptance rubric '${rubric.rubricId}' current revision could not be read, so the ` +
          `sole-vetting-critic guard cannot verify that its vetting attestation is current; ` +
          `retry after the rubric plan-row read recovers`,
      },
    };
  }
  const currentRevision = revisionRead.revision;
  // EI-22182364716054326: read the UNION of critics across every current-revision
  // vetting card (both channels), not just the first one a `.find()` happens to
  // return — see resolveAggregatedVettingCritics for why a single-card read
  // misreports a genuinely two-critic vetting as sole-critic.
  const { critics } = await resolveAggregatedVettingCritics(
    rubric.rubricId,
    currentRevision,
    rubric.criteriaHash,
    rubric.barContract?.meaningRevision,
  );
  // WI-905074: what preserves the three-party chain is an INDEPENDENT critic,
  // not a second row in the list. The old `critics.length === 1` made the
  // identity comparison unreachable for two or more critics, so a vetting record
  // whose critics all resolved to the grader's own identity/lineage was never
  // compared and sailed through the guard written to trip on it.
  if (critics.length > 0) {
    const criticResolvesToGrader = await Promise.all(
      critics.map((critic) => lineageRelated(critic, callerId, { workspaceId })),
    );
    if (criticResolvesToGrader.every(Boolean)) {
      const standing =
        critics.length === 1
          ? 'is the sole recorded vetting critic'
          : `is the only distinct party among the ${critics.length} recorded vetting critics`;
      return {
        implementer,
        principalImplementers,
        callerIsImplementer: false,
        refusal: {
          code: 'grader_is_sole_vetting_critic',
          error:
            `grader '${callerId}' ${standing} for acceptance rubric ` +
            `'${rubric.rubricId}' — no recorded critic is independent of the grader, so rubric ` +
            `fitness and work compliance would be attested by the same party; request a second ` +
            `genuinely independent critic through the router — consult:get_feedback ` +
            `{ policy:'rubric-vetting' } — and record its attestation at the current rubric ` +
            `revision before grading`,
          remedy: {
            summary:
              'Record a SECOND vetting critic who is genuinely independent of this grader, at ' +
              'the current rubric revision — then this same grader becomes eligible.',
            steps: [
              `Request the second critic through the router: consult:get_feedback { policy:'rubric-vetting', ` +
                `question:<ask for a critique of rubric '${rubric.rubricId}' at its CURRENT revision> }. ` +
                'The router picks and screens the critic; its answering session is outside your ' +
                'spawn/rebind lineage, so do not pick or message one yourself.',
              `Record that critique as a vetting attestation for rubric '${rubric.rubricId}' at its ` +
                'CURRENT revision with scorecards:emit against meta-acceptance-rubric, citing the consult ' +
                'as vettingConsult.',
              'Each attestation cites exactly one of vettingConsult / vettingWorkItem, but the guard ' +
                'unions critics across EVERY current-revision attestation on either channel, so a second ' +
                'consult-backed attestation counts alongside the first.',
              'Re-attempt the grading emit — the guard now sees a critic who is not you.',
            ],
            doesNotWork: [
              'A second critic in your OWN spawn/rebind lineage: critics are collapsed to the ' +
                'distinct PARTIES they represent, so a longer list of related identities still ' +
                'resolves to one party and this refusal stands.',
              'Grading FIRST to escape the ordering: with no attestation yet, the readiness ' +
                'projection reports bar_snapshot_vetting_missing/stale instead. The pair reads as a ' +
                'deadlock but is not one — the way out is a second INDEPENDENT critic, not a ' +
                'different order.',
              'Re-vetting the rubric yourself at a newer revision: that re-records the same sole ' +
                'party and changes nothing about independence.',
            ],
            docRef: 'agent-insights/acceptance-rubric-vetting',
          },
        },
      };
    }
  }

  return { implementer, principalImplementers, callerIsImplementer: false, refusal: null };
}
