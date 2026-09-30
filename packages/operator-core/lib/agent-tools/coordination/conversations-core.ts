/**
 * conversations-core.ts — the conversation/question workflow, PURE over injected
 * stores + sink + capture + clock/id (same core/binding split as topics-core.ts).
 * conversations.ts binds the production stores (getOrgPg), the coordLog sink, the
 * real answer-capture, Date, and newMsgId; the integration tests bind the real PG
 * capability stores over a throwaway container + an in-memory sink + a stub
 * capture + a deterministic clock. So every line here is exercised against real
 * Postgres without touching the prod singletons.
 *
 * The conversation rides the substrate for everything shared and keeps only its
 * own scalars; delivery is the SYNCHRONOUS fan-out (resolveObjectSubscribers ∪
 * topic subs → deliverInjectMany), honoring delivery_mode (D-006), EXCLUDING the
 * actor from their own change, never blocking on a peer (D-002).
 */

import {
  objectKey,
  objectToTargetRef,
  type DeliveryMode,
  type ObjectRef,
  type SubscribableStore,
  type TaggableStore,
  type ThreadableStore,
  type ThreadPostRow,
  type TopicStore,
} from '@papercusp/coordination/capabilities';
import { type InjectEvent, type InjectSink } from './fanout-delivery';
import { fanoutForObject } from '../../sync/hyperbee/fanout-projection';
import type { AgentIdentity } from './identity';
import type {
  ConversationKind,
  ConversationProducer,
  ConversationRow,
  ConversationScope,
  ConversationState,
  CreateConversationInput,
  ListConversationsOpts,
  SupersedeStoreError,
  SupersedeStoreResult,
} from './conversations-store';
import { isConversationProducer } from './conversations-store';
import type { CaptureResult, CaptureTarget } from './answer-capture';

/** The conversation table surface the core needs (PgConversationStore satisfies it). */
export interface ConversationStoreLike {
  create(input: CreateConversationInput): Promise<ConversationRow>;
  get(id: string): Promise<ConversationRow | null>;
  /** EI-21914051456641891: prefix-match fallback for a hand-truncated id
   *  (see conversations-store.ts's getByPrefix doc). Optional so an older
   *  test double without it degrades to "no fallback available", never a
   *  type error. */
  getByPrefix?(prefix: string, limit?: number): Promise<ConversationRow[]>;
  list(opts?: ListConversationsOpts): Promise<ConversationRow[]>;
  setState(id: string, state: ConversationState, opts: { now_ts: string }): Promise<void>;
  supersede(
    id: string,
    replacement: CreateConversationInput,
    opts: { now_ts: string },
  ): Promise<SupersedeStoreResult | SupersedeStoreError>;
  setAcceptedAnswer(id: string, input: { answer: string; post_id?: number | null; capture_target?: string | null; now_ts: string }): Promise<void>;
  setPromoted(id: string, input: { issue_id: string; now_ts: string }): Promise<void>;
  touch(id: string, now_ts: string): Promise<void>;
}

/** The bridge to the engineer-issues surface + the thread re-parent (D-005),
 *  injected so promote is testable without the prod getOrgPg singleton. */
export interface PromoteDeps {
  /** Mint an engineer issue (issues-engineer.createIssue). Returns its EI-id + title. */
  createIssue(input: {
    title: string;
    body: string;
    severity?: string;
    source?: string;
    scope?: string;
    topics?: string[];
    foundDuring?: string;
    createdBy?: string;
  }): Promise<{ id: string; title: string }>;
  /** Carry the conversation's thread into the issue (conversations-store.reparentThread). */
  reparentThread(from: ObjectRef, to: ObjectRef, newThreadId: string): Promise<{ reparented: boolean; thread_id?: string }>;
  /** The destination domain's thread_id convention (engineer_issues: `issue-thread-<id>`). */
  issueThreadId(issueId: string): string;
}

/** The capture surface (answer-capture.captureResolvedAnswer satisfies it). */
export type CaptureFn = (input: {
  target: CaptureTarget;
  question: string;
  answer: string;
  scope: ConversationScope;
  harness_slug: string | null;
  workspace_id?: string | null;
  asker_id: string;
  resolver_id: string;
  conversation_id: string;
}) => Promise<CaptureResult>;

