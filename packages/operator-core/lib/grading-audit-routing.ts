/** Source-card adapter for the existing consult router, store and cascade. */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { ScorecardRow } from './scorecards';
import { resolveAgentIdentity, type ResolveIdentityCtx } from './agent-tools/coordination/identity';
import { lineagePartyKeys } from './acceptance-author-identity';
import { getFeedbackProd } from './consult/get-feedback-prod';
import type { RouteResult } from './consult/relevance-router';
import { resolveSessionStates, type LivenessVerdict } from './agent-tools/coordination/liveness-oracle';
import { GRADING_INTEGRITY_AUDIT_POLICY } from './consult/selection-policies';

export interface SourceAuditRouteInput {
  card: ScorecardRow;
  reservationKey: string;
  reservationReservedAt: string;
  brief: string;
  ctx: ResolveIdentityCtx;
  harness?: string;
}
export type SourceAuditRouteResult =
  | { state: 'routed' | 'deduped'; conversationId: string; reason?: string }
  | { state: 'reservation-lost'; reason: string }
  | { state: 'fallback'; reason: string };

const SPEC_QUALITY_RUBRIC_REF = 'spec-quality';
const SPEC_QUALITY_SUBJECT_REF = /^spec-set:[^:]+:[a-f\d]{64}:([a-f\d]{16})$/i;

/** Resolve the plan author from its immutable origin revision. The subject ref
 * intentionally contains only a truncated slug hash, so match it against the
 * scoped seq-1 revision spine and reject missing or ambiguous provenance. */
async function resolveSpecQualityPlanCreator(
  card: ScorecardRow,
  workspaceId: string,
  harness: string | undefined,
  sql: Sql,
): Promise<string | null> {
  if (card.rubricRef !== SPEC_QUALITY_RUBRIC_REF) return null;
  const harnessSlug = harness?.trim();
  const planKey = typeof card.subject?.ref === 'string'
    ? SPEC_QUALITY_SUBJECT_REF.exec(card.subject.ref)?.[1]?.toLowerCase()
    : undefined;
  if (!harnessSlug || !planKey) {
    throw new Error('source audit spec-quality plan creator provenance is missing or ambiguous; refusing reviewer selection');
  }

  const originRevisions = await sql<{ plan_slug: string; author_id: string | null }[]>`
    SELECT plan_slug, author_id
      FROM harness_shared.plan_revisions
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND seq = 1`;
  const matches = originRevisions.filter((revision) =>
    createHash('sha256').update(revision.plan_slug).digest('hex').slice(0, 16) === planKey,
  );
  const planSlugs = new Set(matches.map((revision) => revision.plan_slug));
  const authorIds = new Set(
    matches
      .map((revision) => revision.author_id?.trim())
      .filter((authorId): authorId is string => Boolean(authorId)),
  );
  if (
    planSlugs.size !== 1 ||
    authorIds.size !== 1 ||
    matches.some((revision) => !revision.author_id?.trim())
  ) {
    throw new Error('source audit spec-quality plan creator provenance is missing or ambiguous; refusing reviewer selection');
  }
  return [...authorIds][0]!;
}

/** Resolve lineage BEFORE selection so minimum-fill, refill and revival all
 * inherit the same independence fence. A resolver fault must fail closed. */
export async function independentSourceAuditRoute(
  route: RouteResult,
  card: ScorecardRow,
  workspaceId: string,
  resolveParties: typeof lineagePartyKeys = lineagePartyKeys,
  additionalSourceOwners: readonly string[] = [],
): Promise<RouteResult> {
  if (!card.createdBy?.trim()) throw new Error('source audit author is unknown; refusing reviewer selection');
  const sources = [...new Set([
    card.createdBy,
    ...(card.vetting?.critics ?? []),
    ...additionalSourceOwners,
  ].filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))];
  const candidates = [...route.snapshot.candidates, ...route.qualified];
  const ids = [...new Set([...sources, ...candidates.map((c) => c.ownerId)])];
  const parties = await resolveParties(ids, { workspaceId });
  if (ids.some((id) => !parties.has(id))) throw new Error('source audit lineage resolution is incomplete');
  const excluded = new Set(sources.map((id) => parties.get(id)));
  const allowed = (c: RouteResult['qualified'][number]) => !excluded.has(parties.get(c.ownerId));
  return { ...route, qualified: route.qualified.filter(allowed), snapshot: {
    ...route.snapshot, candidates: route.snapshot.candidates.filter(allowed),
  } };
}

