/**
 * grading-cascade.ts — the ACCEPTANCE-GRADING flavour of the shared consult
 * cascade (unified-responder-selection-critique-and-grading-2026-08-30, D-003 +
 * D-005 [owner]).
 *
 * WHAT CHANGED AND WHY THERE IS A FILE HERE AT ALL. Grading used to select
 * exactly one grader and wake them once. D-001/D-003 make the grader menu min 1
 * / max 2 delivered as a CASCADE: grader 2 is woken only after grader 1 replies,
 * declines or expires, and is woken HOLDING grader 1's card. D-005 then ruled
 * that the advance mechanism is not to be re-implemented here — grading consumes
 * `cascade-core`'s existing CAS-guarded advance, the same one the critique
 * consult, the decline verb and the expiry sweep share.
 *
 * So the only thing grading legitimately owns is COPY: what the next grader is
 * told when the cursor moves. The consult copy is not merely stylistically wrong
 * for a grader, it is substantively wrong — it instructs the woken agent to
 * "answer FROM your transcript, citing evidence", which is precisely what a
 * grader must NOT do. A grade is made from the plan, the rubric and the code.
 *
 * HOW THE COPY REACHES THE ADVANCE, without every trigger having to know.
 * The flavour rides on the PERSISTED routing snapshot (`routing.cascade`), and
 * `cascade-core` derives the copy writer from the row it is already reading.
 * That matters because three of the four triggers are generic: the decline verb
 * and the expiry sweep advance whatever row they find, and neither has any way
 * to know it is holding a grading cascade. Had the copy been a parameter each
 * caller passes, a grader woken by an expiry would silently get consult copy —
 * the same cascade producing different instructions depending on which trigger
 * happened to fire. Deriving it from the row makes that unrepresentable.
 *
 * This module is deliberately PURE (types + string building, no I/O and no
 * import of `cascade-core`'s runtime): `cascade-core` imports the writer, so a
 * runtime dependency back the other way would be a genuine module cycle.
 * Orchestration — opening the cascade row, and advancing it when a card is filed
 * — lives with the gate in `acceptance-grader.ts`.
 */
import type { CascadeWakeContext, CascadeWakeCopy, CascadeWakeCopyWriter } from './cascade-core';
import { qualifyingScoreOf } from './relevance-router';
import type { ObservationRatings } from '../harness/improvements/observation-types';
import type { AcceptanceReviewReservationRef } from '../coord/condition-upsert';

/** The persisted `routing.cascade.flavor` discriminator. */
export const GRADING_CASCADE_FLAVOR = 'acceptance-grading';

/** Source-card audits share the cascade, but settle exactly one card. */
export interface SourceAuditCascadeMeta {
  flavor: 'grading-integrity';
  issueId: string;
  reservationKey: string;
  /** Absent only on cascade rows written before reservation-epoch fencing. */
  reservationReservedAt?: string;
  brief: string;
}

export function sourceAuditCascadeMetaFromRouting(routing: unknown): SourceAuditCascadeMeta | null {
  let snap = routing;
  if (typeof snap === 'string') {
    try { snap = JSON.parse(snap); } catch { return null; }
  }
  const block = (snap as { cascade?: Partial<SourceAuditCascadeMeta> } | null)?.cascade;
  return block?.flavor === 'grading-integrity' && typeof block.issueId === 'string' &&
    typeof block.reservationKey === 'string' && typeof block.brief === 'string'
    ? block as SourceAuditCascadeMeta : null;
}

export function sourceAuditWakeCopy(meta: SourceAuditCascadeMeta, conversationId: string): CascadeWakeCopy {
  const reservationGuidance = meta.reservationReservedAt
    ? `Dispatch lease: key '${meta.reservationKey}', reservedAt '${meta.reservationReservedAt}'. ` +
      `Before reading criterion evidence, re-read the exact target and proceed only if its pending ` +
      `grading-audit reservation matches both values. If it does not, report the current state and stop.`
    : 'Legacy grading-audit route: no reservation epoch token is recorded. Do not read evidence or emit; report the missing epoch and stop.';
  return {
    summary: `Grading-integrity audit: ${meta.issueId}`,
    body: `${meta.brief}\n\nThe existing relevance router selected you as an independent audit candidate; ` +
      `selection can be best-available below the floor. Audit the stored evidence on its merits; ` +
      `selection is not a claim that your transcript proves the result.\n` +
      `${reservationGuidance}\n` +
      `Read the request in conversations:get { id:${JSON.stringify(conversationId)} }. ` +
      `If unable to audit, use consult:decline { conversation_id:${JSON.stringify(conversationId)}, reason:'...' }; ` +
      `the existing cascade selects the next candidate. Emit the exact audit card to finish; a consult reply does not settle it. ` +
      `A successful emit ALSO closes this consult (closed_answered) — do not reply, and do not call ` +
      `consult:close, afterward (it will refuse: the consult is no longer open).`,
  };
}