export interface ConversationDeps {
  conversations: ConversationStoreLike;
  threads: ThreadableStore;
  /**
   * Run a unit of thread writes inside ONE bounded, atomic admin-pool transaction,
   * handing `fn` a transaction-bound ThreadableStore (pg-bounded-txn). The
   * post/answer append (appendPost) routes its get-or-create-thread + add-post
   * through this so the durable write is:
   *   - ATOMIC  — the coord_thread_posts INSERT and the coord_threads post_count
   *               bump commit together, so a stall can't half-write and a
   *               post-stall retry can't duplicate the post; and
   *   - BOUNDED — a SET LOCAL statement_timeout makes a wedged query fail fast +
   *               typed (OrgTxnTimeoutError) instead of hanging the MCP call
   *               indefinitely (the harness_admin pool carries NO default
   *               statement_timeout — migrations share it).
   * Prod wraps boundedOrgTxn + a tx-bound PgThreadStore, mirroring
   * issues-engineer.commentIssue / work-items.commentWorkItem; the integration
   * tests bind the same boundedOrgTxn over their throwaway-PG client so the real
   * atomic path is exercised. (WI-766 — closes the unbounded admin-pool write
   * class for conversations:post / conversations:answer.)
   */
  threadTxn: <T>(fn: (threads: ThreadableStore) => Promise<T>) => Promise<T>;
  tags: TaggableStore;
  subs: SubscribableStore;
  topics: TopicStore;
  /** Delivery sink for the fan-out (coordLog in prod; an in-memory double in tests). */
  sink: InjectSink;
  capture: CaptureFn;
  nowIso: () => string;
  /** Generate an id with the given prefix (newMsgId-backed in prod; a counter in tests). */
  newId: (prefix: string) => string;
  /** Bridge to engineer-issues for conversations:promote (D-005). Absent → promote unavailable. */
  promote?: PromoteDeps;
}

function convRef(id: string): ObjectRef {
  return { kind: 'conversation', ref: id };
}

function truncate(s: string, n = 120): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function normalizeSlug(s: string): string {
  return s.trim().toLowerCase();
}

/** Resolve subscribers (direct ∪ topic), drop the actor, deliver honoring mode.
 *  Routed through the canonical fanoutForObject seam (A6), threading this
 *  module's injected stores + sink so the dependency injection its tests rely
 *  on is preserved. Best-effort — a delivery failure never breaks the write. */
async function fanout(deps: ConversationDeps, object: ObjectRef, ev: InjectEvent, excludeId?: string): Promise<number> {
  return fanoutForObject(object, ev, {
    excludeId,
    sink: deps.sink,
    stores: { subscriptions: deps.subs, tags: deps.tags, topics: deps.topics },
  });
}

async function selfSubscribe(deps: ConversationDeps, conversationId: string, subscriberId: string, now: string): Promise<void> {
  await deps.subs.subscribe({
    subscriber_id: subscriberId,
    target_kind: 'object',
    target_ref: objectToTargetRef(convRef(conversationId)),
    delivery_mode: 'full',
    created_ts: now,
  });
}

// ── Open ─────────────────────────────────────────────────────────────────────

export interface OpenConversationInput {
  kind: ConversationKind;
  body: string;
  /**
   * Which tool is opening this (EI-21462599108204160). REQUIRED so a new
   * caller cannot silently land an unattributed row: the previous attribution
   * — the Decision-tier escalation twin — is closed when the question is
   * answered, so it could only ever describe UNANSWERED asks.
   */
  producer: ConversationProducer;
  /** Internal lane provenance resolved from live coordination state. */
  plan_slug?: string | null;
  work_item_id?: string | null;
  title?: string;
  topics?: string[];
  scope?: ConversationScope;
  harness_slug?: string;
  /**
   * Agents this conversation is addressed to DIRECTLY (WI-5754). They are
   * subscribed to the conversation object BEFORE the open fans out, so the
   * existing subscriber fan-out delivers to them — no second notification path.
   * Topic routing still applies on top; this only guarantees a named recipient
   * is reached even when no topic routes to them (or none was tagged at all).
   */
  direct_to?: string[];
}

export interface OpenConversationResult {
  conversation: ConversationRow;
  thread_id: string;
  topics: string[];
  delivered: number;
  unrouted: boolean;
  /** The named recipients actually subscribed (the asker is never one). */
  direct_to: string[];
  /** Lifecycle-bound wake on this question's concrete answer edge. */
  interestWatch?: import('../../interest-auto-arm').InterestAutoArmHandle;
}

/** Materialize the shared thread/tag/subscription/fan-out half of an open.
 * Supersession uses the same path after its row-level transaction has inserted
 * the replacement, so the old gate can never remain open while the replacement
 * is being created. */