export async function routeSourceGradingAudit(
  input: SourceAuditRouteInput,
  deps: {
    getSql?: () => Sql;
    feedback?: typeof getFeedbackProd;
    /** The only authorized route is the dispatcher that still owns this exact lease epoch. */
    confirmReservation?: () => Promise<boolean>;
    resolveParties?: typeof lineagePartyKeys;
    resolveResponderLiveness?: (
      ownerId: string,
    ) => Promise<Pick<LivenessVerdict, 'sessionState'> | null | undefined>;
  } = {},
): Promise<SourceAuditRouteResult> {
  const identity = resolveAgentIdentity(input.ctx);
  const workspaceId = input.ctx.workspaceId?.trim() || identity.workspaceId;
  if (!workspaceId) throw new Error('source audit workspace is unknown');
  const confirmReservation = deps.confirmReservation;
  if (!input.reservationReservedAt?.trim() || !confirmReservation || !(await confirmReservation())) {
    return { state: 'reservation-lost', reason: 'current grading-audit reservation epoch is not owned by this dispatch' };
  }
  const sql = (deps.getSql ?? (() => getOrgPg().sql))();
  if (!input.card.createdBy?.trim()) throw new Error('source audit author is unknown; refusing reviewer selection');
  const specQualityPlanCreator = await resolveSpecQualityPlanCreator(input.card, workspaceId, input.harness, sql);
  const sourceOwners = [...new Set([
    input.card.createdBy,
    ...(input.card.vetting?.critics ?? []),
    ...(specQualityPlanCreator ? [specQualityPlanCreator] : []),
  ].filter((owner): owner is string => typeof owner === 'string' && Boolean(owner.trim())).map((owner) => owner.trim()))];
  const resolveParties = deps.resolveParties ?? lineagePartyKeys;
  const resolveResponderState =
    deps.resolveResponderLiveness ??
    (async (ownerId: string) => {
      try {
        return (
          (await resolveSessionStates([{ ownerId }], {
            hydratePerId: true,
            psuHostPositiveAuthority: true,
          })).get(ownerId) ?? null
        );
      } catch {
        return null;
      }
    });
  // The card reservation already serializes creation. On its TTL retry, reuse
  // a still-active chain instead of recruiting a second auditor.
  const active = await sql<{
    conversation_id: string;
    state: string;
    dispatch: string | null;
    responder_id: string | null;
  }[]>`
    SELECT conversation_id, state, outcome->>'dispatch' AS dispatch, responder_id
      FROM harness_shared.consult_state
    WHERE workspace_id = ${workspaceId}
      AND routing->'cascade'->>'flavor' = 'grading-integrity'
      AND routing->'cascade'->>'reservationKey' = ${input.reservationKey}
    ORDER BY created_at DESC LIMIT 1`;
  if (active[0]?.dispatch === 'launch-fallback') return { state: 'fallback', reason: 'existing router: reuse reserved launch fallback' };
  let retiredStaleResponder = false;
  if (active[0] && ['awaiting_responder', 'active'].includes(active[0].state)) {
    const activeResponderId = active[0].responder_id;
    if (activeResponderId) {
      const lineageIds = [...new Set([...sourceOwners, activeResponderId])];
      const parties = await resolveParties(lineageIds, { workspaceId });
      if (lineageIds.some((id) => !parties.has(id))) {
        throw new Error('source audit lineage resolution is incomplete');
      }
      const excludedParties = new Set(sourceOwners.map((owner) => parties.get(owner)));
      if (excludedParties.has(parties.get(activeResponderId))) {
        // Do not keep deduping a persisted consult that was routed to the plan
        // creator (or their lineage) before this independence fence existed.
        await sql`
          UPDATE harness_shared.consult_state
             SET state = 'expired', closed_at = now(), updated_at = now(),
                 outcome = jsonb_build_object(
                   'dispatch', 'excluded-source-lineage',
                   'responderId', ${activeResponderId}::text
                 )
           WHERE workspace_id = ${workspaceId}
             AND conversation_id = ${active[0].conversation_id}
             AND state IN ('awaiting_responder', 'active')`;
        retiredStaleResponder = true;
      }
    }
    if (!retiredStaleResponder) {
      // A reservation can outlive the responder it delivered to. Dedupe only
      // when the persisted responder is not positively known to be terminal or
      // non-wakeable; an unknown/degraded liveness read preserves the previous
      // fail-open dedupe behavior rather than creating a duplicate audit.
      const responderState = active[0].responder_id
        ? await resolveResponderState(active[0].responder_id)
        : null;
      if (responderState?.sessionState === 'ended' || responderState?.sessionState === 'recorded') {
        // Retire the stranded row before routing a fresh audit. Without this,
        // the expiry sweep can later advance the dead chain alongside the retry.
        await sql`
          UPDATE harness_shared.consult_state
             SET state = 'expired', closed_at = now(), updated_at = now(),
                 outcome = jsonb_build_object(
                   'dispatch', 'stale-responder',
                   'responderId', ${active[0].responder_id}::text,
                   'sessionState', ${responderState.sessionState}::text
                 )
           WHERE workspace_id = ${workspaceId}
             AND conversation_id = ${active[0].conversation_id}
             AND state IN ('awaiting_responder', 'active')`;
        retiredStaleResponder = true;
      } else {
        return { state: 'deduped', conversationId: active[0].conversation_id };
      }
    }
  }
  if (active[0] && !retiredStaleResponder && active[0].state !== 'closed_answered') {
    return { state: 'fallback', reason: `existing router cascade exhausted (${active[0].state}); bounded launch fallback` };
  }
  if (!(await confirmReservation())) {
    return { state: 'reservation-lost', reason: 'grading-audit reservation changed before consult recruitment' };
  }
  const result = await (deps.feedback ?? getFeedbackProd)({
    workspaceId, requesterId: identity.ownerId,
    question: input.brief,
    originTaskRef: input.card.issueId,
    excludeOwners: sourceOwners,
    archiveFloor: 2,
    policy: GRADING_INTEGRITY_AUDIT_POLICY,
    latencyContract: 'hard-blocked',
    ...(input.harness ? { harnessSlug: input.harness } : {}),
    cascade: { flavor: 'grading-integrity', issueId: input.card.issueId,
      reservationKey: input.reservationKey, reservationReservedAt: input.reservationReservedAt, brief: input.brief },
  }, identity, {
    filterRoute: (route) => independentSourceAuditRoute(
      route,
      input.card,
      workspaceId,
      resolveParties,
      specQualityPlanCreator ? [specQualityPlanCreator] : [],
    ),
  });
  if ('error' in result) throw new Error(`source audit routing refused: ${result.error}`);
  if (result.verdict === 'routed') {
    // EI-23146582794512094: selection and durable delivery are separated by a
    // small race. A candidate can be ranked LIVE, accept the queued notify, and
    // already be only a recorded/non-wakeable launch trace by the time this
    // adapter returns. The retry path below has always retired such responders,
    // but the reservation lease suppresses that retry for fifteen minutes. Do
    // the same authoritative liveness check in the initial epoch so the caller
    // can take its bounded fresh-judge fallback immediately.
    const routedResponder = result.responder?.ownerId;
    const responderState = routedResponder ? await resolveResponderState(routedResponder) : null;
    if (
      routedResponder &&
      (responderState?.sessionState === 'ended' || responderState?.sessionState === 'recorded')
    ) {
      const retired = await sql<{ conversation_id: string }[]>`
        UPDATE harness_shared.consult_state
           SET state = 'expired', closed_at = now(), updated_at = now(),
               outcome = jsonb_build_object(
                 'dispatch', 'stale-responder',
                 'responderId', ${routedResponder}::text,
                 'sessionState', ${responderState.sessionState}::text,
                 'phase', 'post-route'
               )
         WHERE workspace_id = ${workspaceId}
           AND conversation_id = ${result.conversation_id}
           AND responder_id = ${routedResponder}
           AND state IN ('awaiting_responder', 'active')
       RETURNING conversation_id`;
      if (retired[0]) {
        return {
          state: 'fallback',
          reason:
            `new router responder ${routedResponder} became ${responderState.sessionState} before pickup; ` +
            'bounded launch fallback',
        };
      }
    }
    return {
      state: 'routed', conversationId: result.conversation_id,
      reason: 'Independent audit routed; declines and expiry advance the persisted cascade. Exact scorecard emission settles it.',
    };
  }
  // No responder was selected. Retire this empty row before the existing fresh
  // judge fallback runs; an expiry must not revive it alongside that judge.
  await sql`
    UPDATE harness_shared.consult_state SET state = 'expired', closed_at = now(), updated_at = now(),
      outcome = jsonb_build_object('dispatch', 'launch-fallback')
    WHERE workspace_id = ${workspaceId} AND conversation_id = ${result.conversation_id}
      AND responder_id IS NULL AND state IN ('no_qualified_responder', 'awaiting_responder', 'active')`;
  return { state: 'fallback', reason: `existing router: ${result.verdict}${result.reason ? ` (${result.reason})` : ''}` };
}

/** Called only after exact-card settlement; never advance to a second audit. */
export async function closeSourceAuditConsults(workspaceId: string, issueId: string, sql: Sql = getOrgPg().sql): Promise<void> {
  await sql`
    UPDATE harness_shared.consult_state
    SET state = 'closed_answered', closed_at = now(), updated_at = now(),
        outcome = jsonb_build_object('source', 'grading-integrity', 'issueId', ${issueId}::text)
    WHERE workspace_id = ${workspaceId}
      AND routing->'cascade'->>'flavor' = 'grading-integrity'
      AND routing->'cascade'->>'issueId' = ${issueId}
      AND state IN ('awaiting_responder', 'active', 'no_qualified_responder', 'expired')`;
}
