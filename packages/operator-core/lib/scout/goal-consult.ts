/**
 * goal-consult.ts — D-010's independent-review seam for the Blender goal rail.
 *
 * The existing consult substrate is reused end-to-end: getFeedbackCore owns
 * selection, conversation persistence, wake/cascade, archive-first serving and
 * expiry. This module adds only the Scout-shaped adapter and continuation read.
 * A live review is asynchronous, so the proposal + conversation id ride in the
 * existing scout_cycle_stage_artifacts row; the next Scout cycle resumes a
 * terminal answer/unavailable disposition. No parallel queue or table exists.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { GetFeedbackError, GetFeedbackRequest, GetFeedbackResult } from '../consult/get-feedback-core';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { activeWorkspaceId } from '../workspace-registry';
import type { GoalFeedbackConsultPort } from './router';
import type { CreativeLens, Proposal, ProposalConsultation, ProposalSourceIdeaProvenance } from './types';

export const GOAL_CONSULT_ARTIFACT_LIMIT = 30;
const FEEDBACK_MAX_CHARS = 4_000;

export interface GoalConsultPortOptions {
  harnessSlug: string;
  cycleId: string;
  workspaceId?: string;
  requesterId?: string;
}

export type GoalFeedbackRunner = (
  request: GetFeedbackRequest,
  identity: AgentIdentity,
  harnessSlug: string,
) => Promise<GetFeedbackResult | GetFeedbackError>;

function trimText(value: string, max = FEEDBACK_MAX_CHARS): string {
  return value.trim().slice(0, max);
}

/** Extract a usable critique from the structured consult outcome. Archive
 * results wrap the source outcome under `answer`, so recurse through that seam. */
export function extractGoalConsultFeedback(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') return trimText(value) || null;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractGoalConsultFeedback(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length ? trimText(parts.join('\n')) : null;
  }
  if (typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  for (const key of ['answer', 'feedback', 'critique', 'summary']) {
    const extracted = extractGoalConsultFeedback(row[key], depth + 1);
    if (extracted) return extracted;
  }
  return null;
}

/** The proposal body writers consume this field, so adding the disposition here
 * is the actual "fold back" seam for both creation and amendment. */
export function withGoalConsultation(proposal: Proposal, consultation: ProposalConsultation): Proposal {
  return { ...proposal, consultation };
}

export function goalConsultQuestion(proposal: Proposal, targetGoalId?: string): string {
  const shape = targetGoalId ? `amend existing goal ${targetGoalId}` : 'create and auto-start a new bounded goal';
  return trimText(
    [
      `Independent Blender review before this proposal may ${shape}.`,
      `Framing: ${proposal.framing}`,
      `Mechanism: ${proposal.mechanism}`,
      `Why new: ${proposal.whyNew}`,
      `Bet: ${proposal.bet}`,
      `Cheap experiment: ${proposal.cheapExperiment?.method ?? '(missing)'}`,
      `Falsifier: ${proposal.cheapExperiment?.falsifiableSignal ?? '(missing)'}`,
      'Identify concrete failure modes or corrections. This is advice and evidence, not an approval gate.',
    ].join('\n\n'),
  );
}

function resultToConsultation(
  result: GetFeedbackResult | GetFeedbackError,
  opts: GoalConsultPortOptions,
  proposal: Proposal,
): ProposalConsultation {
  if ('error' in result) {
    return {
      originCycleId: opts.cycleId,
      originalProposalId: proposal.id,
      conversationId: null,
      status: 'unavailable',
      state: result.error,
      verdict: 'failed',
      reason: trimText(result.hint),
    };
  }

  const base = {
    originCycleId: opts.cycleId,
    originalProposalId: proposal.id,
    conversationId: result.conversation_id,
    state: result.state,
    reviewerId: result.responder?.ownerId ?? result.archive?.responder_id ?? undefined,
  };
  if (result.verdict === 'routed') {
    return { ...base, status: 'pending', verdict: 'routed' };
  }
  if (result.verdict === 'served_from_archive') {
    const feedback = extractGoalConsultFeedback(result.archive?.answer);
    return {
      ...base,
      status: feedback ? 'answered' : 'unavailable',
      verdict: 'served_from_archive',
      ...(feedback ? { feedback } : { reason: 'archive result carried no extractable critique' }),
    };
  }
  // Carry the verdict through rather than re-labelling it. `routed` and
  // `served_from_archive` returned above, so this narrows to the two
  // unavailable verdicts — and flattening them to `no_qualified_responder`
  // here would re-introduce EI-21485716602970457 one layer up, where the
  // typechecker cannot see it: a hardcoded literal is always well-typed.
  // `status` stays 'unavailable' for both; only the audit label differs.
  return {
    ...base,
    status: 'unavailable',
    verdict: result.verdict,
    reason: trimText([result.reason, result.hint].filter(Boolean).join(': ')),
  };
}

/** Scout-shaped adapter over getFeedbackCore. A routed live reviewer defers the
 * write; archive/unavailable results proceed immediately with their disposition. */
