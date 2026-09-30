/**
 * conversations.ts — the PRODUCTION binding for the conversation workflow (the
 * core/binding split mirrors topics.ts ↔ topics-core.ts). It constructs the
 * @papercusp/coordination capability stores + the PgConversationStore over the
 * org embedded-pg handle, binds the coordLog delivery sink, the real
 * answer-capture, the wall clock, and newMsgId — then re-exports the core
 * functions bound to those prod deps under the names the coord:ask /
 * conversations:* tools import. All workflow logic + delivery lives in
 * conversations-core.ts (so it is integration-tested against real PG without the
 * prod singletons).
 *
 * A conversation is the FIRST consumer of the coordination substrate
 * (coordination-conversations-2026-06-03): Threadable timeline, Taggable topics,
 * Subscribable followers, Lifecycle state, delivered via the synchronous fan-out.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { Sql, TransactionSql } from 'postgres';
import {
  PgEntitySubscriptionStore,
  PgTaggableStore,
  PgThreadStore,
  PgTopicStore,
} from '@papercusp/coordination/capabilities';
import { newMsgId } from '@papercusp/coordination/core';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { coordLog } from './log';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { captureResolvedAnswer } from './answer-capture';
import { PgConversationStore, reparentThread } from './conversations-store';
import { createIssue } from '../../issues-engineer';
import { currentRequestWorkspaceId, runWithWorkspaceIfConcrete } from '../../workspace-als';
import { getActiveClaimForOwner } from '../../work-item-claims';
import { getPresence } from './presence';

/**
 * Resolve the caller's lane provenance from live coordination state. A plan
 * slug in presence alone is not enough: pair it with the caller's live
 * work-item claim. Issue-family work items do not always carry source_plan_slug,
 * so the live lane pair—not a second, lossy work-item projection—is the
 * authoritative provenance here. Missing/stale data returns no provenance,
 * preserving the legacy owner-only authorization rather than widening it on a
 * guess.
 */
async function resolveConversationLaneProvenance(identity: AgentIdentity): Promise<{
  plan_slug?: string;
  work_item_id?: string;
}> {
  const workspaceId = identity.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') return {};
  try {
    const [claim, presence] = await Promise.all([
      getActiveClaimForOwner(workspaceId, identity.ownerId),
      getPresence(identity.ownerId),
    ]);
    const planSlug = presence?.currentPlanSlug?.trim();
    if (!claim || !planSlug) return {};
    return { plan_slug: planSlug, work_item_id: claim.workItemId };
  } catch {
    return {};
  }
}

/**
 * EI-1534: scope conversations (and their thread/tags/subs) to the request's
 * workspace so one shared operator sidecar doesn't leak every window's
 * conversations into every other workspace. STRAND-SAFE resolution — request
 * ALS first, then an explicit process pin, then 'default'. We deliberately do
 * NOT fall through to the registry's volatile `reg.current` (what
 * `activeWorkspaceId()` does): unscoped reads landing on `reg.current`
 * (e.g. a lane fleet's 'generic-test') is exactly the strand that reverted the
 * issues per-workspace flip (su-bdc3a, EI-1460). Request-scoped reads isolate
 * correctly; unscoped/background reads stay on the stable 'default' home.
 */
export function conversationsScopeWorkspace(): string {
  const req = currentRequestWorkspaceId();
  if (req && req.trim()) return req.trim();
  const env = process.env.PAPERCUSP_WORKSPACE_ID;
  if (env && env.trim()) return env.trim();
  return DEFAULT_COORD_WORKSPACE;
}

