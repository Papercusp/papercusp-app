/**
 * consult-expiry-core.ts — the consult LIFECYCLE expiry sweep (plan
 * get-feedback-relevance-consults-2026-08-16, P-005; D-005), cascade-aware
 * since consult-min-max-and-rubric-vetting-2026-08-17 P-013.
 *
 * A past-due OPEN consult_state row (expires_at < now, closed_at IS NULL) is a
 * CHAIN EVENT, not automatically a terminal state (D-005 always-advance): when
 * the routing selection menu still has a next selectee, the sweep ADVANCES the
 * cascade — the silent responder's expiry is appended to the digest and the
 * next selectee is woken (via `reach`) with the question + the feedback so far,
 * under a fresh latency-contract window. Only when the menu is exhausted (or
 * the row never selected anyone) does the row terminally flip to
 * state='expired' + closed_at.
 *
 * The park-key emit mirrors decline semantics: a MID-CHAIN expiry does not
 * wake a hard-blocked parked requester (more feedback is still coming); only
 * the TERMINAL expiry emits the latched `consult:reply:<conversation_id>` key
 * — the requester parked on it (P-003 returns it; get-feedback-core parks
 * hard-blocked callers on exactly it) would otherwise sleep until their
 * await's own timeout. Terminal 'proceed' rows get no emit: the requester is
 * already proceeding and reconciles by reading state='expired'. Both contracts
 * receive a durable requester alert before a stalled lifecycle transition.
 *
 * Concurrency: no FOR UPDATE — advanceCascade's CAS guard (cursor unchanged +
 * row still open) and the guarded terminal flip make a raced row a clean
 * no-op here; the concurrent winner (a reply/decline verb, or another tick)
 * already did the advance. A backlog deeper than the bound drains over
 * successive ticks, riding migration 834's partial index
 * (consult_state_expiry_idx: expires_at IS NOT NULL AND closed_at IS NULL).
 *
 * Core/binding split mirrors get-feedback-core.ts: pure logic behind injected
 * deps (sql, emitReplyEvent, reach) so it integration-tests against the real
 * 834/844 tables; the prod binding is the `system:consult-expiry-sweep`
 * ephemeral routine action (harness/routines/consult-expiry-action.ts), which
 * MUST pass `reach` (notifyAgents under a per-row workspace system identity)
 * or mid-chain advances silently stop waking anyone.
 */
import type { Sql } from 'postgres';
import { consultParkKey, HARD_BLOCKED_EXPIRY_MS } from './get-feedback-core';
import { advanceCascade, digestFromRow, makeDigestEntry, selectionFromRouting } from './cascade-core';
import { appendAnswerFailureRecord, type AnswerFailureReason } from './consult-dispatch';
import { GRADING_CASCADE_FLAVOR } from './grading-cascade';
import { RUBRIC_VETTING_POLICY } from './selection-policies';

/** Rows processed per tick — bounds one sweep's write + wake fan-out. A backlog
 * deeper than this simply drains over successive ticks. */
export const EXPIRY_SWEEP_LIMIT = 200;

/** A due row with the cascade columns the advance decision needs (844). */
export interface DueConsultRow {
  workspace_id: string;
  conversation_id: string;
  requester_id: string;
  responder_id: string | null;
  state: string;
  expires_at: string | Date | null;
  is_due: boolean;
  /** PostgreSQL returns timestamptz as Date under the normal postgres-js client. */
  updated_at: unknown;
  latency_contract: string;
  question: string;
  routing: unknown;
  cascade_cursor: number;
  cascade_digest: unknown;
  /** Responder turns taken on this consult (834). 0 = nobody has engaged. */
  exchanges_used?: number;
  /** True when the row has passed half of its TTL (created_at → expires_at)
   * with zero exchanges — the P-014 conversion trigger, computed in SQL. */
  is_half_silent?: boolean;
}

/**
 * The review families whose SILENT consults convert to pullable work instead of
 * cascading (review-system-rework-reduction-2026-09-23 P-014, spec RSR-P-014-A).
 *
 * Measured 2026-09-23: 304 of 309 expired consults had exchanges_used=0 — the
 * responder never took a turn — and each cascade hop cost a full TTL while
 * producing nothing. Review work (a rubric critique, an acceptance grade, a
 * grading-integrity audit) is therefore turned into a claimable work item at half
 * its TTL, so it is PULLED by agents already polling the claimable backlog.
 */
