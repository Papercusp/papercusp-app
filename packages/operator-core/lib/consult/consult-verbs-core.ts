/**
 * consult-verbs-core.ts — the responder-side consult workflow (plan
 * get-feedback-relevance-consults-2026-08-16, P-004; decisions D-001/D-004/
 * D-005/D-007/D-008). Core/binding split mirrors get-feedback-core.ts: ALL
 * verb logic lives here behind injected deps (sql, post, emitReplyEvent,
 * reach) so it is integration-tested against the real migration-834 tables
 * without the prod singletons; the consult:reply / consult:decline /
 * consult:close tools (agent-tools/consult/*.ts) bind the prod seams.
 *
 * The enforcement chokepoint (D-008 §2): each verb VALIDATES {kind, caps}
 * against consult_state, then WRITES THROUGH into the existing
 * conversation thread via deps.post (bound to conversations.postReply with
 * the internal via_consult_verb flag — the appendPost kind gate refuses every
 * untyped route), stamping consult_post_meta with the post's typed overlay.
 *
 * What this module OWNS:
 *  - KIND RULES (D-001): responder posts ∈ {answer, clarifying_question,
 *    new_fact}; requester follow-ups ∈ {question, new_fact}. A post that is
 *    neither a question nor a new fact has no valid kind — termination is
 *    structural, the enum IS the rule. An answer REQUIRES evidence (D-004:
 *    answers cite transcript refs — that is the grounding enforcement).
 *  - THE EXCHANGE CAP: exchanges_used debits per reply; at the cap a reply is
 *    refused with the close-with-what-you-have nudge (D-001). decline/close
 *    are terminal moves and stay available AT the cap — that is the point.
 *  - STATE TRANSITIONS: awaiting_responder→active (first responder post);
 *    active→declined (decline w/ reason; remaining candidates from the
 *    routing snapshot feed the D-007(7) manual cascade);
 *    active→closed_answered|closed_cant_help (close w/ structured outcome —
 *    the outcome column comment is the authority). Sweeps to expired /
 *    graduated are P-005's, not here.
 *  - THE PARK-KEY EMIT (D-005/D-008): every responder post (reply, decline,
 *    close) emits the latched `consult:reply:<conversation_id>` event to the
 *    requester — the hard-blocked requester's park key (P-003 returns it).
 *  - THE WAKE BUDGET on requester follow-ups (D-005): aggregate wakes_used
 *    over origin_task_ref (same aggregation as get-feedback-core); exhausted
 *    ⇒ the follow-up still posts + delivers by subscription, it just does
 *    not wake the responder. Debited ON THE ATTEMPT.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { PostResult } from '../agent-tools/coordination/conversations-core';
import { consultParkKey as parkKey } from './get-feedback-core';
import {
  advanceCascade,
  digestFromRow,
  makeDigestEntry,
  selectionFromRouting,
  type CascadeDispatch,
  type CascadeEventKind,
} from './cascade-core';
import { consultResponderVerbMenu } from './responder-verb-menu';

export const RESPONDER_REPLY_KINDS = ['answer', 'clarifying_question', 'new_fact'] as const;
export const REQUESTER_REPLY_KINDS = ['question', 'new_fact'] as const;
export type ConsultReplyKind = 'question' | 'answer' | 'clarifying_question' | 'new_fact';

export interface ConsultEvidenceRef {
  session_id: string;
  turn_idx: number;
  note?: string;
}

/** consult_state columns the verbs read (migration 834). */
interface ConsultStateRow {
  workspace_id: string;
  conversation_id: string;
  requester_id: string;
  responder_id: string | null;
  state: string;
  question: string;
  latency_contract: string;
  max_exchanges: number;
  exchanges_used: number;
  wakes_used: number;
  cascade_cursor: number;
  cascade_digest: unknown;
  origin_task_ref: string | null;
  routing: unknown;
  outcome: unknown;
  closed_at: string | null;
}

/** Routing-snapshot candidate shape (consult_state.routing column comment). */
interface SnapshotCandidate {
  ownerId: string;
  score: number;
  liveness?: string;
}

/**
 * EI-21385436565682208: shared remedy text for every not_a_participant refusal.
 * Consult participation is selected by consult:get_feedback's router; a generic
 * conversations:join subscription can never confer it, so the refusal must point
 * at the verbs that CAN advance the caller instead of leaving them in the
 * join->reply->refuse loop the filed repro demonstrated.
 */
const CONSULT_PARTICIPATION_REMEDY =
  'Consult participants are router-assigned by consult:get_feedback - conversations:join cannot enroll you. Re-route via consult:get_feedback { question }, or deliver the answer out-of-band (e.g. coord:send to the requester).';

export interface ConsultVerbDeps {
  getSql: () => Sql;
  /** Write-through into the conversation thread — bound to
   * conversations.postReply WITH via_consult_verb (the kind-gate opt-in). */
  post: (input: {
    conversation_id: string;
    body: string;
    mentions?: string[];
    via_consult_verb: true;
  }) => Promise<PostResult | { error: string }>;
  /** Keep the coarse coord_conversations lifecycle in sync with the consult's
   * fine-grained terminal state. Bound by consult:close and terminal
   * consult:decline; optional so the lower-level verb tests and non-production
   * callers can focus on consult_state. For a terminal decline, the coarse
   * projection uses the non-answering `closed` state via outcome='cant_help';
   * consult_state remains the typed `declined` authority. */
  settleConversation?: (input: {
    conversationId: string;
    outcome: ConsultCloseRequest['outcome'];
    answer?: string;
    postId: number;
    now: string;
  }, tx?: Sql | TransactionSql) => Promise<void>;
  /** Latched `consult:reply:<conv>` emit → the (possibly parked) requester.
   * Prod binds emitAwaitedEvent; best-effort there (never breaks the verb). */
  emitReplyEvent: (input: {
    key: string;
    summary: string;
    payload: Record<string, unknown>;
    to: string[];
  }) => Promise<void>;
  /**
   * Directed ping + wake of the session ALREADY ANSWERING this consult — a
   * requester FOLLOW-UP, and the ONE delivery in the whole consult surface that
   * legitimately messages a live agent (D-011). That session is our own worker:
   * this consult launched it, it is doing nothing else, and the follow-up
   * belongs in the thread it is already holding. Prod binds notifyAgents.
   *
   * ⚠ Its addressee is the ANSWERING identity (selection.selected[cursor]
   * .answeringOwnerId ?? responder_id), NOT the routed expert — on a fork those
   * differ, and pinging the expert wakes an uninvolved agent while the session
   * holding the thread hears nothing.
   *
   * Absent ⇒ deliver-by-subscription only, no wake.
   */
  reach?: (opts: {
    responder: string;
    conversationId: string;
    summary: string;
    body: string;
  }) => Promise<{ woke: number; confirmedDead?: boolean }>;
  /**
   * The cascade DELIVERY seam (D-002/D-011) — fork/convert a NEW answering
   * session from the next expert's transcript. Passed to every advanceCascade
   * call from these verbs; prod binds makeConsultReachDispatcher.
   *
   * Never `reach`: an advance addresses an expert who is not in this
   * conversation, and reaching them is exactly the live-agent wake P-003
   * removes. Absent ⇒ the cursor advances and nobody is dispatched.
   */
  dispatch?: CascadeDispatch;
  /** P-005 graduation (D-004): mint the shared work item a 'graduate' close
   * hands off to — bound in prod (consult:close) to createWorkItem +
   * subscribe-both-participants + a rel:'relates' link to the conversation.
   * Optional because only the close verb needs it; a graduate close without
   * it is refused structurally (graduate_unavailable). */
  mintGraduationWorkItem?: (input: {
    workspaceId: string;
    conversationId: string;
    question: string;
    requesterId: string;
    responderId: string | null;
    closedBy: string;
    reason: string;
  }) => Promise<{ id: string }>;
  now?: () => Date;
}