/**
 * WI-1571 (workspace-threading class, sibling of WI-1564): resolve the
 * workspace partition a conversation write/read should use from the CALLER's
 * `identity.workspaceId` — mirrors `resolveClaimSpecWorkspace`
 * (scheduler/claim-spec-store.ts, WI-1564) exactly.
 *
 * THE BUG: `conversationsScopeWorkspace()` above (EI-1534) only ever consults
 * request-ALS → env → 'default'. A HARNESS-scoped conversation opened from a
 * context with no request ALS (a background/system caller — e.g. a queen
 * principal acting for a shared hive) therefore lands under the literal
 * 'default' workspace partition, even when the hive's real home is a
 * DIFFERENT, concrete workspace. The federation outbox-drain only serves the
 * booted (workspace, harness) handle for that hive's REAL home — a row
 * captured under (default, <hive>) is never drained (live evidence: 4
 * coord_conversations + 4 coord_threads rows undrained under
 * (default, papercusp), newest 2026-07-02 06:56).
 *
 * THE FIX: every identity-bearing entry point below (open/reply/answer/
 * resolve/join/leave/promote) already receives `identity.workspaceId` — the
 * caller's OWN resolved workspace (for a harness-scoped principal this is
 * `principal.workspaceId`, the hive's registered home; identity.ts). Running
 * the call through `runWithWorkspaceIfConcrete(identityWs, fn)` (workspace-als)
 * pins that value onto `currentRequestWorkspaceId()` for the call's async
 * extent, so `conversationsScopeWorkspace()` picks it up as its TOP-priority
 * read — the SAME resolver every downstream store op (write AND read) uses.
 * Two independent callers scoped to the SAME hive therefore agree on the
 * partition (the WI-1564 "resolver shared by writer+reader" invariant),
 * instead of both silently falling through to 'default'. An identity with no
 * concrete workspaceId (unscoped SU/power-user session) is UNCHANGED —
 * `runWithWorkspaceIfConcrete` is a no-op and the existing request→env→
 * default chain still applies (STRAND-SAFE, EI-1460 — never pins the
 * volatile `reg.current`).
 *
 * Reads (`getConversation` / `listConversations` / `listConversationsWithTopics`)
 * take an OPTIONAL identity: the original WI-1571 fix threaded writes only, on
 * the assumption reads came exclusively from request-scoped UI/TUI contexts —
 * but the agent MCP tools (conversations:get/list, plans:attention) and the
 * coord-op caps (listPosts/readAnswer, i.e. coord:ask-owner's answer poll) read
 * from contexts with NO request ALS, so they landed on 'default' while the same
 * caller's writes landed on identity.workspaceId. Live evidence 2026-07-07: 23
 * conversations under (papercusp-workspace) invisible to conversations:get/list,
 * and every coord:ask-owner bounded wait timing out because readAnswer polled
 * the wrong partition. Identity-bearing read callers must pass their identity;
 * UI/sync-resolver reads stay identity-less on the request-ALS chain.
 */
export function resolveConversationsIdentityWorkspace(
  identityWorkspaceId: string | null | undefined,
): string | undefined {
  const ws = identityWorkspaceId?.trim();
  return ws && ws !== '*' ? ws : undefined;
}

/** Run `fn` with the identity's workspace pinned (see resolver doc above). A
 *  harness-scoped open with NO resolvable workspace (neither the caller's
 *  identity nor an ambient request scope) is the exact strand condition — warn
 *  loudly so it's visible instead of silently mis-partitioning (mirrors
 *  claim-spec-store's `warning` field, surfaced here via a log since
 *  OpenConversationResult's shape is owned by conversations-core.ts). */