export type ReviewConsultKind = 'rubric-vetting' | 'acceptance-grading' | 'grading-integrity';

/** Classify a persisted routing snapshot. Null = not a review consult (ordinary
 * consults keep the existing cascade/expiry behaviour). */
export function reviewConsultKind(routing: unknown): ReviewConsultKind | null {
  let snap = routing;
  if (typeof snap === 'string') {
    try {
      snap = JSON.parse(snap);
    } catch {
      return null;
    }
  }
  if (!snap || typeof snap !== 'object') return null;
  const s = snap as { policy?: unknown; cascade?: { flavor?: unknown } | null };
  const flavor = s.cascade?.flavor;
  if (flavor === GRADING_CASCADE_FLAVOR) return 'acceptance-grading';
  if (flavor === 'grading-integrity') return 'grading-integrity';
  if (s.policy === RUBRIC_VETTING_POLICY) return 'rubric-vetting';
  return null;
}

/** Everything the filer needs to write one pullable review work item. */
export interface ReviewWorkItemRequest {
  workspaceId: string;
  conversationId: string;
  kind: ReviewConsultKind;
  question: string;
  requesterId: string;
  /** The selectee that stayed silent (never a critic of record). */
  silentResponderId: string | null;
  /** The persisted routing snapshot, so the filer can reuse a grading
   * reservation (routing.cascade.reservation) instead of minting a sibling. */
  routing: unknown;
}

/** Row-local evidence for the answering session that woke after routing,
 * re-parked, and left the consult thread empty. On a fork this differs from
 * consult_state.responder_id, which names the knowledge-source owner. `routedAt`
 * is the current selection timestamp (`updated_at`), not the whole-consult
 * `created_at`. */
export interface SilentResponderCandidate {
  workspaceId: string;
  conversationId: string;
  /** Null means dispatch never stamped an answering session. After the pickup
   * window, an empty thread is evidence of failed dispatch, not source silence. */
  answeringOwnerId: string | null;
  routedAt: string;
  /** Earlier cascade participants may have posted a decline to advance here.
   * Their posts cannot establish pickup by this selection. */
  priorResponderIds?: string[];
}

/** A missing answerer on a VALID current selection is a possible dispatch
 * failure. Malformed routing or a mismatched source is not: fail closed. */
function currentSelectionAnswerer(
  routing: unknown,
  cursor: number,
  responderId: string,
): { answeringOwnerId: string | null; priorResponderIds: string[] } | null {
  try {
    const selections = selectionFromRouting(routing);
    const selected = selections[cursor];
    if (!selected || selected.ownerId !== responderId) return null;
    const ownerId = selected.answeringOwnerId;
    return {
      answeringOwnerId: typeof ownerId === 'string' && ownerId.trim() ? ownerId.trim() : null,
      priorResponderIds: selections.slice(0, cursor).map((entry) => entry.ownerId),
    };
  } catch {
    return null;
  }
}

export interface ExpirySweepDeps {
  getSql: () => Sql;
  /** Latched `consult:reply:<conv>` emit → the (possibly parked) requester.
   * Prod binds emitAwaitedEvent per-row-workspace; best-effort there. */
  emitReplyEvent: (input: {
    key: string;
    summary: string;
    payload: Record<string, unknown>;
    to: string[];
    workspaceId: string;
  }) => Promise<void>;
  /** D-005 cascade advance, D-002/D-011 delivery: DISPATCH the next selectee —
   * fork/convert a fresh answering session from their transcript, never a wake
   * (prod binds makeConsultReachDispatcher under a per-row workspace system
   * identity; consult_state is workspace-partitioned and ONE sweep serves them
   * all, so the workspace rides on each call rather than on the binding's
   * scope). Absent ⇒ the advance still happens (cursor/responder/digest move)
   * but nobody is dispatched — tests only; prod MUST bind it. */
  dispatch?: (opts: {
    responder: string;
    conversationId: string;
    summary: string;
    body: string;
    workspaceId: string;
  }) => Promise<{ woke: number; answeringOwnerId?: string | null }>;
  /** Durable requester alert for every stalled/expired lifecycle transition.
   * The caller supplies a deterministic replay key. A rejected alert blocks
   * the lifecycle write so the next sweep retries the same key. */
  notifyRequester: (opts: {
    requesterId: string;
    conversationId: string;
    workspaceId: string;
    msgId: string;
    summary: string;
    body: string;
  }) => Promise<void>;
  /** Optional bounded detector for a responder that did not pick up after
   * routing and left the row-workspace thread empty. Detector failures fail
   * closed for this early leg; due rows retain normal expiry. */
  findSilentResponders?: (
    rows: readonly SilentResponderCandidate[],
  ) => Promise<ReadonlySet<string>>;
  /** P-014: file (or adopt) the pullable review work item for a silent review
   * consult. MUST be idempotent per conversation — the sweep may call it again on
   * a later tick when a subsequent step failed. Absent ⇒ no conversion leg (review
   * consults keep the cascade behaviour); prod binds it. */
  fileReviewWorkItem?: (req: ReviewWorkItemRequest) => Promise<{ id: string }>;
  /**
   * P-003 (WI-10003199): stop the answering session a slot launched, once the sweep
   * has WON the transition that ends that slot's window without a post. Returns a
   * short outcome for the failure record; a throw is caught and recorded. Absent ⇒
   * nothing is stopped here (the task reaper's consult-settled class remains the
   * backstop), but the failure is still recorded; prod binds it.
   */
  stopAnsweringSession?: (opts: {
    workspaceId: string;
    conversationId: string;
    answeringOwnerId: string | null;
    sourceOwnerId: string;
  }) => Promise<string>;
  now?: () => Date;
  /** Override the per-tick bound (tests). */
  limit?: number;
}