export type ConsultVerbError =
  | { error: 'not_a_consult'; hint?: string }
  | { error: 'not_a_participant'; hint: string }
  | { error: 'conversation_id_ambiguous'; candidates: string[]; hint: string }
  | { error: 'not_the_responder' }
  | { error: 'consult_not_open'; state: string; hint: string }
  | { error: 'invalid_kind'; role: 'requester' | 'responder'; allowed: readonly string[]; hint: string }
  | { error: 'evidence_required'; hint: string }
  | { error: 'exchange_cap'; exchanges_used: number; max_exchanges: number; hint: string }
  | { error: 'answer_required' }
  | { error: 'reason_required' }
  | { error: 'post_failed'; cause: string }
  | { error: 'graduate_unavailable'; hint: string }
  | { error: 'graduate_failed'; cause: string }
  | { error: 'invalid_decision_ref'; hint: string }
  | { error: 'not_the_requester'; hint: string }
  | { error: 'not_a_proceed_consult'; latency_contract: string; hint: string }
  | { error: 'already_reconciled'; reconciliation: unknown; hint: string };

const POSTABLE_STATES = new Set(['awaiting_responder', 'active']);

function oneLine(s: string, n = 96): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * A full conversation id looks like `conv-mucapfpl-0000-<32 hex>` (51 chars).
 * The LEADING SHORT SEGMENT is what surfaces and prose routinely render, so an
 * id that reaches an agent second-hand is very often clipped to `conv-mucapfpl`
 * — the same `<short>-<n>-<32 hex>` shape, and the same truncation-at-source
 * hazard, that `resolveMessageRef` already resolves for coord `msg_id`s
 * (coordination/messages.ts; surfaced by coord:read and coord:thread).
 */
const FULL_CONVERSATION_ID_SHAPE = /^[^\s]+-\d+-[0-9a-f]{32}$/i;

/** Candidate cap for a truncated-prefix scan — mirrors REF_CANDIDATE_CAP. */
const CONVERSATION_REF_CANDIDATE_CAP = 5;

type ConversationRefResolution =
  | { status: 'found'; conversationId: string; resolvedFrom: 'exact' | 'prefix' }
  | { status: 'not-found'; looksTruncated: boolean }
  | { status: 'ambiguous'; candidates: string[] };

/**
 * Resolve a conversation_id REF (a full id, or a unique leading prefix) to the
 * id of a real `consult_state` row.
 *
 * WHY THIS EXISTS (EI-23942597240908282, MEASURED 2026-09-22). A grader was
 * told "you remain the assigned grader on conv-mucapfpl until consult:decline
 * advances it", fired exactly that, and got a bare `not_a_consult`. The refusal
 * was CORRECT — the row's real id was the 51-char
 * `conv-mucapfpl-0000-30e383612d604ea88789d3c06b3a01fe` — but it was
 * indistinguishable from "this is not a consult, you have no decline to make",
 * so the decline went unregistered, the cascade did not advance, and the plan
 * sat in awaiting-acceptance with nobody grading. Two independent ids in that
 * one incident (`conv-mucapfpl`, `conv-mucb58ib`) both arrived clipped at
 * EXACTLY the first segment boundary, which is a structural shortening rather
 * than a byte-offset coincidence of any one body cap.
 *
 * AMBIGUITY REFUSES rather than guessing: acting on the wrong consult would
 * post a decline into a stranger's cascade, which is worse than the refusal
 * this replaces. A well-formed FULL id that misses is a genuine not-found and
 * skips the scan entirely — so the common path costs nothing.
 */
async function resolveConversationRef(
  sql: Sql,
  workspaceId: string,
  ref: string,
): Promise<ConversationRefResolution> {
  const conversationId = (ref ?? '').trim();
  if (!conversationId) return { status: 'not-found', looksTruncated: false };

  const exact = (await sql`
    SELECT conversation_id
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
     LIMIT 1
  `) as unknown as Array<{ conversation_id: string }>;
  if (exact[0]) return { status: 'found', conversationId, resolvedFrom: 'exact' };

  // A well-formed full id that missed is a genuine miss — no prefix scan.
  if (FULL_CONVERSATION_ID_SHAPE.test(conversationId)) {
    return { status: 'not-found', looksTruncated: false };
  }

  const candidates = (await sql`
    SELECT conversation_id
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId}
       AND conversation_id LIKE ${conversationId + '%'}
     ORDER BY conversation_id
     LIMIT ${CONVERSATION_REF_CANDIDATE_CAP + 1}
  `) as unknown as Array<{ conversation_id: string }>;
  if (candidates.length === 0) return { status: 'not-found', looksTruncated: true };
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates: candidates.slice(0, CONVERSATION_REF_CANDIDATE_CAP).map((c) => c.conversation_id),
    };
  }
  return { status: 'found', conversationId: candidates[0]!.conversation_id, resolvedFrom: 'prefix' };
}

/**
 * Normalize a verb request so the ENTIRE verb body — every read AND every
 * write — operates on the resolved id.
 *
 * ⚠ THIS MUST REBIND THE REQUEST, NOT JUST THE LOOKUP. `conversationId` feeds
 * ~30 downstream sites here (the post, the consult_post_meta INSERT, the
 * consult_state UPDATE, the park key, the cascade wake). Resolving a prefix for
 * the gate read ALONE would let a verb pass its gate and then write against the
 * truncated id — every UPDATE matching zero rows while the verb reports
 * success. That is strictly worse than the honest refusal this replaces, so the
 * resolution happens once, here, before any of them.
 */
async function normalizeConversationRef<T extends { workspaceId: string; conversationId: string }>(
  sql: Sql,
  req: T,
): Promise<{ req: T } | ConsultVerbError> {
  const resolved = await resolveConversationRef(sql, req.workspaceId, req.conversationId);
  if (resolved.status === 'ambiguous') {
    return {
      error: 'conversation_id_ambiguous',
      candidates: resolved.candidates,
      hint:
        `'${req.conversationId}' is a TRUNCATED conversation id matching ${resolved.candidates.length}+ consults — ` +
        `supply more of the id, or the full one from your wake/brief.`,
    };
  }
  if (resolved.status === 'not-found') {
    return {
      error: 'not_a_consult',
      ...(resolved.looksTruncated
        ? {
            hint:
              `No consult id starts with '${req.conversationId}'. Note this is NOT a full conversation id ` +
              `(expected '<short>-0000-<32 hex>') — if you copied it out of prose or a coord line it may have ` +
              `been truncated at the source; cite the full id from your wake/brief.`,
          }
        : {}),
    };
  }
  if (resolved.conversationId === req.conversationId) return { req };
  return { req: { ...req, conversationId: resolved.conversationId } };
}