export function withConversationsIdentityScope<T>(
  identity: AgentIdentity,
  harnessSlugIfOpening: string | undefined,
  fn: () => T,
): T {
  const identityWs = resolveConversationsIdentityWorkspace(identity.workspaceId);
  if (!identityWs && harnessSlugIfOpening && !currentRequestWorkspaceId() && !process.env.PAPERCUSP_WORKSPACE_ID) {
    console.warn(
      `[conversations] opening a harness-scoped conversation (harness_slug='${harnessSlugIfOpening}') ` +
        `with no resolvable workspace (identity.workspaceId and the request scope are both unset) — ` +
        `it will land under the '${DEFAULT_COORD_WORKSPACE}' partition, which the federation outbox-drain ` +
        `likely does not serve for this harness (WI-1571). Thread a workspace-scoped identity.`,
    );
  }
  return runWithWorkspaceIfConcrete(identityWs, fn);
}
import {
  getConversationCore,
  joinConversationCore,
  leaveConversationCore,
  listConversationsCore,
  listConversationsWithTopicsCore,
  openConversationCore,
  postReplyCore,
  answerQuestionCore,
  resolveConversationCore,
  settleConsultConversationCore,
  supersedeConversationCore,
  promoteConversationCore,
  type AppendPostError,
  type ConversationDeps,
  type ConversationDetail,
  type ConversationWithTopics,
  type JoinConversationResult,
  type ListConversationsWithTopicsOpts,
  type OpenConversationInput,
  type OpenConversationResult,
  type PostResult,
  type PromoteConversationInput,
  type PromoteConversationResult,
  type ResolveInput,
  type ResolveError,
  type ResolveResult,
  type SupersedeConversationInput,
  type SupersedeConversationResult,
} from './conversations-core';
import type { AgentIdentity } from './identity';
import type { ConversationRow, ListConversationsOpts } from './conversations-store';
import type { DeliveryMode } from '@papercusp/coordination/capabilities';
import { trackDetached } from '../../detached-imports';
import {
  reconcileInterestEventAwaits,
  retireInterestEventAwaits,
  type InterestAutoArmHandle,
} from '../../interest-auto-arm';

const storeOpts = {
  getSql: () => getOrgPg().sql,
  // Schema is defined by migrations 123 (capabilities) + 132 (conversations);
  // the host seam is a no-op.
  ensureSchema: async () => {},
  // EI-1534: per-call workspace scope (request → pin → default). The capability
  // stores + PgConversationStore re-resolve this on every query, so the module
  // singleton below no longer pins to 'default' for the process life.
  getWorkspaceId: () => conversationsScopeWorkspace(),
};

const deps: ConversationDeps = {
  conversations: new PgConversationStore(storeOpts),
  threads: new PgThreadStore(storeOpts),
  // The post/answer durable write runs through ONE bounded, atomic admin-pool txn
  // (pg-bounded-txn): a tx-bound PgThreadStore reuses the exact tested store SQL,
  // so get-or-create-thread + add-post commit together and a DB stall fails fast +
  // typed instead of hanging the MCP call (the admin pool has no default
  // statement_timeout). Mirrors issues-engineer.commentIssue / work-items.commentWorkItem.
  threadTxn: (fn) => boundedOrgTxn((tx) => fn(new PgThreadStore({ ...storeOpts, getSql: () => tx }))),
  tags: new PgTaggableStore(storeOpts),
  subs: new PgEntitySubscriptionStore(storeOpts),
  topics: new PgTopicStore(storeOpts),
  sink: coordLog,
  capture: captureResolvedAnswer,
  nowIso: () => new Date().toISOString(),
  newId: (prefix) => `${prefix}-${newMsgId()}`,
  // Promote bridge (D-005): mint an engineer issue via the issues-engineer
  // surface + carry the thread (re-key to the issue's thread_id convention).
  promote: {
    createIssue: async (i) => {
      const issue = await createIssue({
        title: i.title,
        body: i.body,
        severity: i.severity as 'critical' | 'major' | 'minor' | 'nit' | undefined,
        source: i.source as 'engineer' | 'su' | undefined,
        scope: i.scope,
        topics: i.topics,
        foundDuring: i.foundDuring,
        createdBy: i.createdBy,
      });
      return { id: issue.id, title: issue.title };
    },
    reparentThread: (from, to, newThreadId) =>
      reparentThread(getOrgPg().sql, conversationsScopeWorkspace(), from, to, newThreadId),
    // Mirrors issues-engineer.ts threadId(): `issue-thread-<EI-id>`.
    issueThreadId: (issueId) => `issue-thread-${issueId}`,
  },
};

export type {
  ConversationDetail,
  OpenConversationInput,
  OpenConversationResult,
  PostResult,
  ResolveInput,
  ResolveError,
  ResolveResult,
  SupersedeConversationInput,
  SupersedeConversationResult,
} from './conversations-core';