export interface ExpirySweepResult {
  ok: true;
  /** Rows terminally flipped to 'expired' this tick (cascade menu exhausted,
   * or the row never selected anyone). */
  expired: number;
  /** Rows ADVANCED to the next selectee instead of expiring (D-005). */
  advanced: number;
  /** Conversation ids whose hard-blocked park key was emitted (terminal only —
   * a mid-chain advance never wakes the parked requester). */
  woke: string[];
  /** Durable alert calls acknowledged this tick (replays included). */
  requesterAlerts: string[];
  /** Rows deliberately left retryable because the durable alert write failed. */
  requesterAlertFailures: string[];
  /** P-014: silent review consults converted to a pullable work item this tick
   * (conversation id + the work item that now carries the review). */
  converted: Array<{ conversationId: string; workItemId: string; kind: ReviewConsultKind }>;
  /** Review consults whose conversion failed this tick; retried next tick. */
  conversionFailures: string[];
  /** P-003: slots whose window ended without a post — session stopped, failure recorded. */
  answerFailures: Array<{ conversationId: string; reason: AnswerFailureReason; stopOutcome: string; recorded: boolean }>;
  /** True when the tick hit the bound — more due rows likely remain. */
  saturated: boolean;
}

export async function sweepExpiredConsults(deps: ExpirySweepDeps): Promise<ExpirySweepResult> {
  const sql = deps.getSql();
  const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
  const limit = deps.limit ?? EXPIRY_SWEEP_LIMIT;

  // Read the due rows WITH their cascade columns — the advance-vs-expire
  // branch is per row, so the bulk single-statement flip is gone. The CAS
  // guards below stand in for row locks (see module doc).
  const due = (await sql`
    SELECT workspace_id, conversation_id, requester_id, responder_id,
           state, expires_at, COALESCE(expires_at < ${nowIso}::timestamptz, false) AS is_due,
           updated_at, latency_contract, question, routing, cascade_cursor, cascade_digest,
           exchanges_used,
           COALESCE(
             exchanges_used = 0
               AND expires_at IS NOT NULL
               AND ${nowIso}::timestamptz >= created_at + (expires_at - created_at) / 2,
             false
           ) AS is_half_silent
      FROM harness_shared.consult_state
     WHERE closed_at IS NULL
       AND (
         expires_at < ${nowIso}::timestamptz
         OR (state = 'awaiting_responder' AND responder_id IS NOT NULL)
         OR (state = 'awaiting_responder' AND exchanges_used = 0 AND expires_at IS NOT NULL
             AND ${nowIso}::timestamptz >= created_at + (expires_at - created_at) / 2)
       )
     ORDER BY expires_at
     LIMIT ${limit}
  `) as unknown as DueConsultRow[];

  // One bounded detector call covers every non-due awaiting row in this tick.
  // The detector receives each row's workspace because this sweep is shared
  // across workspaces; a failure fails closed for the early leg only.
  let silentResponderIds = new Set<string>();
  const earlyCandidates = due
    .flatMap((row) => {
      if (row.is_due === true || row.state !== 'awaiting_responder' || row.responder_id == null) return [];
      const selection = currentSelectionAnswerer(row.routing, row.cascade_cursor, row.responder_id);
      if (!selection) return [];
      return [{
        workspaceId: row.workspace_id,
        conversationId: row.conversation_id,
        answeringOwnerId: selection.answeringOwnerId,
        routedAt: timestampToIso(row.updated_at),
        ...(selection.priorResponderIds.length > 0 ? { priorResponderIds: selection.priorResponderIds } : {}),
      }];
    });
  const unstampedCandidateIds = new Set(
    earlyCandidates.filter((candidate) => candidate.answeringOwnerId === null).map((candidate) => candidate.conversationId),
  );
  if (deps.findSilentResponders && earlyCandidates.length > 0) {
    try {
      silentResponderIds = new Set(await deps.findSilentResponders(earlyCandidates));
    } catch {
      silentResponderIds = new Set<string>();
    }
  }

  let advanced = 0;
  let expiredCount = 0;
  const woke: string[] = [];
  const requesterAlerts: string[] = [];
  const requesterAlertFailures: string[] = [];
  const converted: ExpirySweepResult['converted'] = [];
  const conversionFailures: string[] = [];
  const answerFailures: ExpirySweepResult['answerFailures'] = [];
  for (const row of due) {
    const isDue = row.is_due === true;

    // P-014 / RSR-P-014-A: a silent REVIEW consult at half its TTL is converted to
    // pullable work. An unstamped dispatch with no thread after the bounded
    // pickup window is already known to have produced no reviewer, so convert
    // it at that point too. Runs before the cascade branch in both cases.
    const reviewKind = deps.fileReviewWorkItem ? reviewConsultKind(row.routing) : null;
    const unstampedDispatchFailed =
      unstampedCandidateIds.has(row.conversation_id) && silentResponderIds.has(row.conversation_id);
    if (
      reviewKind &&
      row.state === 'awaiting_responder' &&
      Number(row.exchanges_used ?? 0) === 0 &&
      (row.is_half_silent === true || unstampedDispatchFailed)
    ) {
      const outcome = await convertReviewConsult(deps, sql, row, reviewKind, nowIso, unstampedDispatchFailed);
      if (outcome.status === 'converted') {
        converted.push({ conversationId: row.conversation_id, workItemId: outcome.workItemId, kind: reviewKind });
        requesterAlerts.push(row.conversation_id);
        await endSilentAnsweringSession(deps, sql, row, 'answer-window-converted', nowIso, answerFailures);
        continue;
      }
      if (outcome.status === 'raced') continue;
      conversionFailures.push(row.conversation_id);
      // A failing filer must not strand the consult forever: a not-yet-due row is
      // retried next tick, a due row falls through to the ordinary expiry path.
      if (!isDue) continue;
    }
    const isSilentEarlyRow =
      !isDue && row.state === 'awaiting_responder' && row.responder_id != null && silentResponderIds.has(row.conversation_id);
    if (!isDue && !isSilentEarlyRow) continue;

    // Requester alert delivery is deliberately attempted BEFORE the CAS
    // transition: if its durable write fails, the row remains eligible and the next sweep retries
    // the same deterministic msgId instead of silently losing the alert. Copy
    // describes an observation + PENDING recovery, never claims a future
    // cascade transition succeeded or that an expiry is approval.
    try {
      await deps.notifyRequester(requesterAlertForRow({
        row,
        kind: isDue ? 'expired' : 'pickup_failed',
        nowIso,
      }));
      requesterAlerts.push(row.conversation_id);
    } catch {
      requesterAlertFailures.push(row.conversation_id);
      continue;
    }

    let terminalSlot = { state: row.state, cascadeCursor: row.cascade_cursor, expiresAt: row.expires_at };
    let exhaustedAfterDispatch = false;
    // One malformed routing value or throwing wake must not strand the batch.
    try {
      const adv = await advanceCascade(
        {
          workspaceId: row.workspace_id,
          conversationId: row.conversation_id,
          question: row.question,
          latencyContract: row.latency_contract,
          requesterId: row.requester_id,
          routing: row.routing,
          cascadeCursor: row.cascade_cursor,
          digest: row.cascade_digest,
          expectedState: row.state,
          expectedExpiresAt: row.expires_at,
          event: makeDigestEntry(
            row.responder_id ?? '(unrouted)',
            // D-002: nothing is woken any more, so a no-pickup is a FAILED
            // DISPATCH. 'wake_failed' survives in the enum only to render
            // digests persisted before this shipped; it is never written.
            isDue ? 'expired' : 'dispatch_failed',
            nowIso,
            isDue
              ? `expired unanswered (${row.latency_contract} window elapsed)`
              : 'queued responder did not produce a consult post before bounded pickup recovery (implicit decline)',
          ),
          stateOnAdvance: 'awaiting_responder',
          nowIso,
        },
        sql,
        deps.dispatch
          ? (opts) => deps.dispatch!({ ...opts, workspaceId: row.workspace_id })
          : undefined,
      );
      if (adv.raced) continue; // a verb / concurrent tick won — nothing to do
      if (adv.advanced) {
        advanced += 1;
        // The CAS above proved this slot was still owed a post when its window
        // ended, so its answering session is over (P-003).
        await endSilentAnsweringSession(
          deps, sql, row, isDue ? 'answer-window-expired' : 'answer-pickup-stalled', nowIso, answerFailures,
        );
        continue;
      }
      if (adv.exhaustedAfterDispatch) {
        terminalSlot = adv.exhaustedAfterDispatch;
        exhaustedAfterDispatch = true;
      }
    } catch {
      continue;
    }

    // Early silent-responder recovery may advance to another selectee, but an
    // exhausted menu does not shorten the consult's configured TTL. Review
    // consults still need to reach the half-TTL conversion point above; other
    // consults remain eligible for the ordinary expiry sweep when expires_at
    // is actually due.
    if (!isDue) continue;

    // Menu exhausted → terminal expire. Guarded like the advance: a concurrent
    // close between the digest write and this flip turns it into a no-op.
    //
    // WI-39862 honest expiry (EI-20824019943814803): "expired" used to conflate
    // "nobody answered" with "the cascade ended after collecting real answers".
    // Count substantive ANSWERS from the row's own digest (the pre-advance
    // in-memory copy — the final selectee's 'expired' event that advanceCascade
    // appended is kind 'expired', so it never inflates this): with ≥1 answer the
    // row still flips state='expired' (no enum widening) but its outcome
    // records an answered-flavored disposition, and the requester may still
    // record a real disposition late via consult:close (consult-verbs-core's
    // late-close gate).
    const priorDigest = digestFromRow(row.cascade_digest);
    const answerEvents = priorDigest.filter((e) => e.kind === 'answer');
    const answers = answerEvents.length;
    const answeredBy = [...new Set(answerEvents.map((e) => e.ownerId))];
    // The fine-grained terminal flip and its coarse parent projection are one
    // transaction. Otherwise a crash between these writes leaves the exact
    // split this sweep exists to repair: consult_state='expired' while
    // conversations:get/list still report state='open'. The parent predicate
    // is deliberately narrow: this row's workspace/id and consult kind must
    // match, and only an open parent may be projected. A concurrent typed close
    // or other terminal lifecycle is never overwritten.
    const flipped = await sql.begin(async (tx) => {
      const terminal = (await tx`
        UPDATE harness_shared.consult_state
           SET state = 'expired',
               outcome = COALESCE(${
                 answers > 0
                   ? tx.json({
                       disposition: 'cascade_exhausted_with_answers',
                       answers,
                       answered_by: answeredBy,
                     } as never)
                   : null
               }::jsonb
                 -- EI-23764501791910357: a requester's recorded proceed-reconciliation survives
                 -- the terminal write (a NULL new outcome keeps the old one via the COALESCE).
                 || CASE WHEN (outcome -> 'reconciliation') IS NOT NULL
                         THEN jsonb_build_object('reconciliation', outcome -> 'reconciliation')
                         ELSE '{}'::jsonb END, outcome),
               closed_at = ${nowIso}::timestamptz,
               updated_at = ${nowIso}::timestamptz
         WHERE workspace_id = ${row.workspace_id}
           AND conversation_id = ${row.conversation_id}
           AND closed_at IS NULL
           AND state = ${terminalSlot.state}
           AND cascade_cursor = ${terminalSlot.cascadeCursor}
           AND expires_at IS NOT DISTINCT FROM ${terminalSlot.expiresAt}::timestamptz
           AND (${exhaustedAfterDispatch}::boolean OR expires_at < ${nowIso}::timestamptz)
        RETURNING conversation_id
      `) as unknown as Array<{ conversation_id: string }>;
      if (terminal.length === 0) return terminal;

      await tx`
        UPDATE harness_shared.coord_conversations c
           SET state = 'expired',
               updated_at = GREATEST(c.updated_at, ${nowIso}::timestamptz)
         WHERE c.workspace_id = ${row.workspace_id}
           AND c.id = ${row.conversation_id}
           AND c.kind = 'consult'
           AND c.state = 'open'
           AND EXISTS (
             SELECT 1
               FROM harness_shared.consult_state cs
              WHERE cs.workspace_id = c.workspace_id
                AND cs.conversation_id = c.id
                AND cs.state = 'expired'
           )
      `;
      return terminal;
    }) as unknown as Array<{ conversation_id: string }>;
    if (flipped.length === 0) continue;
    expiredCount += 1;
    await endSilentAnsweringSession(deps, sql, row, 'answer-window-expired', nowIso, answerFailures);

    // Wake the hard-blocked parked requester (the emit LATCHES, so a requester
    // who re-registers after the fire is told immediately). Best-effort: the
    // row is already flipped; the requester's own await timeout is the backstop.
    if (row.latency_contract !== 'hard-blocked') continue;
    try {
      await deps.emitReplyEvent({
        key: consultParkKey(row.conversation_id),
        summary:
          answers > 0
            ? `consult ${row.conversation_id}: cascade exhausted with ${answers} answer(s) collected — NOT unanswered; review the thread and record your disposition with consult:close`
            : `consult ${row.conversation_id}: EXPIRED unanswered (hard-blocked contract, cascade exhausted) — proceed on your own judgment`,
        payload: {
          conversation_id: row.conversation_id,
          responder: row.responder_id,
          kind: 'expired',
          ...(answers > 0 ? { answers } : {}),
        },
        to: [row.requester_id],
        workspaceId: row.workspace_id,
      });
      woke.push(row.conversation_id);
    } catch {
      // See best-effort note above.
    }
  }

  // Rows admitted solely for the early detector can fill the bound after all
  // due rows have drained. Report saturation only when the last admitted row
  // is itself due; otherwise the ordering guarantees no older due row was
  // hidden behind a non-due row.
  return {
    ok: true,
    expired: expiredCount,
    advanced,
    woke,
    requesterAlerts,
    requesterAlertFailures,
    converted,
    conversionFailures,
    answerFailures,
    saturated: due.length >= limit && due[limit - 1]?.is_due === true,
  };
}