async function readState(
  sql: Sql,
  workspaceId: string,
  conversationId: string,
): Promise<ConsultStateRow | null> {
  const rows = (await sql`
    SELECT workspace_id, conversation_id, requester_id, responder_id, state,
           question, latency_contract, max_exchanges, exchanges_used,
           wakes_used, cascade_cursor, cascade_digest,
           origin_task_ref, routing, outcome, closed_at
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
  `) as unknown as ConsultStateRow[];
  return rows[0] ?? null;
}

/** The routing snapshot's qualified-but-not-chosen menu after a decline — the
 * decliner excluded, and nothing else.
 *
 * D-007(7) also filtered out route-time-DEAD candidates here, because the menu
 * fed a wake and a dead session could not be woken. D-002 removed that premise:
 * the menu now feeds the fork/convert dispatcher, which answers FROM the
 * transcript, so an `ended` candidate is exactly as dispatchable as a live one.
 * Keeping the filter would silently shrink every post-decline cascade to the
 * candidates that happen to still be running — the selection bias R-2 forbids.
 *
 * The driver may hand jsonb back unparsed; normalize before reading. */
function remainingFromSnapshot(routing: unknown, excludeOwnerId: string): Array<{ ownerId: string; score: number; liveness: string }> {
  const snap = typeof routing === 'string' ? (JSON.parse(routing) as unknown) : routing;
  const candidates = (snap as { candidates?: SnapshotCandidate[] } | null)?.candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((c) => c && typeof c.ownerId === 'string' && c.ownerId !== excludeOwnerId)
    .map((c) => ({ ownerId: c.ownerId, score: c.score, liveness: c.liveness ?? 'unknown' }));
}

function gateCommon(
  row: ConsultStateRow | null,
  manualReply?: { authorId: string; kind: ConsultReplyKind },
): ConsultVerbError | { row: ConsultStateRow } {
  if (!row) return { error: 'not_a_consult' };
  const isManualNoQualifiedReply =
    row.state === 'no_qualified_responder' &&
    row.responder_id !== null &&
    row.responder_id !== row.requester_id &&
    manualReply?.authorId === row.responder_id &&
    manualReply.kind === 'new_fact';
  if (!POSTABLE_STATES.has(row.state) && !isManualNoQualifiedReply) {
    return {
      error: 'consult_not_open',
      state: row.state,
      hint:
        row.state === 'declined'
          ? "This consult's cascade menu is exhausted (terminal decline) — re-call consult:get_feedback (optionally exclude the decliners) for a fresh route."
          : row.state === 'expired'
            ? 'This consult EXPIRED (cascade exhausted) and takes no further replies — but the REQUESTER may still record a late disposition with consult:close (WI-39862: e.g. outcome ‘answered’ citing the collected answers).'
            : `This consult is '${row.state}' and takes no further posts.`,
    };
  }
  return { row };
}

/**
 * A cascade responder remains a participant after their perspective advances
 * the menu to the next selectee. Keep close symmetry with reply: the current
 * responder, the requester, and every responder in the consumed selection
 * prefix may settle the consult.
 */
/** Is `authorId` the CURRENT responder — the cursor entry, not the whole
 * participant prefix?
 *
 * D-002 split this from a `=== row.responder_id` comparison, and the split is
 * load-bearing: `responder_id` names the EXPERT WHOSE TRANSCRIPT was routed,
 * while a FORK posts under a fresh coord identity. So on every fork the two
 * differ BY CONSTRUCTION, and the equality test silently classified the
 * dispatched session's own answer as an ordinary follow-up — which debits the
 * exchange cap and, worse, skips the cascade advance entirely, so the answer
 * never reaches `cascade_digest` and the next expert is never dispatched.
 * `answeringOwnerId` is stamped on the cursor entry for exactly this reason. */
function isCurrentResponder(row: ConsultStateRow, authorId: string): boolean {
  if (authorId === row.responder_id) return true;
  const cursorEntry = selectionFromRouting(row.routing)[row.cascade_cursor];
  return cursorEntry?.answeringOwnerId === authorId;
}

function isConsultParticipant(row: ConsultStateRow, authorId: string): boolean {
  if (authorId === row.requester_id || authorId === row.responder_id) return true;
  return selectionFromRouting(row.routing)
    .slice(0, row.cascade_cursor + 1)
    // D-002: the session that ANSWERS is not the expert whose transcript was
    // routed. A fork gets a fresh coord identity (so it cannot collide with a
    // still-live original), so `ownerId` alone would refuse the very session
    // this consult launched to answer it. `answeringOwnerId` is stamped by
    // dispatch for exactly this gate.
    .some((selection) => selection.ownerId === authorId || selection.answeringOwnerId === authorId);
}

/**
 * Consume a HISTORICAL revivalPending reservation (D-002 retired the revival
 * leg that wrote them, but a row reserved before this shipped can still be
 * open). The reserved session can reply at any time, so claim the reservation
 * atomically before the normal post/state path rather than refusing a reply the
 * old apparatus asked for. Returns a row snapshot with the reservation
 * consumed; nothing writes a new one.
 */
async function claimPendingRevival(
  sql: Sql,
  workspaceId: string,
  conversationId: string,
  authorId: string,
  now: string,
): Promise<ConsultStateRow | null> {
  const rows = (await sql`
    UPDATE harness_shared.consult_state
       SET routing = jsonb_set(
             routing #- ARRAY['selection', 'selected', cascade_cursor::text, 'revivalPending'],
             ARRAY['selection', 'selected', cascade_cursor::text, 'revived'],
             'true'::jsonb
           ),
           state = CASE WHEN state = 'no_qualified_responder' THEN 'awaiting_responder' ELSE state END,
           responder_id = ${authorId},
           updated_at = ${now}::timestamptz
     WHERE workspace_id = ${workspaceId}
       AND conversation_id = ${conversationId}
       AND responder_id = ${authorId}
       AND closed_at IS NULL
       AND routing #>> ARRAY['selection', 'selected', cascade_cursor::text, 'ownerId'] = ${authorId}
       AND routing #>> ARRAY['selection', 'selected', cascade_cursor::text, 'revivalPending'] = 'true'
    RETURNING workspace_id, conversation_id, requester_id, responder_id, state,
              question, latency_contract, max_exchanges, exchanges_used,
              wakes_used, cascade_cursor, cascade_digest,
              origin_task_ref, routing, outcome, closed_at
  `) as unknown as ConsultStateRow[];
  return rows[0] ?? null;
}

// ── consult:reply ────────────────────────────────────────────────────────────

export interface ConsultReplyRequest {
  workspaceId: string;
  authorId: string;
  conversationId: string;
  kind: ConsultReplyKind;
  body: string;
  evidence?: ConsultEvidenceRef[];
}

export interface ConsultReplyResult {
  ok: true;
  post_id: number;
  role: 'requester' | 'responder';
  state: string;
  exchanges_used: number;
  max_exchanges: number;
  /** Present on a requester follow-up. The per-task wake budget is REMOVED
   * (consult-min-max-and-rubric-vetting-2026-08-17 D-005) — a requester
   * follow-up always attempts the wake; wakes_used stays a plain stat. */
  wake?: {
    attempted: boolean;
    woke: number;
    /** Present after a zero-count wake attempt; records the confirmed-dead
     * check and the outcome of the CAS-guarded cascade. */
    reroute?: {
      status: 'not_confirmed_dead' | 'advanced' | 'exhausted' | 'raced' | 'unchanged';
      to: string | null;
    };
  };
  /** Present on a cascade-advancing perspective reply (D-005): which expert's
   * transcript the next answering session was DISPATCHED from with the
   * feedback-so-far digest (D-002 — no live agent is woken), or exhausted:true
   * when this selectee was the menu's last. refilled marks the WI-39861
   * min-ANSWERS refill round (the menu was extended once because
   * answers < min). */
  cascade?: {
    advanced_to: string | null;
    exhausted: boolean;
    woke: number;
    refilled?: boolean;
  };
  hint: string;
}