export function buildGoalFeedbackConsultPort(
  opts: GoalConsultPortOptions,
  run: GoalFeedbackRunner = runGoalFeedbackProd,
): GoalFeedbackConsultPort {
  return async ({ proposal, targetGoalId }) => {
    const workspaceId = opts.workspaceId ?? activeWorkspaceId();
    const requesterId = opts.requesterId ?? `system:scout:${opts.harnessSlug}`;
    const identity: AgentIdentity = {
      ownerId: requesterId,
      ownerLabel: `Scout · ${opts.harnessSlug}`,
      source: 'event-reaction',
      workspaceId,
      userId: null,
    };
    try {
      const result = await run(
        {
          workspaceId,
          requesterId,
          question: goalConsultQuestion(proposal, targetGoalId),
          observed: `Blender proposal ${proposal.id} is classified for the goal rail${targetGoalId ? ` with target ${targetGoalId}` : ' as creation'}.`,
          decisionAtStake: 'What critique must be carried into the goal creation/amendment before dispatch?',
          latencyContract: 'proceed',
          originTaskRef: trimText(`scout-goal:${opts.cycleId}:${proposal.id}`, 120),
          minResponders: 1,
          maxResponders: 3,
          topics: ['blender', 'goal'],
          harnessSlug: opts.harnessSlug,
        },
        identity,
        opts.harnessSlug,
      );
      const consultation = resultToConsultation(result, opts, proposal);
      return { proposal: withGoalConsultation(proposal, consultation), consultation };
    } catch (error) {
      const consultation: ProposalConsultation = {
        originCycleId: opts.cycleId,
        originalProposalId: proposal.id,
        conversationId: null,
        status: 'unavailable',
        state: 'binding_error',
        verdict: 'failed',
        reason: trimText(error instanceof Error ? error.message : String(error), 1_000),
      };
      return { proposal: withGoalConsultation(proposal, consultation), consultation };
    }
  };
}

/** Production binding copied from the consult tool only at the dependency seam;
 * all behavior remains in the shared getFeedbackCore/relevance/conversation code. */
async function runGoalFeedbackProd(
  request: GetFeedbackRequest,
  identity: AgentIdentity,
  harnessSlug: string,
): Promise<GetFeedbackResult | GetFeedbackError> {
  const [
    { getFeedbackCore },
    { routeConsult },
    { buildQueryEmbedderResolved },
    { resolveProseProfileSelection },
    { resolveSessionStates },
    conversations,
    { notifyAgents },
  ] = await Promise.all([
    import('../consult/get-feedback-core'),
    import('../consult/relevance-router'),
    import('../agent-tools/search/embedder'),
    import('../search/prose-vector-dims'),
    import('../agent-tools/coordination/liveness-oracle'),
    import('../agent-tools/coordination/conversations'),
    import('../agent-tools/coordination/notify-agents'),
  ]);
  const resolved = await buildQueryEmbedderResolved();
  const embeddingProfile = resolved
    ? resolveProseProfileSelection(resolved.mode, resolved.profile)
    : null;
  return getFeedbackCore(request, {
    getSql: () => getOrgPg().sql,
    route: (params) =>
      routeConsult(params, {
        getSql: () => getOrgPg().sql,
        embed: resolved?.embed ?? null,
        embeddingProfile,
        embeddingMode: embeddingProfile && resolved ? resolved.mode : null,
        getLiveness: async (ownerIds) => {
          const verdicts = await resolveSessionStates(
            ownerIds.map((ownerId) => ({ ownerId })),
            { hydratePerId: true },
          );
          return Object.fromEntries([...verdicts.values()].map((v) => [v.ownerId, v.sessionState]));
        },
      }),
    open: async (input) => {
      const opened = await conversations.openConversation(identity, {
        ...input,
        producer: 'scout:goal-consult',
      });
      return {
        conversation_id: opened.conversation.id,
        thread_id: opened.thread_id,
        delivered: opened.delivered,
      };
    },
    reach: async (reach) => {
      const result = await notifyAgents(identity, {
        addressees: [reach.responder],
        objectRef: { kind: 'conversation', ref: reach.conversationId },
        summary: reach.summary,
        body: reach.body,
        harnessSlug,
        wake: true,
      });
      return { woke: result.woke };
    },
  });
}

export interface GoalConsultArtifactRow {
  cycle_id: string;
  created_at: Date | string;
  ideas: unknown;
  proposals: unknown;
  routing_decisions: unknown;
}

export interface GoalConsultStateRow {
  conversation_id: string;
  state: string;
  outcome: unknown;
  responder_id: string | null;
}

interface PendingGoalProposal {
  key: string;
  proposal: Proposal;
  sourceIdeaProvenance: ProposalSourceIdeaProvenance[];
}

const consultationKey = (consultation: ProposalConsultation): string =>
  `${consultation.originCycleId}\u0000${consultation.originalProposalId}`;

const isProposal = (value: unknown): value is Proposal =>
  value != null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string';

const isConsultation = (value: unknown): value is ProposalConsultation => {
  if (value == null || typeof value !== 'object') return false;
  const row = value as Partial<ProposalConsultation>;
  return (
    typeof row.originCycleId === 'string' &&
    typeof row.originalProposalId === 'string' &&
    typeof row.status === 'string'
  );
};