const ANSWER_FAILURE_DETAIL: Record<AnswerFailureReason, (row: DueConsultRow) => string> = {
  'answer-window-expired': (row) =>
    `answering session for ${row.responder_id} did not post before its ${row.latency_contract} consult window expired ` +
    `(cascade position ${row.cascade_cursor + 1})`,
  'answer-pickup-stalled': (row) =>
    `answering session for ${row.responder_id} did not post before bounded pickup recovery ` +
    `(cascade position ${row.cascade_cursor + 1})`,
  'answer-window-converted': (row) =>
    `answering session for ${row.responder_id} had not posted when the review was converted to a work item ` +
    `at half its window (cascade position ${row.cascade_cursor + 1})`,
};

/**
 * P-003 (WI-10003199): end the answering session of a slot whose window the sweep
 * has just closed without a post, and record it on the consult as a failed attempt.
 *
 * Call ONLY after the sweep's own guarded write won (advance, terminal expire, or
 * review conversion). That CAS is what proves the slot was still `awaiting_responder`
 * on this cursor, i.e. the session had not posted; stopping any earlier could kill a
 * session whose reply just landed. A row not awaiting its responder (the responder
 * answered and the requester is the silent side) is not a failed attempt and is left
 * to the task reaper. Never throws: the transition has already happened, so a failed
 * stop or record must not strand the rest of the batch.
 */