export async function consultReplyCore(
  req: ConsultReplyRequest,
  deps: ConsultVerbDeps,
): Promise<ConsultReplyResult | ConsultVerbError> {
  const sql = deps.getSql();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  // Resolve a truncated conversation ref BEFORE any read or write — see
  // normalizeConversationRef for why this must rebind the request.
  const normalized = await normalizeConversationRef(sql, req);
  if ('error' in normalized) return normalized;
  req = normalized.req;

  let currentRow = await readState(sql, req.workspaceId, req.conversationId);
  const pendingClaim = currentRow && req.authorId === currentRow.responder_id
    ? await claimPendingRevival(sql, req.workspaceId, req.conversationId, req.authorId, now)
    : null;
  if (pendingClaim) currentRow = pendingClaim;
  const gated = gateCommon(currentRow, {
    authorId: req.authorId,
    kind: req.kind,
  });
  if ('error' in gated) return gated;
  const row = gated.row;

  // Participants (D-005 cascade): the requester + every responder woken so
  // far (the selection menu's [0..cascade_cursor] prefix). Earlier cascade
  // selectees REMAIN participants after the chain advances past them — the
  // one consult thread is the accumulator they keep deliberating in.
  if (!isConsultParticipant(row, req.authorId)) {
    // EI-21385436565682208: name the ACTUAL remedy. conversations:join cannot
    // enroll anyone here (participation is router-assigned), so an un-hinted
    // not_a_participant sent agents into a join -> reply -> refuse loop.
    return {
      error: 'not_a_participant',
      hint: CONSULT_PARTICIPATION_REMEDY,
    };
  }
  const role: 'requester' | 'responder' = req.authorId === row.requester_id ? 'requester' : 'responder';

  // Kind rules (D-001): the enum is the structural termination — untyped prose
  // ("ok thanks") has no valid kind and cannot enter the thread.
  const allowed: readonly string[] = role === 'responder' ? RESPONDER_REPLY_KINDS : REQUESTER_REPLY_KINDS;
  if (!allowed.includes(req.kind)) {
    return {
      error: 'invalid_kind',
      role,
      allowed,
      hint: `A ${role} reply must be one of {${allowed.join(', ')}}. To end the consult, use consult:close (structured outcome) or consult:decline (responder).`,
    };
  }
  // D-004 grounding: an answer cites transcript evidence, always.
  if (req.kind === 'answer' && !(req.evidence && req.evidence.length > 0)) {
    return {
      error: 'evidence_required',
      hint: 'kind=answer requires evidence: [{ session_id, turn_idx, note? }] — cite the transcript turns the answer rests on (sessions:read resolves them).',
    };
  }
  // A cascade-advancing PERSPECTIVE reply is the CURRENT responder's post
  // (any kind, D-005). It is exempt from the exchange cap and does not debit
  // it: the cap bounds deliberation DEPTH, while the selection menu already
  // bounded perspective BREADTH (a max-5 consult collects 5 perspectives —
  // the default cap of 4 must not refuse the 5th). Later posts by the same
  // selectee are ordinary exchanges: the advance moves responder_id, so a
  // selectee can trigger at most one advance.
  // ⚠ "the current responder" is NOT `=== row.responder_id` since D-002 — on a
  // fork the answering identity differs from the routed expert. See
  // isCurrentResponder for what that equality test silently cost.
  const isPerspective = role === 'responder' && isCurrentResponder(row, req.authorId);

  // The exchange cap (D-001): a reply past the cap is refused; close/decline stay open.
  if (!isPerspective && row.exchanges_used + 1 > row.max_exchanges) {
    return {
      error: 'exchange_cap',
      exchanges_used: row.exchanges_used,
      max_exchanges: row.max_exchanges,
      hint: `Exchange cap reached (${row.exchanges_used}/${row.max_exchanges}) — close with what you have (consult:close { outcome: 'answered' | 'cant_help' }), or if you are both still deliberating, graduate it: consult:close { outcome: 'graduate', reason } mints a shared work item that carries the question forward (D-004).`,
    };
  }

  // Requester follow-ups wake the responder unconditionally — the per-task
  // wake budget is REMOVED (consult-min-max-and-rubric-vetting-2026-08-17
  // D-005: the per-consult exchange cap above is the remaining bound;
  // wakes_used keeps being written as a plain stat, never a gate).
  const willWake = role === 'requester' && row.responder_id != null && Boolean(deps.reach);

  // Write-through: post (the substrate commit) → meta overlay → state debit.
  // Sequential by house style (no txn across the substrate binding); the meta
  // INSERT lands only after the post committed, so an orphan meta row is
  // impossible — the reverse (post without meta) is the crash window and is
  // repaired by P-006 backfill semantics.
  const posted = await deps.post({ conversation_id: req.conversationId, body: req.body, via_consult_verb: true });
  if ('error' in posted) return { error: 'post_failed', cause: posted.error };
  const postId = posted.post.id;

  await sql`
    INSERT INTO harness_shared.consult_post_meta
      (workspace_id, post_id, conversation_id, author_id, kind, evidence)
    VALUES
      (${req.workspaceId}, ${postId}, ${req.conversationId}, ${req.authorId},
       ${req.kind}, ${req.evidence ? sql.json(req.evidence as never) : null})
  `;

  const nextState =
    role === 'responder' && (row.state === 'awaiting_responder' || row.state === 'no_qualified_responder')
      ? 'active'
      : row.state;
  const exchangesUsed = row.exchanges_used + (isPerspective ? 0 : 1);
  await sql`
    UPDATE harness_shared.consult_state
       SET state = ${nextState},
           exchanges_used = ${exchangesUsed},
           wakes_used = wakes_used + ${willWake ? 1 : 0},
           updated_at = ${now}::timestamptz
     WHERE workspace_id = ${req.workspaceId} AND conversation_id = ${req.conversationId}
  `;

  // The park-key emit (D-005/D-008): every responder post signals the requester
  // — a hard-blocked requester parked on the latched key wakes NOW.
  if (role === 'responder') {
    await deps.emitReplyEvent({
      key: parkKey(req.conversationId),
      summary: `consult ${req.conversationId}: ${req.kind} from ${req.authorId} — ${oneLine(req.body)}`,
      payload: { conversation_id: req.conversationId, responder: req.authorId, kind: req.kind, post_id: postId },
      to: [row.requester_id],
    });
  }

  let woke = 0;
  let answeringOwnerId: string | null = null;
  let responderConfirmedDead = false;
  if (willWake && deps.reach && row.responder_id) {
    // D-011: address the session that is ANSWERING, not the expert who was
    // routed. A fork answers under a new coord identity (stamped by dispatch as
    // answeringOwnerId); `responder_id` still names the expert whose knowledge
    // was selected, and waking THEM would ping an agent with no part in this
    // consult while the session holding the thread never hears the follow-up.
    const answering =
      selectionFromRouting(row.routing)[row.cascade_cursor]?.answeringOwnerId ?? row.responder_id;
    answeringOwnerId = answering;
    const r = await deps.reach({
      responder: answering,
      conversationId: req.conversationId,
      summary: `🧭 consult follow-up from ${req.authorId}: ${oneLine(req.body, 72)}`,
      // EI-21761566265989000: a follow-up wake is the case where unread posts are GUARANTEED to
      // exist — that is what makes it a follow-up — so naming the read door matters most here.
      body:
        `Follow-up (${req.kind}) on consult ${req.conversationId} (exchange ${exchangesUsed}/${row.max_exchanges}).\n` +
        consultResponderVerbMenu({ conversationId: req.conversationId }),
    });
    woke = r.woke;
    responderConfirmedDead = woke === 0 && r.confirmedDead === true;
  }

  // D-005 always-advance: the current responder's perspective advances the
  // chain — the next selectee is woken with the question + the feedback so
  // far. The park-key emit above already served a hard-blocked requester
  // (parks on the FIRST reply); the chain continues behind it.
  let cascade: ConsultReplyResult['cascade'];
  let requesterReroute:
    | NonNullable<ConsultReplyResult['wake']>['reroute']
    | undefined = willWake && woke === 0 ? { status: 'not_confirmed_dead', to: null } : undefined;
  const confirmedDeadFollowup = role === 'requester' && responderConfirmedDead;
  if (isPerspective || confirmedDeadFollowup) {
    const adv = await advanceCascade(
      {
        workspaceId: req.workspaceId,
        conversationId: req.conversationId,
        question: row.question,
        latencyContract: row.latency_contract,
        requesterId: row.requester_id,
        routing: row.routing,
        cascadeCursor: row.cascade_cursor,
        digest: row.cascade_digest,
        // Safe narrowing: isPerspective ⇒ role 'responder', and the kind gate
        // above already restricted req.kind to RESPONDER_REPLY_KINDS — the
        // requester-only 'question' cannot reach this branch.
        event: isPerspective
          ? makeDigestEntry(req.authorId, req.kind as CascadeEventKind, now, req.body)
          : makeDigestEntry(
              answeringOwnerId ?? row.responder_id ?? req.authorId,
              'wake_failed',
              now,
              'The answering session was confirmed ended after a requester follow-up.',
            ),
        stateOnAdvance: isPerspective
          ? 'active'
          : row.state === 'awaiting_responder'
            ? 'awaiting_responder'
            : 'active',
        nowIso: now,
      },
      sql,
      deps.dispatch,
    );
    // A raced advance means a concurrent trigger (the expiry sweep, typically)
    // moved the chain first — its advance stands and already woke the next
    // selectee, so this reply has no cascade consequence to report.
    if (!adv.raced) {
      cascade = {
        advanced_to: adv.next?.ownerId ?? null,
        exhausted: adv.exhausted,
        woke: adv.woke,
        ...(adv.refilled ? { refilled: true } : {}),
      };
      if (confirmedDeadFollowup) {
        requesterReroute = {
          status: adv.advanced ? 'advanced' : adv.exhausted ? 'exhausted' : 'unchanged',
          to: adv.advanced ? adv.next?.ownerId ?? null : null,
        };
      }
    } else if (confirmedDeadFollowup) {
      requesterReroute = { status: 'raced', to: null };
    }
  }
  const cascadeNote = cascade
    ? cascade.advanced_to
      ? ` Cascade advanced (D-005): an answering session was dispatched from ${cascade.advanced_to}'s transcript with the feedback so far (D-002 — forked/converted, never woken).${cascade.refilled ? ' (min-ANSWERS refill, WI-39861: the menu was extended once — answers collected < selection.min.)' : ''}`
      : ' Cascade menu exhausted — you were the last selectee.'
    : '';
  const requesterRerouteHint =
    requesterReroute?.status === 'advanced'
      ? `; the consult advanced to reviewer ${requesterReroute.to}`
      : requesterReroute?.status === 'exhausted'
        ? '; the confirmed-ended responder had no remaining selected reviewer'
        : requesterReroute?.status === 'raced'
          ? '; another operation advanced the cascade first'
          : requesterReroute?.status === 'unchanged'
            ? '; the cascade did not advance'
            : '';

  const capNow = exchangesUsed >= row.max_exchanges;
  const hint =
    role === 'responder'
      ? capNow
        ? `Posted (exchange ${exchangesUsed}/${row.max_exchanges} — cap reached). Further replies are refused; settle with consult:close { outcome: 'answered' | 'cant_help' } — or still deliberating? consult:close { outcome: 'graduate', reason } mints a shared work item that carries it forward (D-004).`
        : req.kind === 'answer'
          ? `Answer posted (exchange ${exchangesUsed}/${row.max_exchanges}); the requester was signaled via ${parkKey(req.conversationId)}. When the thread is settled, close it: consult:close { outcome: 'answered' }.${cascadeNote}`
          : `Posted (exchange ${exchangesUsed}/${row.max_exchanges}); the requester was signaled via ${parkKey(req.conversationId)}.${cascadeNote}`
      : `Follow-up posted (exchange ${exchangesUsed}/${row.max_exchanges})${willWake ? `; responder ${woke > 0 ? 'woken' : responderConfirmedDead ? 'confirmed ended' : 'pinged'}` : ''}${requesterRerouteHint}.`;

  return {
    ok: true,
    post_id: postId,
    role,
    state: nextState,
    exchanges_used: exchangesUsed,
    max_exchanges: row.max_exchanges,
    ...(role === 'requester'
      ? {
          wake: {
            attempted: willWake,
            woke,
            ...(willWake && woke === 0 && requesterReroute ? { reroute: requesterReroute } : {}),
          },
        }
      : {}),
    ...(cascade ? { cascade } : {}),
    hint,
  };
}