async function armQuestionInterest(
  ownerId: string,
  conversationId: string,
): Promise<InterestAutoArmHandle | undefined> {
  try {
    return await reconcileInterestEventAwaits({
      ownerId,
      eventKeys: [`conversation:answered:${conversationId}`],
      boundTo: { kind: 'conversation-question', ref: conversationId },
      note: `question-requester auto-arm for ${conversationId}`,
    });
  } catch {
    return undefined;
  }
}

export async function openConversation(identity: AgentIdentity, input: OpenConversationInput): Promise<OpenConversationResult> {
  const provenance = await resolveConversationLaneProvenance(identity);
  const opened = await withConversationsIdentityScope(identity, input.harness_slug, () =>
    openConversationCore(deps, identity, { ...input, ...provenance }),
  );
  if (opened.conversation.kind === 'question') {
    opened.interestWatch = await armQuestionInterest(identity.ownerId, opened.conversation.id);
  }
  return opened;
}

export function postReply(
  identity: AgentIdentity,
  input: { conversation_id: string; body: string; mentions?: string[]; via_consult_verb?: boolean },
): Promise<PostResult | AppendPostError> {
  return withConversationsIdentityScope(identity, undefined, () => postReplyCore(deps, identity, input));
}

export function answerQuestion(
  identity: AgentIdentity,
  input: { conversation_id: string; body: string; mentions?: string[]; via_consult_verb?: boolean },
): Promise<PostResult | AppendPostError> {
  return withConversationsIdentityScope(identity, undefined, () => answerQuestionCore(deps, identity, input));
}

/**
 * Settle the coarse conversation projection for a terminal consult close.
 * consult_state carries the consult-specific lifecycle; coord_conversations is
 * what conversations:get/list reads, so a consult close must update both.
 * The terminal post is written by consultCloseCore before this callback and is
 * deliberately not duplicated here.
 */
export async function settleConsultConversation(
  identity: AgentIdentity,
  input: {
    conversationId: string;
    outcome: 'answered' | 'cant_help' | 'graduate';
    answer?: string;
    postId: number;
    now: string;
  },
  tx?: Sql | TransactionSql,
): Promise<void> {
  await withConversationsIdentityScope(identity, undefined, () =>
    settleConsultConversationCore(
      tx
        ? { ...deps, conversations: new PgConversationStore({ ...storeOpts, getSql: () => tx }) }
        : deps,
      {
        conversation_id: input.conversationId,
        outcome: input.outcome,
        answer: input.answer,
        post_id: input.postId,
        now_ts: input.now,
      },
    ),
  );
}

export async function resolveConversation(
  identity: AgentIdentity,
  input: ResolveInput,
): Promise<ResolveResult | ResolveError> {
  const result = await withConversationsIdentityScope(identity, undefined, () =>
    resolveConversationCore(deps, identity, input),
  );
  // await-event-primitive-2026-06-05 P-011 (D-006 #3): ask-answered is an
  // awaitable event — a SLEEPING asker is woken when its question resolves
  // (`events:await { event: 'conversation:answered:<id>' }`). The asker is on
  // the notify list too (belt over the core's fanout — same durable inbox).
  // Host-wrapper concern, kept out of the pure core; never breaks the resolve.
  if (!('error' in result)) {
    const conv = result.conversation;
    // EI-19399318647145782: a `coord:ask-owner` question is TWO attention rows —
    // this conversation (Alert tier) and a `severity:'question'` escalation
    // (DECISION tier). Nothing closed the second one, so every question the
    // owner ANSWERED left a permanent Decision-tier zombie: measured 9 of the
    // 11 ever-resolved question conversations, against 131 open question
    // escalations (112 older than 7d, oldest 49 days). That zombie flood is
    // what buries the LIVE owner decisions.
    //
    // Same host-wrapper contract as the event emit below: best-effort, never
    // breaks the resolve, kept out of the pure core. Matched on the stamped
    // `conversationId` ONLY (never an id-prefix guess — see
    // attention/conversation-escalation-link.ts for why).
    void (async () => {
      const [{ selectEscalationsForConversation, ANSWERED_QUESTION_RESOLVER, ANSWERED_QUESTION_CHOICE }, { listEscalations, resolveEscalationsBatch }] =
        await Promise.all([
          import('../../attention/conversation-escalation-link.js'),
          import('./escalations.js'),
        ]);
      const opens = await listEscalations({ status: 'open' });
      const msgIds = selectEscalationsForConversation(
        opens as unknown as { msg_id: string }[],
        conv.id,
      );
      if (msgIds.length === 0) return;
      await resolveEscalationsBatch(
        msgIds.map((msg_id) => ({
          msg_id,
          choice: ANSWERED_QUESTION_CHOICE,
          resolver: ANSWERED_QUESTION_RESOLVER,
          note: `answered in conversation ${conv.id}`,
        })),
      );
    })().catch(() => {});
    try {
      const { emitAwaitedEvent } = await import('../../events/await/engine');
      await emitAwaitedEvent({
          key: `conversation:answered:${conv.id}`,
          summary: `conversation ${conv.id} resolved: ${(conv.accepted_answer ?? '').slice(0, 200)}`,
          payload: { conversation_id: conv.id, resolver: identity.ownerId },
          to: conv.asker_id && conv.asker_id !== identity.ownerId ? [conv.asker_id] : [],
          source: identity.ownerId,
      });
    } catch {
      /* answer persistence is authoritative; wake delivery remains fail-soft */
    }
    try {
      await retireInterestEventAwaits({ kind: 'conversation-question', ref: conv.id });
    } catch {
      /* lifecycle cleanup is fail-soft */
    }
  }
  return result;
}

