/**
 * consult:get_feedback — the requester-side consult tool (plan
 * get-feedback-relevance-consults-2026-08-16, P-003).
 *
 * PROD BINDING ONLY. All workflow logic lives in
 * lib/consult/get-feedback-core.ts (core/binding split, mirrors
 * conversations-core.ts) — this file wires the prod seams:
 *   route   → routeConsult + buildQueryEmbedder + the liveness oracle
 *   open    → openConversation (kind='consult'; the new conversation is not
 *             directly addressed to the expert whose transcript is selected)
 *   reach   → the fork/convert dispatcher (an isolated answer session from the
 *             expert transcript; the expert's live session is not woken)
 *
 * Heavy deps are imported INSIDE the handler (probe-capacity style): the
 * embedder/search graph opens PG at import time, and registration must stay
 * cheap (the router module itself documents this constraint).
 *
 * Selection (consult-min-max-and-rubric-vetting-2026-08-17 D-001/D-003):
 * min_agents/max_agents map to the core's minResponders/maxResponders — the
 * selected set is every above-floor qualified candidate plus best-scoring
 * minimum-fill to reach min (labeled via:'minimum'), capped at max. The top
 * selectee is dispatched as an isolated answer session; the rest are the
 * cascade menu (`remaining_candidates`). A dead expert can still be selected
 * because the transcript, not the source session's liveness, carries expertise.
 * The per-task wake budget is REMOVED (D-005).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { hardText, LIMITS } from '../limits';
// The two "default N" figures in the arg descriptions below are RENDERED from the
// registry, never typed: a tool description is prose that describes code, and P-006
// found five hand-maintained copies of this same bound already stale in the tree.
import { DEFAULT_MIN_RESPONDERS, DEFAULT_MAX_RESPONDERS } from '../../consult/selection-policies';
import { reconcileInterestEventAwaits } from '../../interest-auto-arm';
import { consultFeedbackAbortCompletionReceipt } from './abort-completion';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'consult:get_feedback',
  description:
    'Request a consult (request/creation verb), not a reader for an existing conversation; use conversations:get { id }. The closed-consult archive serves matches first; otherwise transcript expertise routes to an isolated answer session and does not wake the expert’s live session. Below-floor outcomes are reported honestly.',
  guidance: {
    when:
      'After a first-pass check of local code, docs, or search, Ask once with a concrete question before long re-derivation; include what you tried, observed, and the decision it informs.',
    notWhen:
      'Reading an existing conversation? use conversations:get { id }. Query live state; coord:ask-owner for owner decisions, coord:send for known agents. Do not consult to meet a quota or when code, docs, or search answer it. Do not open duplicate consults or repeat unchanged questions after no_available_responder; advice is not a handoff.',
    chaining:
      "This tool does not read an existing conversation; use conversations:get { id }. The dispatcher already walks allowed model ranks; do not retry. Set latency_contract:'hard-blocked' only if blocked on the answer; declines/expiries advance the cascade. After advice arrives, read the reply and compare it with the decision you took; record confirmed/rescoped/reversed/moot via consult:reconcile with a substantive note. Receipt or silence does not prove usefulness. With allow_dispatch:false, retrieval-only returns candidates but no answer session.",
    returns:
      '{ verdict, conversation_id, thread_id, responder, responder_via, remaining_candidates, latency_contract, expires_at, archive?, hint }',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  abortCompletionReceipt: consultFeedbackAbortCompletionReceipt,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    question: hardText(LIMITS.ANNOTATION).describe('The new question to route. This tool opens a new consult; to read an existing conversation, use conversations:get { id }. Name concrete files/symbols where relevant — authorship of the code in question is a routing signal.'),
    tried: hardText(LIMITS.ANNOTATION).optional().describe('What you already tried (grounds the responder; avoids re-suggesting it).'),
    observed: hardText(LIMITS.ANNOTATION).optional().describe('What you observed (evidence, not interpretation).'),
    decision_at_stake: hardText(LIMITS.ANNOTATION).optional().describe('The decision this consult informs — the requester owns it (advice, not consensus).'),
    latency_contract: z
      .enum(['proceed', 'hard-blocked'])
      .optional()
      .describe("'proceed' (default): continue on your own judgment, reconcile when the reply lands. 'hard-blocked': you will park on the returned park_key event."),
    origin_task_ref: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Work-item/task this consult is attributed to (default: your most recently progressed wip work-item).'),
    exclude: z
      .array(z.string().min(1))
      .max(16)
      .optional()
      .describe("Owners to exclude from candidacy — e.g. the exhausted menu's decliners when re-routing after a terminal 'declined'/'expired' (the cascade itself advances server-side; no per-decline re-call)."),
    parent_consult_id: z
      .string()
      .min(1)
      .optional()
      .describe("Consulting onward from WITHIN a consult you are answering? Pass THAT consult's conversation_id: depth = parent+1 (capped at 2), and the lineage's participants are excluded from routing (cycle refusal, D-005)."),
    max_agents: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe(`Cap on the selected cascade menu (default ${DEFAULT_MAX_RESPONDERS}). Delivery stays single-wake: the top selectee is woken, the rest are the menu (remaining_candidates).`),
    min_agents: z
      .number()
      .int()
      .min(0)
      .max(8)
      .optional()
      .describe(`Select at least this many responders even below the relevance floor (best-available LIVE fill, labeled via:'minimum'; default ${DEFAULT_MIN_RESPONDERS}). Pass 0 to restore pure-floor selection.`),
    policy: z
      .string()
      .optional()
      .describe(
        "Named selection policy to take min/max from ('rubric-vetting' for the meta-rubric vetting consult). Prefer this over typing max_agents at a governed call site — the bound then lives in code, not in your instructions. Unknown key refuses.",
      ),
    archive_floor: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe(
        'Similarity floor for the archive-first serve (default ~0.8, precision-biased). Pass 2 to bypass the archive entirely (force fresh routing — e.g. when an archived answer did not fit your context); lower it only when a stale-but-close answer beats waking anyone.',
      ),
    allow_dispatch: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Allow launching an answering session from the matched expert (fork same-backend, convert cross-backend; default true). Pass false to keep this consult retrieval-only — you get the ranked candidates and read their transcripts yourself.',
      ),
    topics: z.array(z.string().min(1)).max(8).optional().describe('Area topics to tag the consult with (ambient discoverability).'),
    harness: z.string().optional().describe('Tag the conversation harness-scoped.'),
  }),
  result: z
    .object({
      verdict: z.unknown().optional(),
      conversation_id: z.unknown().optional(),
      thread_id: z.unknown().optional(),
      responder: z.unknown().optional(),
      responder_via: z.unknown().optional(),
      floor: z.unknown().optional(),
      remaining_candidates: z.unknown().optional(),
      origin_task_ref: z.unknown().optional(),
      latency_contract: z.unknown().optional(),
      expires_at: z.unknown().optional(),
      wake: z.unknown().optional(),
      park_key: z.unknown().optional(),
      archive: z.unknown().optional(),
      served_from_archive: z.unknown().optional(),
      hint: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);

    const [{ getFeedbackProd }, conversations] = await Promise.all([
      import('../../consult/get-feedback-prod'),
      import('../coordination/conversations'),
    ]);
    const workspaceId = conversations.withConversationsIdentityScope(identity, undefined, () =>
      conversations.conversationsScopeWorkspace(),
    );
    const result = await getFeedbackProd({
      workspaceId,
      requesterId: identity.ownerId,
      question: args.question,
      tried: args.tried,
      observed: args.observed,
      decisionAtStake: args.decision_at_stake,
      latencyContract: args.latency_contract,
      ...(args.origin_task_ref !== undefined ? { originTaskRef: args.origin_task_ref } : {}),
      ...(args.parent_consult_id !== undefined ? { parentConsultId: args.parent_consult_id } : {}),
      excludeOwners: args.exclude,
      ...(args.min_agents !== undefined ? { minResponders: args.min_agents } : {}),
      ...(args.max_agents !== undefined ? { maxResponders: args.max_agents } : {}),
      ...(args.policy !== undefined ? { policy: args.policy } : {}),
      ...(args.archive_floor !== undefined ? { archiveFloor: args.archive_floor } : {}),
      topics: args.topics,
      harnessSlug: args.harness,
    }, identity, {
      harnessSlug: ctx.harnessSlug !== '*' ? ctx.harnessSlug : null,
      allowDispatch: args.allow_dispatch,
    });
    let interestWatch;
    if (
      'verdict' in result &&
      result.verdict === 'routed' &&
      result.latency_contract === 'hard-blocked' &&
      result.park_key
    ) {
      try {
        interestWatch = await reconcileInterestEventAwaits({
          ownerId: identity.ownerId,
          eventKeys: [result.park_key],
          boundTo: { kind: 'consult-request', ref: result.conversation_id },
          note: `hard-blocked consult requester auto-arm for ${result.conversation_id}`,
        });
      } catch {
        /* consult routing remains authoritative; interest arming is fail-soft */
      }
    }

    return ok({
      ...(result as unknown as Record<string, unknown>),
      ...(interestWatch ? { interest_watch: interestWatch } : {}),
    });
  },
});