async function endSilentAnsweringSession(
  deps: ExpirySweepDeps,
  sql: Sql,
  row: DueConsultRow,
  reason: AnswerFailureReason,
  nowIso: string,
  out: ExpirySweepResult['answerFailures'],
): Promise<void> {
  if (row.state !== 'awaiting_responder' || row.responder_id == null) return;
  const selection = currentSelectionAnswerer(row.routing, row.cascade_cursor, row.responder_id);
  if (!selection) return;
  const target = {
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    answeringOwnerId: selection.answeringOwnerId,
    sourceOwnerId: row.responder_id,
  };
  let stopOutcome: string;
  if (!deps.stopAnsweringSession) {
    stopOutcome = 'no session stopper bound (task reaper is the backstop)';
  } else {
    try {
      stopOutcome = await deps.stopAnsweringSession(target);
    } catch (e) {
      stopOutcome = `stop threw: ${(e as Error)?.message ?? String(e)}`;
    }
  }
  let recorded = false;
  try {
    await appendAnswerFailureRecord(
      sql,
      {
        ...target,
        cascadeCursor: row.cascade_cursor,
        reason,
        detail: ANSWER_FAILURE_DETAIL[reason](row),
        stopOutcome,
      },
      nowIso,
    );
    recorded = true;
  } catch {
    // Best-effort, like the dispatcher's own recorder: evidence must not cost the sweep.
  }
  out.push({ conversationId: row.conversation_id, reason, stopOutcome, recorded });
}