export async function supersedeConversation(
  identity: AgentIdentity,
  input: SupersedeConversationInput,
): Promise<
  | SupersedeConversationResult
  | { error: 'not_found' }
  | { error: 'not_owner' }
  | { error: 'already_superseded' }
  | { error: 'already_terminal' }
  | { error: 'invalid_replacement' }
> {
  const provenance = await resolveConversationLaneProvenance(identity);
  const result = await withConversationsIdentityScope(identity, undefined, () =>
    supersedeConversationCore(deps, identity, { ...input, ...provenance }),
  );
  if (!('error' in result)) {
    try {
      await retireInterestEventAwaits({ kind: 'conversation-question', ref: result.conversation.id });
    } catch {
      /* lifecycle cleanup is fail-soft */
    }
    if (result.replacement.conversation.kind === 'question') {
      result.replacement.interestWatch = await armQuestionInterest(
        identity.ownerId,
        result.replacement.conversation.id,
      );
    }
    // A coord:ask-owner has a Decision-tier escalation twin. Retiring the
    // conversation must retire that twin too, or a retracted question remains
    // a visible owner gate even though the replacement is the live question.
    void (async () => {
      const [{ selectEscalationsForConversation, SUPERSEDED_QUESTION_RESOLVER, SUPERSEDED_QUESTION_CHOICE }, { listEscalations, resolveEscalationsBatch }] =
        await Promise.all([
          import('../../attention/conversation-escalation-link.js'),
          import('./escalations.js'),
        ]);
      const opens = await listEscalations({ status: 'open' });
      const msgIds = selectEscalationsForConversation(
        opens as unknown as { msg_id: string }[],
        result.conversation.id,
      );
      if (msgIds.length === 0) return;
      await resolveEscalationsBatch(
        msgIds.map((msg_id) => ({
          msg_id,
          choice: SUPERSEDED_QUESTION_CHOICE,
          resolver: SUPERSEDED_QUESTION_RESOLVER,
          note: `superseded by conversation ${result.replacement.conversation.id}`,
        })),
      );
    })().catch(() => {});
  }
  return result;
}

export function joinConversation(
  identity: AgentIdentity,
  input: { conversation_id: string; mode?: DeliveryMode; ttl_sec?: number },
): Promise<JoinConversationResult> {
  return withConversationsIdentityScope(identity, undefined, () => joinConversationCore(deps, identity, input));
}

export function leaveConversation(identity: AgentIdentity, conversationId: string): Promise<void> {
  return withConversationsIdentityScope(identity, undefined, () =>
    leaveConversationCore(deps, identity, conversationId),
  );
}