// ── consult:decline ──────────────────────────────────────────────────────────

export interface ConsultDeclineRequest {
  workspaceId: string;
  authorId: string;
  conversationId: string;
  reason: string;
}

export interface ConsultDeclineResult {
  ok: true;
  post_id: number;
  /** 'awaiting_responder' when the cascade advanced to the next selectee
   * (D-005 — the consult stays open); 'declined' only on menu exhaustion. */
  state: 'awaiting_responder' | 'declined';
  /** Cascade consequence of this decline (D-005). `advanced_to` names the
   * expert whose transcript the next answering session was DISPATCHED from
   * (D-002 — no live agent is woken); refilled marks the WI-39861 min-ANSWERS
   * refill round. */
  cascade: {
    advanced_to: string | null;
    exhausted: boolean;
    woke: number;
    refilled?: boolean;
  };
  /** Route-time candidate refs — decliner excluded, route-time-dead filtered
   * (retrieval fallback; the SERVER drains the selected menu itself). */
  remaining_candidates: Array<{ ownerId: string; score: number; liveness: string }>;
  hint: string;
}

export async function consultDeclineCore(
  req: ConsultDeclineRequest,
  deps: ConsultVerbDeps,
): Promise<ConsultDeclineResult | ConsultVerbError> {
  const sql = deps.getSql();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  // Resolve a truncated conversation ref BEFORE any read or write. This is the
  // verb EI-23942597240908282 was filed against: the decline that could not be
  // made because the id had been clipped to its leading segment in transit.
  const normalized = await normalizeConversationRef(sql, req);
  if ('error' in normalized) return normalized;
  req = normalized.req;

  const gated = gateCommon(await readState(sql, req.workspaceId, req.conversationId));
  if ('error' in gated) return gated;
  const row = gated.row;

  // Not `!== row.responder_id`: on a fork the DISPATCHED session is the one
  // reading the question, so it is the one that discovers the transcript does
  // not cover it — and a decline is the only thing that advances the cascade
  // to the next expert. Refusing it here would strand every forked consult on
  // an expert who cannot answer until the expiry sweep settles it hours later.
  if (!isCurrentResponder(row, req.authorId)) return { error: 'not_the_responder' };
  const reason = req.reason.trim();
  if (!reason) return { error: 'reason_required' };

  const posted = await deps.post({
    conversation_id: req.conversationId,
    body: `Declined: ${reason}`,
    via_consult_verb: true,
  });
  if ('error' in posted) return { error: 'post_failed', cause: posted.error };
  const postId = posted.post.id;

  await sql`
    INSERT INTO harness_shared.consult_post_meta
      (workspace_id, post_id, conversation_id, author_id, kind, evidence)
    VALUES (${req.workspaceId}, ${postId}, ${req.conversationId}, ${req.authorId}, 'decline', NULL)
  `;
  // D-005 always-advance: a decline ADVANCES the chain instead of closing the
  // consult — the terminal 'declined' close happens only when the menu is
  // exhausted. A hard-blocked requester parked on the latched key is NOT
  // woken by a mid-chain decline (more feedback is still coming); the emit
  // fires only on the terminal close.
  const adv = await advanceCascade(
    {
      workspaceId: req.workspaceId,
      conversationId: req.conversationId,
      question: row.question,
      latencyContract: row.latency_contract,
      requesterId: row.requester_id,
      routing: row.routing,
      cascadeCursor: row.cascade_cursor,
      digest: row.cascade_digest,
      event: makeDigestEntry(req.authorId, 'decline', now, reason),
      stateOnAdvance: 'awaiting_responder',
      nowIso: now,
    },
    sql,
    deps.dispatch,
  );
  const remaining = remainingFromSnapshot(row.routing, req.authorId);

  // A raced advance: a concurrent trigger (expiry sweep / a reply) moved the
  // chain between our read and write — the winner already woke the next
  // selectee and appended its digest entry. The decline post stands in the
  // thread; do NOT terminal-close (the consult continues under the winner's
  // selectee), and do not double-report the winner's wake.
  if (adv.raced) {
    return {
      ok: true,
      post_id: postId,
      state: 'awaiting_responder',
      cascade: { advanced_to: null, exhausted: false, woke: 0 },
      remaining_candidates: remaining,
      hint: 'Declined. A concurrent event had already advanced the cascade — the consult continues under the next selected responder.',
    };
  }

  if (adv.advanced) {
    return {
      ok: true,
      post_id: postId,
      state: 'awaiting_responder',
      cascade: {
        advanced_to: adv.next?.ownerId ?? null,
        exhausted: false,
        woke: adv.woke,
        ...(adv.refilled ? { refilled: true } : {}),
      },
      remaining_candidates: remaining,
      hint: `Declined. Cascade advanced (D-005): an answering session was dispatched from ${adv.next?.ownerId ?? 'the next selectee'}'s transcript with the feedback so far — the consult stays open.${adv.refilled ? ' (min-ANSWERS refill, WI-39861: the menu was extended once — answers collected < selection.min.)' : ''}`,
    };
  }

  // WI-39862: a decline-exhaustion terminal that still COLLECTED answers says
  // so on its outcome — "declined" alone conflates "nobody helped" with "the
  // last selectee declined after real answers landed".
  const declineAnswerEvents = digestFromRow(row.cascade_digest).filter((e) => e.kind === 'answer');
  await sql.begin(async (tx) => {
    await tx`
      UPDATE harness_shared.consult_state
         SET state = 'declined',
             outcome = ${tx.json({
               reason,
               ...(declineAnswerEvents.length > 0
                 ? {
                     answers: declineAnswerEvents.length,
                     answered_by: [...new Set(declineAnswerEvents.map((e) => e.ownerId))],
                   }
                 : {}),
             } as never)}::jsonb
                       || CASE WHEN (outcome -> 'reconciliation') IS NOT NULL
                               THEN jsonb_build_object('reconciliation', outcome -> 'reconciliation')
                               ELSE '{}'::jsonb END,
             closed_at = ${now}::timestamptz,
             updated_at = ${now}::timestamptz
       WHERE workspace_id = ${req.workspaceId} AND conversation_id = ${req.conversationId}
    `;
    if (deps.settleConversation) {
      // coord_conversations has only the coarse open/resolved/closed lifecycle;
      // keep the typed `declined` outcome in consult_state while projecting the
      // non-answering terminal into its closed state.
      await deps.settleConversation(
        {
          conversationId: req.conversationId,
          outcome: 'cant_help',
          postId,
          now,
        },
        tx,
      );
    }
  });

  // Menu exhausted: this terminal decline IS the reply a parked requester is
  // waiting for — emit the latched key.
  await deps.emitReplyEvent({
    key: parkKey(req.conversationId),
    summary: `consult ${req.conversationId}: declined by ${req.authorId} (cascade menu exhausted) — ${oneLine(reason)}`,
    payload: { conversation_id: req.conversationId, responder: req.authorId, kind: 'decline', post_id: postId },
    to: [row.requester_id],
  });

  return {
    ok: true,
    post_id: postId,
    state: 'declined',
    cascade: { advanced_to: null, exhausted: true, woke: 0 },
    remaining_candidates: remaining,
    hint: `Declined — the cascade menu is exhausted (you were the last selectee). The requester proceeds on their own judgment; a fresh consult:get_feedback re-routes.`,
  };
}