type ReviewConversionOutcome =
  | { status: 'converted'; workItemId: string }
  | { status: 'raced' }
  | { status: 'failed' };

/**
 * File the pullable review item, tell the requester where the review went, then
 * close the consult with an outcome that names the item.
 *
 * Order is file → alert → close, and each step is safe to repeat: the filer is
 * idempotent per conversation (condition-keyed), the alert carries a deterministic
 * replay key, and the close is guarded on the row still being open, silent and on
 * the same cascade position. A failure at any step leaves the consult open so the
 * next tick retries the same item. A reply that lands between filing and closing
 * wins the race: the consult stays open with its reply, and the filed item remains
 * a valid (if now redundant) review request.
 *
 * The consult flips to state='expired' — the state CHECK has no dedicated value —
 * and its outcome records disposition 'converted_to_review_work_item', following the
 * 'cascade_exhausted_with_answers' precedent of disambiguating through `outcome`.
 */
async function convertReviewConsult(
  deps: ExpirySweepDeps,
  sql: Sql,
  row: DueConsultRow,
  kind: ReviewConsultKind,
  nowIso: string,
  unstampedDispatchFailed = false,
): Promise<ReviewConversionOutcome> {
  let workItemId: string;
  try {
    const filed = await deps.fileReviewWorkItem!({
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      kind,
      question: row.question,
      requesterId: row.requester_id,
      silentResponderId: row.responder_id,
      routing: row.routing,
    });
    if (!filed?.id) return { status: 'failed' };
    workItemId = filed.id;
  } catch {
    return { status: 'failed' };
  }

  try {
    await deps.notifyRequester(reviewConversionAlertForRow({ row, kind, workItemId, nowIso }));
  } catch {
    return { status: 'failed' };
  }

  let flipped: Array<{ conversation_id: string }>;
  try {
    flipped = (await sql.begin(async (tx) => {
      const terminal = (await tx`
        UPDATE harness_shared.consult_state
           SET state = 'expired',
               outcome = ${tx.json({
                 disposition: 'converted_to_review_work_item',
                 work_item_id: workItemId,
                 review_kind: kind,
                 silent_responder: row.responder_id,
               } as never)}::jsonb
                 || CASE WHEN (outcome -> 'reconciliation') IS NOT NULL
                         THEN jsonb_build_object('reconciliation', outcome -> 'reconciliation')
                         ELSE '{}'::jsonb END,
               closed_at = ${nowIso}::timestamptz,
               updated_at = ${nowIso}::timestamptz
         WHERE workspace_id = ${row.workspace_id}
           AND conversation_id = ${row.conversation_id}
           AND closed_at IS NULL
           AND state = 'awaiting_responder'
           AND exchanges_used = 0
           AND cascade_cursor = ${row.cascade_cursor}
           AND expires_at IS NOT DISTINCT FROM ${row.expires_at}::timestamptz
           AND (
             ${nowIso}::timestamptz >= created_at + (expires_at - created_at) / 2
             OR (
               ${unstampedDispatchFailed}::boolean
               AND updated_at IS NOT DISTINCT FROM ${timestampToIso(row.updated_at)}::timestamptz
               AND ${nowIso}::timestamptz >= updated_at + (${HARD_BLOCKED_EXPIRY_MS}::bigint * interval '1 millisecond')
             )
           )
        RETURNING conversation_id
      `) as unknown as Array<{ conversation_id: string }>;
      if (terminal.length === 0) return terminal;
      await tx`
        UPDATE harness_shared.coord_conversations c
           SET state = 'expired',
               updated_at = GREATEST(c.updated_at, ${nowIso}::timestamptz)
         WHERE c.workspace_id = ${row.workspace_id}
           AND c.id = ${row.conversation_id}
           AND c.kind = 'consult'
           AND c.state = 'open'
      `;
      return terminal;
    })) as unknown as Array<{ conversation_id: string }>;
  } catch {
    return { status: 'failed' };
  }
  if (flipped.length === 0) return { status: 'raced' };

  if (row.latency_contract === 'hard-blocked') {
    try {
      await deps.emitReplyEvent({
        key: consultParkKey(row.conversation_id),
        summary:
          `consult ${row.conversation_id}: no reviewer engaged by half its window — converted to pullable ` +
          `review work item ${workItemId}; follow that item instead of waiting on this consult`,
        payload: {
          conversation_id: row.conversation_id,
          responder: row.responder_id,
          kind: 'converted',
          work_item_id: workItemId,
          review_kind: kind,
        },
        to: [row.requester_id],
        workspaceId: row.workspace_id,
      });
    } catch {
      // Best-effort, like the terminal-expiry emit: the durable alert above
      // already named the work item.
    }
  }
  return { status: 'converted', workItemId };
}