async function materializeOpenedConversation(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: OpenConversationInput,
  conversation: ConversationRow,
): Promise<OpenConversationResult> {
  const now = deps.nowIso();
  const id = conversation.id;
  const harness_slug = conversation.harness_slug;

  const thread = await deps.threads.getOrCreateThread(convRef(id), {
    // Deterministic thread_id derived from the conversation id, so every machine
    // converges on ONE canonical thread per conversation (the coord_threads
    // parent-unique index would otherwise reject a peer's thread for the same
    // conversation under a federation race). Federation, Track A.
    thread_id: `thr-${id}`,
    title: input.title,
    created_by: identity.ownerId,
    created_ts: now,
    // Federation: a harness-scoped conversation's thread + posts federate
    // (distributed-coordination-shared-harness-2026-06-04 Track A).
    harness_slug: harness_slug ?? undefined,
  });

  const topics = [...new Set((input.topics ?? []).map(normalizeSlug).filter(Boolean))];
  for (const slug of topics) {
    await deps.tags.addTag(convRef(id), slug, { created_by: identity.ownerId, created_ts: now });
  }

  // Fan out the OPEN to topic subscribers BEFORE the asker self-subscribes, so
  // the asker isn't notified of their own question; then subscribe them so peer
  // answers come back. The ordering only shields the asker's OBJECT
  // subscription — an asker already following one of the question's TOPICS is
  // resolved as a topic subscriber, so they must also be excluded explicitly
  // (excludeId), like every other lifecycle fan-out in this module.
  const ev: InjectEvent = {
    from: identity.ownerId,
    subject: `conversation:${id}`,
    summary: `${input.kind === 'question' ? '❓ question' : input.kind === 'consult' ? '🧭 consult' : '💬 discussion'}: ${input.title ?? truncate(input.body)}`,
    body: input.body,
    notify_kind: input.kind === 'question' ? 'question_opened' : 'discussion_opened',
    isResolution: false,
  };
  // Named recipients (WI-5754) subscribe BEFORE the fan-out, so the SAME
  // subscriber fan-out below reaches them — a directed ask needs no second
  // delivery path, and the recipient stays subscribed for the whole thread.
  // The asker is excluded: they self-subscribe just after, and fanout already
  // shields them from being notified of their own question.
  const directTo = [...new Set(input.direct_to ?? [])].filter(
    (agentId) => agentId && agentId !== identity.ownerId,
  );
  for (const agentId of directTo) {
    await selfSubscribe(deps, id, agentId, now);
  }

  const delivered = await fanout(deps, convRef(id), ev, identity.ownerId);
  await selfSubscribe(deps, id, identity.ownerId, now);

  // `unrouted` means NOBODY WAS ACTUALLY REACHED — measured from the fan-out,
  // not inferred from "did the asker supply topics".
  //
  // It used to be `topics.length === 0 && directTo.length === 0`, i.e. "you
  // tagged something, so you're fine". That is a FALSE ASSURANCE, and it hid a
  // total routing failure for weeks (2026-07-25 audit): topic fan-out resolves
  // TOPIC subscribers, and this workspace has ZERO live topic subscriptions —
  // across 30 distinct topics used by open questions, not one had a subscriber.
  // The proof: 13 open questions were correctly topic-tagged, still ended up
  // with only the asker subscribed, and 100% of them got zero replies. Each of
  // those askers was told "opened to topic subscribers" and reasonably believed
  // the question had landed somewhere.
  //
  // Deriving it from `delivered` cannot drift from reality: directTo recipients
  // are subscribed BEFORE the fan-out above, and the asker is excluded from it,
  // so delivered === 0 means literally no other agent was notified — whatever
  // the asker tagged.
  return {
    conversation,
    thread_id: thread.thread_id,
    topics,
    delivered,
    unrouted: delivered === 0,
    direct_to: directTo,
  };
}

export async function openConversationCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: OpenConversationInput,
): Promise<OpenConversationResult> {
  const now = deps.nowIso();
  const id = deps.newId('conv');
  // allow-scope-default: no harness ⇒ an operator-level conversation (the explicit top scope, not a workspace).
  const scope: ConversationScope = input.harness_slug ? 'harness' : input.scope ?? 'operator';
  const harness_slug = scope === 'harness' ? input.harness_slug ?? null : null;
  const conversation = await deps.conversations.create({
    id,
    kind: input.kind,
    scope,
    harness_slug,
    asker_id: identity.ownerId,
    title: input.title ?? null,
    body: input.body,
    producer: input.producer,
    plan_slug: input.plan_slug ?? null,
    work_item_id: input.work_item_id ?? null,
    created_ts: now,
  });
  return materializeOpenedConversation(deps, identity, input, conversation);
}