/**
 * What a grading cascade must carry on its row so ANY trigger can render the
 * next wake. Kept to identity only — everything else (position, via, digest)
 * comes from the cascade state itself, so this block cannot go stale mid-chain.
 */
export interface GradingCascadeMeta {
  flavor: typeof GRADING_CASCADE_FLAVOR;
  planSlug: string;
  rubricId: string;
  /** The plan's harness; null when the plan is not harness-scoped. Carried
   * because a grader's session may sit in a different hive and every read the
   * brief asks for has to name the subject tree explicitly. */
  harnessSlug: string | null;
  /** The durable acceptance assignment this cascade is servicing. */
  reservation?: AcceptanceReviewReservationRef;
}

/** Shared line used by fresh-judge and cascade briefs; key and id are both
 * intentional so an operator can reconcile a retry from either surface. */
export function acceptanceReviewReservationGuidance(
  reservation?: AcceptanceReviewReservationRef,
): string {
  if (!reservation) return '';
  return (
    `Dispatch reservation: condition key '${reservation.conditionKey}', canonical work-item ` +
    `'${reservation.id ?? 'unassigned'}'. Reuse this exact reservation for retries of the same ` +
    `workspace/harness/plan/rubric/revision target; a changed target must receive a new key.`
  );
}

/**
 * Read the grading flavour back off a persisted routing snapshot. Tolerant of
 * the jsonb-as-string round trip the driver can hand back (the same quirk
 * `selectionFromRouting` absorbs), and returns null for every non-grading row —
 * absence is the ordinary case, never an error.
 */
export function gradingCascadeMetaFromRouting(routing: unknown): GradingCascadeMeta | null {
  let snap: unknown = routing;
  if (typeof snap === 'string') {
    try {
      snap = JSON.parse(snap) as unknown;
    } catch {
      return null;
    }
  }
  const block = (snap as { cascade?: unknown } | null)?.cascade as Partial<GradingCascadeMeta> | undefined;
  if (!block || block.flavor !== GRADING_CASCADE_FLAVOR) return null;
  if (typeof block.planSlug !== 'string' || typeof block.rubricId !== 'string') return null;
  const rawReservation = block.reservation;
  const reservation =
    rawReservation &&
    typeof rawReservation === 'object' &&
    !Array.isArray(rawReservation) &&
    typeof (rawReservation as { conditionKey?: unknown }).conditionKey === 'string' &&
    (typeof (rawReservation as { id?: unknown }).id === 'string' ||
      (rawReservation as { id?: unknown }).id === null ||
      (rawReservation as { id?: unknown }).id === undefined)
      ? {
          conditionKey: (rawReservation as { conditionKey: string }).conditionKey,
          id:
            typeof (rawReservation as { id?: unknown }).id === 'string'
              ? (rawReservation as { id: string }).id
              : null,
        }
      : undefined;
  return {
    flavor: GRADING_CASCADE_FLAVOR,
    planSlug: block.planSlug,
    rubricId: block.rubricId,
    harnessSlug: typeof block.harnessSlug === 'string' ? block.harnessSlug : null,
    ...(reservation ? { reservation } : {}),
  };
}

/**
 * How a grader spot-checks the implementer's audit citations.
 *
 * A superproject records a nested submodule as a gitlink, not as a tree of
 * blobs, so asking the superproject to resolve a file below that gitlink is an
 * expected miss rather than evidence that the audit fabricated the path.
 */
export const ACCEPTANCE_CITATION_SPOT_CHECK_GUIDANCE =
  "For manual citation spot-checks, first resolve the subject harness checkout (a fresh judge is launched in it; a cross-hive judge can use `harness:phase_path` for the subject staging path), then use `capability:read` on the cited repository-relative path there. Do not use the grader's checkout as a substitute. For a path below a git submodule (for example `libs/papercusp/...`), the superproject stores only a gitlink: `git rev-parse <superproject-ref>:<nested-path>` and `git show <superproject-ref>:<nested-path>` are expected to fail and are not evidence of a fabricated citation. Inspect the working-tree file or, when history is required, inspect the superproject gitlink and run `capability:git` with `cwd` set to the nested submodule and its pinned submodule SHA. Mark a citation unresolved only when the subject root or the relevant submodule cannot resolve it.";