/** The durable requester alert for a P-014 conversion. The replay key is per
 * conversation (not per cascade position): a conversion happens at most once. */
export function reviewConversionAlertForRow(input: {
  row: DueConsultRow;
  kind: ReviewConsultKind;
  workItemId: string;
  nowIso: string;
}): Parameters<ExpirySweepDeps['notifyRequester']>[0] {
  const { row, kind, workItemId } = input;
  const msgId = ['consult-review-conversion', row.workspace_id, row.conversation_id]
    .map(encodeURIComponent)
    .join(':');
  const next =
    kind === 'rubric-vetting'
      ? `Once a reviewer other than you and the rubric author posts a critique as a comment on ${workItemId}, ` +
        `record vetting with scorecards:emit { ..., vettingWorkItem: '${workItemId}' }.`
      : `A reviewer claims ${workItemId} from the claimable backlog and emits the scorecard; ` +
        `independence rules are unchanged.`;
  return {
    requesterId: row.requester_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    msgId,
    summary: `Consult ${row.conversation_id}: no reviewer engaged — review is now pullable work item ${workItemId}`,
    body:
      `At ${input.nowIso}, ${kind} consult ${row.conversation_id} had no reviewer exchange at half its window ` +
      `(silent selectee ${row.responder_id ?? '(unassigned)'}). Instead of cascading to another responder, the ` +
      `review was converted to work item ${workItemId}, which any eligible agent can claim ` +
      `(review-system-rework-reduction-2026-09-23 P-014). The consult is closed with outcome ` +
      `'converted_to_review_work_item'. ${next} This is not approval: nothing has been reviewed yet.`,
  };
}