// ── Supersede ───────────────────────────────────────────────────────────────

export interface SupersedeConversationInput {
  conversation_id: string;
  /** Internal lane provenance; public tools never accept these fields directly. */
  plan_slug?: string | null;
  work_item_id?: string | null;
  replacement: {
    body: string;
    title?: string;
    topics?: string[];
    direct_to?: string[];
    kind?: ConversationKind;
  };
  reason?: string;
}

export interface SupersedeConversationResult {
  conversation: ConversationRow;
  replacement: OpenConversationResult;
  delivered: number;
}

export async function supersedeConversationCore(
  deps: ConversationDeps,
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
  const old = await deps.conversations.get(input.conversation_id);
  if (!old) return { error: 'not_found' };
  if (old.state === 'superseded') return { error: 'already_superseded' };
  if (old.state !== 'open') return { error: 'already_terminal' };
  // Owner questions are gates owned by the agent that asked them. A peer that
  // misidentifies a conversation id must not be able to retract that gate (the
  // replacement would silently move the human decision to the wrong lane). The
  // producer check keeps owner-UI `coord:ask` questions and discussions
  // supersedable by their coordinators, while legacy unattributed questions
  // fail closed because they cannot prove a different ownership contract.
  // WI-1373235: a P-011 correction accidentally superseded an unrelated P-003
  // owner gate and cancelled its answer await.
  const ownerQuestion =
    old.kind === 'question' && (old.producer === 'coord:ask-owner' || old.producer == null);
  const recoveredOwnerMatchesLane = Boolean(
    old.plan_slug && old.work_item_id &&
    input.plan_slug?.trim() === old.plan_slug &&
    input.work_item_id?.trim() === old.work_item_id,
  );
  if (ownerQuestion && old.asker_id !== identity.ownerId && !recoveredOwnerMatchesLane) return { error: 'not_owner' };
  if (!input.replacement.body.trim()) return { error: 'invalid_replacement' };

  const now = deps.nowIso();
  // The replacement INHERITS the original's producer: superseding is a retraction
  // and re-ask of the SAME question by the same tool, so attributing it to the
  // supersede verb would lose exactly the attribution this column exists to keep.
  // A row opened before the column existed (or federated from an older peer) has
  // nothing to inherit — only then does the supersede verb name itself.
  const replacementProducer: ConversationProducer = isConversationProducer(old.producer)
    ? old.producer
    : 'conversations:supersede';
  const replacementInput: CreateConversationInput = {
    id: deps.newId('conv'),
    kind: input.replacement.kind ?? old.kind,
    scope: old.scope,
    harness_slug: old.harness_slug,
    asker_id: identity.ownerId,
    title: input.replacement.title ?? old.title,
    body: input.replacement.body,
    producer: replacementProducer,
    plan_slug: old.plan_slug ?? input.plan_slug ?? null,
    work_item_id: old.work_item_id ?? input.work_item_id ?? null,
    created_ts: now,
  };
  const swapped = await deps.conversations.supersede(old.id, replacementInput, { now_ts: now });
  if ('error' in swapped) {
    if (swapped.error === 'not_found') return swapped;
    return swapped.conversation.state === 'superseded'
      ? { error: 'already_superseded' }
      : { error: 'already_terminal' };
  }

  const replacement = await materializeOpenedConversation(
    deps,
    identity,
    {
      kind: replacementInput.kind,
      body: replacementInput.body,
      producer: replacementProducer,
      title: replacementInput.title ?? undefined,
      topics: input.replacement.topics,
      scope: replacementInput.scope,
      harness_slug: replacementInput.harness_slug ?? undefined,
      direct_to: input.replacement.direct_to,
    },
    swapped.replacement,
  );

  const reason = input.reason?.trim() || 'The premise or requested answer changed.';
  const ev: InjectEvent = {
    from: identity.ownerId,
    subject: `conversation:${old.id}`,
    summary: `↩️ retracted ${old.kind} ${old.id}; replacement ${replacement.conversation.id}`,
    body: `${reason} Replacement conversation: ${replacement.conversation.id}`,
    notify_kind: 'conversation_superseded',
    isResolution: true,
    extra: {
      superseded_by: replacement.conversation.id,
      superseded_reason: reason,
    },
  };
  const delivered = await fanout(deps, convRef(old.id), ev, identity.ownerId);
  const updated = (await deps.conversations.get(old.id)) ?? swapped.conversation;
  return { conversation: updated, replacement, delivered };
}

// ── Post / answer ────────────────────────────────────────────────────────────

export interface PostResult {
  post: ThreadPostRow;
  delivered: number;
}