function sourceSnapshots(ideas: unknown, ids: readonly string[]): ProposalSourceIdeaProvenance[] {
  if (!Array.isArray(ideas)) return [];
  const wanted = new Set(ids);
  return ideas.flatMap((raw) => {
    if (raw == null || typeof raw !== 'object') return [];
    const idea = raw as Record<string, unknown>;
    if (typeof idea.id !== 'string' || !wanted.has(idea.id) || typeof idea.lens !== 'string') return [];
    return [
      {
        id: idea.id,
        lens: idea.lens as CreativeLens,
        ...(Array.isArray(idea.addressesPatternRefs)
          ? { addressesPatternRefs: idea.addressesPatternRefs.filter((ref): ref is string => typeof ref === 'string') }
          : {}),
      },
    ];
  });
}

/** Find still-pending proposal/consult pairs. A later routed decision carrying
 * the same origin key is the completion marker, preventing duplicate goals. */
export function selectPendingGoalConsults(rows: readonly GoalConsultArtifactRow[]): PendingGoalProposal[] {
  const completed = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.routing_decisions)) continue;
    for (const raw of row.routing_decisions) {
      if (raw == null || typeof raw !== 'object') continue;
      const decision = raw as Record<string, unknown>;
      if (typeof decision.routedRef !== 'string' || !isConsultation(decision.consultation)) continue;
      completed.add(consultationKey(decision.consultation));
    }
  }

  const seen = new Set<string>();
  const pending: PendingGoalProposal[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.proposals)) continue;
    for (const raw of row.proposals) {
      if (!isProposal(raw) || !isConsultation(raw.consultation) || raw.consultation.status !== 'pending') continue;
      const key = consultationKey(raw.consultation);
      if (completed.has(key) || seen.has(key) || !raw.consultation.conversationId) continue;
      seen.add(key);
      pending.push({
        key,
        proposal: raw,
        sourceIdeaProvenance: sourceSnapshots(row.ideas, raw.sourceIdeaIds ?? []),
      });
    }
  }
  return pending;
}

const TERMINAL_UNAVAILABLE_STATES = new Set([
  'no_qualified_responder',
  'closed_cant_help',
  'declined',
  'graduated',
  'expired',
]);

/** Apply terminal consult rows to their persisted proposals. Open rows return
 * nothing and remain deferred; terminal unavailability proceeds honestly. */
export function resolvePendingGoalConsults(
  pending: readonly PendingGoalProposal[],
  states: ReadonlyMap<string, GoalConsultStateRow>,
): Proposal[] {
  const resolved: Proposal[] = [];
  for (const candidate of pending) {
    const prior = candidate.proposal.consultation!;
    const row = prior.conversationId ? states.get(prior.conversationId) : undefined;
    if (!row) continue;
    const feedback = extractGoalConsultFeedback(row.outcome);
    if (row.state !== 'closed_answered' && !TERMINAL_UNAVAILABLE_STATES.has(row.state)) continue;
    const consultation: ProposalConsultation = {
      ...prior,
      status: feedback ? 'answered' : 'unavailable',
      state: row.state,
      reviewerId: row.responder_id ?? prior.reviewerId,
      ...(feedback ? { feedback } : { reason: `consult ended ${row.state} without an extractable critique` }),
    };
    resolved.push({
      ...candidate.proposal,
      // Proposal ids repeat between cycles. The resume id must be unique in the
      // current route batch while the original id stays in the consultation key.
      id: `consulted:${prior.originCycleId}:${prior.originalProposalId}`,
      consultation,
      sourceIdeaProvenance: candidate.sourceIdeaProvenance,
    });
  }
  return resolved;
}

/** Read terminally resolvable reviews from the existing stage artifact +
 * consult ledgers. This is the only continuation read; it writes nothing. */
export async function readResolvedGoalConsultProposals(opts: {
  workspaceId?: string;
  harnessSlug: string;
  limit?: number;
}): Promise<Proposal[]> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const artifacts = (await sql`
    SELECT cycle_id, created_at, ideas, proposals, routing_decisions
      FROM harness_shared.scout_cycle_stage_artifacts
     WHERE workspace_id = ${workspaceId}
       AND install_slug = ${opts.harnessSlug}
       AND proposals IS NOT NULL
     ORDER BY created_at DESC
     LIMIT ${opts.limit ?? GOAL_CONSULT_ARTIFACT_LIMIT}
  `) as unknown as GoalConsultArtifactRow[];
  const pending = selectPendingGoalConsults(artifacts);
  const ids = [
    ...new Set(
      pending.map((entry) => entry.proposal.consultation?.conversationId).filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return [];
  const states = (await sql`
    SELECT conversation_id, state, outcome, responder_id
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId}
       AND conversation_id = ANY(${sql.array(ids)}::text[])
  `) as unknown as GoalConsultStateRow[];
  return resolvePendingGoalConsults(pending, new Map(states.map((row) => [row.conversation_id, row])));
}