// Reads: identity is OPTIONAL (see the resolver doc above) — an identity-bearing
// caller (agent tool / coord-op cap) passes it so reader and writer resolve the
// SAME partition; an identity-less caller (UI/sync-resolver, request-scoped)
// keeps the request-ALS chain unchanged.
export function listConversations(input: ListConversationsOpts = {}, identity?: AgentIdentity): Promise<ConversationRow[]> {
  const run = () => listConversationsCore(deps, input);
  return identity ? withConversationsIdentityScope(identity, undefined, run) : run();
}

export function listConversationsWithTopics(
  input: ListConversationsWithTopicsOpts = {},
  identity?: AgentIdentity,
): Promise<ConversationWithTopics[]> {
  const run = () => listConversationsWithTopicsCore(deps, input);
  return identity ? withConversationsIdentityScope(identity, undefined, run) : run();
}

export function getConversation(id: string, identity?: AgentIdentity): Promise<ConversationDetail | null> {
  const run = () => getConversationCore(deps, id);
  return identity ? withConversationsIdentityScope(identity, undefined, run) : run();
}

/**
 * A consult's LIFECYCLE state, which lives in `harness_shared.consult_state` —
 * a different table from the conversation row itself.
 *
 * EI-21510601647367544: those two states diverge, and the divergence is
 * actively misleading. A consult whose window elapsed is swept to
 * `state:'expired'` + `closed_at` by `system:consult-expiry-sweep`, but its
 * CONVERSATION row keeps reading `state:'open'`. Since a cascade advance wakes
 * the next selectee rather than posting to the thread, `posts:[]` also stays
 * empty on a perfectly healthy consult. So an agent reading only the
 * conversation sees `open` + zero posts for both "still waiting on a responder"
 * and "expired and closed an hour ago", and the natural inference from that
 * pair — nobody is acting on this, it is stranded — is wrong in the second
 * case. Measured instance: conv-mt9jw66p read `open` at 08:37Z, 49 minutes
 * after its consult_state row was expired and closed at 07:48:28Z.
 *
 * There is no dedicated consult-status verb to point at instead — the consult
 * surface is exactly get_feedback / reply / decline / close — so the lifecycle
 * has to reach the reader through the conversation read they already make.
 *
 * Batched deliberately: `conversations:get` accepts up to 100 ids, and a
 * per-id lookup inside its bulk loop would be 100 round-trips for one read.
 */
export interface ConsultLifecycleState {
  conversation_id: string;
  state: string;
  latency_contract: string | null;
  responder_id: string | null;
  expires_at: string | null;
  closed_at: string | null;
  wakes_used: number | null;
  /** Live spend samples for the answer sessions this consult launched. A
   * missing/NULL USD amount stays unknown; estimated prices remain labeled. */
  session_cost: {
    status: 'pending' | 'measured' | 'partial';
    usd: number | null;
    sample_count: number;
    priced_sample_count: number;
    estimated_sample_count: number;
    unpriced_sample_count: number;
  } | null;
  /**
   * The answering-session dispatch walks this consult made (WI-10003197), so a
   * fork/convert that never posted is visible here instead of only in
   * fleet-logs. null = no walk recorded (never dispatched, or a DB before
   * migration 1225). Bounded: the newest {@link CONSULT_DISPATCH_RECENT} walks.
   */
  dispatch: ConsultDispatchSummary | null;
}

/** Walks shown per consult in a conversation read (the column itself keeps 24). */
export const CONSULT_DISPATCH_RECENT = 3;