async function resolveConversationRow(
  deps: ConversationDeps,
  id: string,
): Promise<{ conversation: ConversationRow; resolvedFromPrefix?: string } | null> {
  const exact = await deps.conversations.get(id);
  if (exact) return { conversation: exact };
  if (!deps.conversations.getByPrefix) return null;
  const candidates = await deps.conversations.getByPrefix(id, 2);
  if (candidates.length !== 1) return null;
  return { conversation: candidates[0]!, resolvedFromPrefix: id };
}

async function appendPost(
  deps: ConversationDeps,
  identity: AgentIdentity,
  conversationId: string,
  body: string,
  opts: { isAnswer: boolean; mentions?: string[]; viaConsultVerb?: boolean },
): Promise<PostResult | { error: 'not_found' } | { error: 'resolved' } | { error: 'closed' } | { error: 'superseded' } | { error: 'consult_requires_typed_verb' }> {
  const resolved = await resolveConversationRow(deps, conversationId);
  if (!resolved) return { error: 'not_found' };
  const conv = resolved.conversation;
  conversationId = conv.id;
  // THE CONSULT KIND GATE (get-feedback-relevance-consults-2026-08-16 P-004,
  // D-008 §2): a kind='consult' conversation takes only TYPED posts — every
  // post carries a consult_post_meta row (kind + evidence; migration 834), and
  // a post that is neither a question nor a new fact is refused by the verbs
  // (termination is structural, D-001). This is the LOWEST shared chokepoint:
  // conversations:post, conversations:answer AND the coord-op postThread cap
  // all route through here, so none can land an untyped post. The consult
  // verbs (consult:reply / consult:decline / consult:close) set the INTERNAL
  // viaConsultVerb flag after validating {kind, caps, budget} — no public tool
  // schema exposes it.
  if (conv.kind === 'consult' && !opts.viaConsultVerb) return { error: 'consult_requires_typed_verb' };
  // A terminal conversation no longer takes posts (P1-17): a resolved question
  // is answered, and a promoted one continues on its issue thread — appending
  // here would silently land a post nobody is watching the conversation for.
  if (conv.state === 'resolved') return { error: 'resolved' };
  if (conv.state === 'closed') return { error: 'closed' };
  if (conv.state === 'superseded') return { error: 'superseded' };
  // consult:close's requester late-disposition path is intentionally allowed to
  // write a typed terminal post after the expiry sweep projects this coarse
  // state. The consult verb has already validated the author/outcome; generic
  // posts still fail at the consult kind gate above.
  if (conv.state === 'expired' && !opts.viaConsultVerb) return { error: 'closed' };
  const now = deps.nowIso();

  // The durable write — get-or-create the conversation's thread, then append the
  // post — runs in ONE bounded, atomic admin-pool txn (threadTxn → boundedOrgTxn).
  // ATOMIC: the post row + the coord_threads post_count bump commit together, so a
  // stall can't half-write and a post-stall retry can't duplicate. BOUNDED: a
  // wedged query fails fast + typed instead of hanging the MCP call indefinitely
  // (the admin pool has no default statement_timeout). getOrCreateThread already
  // resolves by PARENT first, so it returns the existing thread when present (no
  // need for a separate getThreadByParent round-trip). Mirrors
  // issues-engineer.commentIssue / work-items.commentWorkItem (WI-766).
  const post = await deps.threadTxn(async (threads) => {
    const thread = await threads.getOrCreateThread(convRef(conversationId), {
      thread_id: `thr-${conversationId}`,
      created_by: identity.ownerId,
      created_ts: now,
      harness_slug: conv.harness_slug ?? undefined,
    });
    return threads.addPost({ thread_id: thread.thread_id, author_id: identity.ownerId, body, created_ts: now });
  });
  await deps.conversations.touch(conversationId, now);
  // Contributing → auto-join (so the rest of the thread reaches the poster), then fan out excluding them.
  await selfSubscribe(deps, conversationId, identity.ownerId, now);

  const verb = opts.isAnswer ? '✅ answer' : '💬 reply';
  const ev: InjectEvent = {
    from: identity.ownerId,
    subject: `conversation:${conversationId}`,
    summary: `${verb} on ${conv.kind} ${conversationId}: ${truncate(body)}`,
    body,
    notify_kind: opts.isAnswer ? 'answer_posted' : 'conversation_post',
    mentions: opts.mentions,
    isResolution: false,
  };
  const delivered = await fanout(deps, convRef(conversationId), ev, identity.ownerId);
  return { post, delivered };
}