export function requesterAlertForRow(input: {
  row: DueConsultRow;
  kind: 'pickup_failed' | 'expired';
  nowIso: string;
}): Parameters<ExpirySweepDeps['notifyRequester']>[0] {
  const { row, kind } = input;
  // Neither wall-clock time nor reason belongs in the replay key: a failed
  // early-pickup notification may retry after the ordinary expiry threshold.
  // Encoding each component avoids delimiter collisions between workspaces.
  const msgId = [
    'consult-expiry-requester-alert',
    row.workspace_id,
    row.conversation_id,
    String(row.cascade_cursor),
  ].map(encodeURIComponent).join(':');
  const reason = kind === 'pickup_failed'
    ? 'reviewer pickup stalled without a consult post'
    : `${row.latency_contract} reviewer wait window elapsed`;
  const action =
    row.latency_contract === 'hard-blocked'
      ? `If still open, await ${consultParkKey(row.conversation_id)}; if terminal, inspect the feedback and request another review when required.`
      : 'Continue independent work and reconcile with the consult thread; request another review when required.';
  return {
    requesterId: row.requester_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    msgId,
    summary: `Consult ${row.conversation_id}: ${reason} — recovery pending`,
    body:
      `At ${input.nowIso}, consult ${row.conversation_id} was ${row.state} with reviewer ` +
      `${row.responder_id ?? '(unassigned)'} (cascade position ${row.cascade_cursor + 1}): ${reason}. ` +
      'Recovery disposition: pending. The existing router will attempt the next eligible reviewer, ' +
      'or expire the consult if the cascade is exhausted. This alert does not confirm recovery, reviewer death, or approval. ' +
      `Read conversations:get { conversation_id: ${JSON.stringify(row.conversation_id)} } for current state and feedback. ` +
      `${action} Record any policy-allowed disposition with consult:close; a review failure is never approval.`,
  };
}

function timestampToIso(value: unknown): string {
  if (value == null) return '';
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}