export interface ConsultDispatchSummary {
  /** Walks recorded on the consult (at most the column's bound of 24). */
  total_walks: number;
  /** The newest walks, oldest first; each rank carries why it failed. */
  recent: Array<{
    at: string | null;
    dispatched: boolean;
    answering_owner_id: string | null;
    attempts: Array<{
      rank: number | null;
      agent: string | null;
      model: string | null;
      operation: string | null;
      outcome: string | null;
      reason?: string;
      /** The launcher's own words (e.g. psu's refusal), when its log had one. */
      launch_error?: string;
    }>;
  }>;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Compact a raw `consult_state.dispatch_attempts` array for a conversation read:
 * the newest {@link CONSULT_DISPATCH_RECENT} walks, dropping the long `detail`
 * strings (reason + launch_error carry the failure). Pure; null when empty or
 * not an array.
 */
export function summarizeConsultDispatch(raw: unknown): ConsultDispatchSummary | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const recent = raw.slice(-CONSULT_DISPATCH_RECENT).map((w) => {
    const walk = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
    const attempts = Array.isArray(walk.attempts) ? walk.attempts : [];
    return {
      at: str(walk.at),
      dispatched: walk.dispatched === true,
      answering_owner_id: str(walk.answeringOwnerId),
      attempts: attempts.map((a) => {
        const at = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
        return {
          rank: typeof at.rank === 'number' ? at.rank : null,
          agent: str(at.agent),
          model: str(at.model),
          operation: str(at.operation),
          outcome: str(at.outcome),
          ...(str(at.reason) ? { reason: str(at.reason)! } : {}),
          ...(str(at.launchError) ? { launch_error: str(at.launchError)! } : {}),
        };
      }),
    };
  });
  return { total_walks: raw.length, recent };
}

type ConsultLifecycleBaseRow = Omit<ConsultLifecycleState, 'session_cost' | 'dispatch'>;

interface ConsultLifecycleUsageRow {
  conversation_id: string;
  session_cost_usd: number | string | null;
  session_cost_sample_count: number | string | null;
  session_cost_priced_count: number | string | null;
  session_cost_estimated_count: number | string | null;
  session_cost_unpriced_count: number | string | null;
  session_cost_answer_session_count: number | string | null;
}