/** The post/answer error union (P-004 widened it with the consult kind-gate refusal). */
export type AppendPostError =
  | { error: 'not_found' }
  | { error: 'resolved' }
  | { error: 'closed' }
  | { error: 'superseded' }
  | { error: 'consult_requires_typed_verb' };

export function postReplyCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: { conversation_id: string; body: string; mentions?: string[]; via_consult_verb?: boolean },
): Promise<PostResult | AppendPostError> {
  return appendPost(deps, identity, input.conversation_id, input.body, {
    isAnswer: false,
    mentions: input.mentions,
    viaConsultVerb: input.via_consult_verb,
  });
}

export function answerQuestionCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: { conversation_id: string; body: string; mentions?: string[]; via_consult_verb?: boolean },
): Promise<PostResult | AppendPostError> {
  return appendPost(deps, identity, input.conversation_id, input.body, {
    isAnswer: true,
    mentions: input.mentions,
    viaConsultVerb: input.via_consult_verb,
  });
}

/**
 * Settle the coarse conversation projection for a terminal consult close.
 * consult_state carries the consult-specific lifecycle; coord_conversations is
 * what conversations:get/list reads, so a consult close must update both.
 * The terminal post is written by consultCloseCore before this callback and is
 * deliberately not duplicated here.
 */
export async function settleConsultConversationCore(
  deps: ConversationDeps,
  input: {
    conversation_id: string;
    outcome: 'answered' | 'cant_help' | 'graduate';
    answer?: string;
    post_id: number;
    now_ts: string;
  },
): Promise<void> {
  if (input.outcome === 'answered') {
    const answer = input.answer?.trim();
    if (!answer) throw new Error(`consult ${input.conversation_id} answered close has no answer`);
    await deps.conversations.setAcceptedAnswer(input.conversation_id, {
      answer,
      post_id: input.post_id,
      now_ts: input.now_ts,
    });
    await deps.conversations.setState(input.conversation_id, 'resolved', { now_ts: input.now_ts });
    return;
  }
  await deps.conversations.setState(input.conversation_id, 'closed', { now_ts: input.now_ts });
}

// ── Resolve ──────────────────────────────────────────────────────────────────

export interface ResolveInput {
  conversation_id: string;
  accepted_answer?: string;
  accepted_post_id?: number;
  capture?: CaptureTarget;
}

export interface ResolveResult {
  conversation: ConversationRow;
  capture: CaptureResult;
  delivered: number;
}

export type ResolveError =
  | { error: 'not_found' }
  | { error: 'no_answer' }
  | { error: 'already_resolved' }
  | { error: 'consult_requires_typed_verb' };

export async function resolveConversationCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: ResolveInput,
): Promise<ResolveResult | ResolveError> {
  const conv = await deps.conversations.get(input.conversation_id);
  if (!conv) return { error: 'not_found' };
  // Consults have a finer-grained lifecycle and typed terminal outcomes in
  // consult_state. Generic resolution would only update the coarse
  // coord_conversations projection, making a consult look resolved while the
  // authoritative consult row is still open/expired and has no critique. Keep
  // consult:close as the sole terminal writer for consult conversations.
  if (conv.kind === 'consult') return { error: 'consult_requires_typed_verb' };
  // Re-resolving is rejected (P1-17): without this guard a SECOND resolve re-ran
  // capture and OVERWROTE the accepted answer with the new one — silently
  // corrupting the record the first resolver captured. The accepted answer is
  // immutable once set; a genuine correction is a fresh conversation, not a
  // re-resolve. (A promoted-closed conversation is likewise terminal.)
  if (conv.state === 'resolved' || conv.state === 'closed' || conv.state === 'superseded' || conv.state === 'expired') return { error: 'already_resolved' };
  const now = deps.nowIso();

  let answer = input.accepted_answer?.trim();
  const postId = input.accepted_post_id ?? null;
  if (!answer && postId != null) {
    const thread = await deps.threads.getThreadByParent(convRef(input.conversation_id));
    if (thread) {
      const posts = await deps.threads.listPosts(thread.thread_id);
      const match = posts.find((p) => p.id === postId);
      if (match) answer = match.body.trim();
    }
  }
  if (!answer) return { error: 'no_answer' };

  // Capture into an INDEXED knowledge surface so the NEXT asker gets a sync hit
  // (D-004 — the loop-closer + idle-asker safety net).
  const capture = await deps.capture({
    target: input.capture ?? 'mem0',
    question: conv.title ?? conv.body,
    answer,
    scope: conv.scope,
    harness_slug: conv.harness_slug,
    workspace_id: identity.workspaceId,
    asker_id: conv.asker_id,
    resolver_id: identity.ownerId,
    conversation_id: conv.id,
  });

  await deps.conversations.setAcceptedAnswer(conv.id, { answer, post_id: postId, capture_target: capture.target, now_ts: now });
  await deps.conversations.setState(conv.id, 'resolved', { now_ts: now });

  const ev: InjectEvent = {
    from: identity.ownerId,
    subject: `conversation:${conv.id}`,
    summary: `🏁 resolved ${conv.kind} ${conv.id}: ${truncate(answer)}`,
    body: answer,
    notify_kind: 'conversation_resolved',
    isResolution: true,
  };
  // Notify everyone INCLUDING the asker (only the resolver is excluded).
  const delivered = await fanout(deps, convRef(conv.id), ev, identity.ownerId);

  const updated = (await deps.conversations.get(conv.id)) ?? conv;
  return { conversation: updated, capture, delivered };
}