/**
 * Why a grader may not decline on claim-scope grounds (EI-20249725405239230).
 *
 * MEASURED: the recruited peer declined TWICE because their fleet mission was
 * execute-fleet-plan-only and a grading request matches no fleet claim spec, so
 * they read it as structurally inadmissible. That reasoning is WRONG, and
 * nothing in the copy told them so: `scorecards:emit` declares
 * `capability: 'coord:write'` with `requirePrincipal: false` and gates on no
 * claim, no assignee and no fleet admission anywhere. The objection is a
 * phantom, but a phantom is indistinguishable from a real floor to the agent
 * holding it.
 *
 * This is the SECOND decline reason the briefs pre-empt — "do not decline
 * solely for lack of prior context" already handles the first. It sits in
 * `graderReadingInstructions` because that is the single point all three
 * grader-facing paths render through (assigned brief, minimum-fill brief,
 * cascade wake k+1), so no path can be told a different thing.
 */
export const ACCEPTANCE_GRADING_NO_CLAIM_FACT =
  'Grading needs NO work-item claim and NO fleet-scope admission — scorecards:emit requires neither — so a fleet mission or claim spec that cannot represent the request is not a reason to decline it.';

/**
 * The grader-facing rendering of the fact above. The author-facing refusals in
 * `plan-acceptance-gate.ts` import the FACT and add their own framing ("say so
 * when you ask"), so the claim itself is single-sourced across both audiences
 * and cannot drift into two different statements of what emit requires.
 */
export const ACCEPTANCE_GRADING_NO_CLAIM_GUIDANCE = `${ACCEPTANCE_GRADING_NO_CLAIM_FACT} Emit the card directly.`;

/**
 * The criterion's declared evidence plane and scope define what the grader must
 * prove. A missing signal on another plane cannot lower the rating, and a
 * degraded/unknown explanation must identify the exact declared requirement
 * that could not be verified.
 */
export const ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE =
  "For each rubric criterion, use its own structured `evidencePlane` and `requiredScope` as the authority for what evidence is required. Judge only those declared requirements. Do not mark a criterion degraded or unknown because evidence from an undeclared plane or scope is missing, denied, or unavailable. For a degraded or unknown rating, name the specific declared scope dimension and evidence plane that remains unproven, plus the read that failed. Example: for a tree-plane R-3 requiring the current-build portal, a current-build tree positive with a deployed-only 403 remains healthy; the production denial does not negate the tree criterion unless deployed proof is explicitly required.";

/** The reads a grader has to do, rendered with the subject harness pinned. */
function graderReadingInstructions(
  planSlug: string,
  harnessSlug: string | null,
  rubricId: string,
  reservation?: AcceptanceReviewReservationRef,
): string {
  const planRead = harnessSlug
    ? `plans:get { slug:${JSON.stringify(planSlug)}, harness:${JSON.stringify(harnessSlug)} }`
    : `plans:get { slug:${JSON.stringify(planSlug)} }`;
  const targetHive = harnessSlug ? `, targetHive:${JSON.stringify(harnessSlug)}` : '';
  return (
    `Because your session may be in a different hive, keep the plan harness explicit: read the plan ` +
    `(${planRead}) + the acceptance rubric '${rubricId}' + the completion evidence, then emit ONE complete ` +
    `scorecard: scorecards:emit { rubricRef:${JSON.stringify(rubricId)}${targetHive}, ratings:{ <every criterion key> } } ` +
    `with concrete evidence per rating. ${ACCEPTANCE_GRADING_NO_CLAIM_GUIDANCE} ${ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE} The targetHive makes ` +
    `deterministic checks run against the subject ` +
    `tree rather than the grader's checkout. ${ACCEPTANCE_CITATION_SPOT_CHECK_GUIDANCE} ` +
    `${acceptanceReviewReservationGuidance(reservation)} The verdict is YOURS — ` +
    `consult if you need to, but the grade is not delegable.`
  );
}

/**
 * The FIRST grader's brief (cursor 0 — nobody has graded yet, so there is no
 * carry). Kept in the same module as the cascade copy so the two cannot drift
 * into telling a grader different things depending on their position.
 */
export function buildAssignedAcceptanceGraderBrief(
  planSlug: string,
  harnessSlug: string | null,
  rubricId: string,
  reservation?: AcceptanceReviewReservationRef,
): string {
  return (
    `The relevance router selected you to grade plan '${planSlug}' — your transcript history matched the ` +
    `plan + rubric above the precision floor and you are outside its implementer/consult-participant ` +
    `exclusion set (D-009 independence). ${graderReadingInstructions(planSlug, harnessSlug, rubricId, reservation)}`
  );
}

/**
 * The FIRST grader's brief when they are a MINIMUM-FILL pick (D-002 [owner]:
 * below-floor now fills instead of minting a fresh session). Honest by
 * construction — claiming router relevance for a below-floor pick is the
 * specific dishonesty D-002's own text warns about, and a grader who believes
 * they were matched on expertise grades with unearned confidence.
 */