// ── consult:close ────────────────────────────────────────────────────────────

export interface ConsultCloseRequest {
  workspaceId: string;
  authorId: string;
  conversationId: string;
  /** 'graduate' (P-005, D-004): the consult outgrew its bounds (canonically:
   * cap hit while still deliberating) — closes as state='graduated' and mints
   * a shared work item both participants follow. Requires `reason`. Either
   * participant may graduate (close symmetry). */
  outcome: 'answered' | 'cant_help' | 'graduate';
  answer?: string;
  /** Responder's confidence in the answer, 0..1 (outcome jsonb, D-001). */
  confidence?: number;
  evidence?: ConsultEvidenceRef[];
  reason?: string;
}

export interface ConsultCloseResult {
  ok: true;
  post_id: number;
  state: 'closed_answered' | 'closed_cant_help' | 'graduated';
  /** The minted shared work item (graduate closes only). */
  work_item_id?: string;
  hint: string;
}

export async function consultCloseCore(
  req: ConsultCloseRequest,
  deps: ConsultVerbDeps,
): Promise<ConsultCloseResult | ConsultVerbError> {
  const sql = deps.getSql();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  // Resolve a truncated conversation ref BEFORE any read or write, exactly as
  // reply and decline do. Close was the THIRD verb of the same class and was
  // missed by the original EI-23942597240908282 fix: a requester citing a
  // clipped id got the same bare `not_a_consult`, and close is the verb that
  // records the terminal outcome — so the miss stranded precisely the consults
  // that most needed a disposition. Must run before the late-disposition read
  // below, or that gate would admit on a resolved row while every write below
  // still targeted the truncated id.
  const normalized = await normalizeConversationRef(sql, req);
  if ('error' in normalized) return normalized;
  req = normalized.req;

  // Close-specific gate (WI-39862 / EI-20824019943814803): unlike reply and
  // decline, close ALSO admits the REQUESTER on a state='expired' row — a
  // LATE DISPOSITION. The repro: a cascade collected 3 substantive answers,
  // exhausted, was stamped 'expired', and the requester's disposition post was
  // refused consult_not_open — the one row that most deserved a real outcome
  // could never get one. A late close overwrites state/outcome (a
  // closed_answered with a real answer regains archive candidacy — the point).
  const rawRow = await readState(sql, req.workspaceId, req.conversationId);
  if (!rawRow) return { error: 'not_a_consult' };
  const lateDisposition = rawRow.state === 'expired' && req.authorId === rawRow.requester_id;
  if (!lateDisposition) {
    const gated = gateCommon(rawRow);
    if ('error' in gated) return gated;
  }
  const row = rawRow;

  if (!isConsultParticipant(row, req.authorId)) {
    return { error: 'not_a_participant', hint: CONSULT_PARTICIPATION_REMEDY };
  }

  // Structured outcome (D-001 — the outcome column comment is the authority):
  // closed_answered carries the answer; closed_cant_help/graduated carry the reason.
  const answer = req.answer?.trim();
  const reason = req.reason?.trim();
  if (req.outcome === 'answered' && !answer) return { error: 'answer_required' };
  if ((req.outcome === 'cant_help' || req.outcome === 'graduate') && !reason) return { error: 'reason_required' };

  // P-005 graduation (D-004): mint the shared work item FIRST — a mint failure
  // is a clean refusal (nothing written), and the closing post can then name
  // the minted id. The rare mint-then-post-fail crash window leaves a visible,
  // conversation-linked work item and an OPEN consult (retryable), which is
  // strictly more repairable than a closed consult with no work item.
  let graduatedWorkItemId: string | null = null;
  if (req.outcome === 'graduate') {
    if (!deps.mintGraduationWorkItem) {
      return {
        error: 'graduate_unavailable',
        hint: "This surface has no graduation work-item seam bound — close with outcome 'answered' | 'cant_help', or file the shared work item by hand and reference it in the close.",
      };
    }
    try {
      const minted = await deps.mintGraduationWorkItem({
        workspaceId: req.workspaceId,
        conversationId: req.conversationId,
        question: row.question,
        requesterId: row.requester_id,
        responderId: row.responder_id,
        closedBy: req.authorId,
        reason: reason as string,
      });
      graduatedWorkItemId = minted.id;
    } catch (e) {
      return { error: 'graduate_failed', cause: e instanceof Error ? e.message : String(e) };
    }
  }

  const state: ConsultCloseResult['state'] =
    req.outcome === 'answered' ? 'closed_answered' : req.outcome === 'graduate' ? 'graduated' : 'closed_cant_help';
  const body =
    req.outcome === 'answered'
      ? `Closed (answered): ${answer}`
      : req.outcome === 'graduate'
        ? `Graduated to shared work item ${graduatedWorkItemId}: ${reason}`
        : `Closed (can't help): ${reason}`;

  const posted = await deps.post({ conversation_id: req.conversationId, body, via_consult_verb: true });
  if ('error' in posted) return { error: 'post_failed', cause: posted.error };
  const postId = posted.post.id;

  const outcome = {
    ...(answer ? { answer } : {}),
    ...(req.confidence != null ? { confidence: req.confidence } : {}),
    ...(req.evidence?.length ? { evidence: req.evidence } : {}),
    ...(reason ? { reason } : {}),
    ...(graduatedWorkItemId ? { work_item_id: graduatedWorkItemId } : {}),
  };

  // consult_state is the fine-grained consult authority, while
  // coord_conversations owns the coarse lifecycle consumed by
  // conversations:get/list. Keep both projections coherent at the close
  // boundary. The metadata, consult state, and coarse projection share one
  // transaction so a failed secondary write cannot leave consult_state
  // terminal while conversations:get/list still reports the consult open.
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.consult_post_meta
        (workspace_id, post_id, conversation_id, author_id, kind, evidence)
      VALUES
        (${req.workspaceId}, ${postId}, ${req.conversationId}, ${req.authorId},
         'close', ${req.evidence ? tx.json(req.evidence as never) : null})
    `;
    await tx`
      UPDATE harness_shared.consult_state
         SET state = ${state},
             outcome = ${tx.json(outcome as never)}::jsonb
                       || CASE WHEN (outcome -> 'reconciliation') IS NOT NULL
                               THEN jsonb_build_object('reconciliation', outcome -> 'reconciliation')
                               ELSE '{}'::jsonb END,
             closed_at = ${now}::timestamptz,
             updated_at = ${now}::timestamptz
       WHERE workspace_id = ${req.workspaceId} AND conversation_id = ${req.conversationId}
    `;
    if (deps.settleConversation) {
      await deps.settleConversation(
        {
          conversationId: req.conversationId,
          outcome: req.outcome,
          answer,
          postId,
          now,
        },
        tx,
      );
    }
  });

  // A responder close is the terminal reply — wake the parked requester. A
  // requester closing their own consult has nobody parked on the key.
  // (isCurrentResponder, not an id equality: a fork closes under its own
  // identity, and the parked requester must still be released.)
  if (isCurrentResponder(row, req.authorId)) {
    await deps.emitReplyEvent({
      key: parkKey(req.conversationId),
      summary: `consult ${req.conversationId}: ${state} by ${req.authorId} — ${oneLine(body)}`,
      payload: { conversation_id: req.conversationId, responder: req.authorId, kind: 'close', post_id: postId, state },
      to: [row.requester_id],
    });
  }

  return {
    ok: true,
    post_id: postId,
    state,
    ...(graduatedWorkItemId ? { work_item_id: graduatedWorkItemId } : {}),
    hint:
      state === 'closed_answered'
        ? `Closed with a structured answer${req.confidence != null ? ` (confidence ${req.confidence})` : ''}. The outcome is on consult_state (the D-003 honesty-metric feed).`
        : state === 'graduated'
          ? `Graduated (D-004): the consult outgrew its bounds — shared work item ${graduatedWorkItemId} carries it forward and both participants are subscribed. The consult takes no further posts.`
          : `Closed as can't-help — an honest terminal outcome (D-003), not a failure. The requester proceeds on their own judgment.`,
  };
}