export function getConsultStates(
  conversationIds: readonly string[],
  identity?: AgentIdentity,
): Promise<Map<string, ConsultLifecycleState>> {
  const run = async (): Promise<Map<string, ConsultLifecycleState>> => {
    const out = new Map<string, ConsultLifecycleState>();
    if (conversationIds.length === 0) return out;
    try {
      const { sql } = getOrgPg();
      const rows = await sql<ConsultLifecycleBaseRow[]>`
        SELECT conversation_id, state, latency_contract, responder_id,
               expires_at, closed_at, wakes_used
          FROM harness_shared.consult_state
         WHERE workspace_id = ${conversationsScopeWorkspace()}
           AND conversation_id = ANY(${conversationIds as string[]}::text[])
      `;
      const usageByConversation = new Map<string, ConsultLifecycleUsageRow>();
      try {
        const usageRows = await sql<ConsultLifecycleUsageRow[]>`
          SELECT cs.conversation_id,
                 usage.session_cost_usd, usage.session_cost_sample_count,
                 usage.session_cost_priced_count, usage.session_cost_estimated_count,
                 usage.session_cost_unpriced_count, usage.session_cost_answer_session_count
            FROM harness_shared.consult_state cs
            JOIN LATERAL (
              SELECT COUNT(DISTINCT answer_session.session_id)::int AS session_cost_answer_session_count,
                     SUM(u.cost_usd) AS session_cost_usd,
                     COUNT(u.id)::int AS session_cost_sample_count,
                     COUNT(u.id) FILTER (WHERE u.cost_usd IS NOT NULL AND u.cost_source = 'provider')::int
                       AS session_cost_priced_count,
                     COUNT(u.id) FILTER (WHERE u.cost_usd IS NOT NULL AND u.cost_source = 'estimated')::int
                       AS session_cost_estimated_count,
                     COUNT(u.id) FILTER (WHERE u.id IS NOT NULL AND u.cost_usd IS NULL)::int
                       AS session_cost_unpriced_count
                FROM jsonb_array_elements(
                       CASE
                         WHEN jsonb_typeof(cs.routing #> '{selection,selected}') = 'array'
                           THEN cs.routing #> '{selection,selected}'
                         ELSE '[]'::jsonb
                       END
                     ) selected
                JOIN harness_shared.adv_sessions answer_session
                  ON answer_session.workspace_id = cs.workspace_id
                 AND answer_session.coord_owner_id = NULLIF(selected->>'answeringOwnerId', '')
                 AND answer_session.session_id IS NOT NULL
                 AND answer_session.started_at >= cs.created_at
                LEFT JOIN harness_shared.agent_usage_samples u
                  ON u.workspace_id = cs.workspace_id
                 AND u.session_id = answer_session.session_id
                 AND u.ts >= (EXTRACT(EPOCH FROM answer_session.started_at) * 1000)::bigint
               WHERE NULLIF(selected->>'answeringOwnerId', '') IS NOT NULL
            ) usage ON usage.session_cost_answer_session_count > 0
           WHERE cs.workspace_id = ${conversationsScopeWorkspace()}
             AND cs.conversation_id = ANY(${conversationIds as string[]}::text[])
        `;
        for (const usage of usageRows) usageByConversation.set(usage.conversation_id, usage);
      } catch {
        // Spend is supplemental. A usage-ledger read failure must not hide the
        // consult lifecycle the caller asked for.
      }
      // A SEPARATE query, like spend: on a DB without migration 1225 the column
      // is absent, and folding it into the base SELECT would fail that query and
      // drop the whole `consult` block (WI-10003197).
      const dispatchByConversation = new Map<string, ConsultDispatchSummary | null>();
      try {
        const dispatchRows = await sql<Array<{ conversation_id: string; dispatch_attempts: unknown }>>`
          SELECT conversation_id, dispatch_attempts
            FROM harness_shared.consult_state
           WHERE workspace_id = ${conversationsScopeWorkspace()}
             AND conversation_id = ANY(${conversationIds as string[]}::text[])
             AND jsonb_array_length(dispatch_attempts) > 0
        `;
        for (const d of dispatchRows) {
          dispatchByConversation.set(d.conversation_id, summarizeConsultDispatch(d.dispatch_attempts));
        }
      } catch {
        // Dispatch history is supplemental too.
      }
      for (const r of rows) {
        const usage = usageByConversation.get(r.conversation_id);
        const sampleCount = Number(usage?.session_cost_sample_count ?? 0);
        const pricedSampleCount = Number(usage?.session_cost_priced_count ?? 0);
        const estimatedSampleCount = Number(usage?.session_cost_estimated_count ?? 0);
        const unpricedSampleCount = Number(usage?.session_cost_unpriced_count ?? 0);
        const sessionCost = usage ? {
          status: sampleCount === 0 ? 'pending' as const
            : unpricedSampleCount > 0 ? 'partial' as const : 'measured' as const,
          usd: usage.session_cost_usd == null ? null : Number(usage.session_cost_usd),
          sample_count: sampleCount,
          priced_sample_count: pricedSampleCount,
          estimated_sample_count: estimatedSampleCount,
          unpriced_sample_count: unpricedSampleCount,
        } : null;
        out.set(r.conversation_id, {
          conversation_id: r.conversation_id,
          state: r.state,
          latency_contract: r.latency_contract ?? null,
          responder_id: r.responder_id ?? null,
          expires_at: r.expires_at ?? null,
          closed_at: r.closed_at ?? null,
          wakes_used: r.wakes_used ?? null,
          session_cost: sessionCost,
          dispatch: dispatchByConversation.get(r.conversation_id) ?? null,
        });
      }
    } catch (err) {
      // FAIL-SOFT, and deliberately so: this is supplementary context on an
      // established read path. A consult-lifecycle lookup that fails must
      // degrade `conversations:get` to its previous behaviour (no `consult`
      // block), never break the thread read the caller actually asked for.
      console.warn('[conversations] consult lifecycle lookup failed; omitting consult state', err);
    }
    return out;
  };
  return identity ? withConversationsIdentityScope(identity, undefined, run) : run();
}

export function promoteConversation(
  identity: AgentIdentity,
  input: PromoteConversationInput,
): Promise<PromoteConversationResult | { error: 'not_found' } | { error: 'already_promoted' } | { error: 'already_terminal' } | { error: 'promote_unavailable' }> {
  return withConversationsIdentityScope(identity, undefined, () => promoteConversationCore(deps, identity, input));
}