export function buildMinimumFillAcceptanceGraderBrief(
  planSlug: string,
  harnessSlug: string | null,
  rubricId: string,
  reservation?: AcceptanceReviewReservationRef,
): string {
  return (
    `You were selected to grade plan '${planSlug}' as the BEST-AVAILABLE independent grader — BELOW the ` +
    `relevance floor. Your transcript is NOT claimed to cover this plan; you were chosen because you are ` +
    `outside its implementer/consult-participant exclusion set and grading requires an independent grader. ` +
    `Grade it FIRST-PRINCIPLES from the plan, the rubric and the code — do not decline solely for lack of ` +
    `prior context, and do not present unfamiliarity as a finding. ` +
    `${graderReadingInstructions(planSlug, harnessSlug, rubricId, reservation)}`
  );
}

/**
 * Compress a filed card into the digest excerpt grader k+1 carries.
 *
 * RATINGS, NOT EVIDENCE. `makeDigestEntry` caps an excerpt at 400 characters, so
 * a card that spent its budget on one criterion's evidence would arrive at
 * grader 2 as a truncated fragment of a single rating — worse than useless,
 * because a partial view of one criterion reads as the whole verdict. The
 * per-criterion RATINGS are what grader 2 must be able to contest; the evidence
 * behind them is one `scorecards:list` away and the wake body names the thread.
 */
export function gradingCardDigestExcerpt(ratings: ObservationRatings): string {
  const entries = Object.entries(ratings);
  if (entries.length === 0) return 'filed a card with no ratings';
  return entries.map(([criterion, entry]) => `${criterion}=${entry.rating}`).join(', ');
}

/** Why THIS grader, for a cascade wake — one line, honest about `via`. */
function whyThisGrader(next: CascadeWakeContext['next']): string {
  return next.via === 'minimum'
    ? `You are the BEST-AVAILABLE independent grader (relevance ${qualifyingScoreOf(next).toFixed(2)}, sim ${next.similarity.toFixed(2)} — BELOW the relevance floor). Your transcript is not claimed to cover this plan: grade it FIRST-PRINCIPLES from the plan, the rubric and the code, and do not decline solely for lack of prior context.`
    : `You matched the plan + rubric above the relevance floor (relevance ${qualifyingScoreOf(next).toFixed(2)}, sim ${next.similarity.toFixed(2)}) and are outside the implementer/consult-participant exclusion set.`;
}

/**
 * The cascade wake copy for grader k+1.
 *
 * The carried digest is grader k's card. D-003 [owner] chose this over a blind
 * fan-out with its cost stated: a carried card ANCHORS the second grader, so
 * the second grading is a REVIEW of the first, not an independent second sample.
 * The copy says exactly that rather than letting the grader assume otherwise —
 * and nothing downstream may describe the pair as two independent gradings.
 */
export function gradingCascadeWakeCopy(meta: GradingCascadeMeta): CascadeWakeCopyWriter {
  return (ctx: CascadeWakeContext): CascadeWakeCopy => {
    const priorLines =
      ctx.digest.length === 0
        ? '(none — every earlier grader declined or expired without filing a card)'
        : ctx.digest.map((entry) => `- ${entry.ownerId} (${entry.kind}): ${entry.excerpt}`).join('\n');
    return {
      summary:
        `⚖️ acceptance grading (grader ${ctx.position}/${ctx.menuSize}` +
        `${ctx.extension ? `, ${ctx.extension}` : ''}): plan ${meta.planSlug}`,
      body:
        `ACCEPTANCE GRADING — you are grader ${ctx.position}/${ctx.menuSize} for plan '${meta.planSlug}' ` +
        `(rubric ${meta.rubricId}). The chain advanced to you because the previous grader replied, declined ` +
        `or expired.\n` +
        `${whyThisGrader(ctx.next)}\n` +
        `GRADING SO FAR — this is a REVIEW of it, not a blind second sample; you have SEEN the card below, ` +
        `so do not let it stand unchallenged if it is wrong, and do not treat agreement with it as ` +
        `independent corroboration (D-003). The full thread is conversation ${ctx.conversationId}:\n` +
        `${priorLines}\n` +
        `${graderReadingInstructions(meta.planSlug, meta.harnessSlug, meta.rubricId, meta.reservation)}\n` +
        `After you emit your scorecard, post it into the conversation with ` +
        `consult:reply { conversation_id:${JSON.stringify(ctx.conversationId)}, kind:'answer', ... } so the ` +
        `chain records your verdict; consult:decline closes your slot and advances to the next grader.`,
    };
  };
}