// ── consult:reconcile ────────────────────────────────────────────────────────
// EI-23764501791910357 slice 3. A consult opened under latency_contract:'proceed'
// hands the requester a PROCEED-NOW-RECONCILE-LATER affordance; the "later" half
// is an obligation (agent-obligation-reader's consult-reconciliation source: a
// proceed consult with no `outcome.reconciliation`). THIS verb is the terminal
// state that clears it — the requester's own disposition of the assumption they
// proceeded on, written beside the responder's outcome so neither erases the other
// (close / decline / the expiry sweep all carry `reconciliation` forward).

export const CONSULT_RECONCILIATION_DISPOSITIONS = ['confirmed', 'rescoped', 'reversed', 'moot'] as const;
export type ConsultReconciliationDisposition = (typeof CONSULT_RECONCILIATION_DISPOSITIONS)[number];

export interface ConsultReconcileRequest {
  workspaceId: string;
  authorId: string;
  conversationId: string;
  disposition: ConsultReconciliationDisposition;
  /** What the answer (or its absence) changed — or why nothing did. Required: a bare
   * `confirmed` with no account is exactly the debt-that-looks-discharged this verb
   * exists to end. */
  note: string;
  /** Optional `<plan-slug>#D-NNN` of the plan Decision recording a rescope/reversal,
   * so the ruling stays addressable where governing rulings already live. */
  decisionRef?: string;
}