// ── Join / leave ───────────────────────────────────────────────────────────

export async function joinConversationCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: { conversation_id: string; mode?: DeliveryMode; ttl_sec?: number },
): Promise<JoinConversationResult> {
  const conv = await deps.conversations.get(input.conversation_id);
  if (!conv) return { error: 'not_found' };
  // Consult participation is selected by consult:get_feedback's router. A
  // generic subscription does not enroll a responder, so reporting a normal
  // full-mode join would send callers toward consult:reply only to receive
  // not_a_participant. Refuse the misleading path before writing a sub.
  if (conv.kind === 'consult') return { error: 'consult_participation_router_assigned' };
  const now = deps.nowIso();
  const expires_ts = input.ttl_sec != null ? new Date(Date.parse(now) + input.ttl_sec * 1000).toISOString() : null;
  const sub = await deps.subs.subscribe({
    subscriber_id: identity.ownerId,
    target_kind: 'object',
    target_ref: objectToTargetRef(convRef(input.conversation_id)),
    delivery_mode: input.mode ?? 'full',
    created_ts: now,
    expires_ts,
  });
  return { ok: true, mode: sub.delivery_mode };
}

export type JoinConversationResult =
  | { ok: true; mode: DeliveryMode }
  | { error: 'not_found' }
  | { error: 'consult_participation_router_assigned' };

export async function leaveConversationCore(deps: ConversationDeps, identity: AgentIdentity, conversationId: string): Promise<void> {
  await deps.subs.unsubscribe(identity.ownerId, 'object', objectToTargetRef(convRef(conversationId)));
}

// ── Read ─────────────────────────────────────────────────────────────────────

export function listConversationsCore(deps: ConversationDeps, input: ListConversationsOpts = {}): Promise<ConversationRow[]> {
  return deps.conversations.list(input);
}

export interface ListConversationsWithTopicsOpts extends ListConversationsOpts {
  /** Filter to conversations tagged with this topic slug (normalized lowercase).
   *  Applied AFTER the scalar filters (kind/state/scope/harness) over the page. */
  topic?: string;
}

export type ConversationWithTopics = ConversationRow & { topics: string[] };

/** List conversations AND their topic tags in one batch (the browse-tab read).
 *  Topics ride a single `listTagsForMany` over the page (no N+1); an optional
 *  `topic` filters to conversations tagged with that slug via the reverse-edge
 *  index. When `topic` is set we page wide (store cap) then narrow + re-limit, so
 *  a topic match isn't lost behind the scalar page's `limit`. */
export async function listConversationsWithTopicsCore(
  deps: ConversationDeps,
  input: ListConversationsWithTopicsOpts = {},
): Promise<ConversationWithTopics[]> {
  const { topic, limit, ...rest } = input;
  const wantTopic = topic?.trim().toLowerCase();
  // When filtering by topic, fetch the full scalar page (store caps at 200) and
  // narrow afterwards; otherwise honor the caller's limit directly.
  let rows = await deps.conversations.list({ ...rest, limit: wantTopic ? 200 : limit });
  if (wantTopic) {
    const tagged = await deps.tags.listTagged(wantTopic);
    const ids = new Set(tagged.filter((o) => o.kind === 'conversation').map((o) => o.ref));
    rows = rows.filter((r) => ids.has(r.id)).slice(0, limit ?? 50);
  }
  if (rows.length === 0) return [];
  const tagMap = await deps.tags.listTagsForMany(rows.map((r) => convRef(r.id)));
  return rows.map((r) => ({ ...r, topics: tagMap.get(objectKey(convRef(r.id))) ?? [] }));
}