export interface ConsultReconciliationRecord {
  disposition: ConsultReconciliationDisposition;
  note: string;
  by: string;
  at: string;
  /** The consult's state when it was reconciled — separates "answered, then diffed"
   * from "reconciled while still open" from "ended with no answer". */
  consult_state: string;
  decision_ref?: string;
}

export interface ConsultReconcileResult {
  ok: true;
  conversation_id: string;
  disposition: ConsultReconciliationDisposition;
  consult_state: string;
  recorded_at: string;
  hint: string;
}

const DECISION_REF_SHAPE = /^[a-z0-9][a-z0-9-]*#D-\d{3,}$/;

export async function consultReconcileCore(
  req: ConsultReconcileRequest,
  deps: Pick<ConsultVerbDeps, 'getSql' | 'now'>,
): Promise<ConsultReconcileResult | ConsultVerbError> {
  const sql = deps.getSql();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  // Same truncated-ref resolution as reply/decline/close, before any read or write.
  const normalized = await normalizeConversationRef(sql, req);
  if ('error' in normalized) return normalized;
  req = normalized.req;

  const row = await readState(sql, req.workspaceId, req.conversationId);
  if (!row) return { error: 'not_a_consult' };

  // The debt is the REQUESTER's: they proceeded on the assumption, so only they can
  // say what the answer did to it. A responder (or any participant) recording it would
  // clear the requester's obligation without the requester having diffed anything.
  if (req.authorId !== row.requester_id) {
    return {
      error: 'not_the_requester',
      hint: `Only the requester (${row.requester_id}) can reconcile a proceed-consult — it is their assumption to disposition. Participants can still post/close the thread itself.`,
    };
  }
  if (row.latency_contract !== 'proceed') {
    return {
      error: 'not_a_proceed_consult',
      latency_contract: row.latency_contract,
      hint: `Only a consult opened under latency_contract:'proceed' carries a reconciliation debt; this one is '${row.latency_contract}' (you blocked on the answer instead of assuming).`,
    };
  }
  const note = req.note?.trim();
  if (!note) return { error: 'reason_required' };
  const decisionRef = req.decisionRef?.trim();
  if (decisionRef && !DECISION_REF_SHAPE.test(decisionRef)) {
    return {
      error: 'invalid_decision_ref',
      hint: `decision_ref must be '<plan-slug>#D-NNN' (the id plans:add-decision returned), got '${decisionRef}'.`,
    };
  }

  const record: ConsultReconciliationRecord = {
    disposition: req.disposition,
    note,
    by: req.authorId,
    at: now,
    consult_state: row.state,
    ...(decisionRef ? { decision_ref: decisionRef } : {}),
  };

  // Terminal + race-safe: the guard is IN the UPDATE, so two concurrent reconciles
  // cannot both win and a close landing in between cannot be clobbered (the
  // close/decline/expiry writers carry `reconciliation` forward the other way).
  const written = (await sql`
    UPDATE harness_shared.consult_state
       SET outcome = COALESCE(outcome, '{}'::jsonb)
                     || jsonb_build_object('reconciliation', ${sql.json(record as never)}::jsonb),
           updated_at = ${now}::timestamptz
     WHERE workspace_id = ${req.workspaceId}
       AND conversation_id = ${req.conversationId}
       AND requester_id = ${req.authorId}
       AND (outcome -> 'reconciliation') IS NULL
    RETURNING conversation_id
  `) as unknown as Array<{ conversation_id: string }>;

  if (written.length === 0) {
    // Lost the guard: this requester already recorded it (a repeat or a race).
    const current = await readState(sql, req.workspaceId, req.conversationId);
    const existing =
      current?.outcome && typeof current.outcome === 'object' && !Array.isArray(current.outcome)
        ? (current.outcome as Record<string, unknown>).reconciliation
        : undefined;
    return {
      error: 'already_reconciled',
      reconciliation: existing ?? null,
      hint: 'This consult already has a recorded reconciliation — it is terminal. Nothing was changed.',
    };
  }

  return {
    ok: true,
    conversation_id: req.conversationId,
    disposition: req.disposition,
    consult_state: row.state,
    recorded_at: now,
    hint:
      req.disposition === 'rescoped' || req.disposition === 'reversed'
        ? `Recorded (${req.disposition}); the obligation is cleared. A ${req.disposition} outcome is a ruling other lanes may need — if you have not already, record it with plans:add-decision and cite it via decision_ref.`
        : `Recorded (${req.disposition}); the proceed-reconciliation obligation for this consult is cleared.`,
  };
}

// ── plans:start override linkage ─────────────────────────────────────────────
// EI-23764501791910357 slice 3b (WI-10005177). `plans:start`'s consult override
// (`consulted` + `consult_reason`) is free text; `consult_id` makes the consult the
// caller proceeded on a STRUCTURED reference. This resolves + validates it — never
// writes — so the result/ledger can name the consult and say whether a
// proceed-reconciliation is still owed (the obligation reader surfaces it either way).

export interface ConsultRequestedRefRequest {
  workspaceId: string;
  requesterId: string;
  /** Full conversation id or a unique prefix (same resolution as the consult verbs). */
  conversationRef: string;
}

export interface ConsultRequestedRefResult {
  ok: true;
  conversation_id: string;
  consult_state: string;
  latency_contract: string;
  /** True when this is a proceed consult with no recorded reconciliation — the debt
   * `consult:reconcile` clears. */
  reconciliation_owed: boolean;
}

export async function consultResolveRequestedConsult(
  req: ConsultRequestedRefRequest,
  deps: Pick<ConsultVerbDeps, 'getSql'>,
): Promise<ConsultRequestedRefResult | ConsultVerbError> {
  const sql = deps.getSql();
  const normalized = await normalizeConversationRef(sql, {
    workspaceId: req.workspaceId,
    conversationId: req.conversationRef,
  });
  if ('error' in normalized) return normalized;
  const row = await readState(sql, req.workspaceId, normalized.req.conversationId);
  if (!row) return { error: 'not_a_consult' };
  if (row.requester_id !== req.requesterId) {
    return {
      error: 'not_the_requester',
      hint: `consult_id must name a consult YOU requested; ${row.conversation_id} was requested by ${row.requester_id}.`,
    };
  }
  const reconciled =
    row.outcome != null &&
    typeof row.outcome === 'object' &&
    !Array.isArray(row.outcome) &&
    (row.outcome as Record<string, unknown>).reconciliation != null;
  return {
    ok: true,
    conversation_id: row.conversation_id,
    consult_state: row.state,
    latency_contract: row.latency_contract,
    reconciliation_owed: row.latency_contract === 'proceed' && !reconciled,
  };
}