export interface ConversationDetail {
  conversation: ConversationRow;
  topics: string[];
  posts: ThreadPostRow[];
  subscriber_count: number;
  /**
   * EI-21914051456641891: set ONLY when `id` did not resolve as an exact
   * match but UNIQUELY matched as a prefix (a hand-truncated citation of a
   * longer real id — see getByPrefix's doc). `conversation.id` is always the
   * real, full, canonical id; this records what the CALLER actually passed,
   * so the caller can be warned to cite the full id from here on.
   */
  resolvedFromPrefix?: string;
}

export async function getConversationCore(deps: ConversationDeps, id: string): Promise<ConversationDetail | null> {
  const resolved = await resolveConversationRow(deps, id);
  if (!resolved) return null;
  const conversation = resolved.conversation;
  id = conversation.id;
  const topics = await deps.tags.listTags(convRef(id));
  const thread = await deps.threads.getThreadByParent(convRef(id));
  const posts = thread ? await deps.threads.listPosts(thread.thread_id) : [];
  const subscribers = await deps.subs.listTargetSubscribers('object', objectToTargetRef(convRef(id)));
  return {
    conversation,
    topics,
    posts,
    subscriber_count: subscribers.length,
    ...(resolved.resolvedFromPrefix ? { resolvedFromPrefix: resolved.resolvedFromPrefix } : {}),
  };
}

// ── Promote → engineer issue (D-005) ─────────────────────────────────────────
// A question/discussion that concludes "this is a real problem" promotes into an
// engineer_issues row, CARRYING its thread (re-parented, not migrated). The
// conversation is then closed and records the issue id; the discussion continues
// on the issue.

export interface PromoteConversationInput {
  conversation_id: string;
  severity?: 'critical' | 'major' | 'minor' | 'nit';
  source?: 'engineer' | 'su';
  /** Force a harness-scoped issue (overrides an operator-scope conversation). */
  harness?: string;
}

export interface PromoteConversationResult {
  conversation: ConversationRow;
  issue: { id: string; title: string };
  thread_reparented: boolean;
  delivered: number;
}

export async function promoteConversationCore(
  deps: ConversationDeps,
  identity: AgentIdentity,
  input: PromoteConversationInput,
): Promise<PromoteConversationResult | { error: 'not_found' } | { error: 'already_promoted' } | { error: 'already_terminal' } | { error: 'promote_unavailable' }> {
  if (!deps.promote) return { error: 'promote_unavailable' };
  const conv = await deps.conversations.get(input.conversation_id);
  if (!conv) return { error: 'not_found' };
  if (conv.promoted_issue_id) return { error: 'already_promoted' };
  if (conv.state === 'superseded') return { error: 'already_terminal' };
  const now = deps.nowIso();

  // engineer_issues encodes the harness in its scope STRING ('operator' | 'harness:<slug>').
  const issueScope =
    conv.scope === 'harness' && conv.harness_slug
      ? `harness:${conv.harness_slug}`
      : input.harness
        ? `harness:${input.harness}`
        : 'operator';
  const topics = await deps.tags.listTags(convRef(conv.id));

  const issue = await deps.promote.createIssue({
    title: conv.title ?? truncate(conv.body, 120),
    body: `${conv.body}\n\n— promoted from conversation ${conv.id}`,
    severity: input.severity ?? 'minor',
    source: input.source ?? 'su',
    scope: issueScope,
    topics,
    foundDuring: `conversation:${conv.id}`,
    createdBy: identity.ownerId,
  });

  // Carry the discussion thread into the issue (D-005 — re-parent, not migrate).
  const rep = await deps.promote.reparentThread(
    convRef(conv.id),
    { kind: 'issue', ref: issue.id },
    deps.promote.issueThreadId(issue.id),
  );

  // Close the conversation + record the promotion.
  await deps.conversations.setPromoted(conv.id, { issue_id: issue.id, now_ts: now });

  // Notify the conversation's subscribers (a terminal event — isResolution so even
  // mention-mode followers hear it).
  const ev: InjectEvent = {
    from: identity.ownerId,
    subject: `conversation:${conv.id}`,
    summary: `⬆️ promoted ${conv.kind} ${conv.id} → issue ${issue.id}: ${truncate(issue.title)}`,
    body: `Promoted to engineer issue ${issue.id}.`,
    notify_kind: 'conversation_promoted',
    isResolution: true,
    extra: { issue_id: issue.id },
  };
  const delivered = await fanout(deps, convRef(conv.id), ev, identity.ownerId);

  const updated = (await deps.conversations.get(conv.id)) ?? conv;
  return { conversation: updated, issue, thread_reparented: rep.reparented, delivered };
}
