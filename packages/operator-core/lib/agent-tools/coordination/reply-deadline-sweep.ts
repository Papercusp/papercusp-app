/**
 * reply-deadline-sweep — coord:send { replyDeadlineSec } backstop (EI-8986).
 *
 * wakeOnReply covers the reply-ARRIVES case (coord-wake-on-reply): the sender
 * is woken the moment a peer replies. Nothing covered the reply-NEVER-arrives
 * case — a leader hand-carrying "nudge X at HH:MMZ if silent" in a checkpoint/
 * carry-note is exactly the hand-rolled deadline-tracking this backstop
 * replaces, and it dies with compaction.
 *
 * `replyDeadlineSec` is stamped onto the envelope as a top-level
 * `replyDeadlineAt` (epoch ms) field — same shape as `wakeOnReply` (see
 * tools/send.ts's `extra.wakeOnReply` stamp). This sweep finds every message
 * whose deadline has passed with no reply yet, and nudges the ORIGINAL sender
 * once.
 *
 * DATA MODEL (mirrors reconcile-handoffs.ts's sibling-record idempotency —
 * coord_event_log's `messages` surface is append-only, no update-in-place):
 * the nudge itself IS the idempotency marker. It's sent with
 * `related_msg_id: <original msg_id>`, so it satisfies the exact same
 * "does a reply exist" check a genuine peer reply would — one nudge per
 * deadline, guaranteed by construction, no separate marker/side-table needed.
 *
 * SCOPE: `replyDeadlineAt` is a rare, explicit opt-in field, so this queries
 * `harness_shared.coord_event_log` directly (mirrors message-log-gc.ts's
 * `gcOldOperatorMessages` — a raw JSONB-predicate scan across ALL workspaces
 * via the admin connection) rather than extending the generic CoordEventLog
 * interface (`readLinesBounded` et al, in `@papercusp/coordination`) with a
 * one-off filter only this sweep needs.
 *
 * EI-13610: a reply is not the ONLY way an awaited recipient answers — su
 * agents habitually post their answer as a WORK-ITEM THREAD POST
 * (work_items:comment) rather than a coord reply with `related_msg_id`, since
 * that's where the evidence belongs. The sweep only watched coord replies, so
 * it fired a stale "no reply by deadline" false-alarm nudge (+ wake) even when
 * the awaited agent had already answered on the very work-item the original
 * message was about. Before alarming, this sweep now auto-detects WI-/EI- ids
 * mentioned in the original message's summary/body (the same P-008 auto-ref
 * detector `coord:send` uses for delivery hydration) and checks whether any
 * awaited recipient (`to`) has since posted on that item's thread. A hit
 * REPLACES the alarm with a quiet, non-waking auto-resolved note (still
 * carrying `related_msg_id` as the idempotency marker, so it is never
 * re-checked) instead of a false-alarm wake.
 *
 * EI-18689956983040659: a reply isn't the only way the QUESTION itself stops
 * being open, either — the SENDER can withdraw or supersede it. Observed
 * live: a sender briefed a recipient with `expectsReply:true`, then 48s later
 * sent a retraction ("false alarm, do NOT build it") to the same recipient —
 * yet the sweep fired a "reply deadline missed" alarm + wake ~30m later,
 * even though `coord:inbox{unanswered_only:true}` already correctly read 0
 * (nothing owed). `findDueReplyDeadlines`' own idempotency check only looks
 * for a sibling row carrying `related_msg_id = <original msg_id>` — it never
 * considers that the ORIGINAL SENDER moved the conversation forward
 * themselves. Before alarming, this sweep now also checks whether the sender
 * sent ANY later directed message to (at least one of) the same recipients
 * — a supersede/retraction/follow-up implies the sender is no longer
 * blocked-waiting on the original ask. A hit auto-resolves the deadline
 * (quiet note, no alarm, no wake) the same way an EI-13610 reply-equivalent
 * hit does; checked FIRST since it needs no auto-ref detection and directly
 * addresses the sender's own side of the exchange.
 */

import { getOrgPg } from '@papercusp/db-org';
import { sendMessage } from './messages';
import { wakeRecipients } from './inbox-wake';
import { fetchDirectiveActuations } from './directive-effect';
import { parseEffectStamp } from './directive-effect-read';
import { detectBodyRefs } from './ref-hydrate';
import type { DirectiveActuation, DirectiveEffectSpec } from './directive-effect';
import type { AgentIdentity } from './identity';

/** Resolver identity stamped on auto-fired deadline nudges (audit trail). */
export const RECONCILE_REPLY_DEADLINE_OWNER = 'system:reply-deadline-sweep';

/** Coord identity for the sweep's own nudge write. A system action runs
 *  in-process, so it attributes as a `principal` (mirrors
 *  RECONCILE_HANDOFF_OWNER / the coord-invariant-monitor's MONITOR_IDENTITY)
 *  — never a real fleet agent. */
const RECONCILE_IDENTITY: AgentIdentity = {
  ownerId: RECONCILE_REPLY_DEADLINE_OWNER,
  ownerLabel: 'system · reply-deadline-sweep',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Max deadline-missed messages nudged per sweep tick — a safety bound; the
 *  opt-in volume is expected to be small (mirrors RECONCILE_REPING_BATCH_LIMIT). */
export const REPLY_DEADLINE_SWEEP_BATCH_LIMIT = 200;

export interface DueReplyDeadline {
  workspaceId: string;
  msgId: string;
  from: string;
  to: string[];
  /** Original audience selector provenance. An empty expanded `to` plus a
   *  non-empty audience means the message reached no live recipient, so no
   *  reply could ever arrive. */
  audience: string[];
  summary?: string;
  planSlug?: string;
  /** How overdue the deadline is, for the nudge prose. */
  overdueMinutes: number;
  /** The original message body text (EI-13610: fed into detectBodyRefs alongside
   *  `summary` to find WI-/EI- ids the reply-equivalent-activity check probes). */
  body?: string;
  /** P-013: an explicitly declared side effect this directive expected. */
  expectEffect?: DirectiveEffectSpec;
  /** When the original message was sent (epoch ms) — the reply-equivalent-activity
   *  check only counts a thread post AFTER this (EI-13610). */
  sentAtMs: number;
}

interface DueReplyDeadlineRow {
  workspace_id: string;
  msg_id: string;
  from_id: string;
  to_ids: unknown;
  audience: unknown;
  summary: string | null;
  body: string | null;
  plan_slug: string | null;
  expect_effect: unknown;
  deadline_at: string; // bigint comes back as text over the pg driver
  sent_at_ms: string; // bigint comes back as text over the pg driver
}

/**
 * Every message whose `replyDeadlineAt` has passed with no reply yet
 * (NOT EXISTS a sibling row carrying `related_msg_id = <this msg_id>` — a
 * genuine peer reply OR a prior nudge both satisfy this, so a message is
 * selected at most once). Oldest-overdue first so a batch-limited sweep
 * drains the longest-waiting first.
 */
async function findDueReplyDeadlines(nowMs: number, limit: number): Promise<DueReplyDeadline[]> {
  const { sql } = getOrgPg();
  const rows = await sql<DueReplyDeadlineRow[]>`
    SELECT e1.workspace_id,
           e1.msg_id,
           e1.body->>'from' AS from_id,
           e1.body->'to' AS to_ids,
           e1.body->'audience' AS audience,
           e1.body->>'summary' AS summary,
           e1.body->>'body' AS body,
           e1.body->>'plan_slug' AS plan_slug,
           e1.body->'expectEffect' AS expect_effect,
           e1.body->>'replyDeadlineAt' AS deadline_at,
           (extract(epoch FROM e1.ts) * 1000)::bigint AS sent_at_ms
      FROM harness_shared.coord_event_log e1
     WHERE e1.surface = 'messages'
       AND e1.body ? 'replyDeadlineAt'
       AND (e1.body->>'replyDeadlineAt')::bigint <= ${nowMs}
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.coord_event_log e2
          -- msg_id is generated as a global coordination identity. A reply
          -- marker can therefore land in a different workspace partition than
          -- the original message (for example after a workspace restamp or
          -- federation), and must still retire the original deadline.
          WHERE e2.surface = 'messages'
            -- The body ? 'related_msg_id' clause is logically REDUNDANT with the equality
            -- below (body->>key is NULL when the key is absent, and NULL never equals a
            -- msg_id), but it is REQUIRED for the planner to use
            -- coord_event_log_related_msg_id_idx, which is PARTIAL: it is defined
            -- WHERE (body ? 'related_msg_id'). Without this clause the index cannot be
            -- proven to cover, and the anti-join degrades to hashing every messages row.
            -- Measured 2026-08-03 (EI-19448297390091252): 40,684 -> 721 buffers (56x),
            -- 156.9ms -> 8.96ms, scanning 86,722 rows to return zero. Do not "simplify".
            AND e2.body ? 'related_msg_id'
            AND e2.body->>'related_msg_id' = e1.msg_id
       )
     ORDER BY (e1.body->>'replyDeadlineAt')::bigint ASC
     LIMIT ${limit}
  `;
  return rows
    .filter((r) => typeof r.from_id === 'string' && r.from_id)
    .map((r) => {
      const deadlineMs = Number(r.deadline_at);
      const to = Array.isArray(r.to_ids)
        ? (r.to_ids as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      const audience = Array.isArray(r.audience)
        ? (r.audience as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      const sentAtMs = Number(r.sent_at_ms);
      return {
        workspaceId: r.workspace_id,
        msgId: r.msg_id,
        from: r.from_id,
        to,
        audience,
        summary: r.summary ?? undefined,
        body: r.body ?? undefined,
        expectEffect: parseEffectStamp(r.expect_effect) ?? undefined,
        planSlug: r.plan_slug ?? undefined,
        overdueMinutes: Number.isFinite(deadlineMs) ? (nowMs - deadlineMs) / 60_000 : 0,
        sentAtMs: Number.isFinite(sentAtMs) ? sentAtMs : 0,
      };
    });
}

export interface SupersedingMessage {
  /** The later message's own msg_id (for the auto-resolved note's prose). */
  msgId: string;
  /** When the sender sent it (epoch ms). */
  sentAtMs: number;
}

/**
 * EI-18689956983040659: did the ORIGINAL SENDER send any LATER directed
 * message to (at least one of) the same recipients, strictly after the
 * original ask? A supersede/retraction/follow-up is the clearest case, but
 * this deliberately doesn't require `related_msg_id`-threading or any
 * particular content — ANY later directed message from the same sender to
 * the same recipient(s) is evidence the sender has moved the conversation
 * forward themselves and is no longer sitting blocked-waiting on the
 * original ask (mirrors unanswered-directed.ts's WI-5345 rationale for the
 * symmetric "recipient replied, even unthreaded" case). Returns the single
 * earliest such message (enough to annotate the auto-resolved note with), or
 * `null` when nothing matches (the normal genuinely-still-due case).
 */
async function findSupersedingMessage(
  workspaceId: string,
  originalMsgId: string,
  from: string,
  to: string[],
  sentAtMs: number,
): Promise<SupersedingMessage | null> {
  if (!to.length) return null;
  const { sql } = getOrgPg();
  const rows = await sql<{ msg_id: string; ts_ms: string }[]>`
    -- EI-18689956983040659 supersede-check: a later directed message from the
    -- SAME sender to (at least one of) the SAME recipients.
    SELECT e.msg_id, (extract(epoch FROM e.ts) * 1000)::bigint AS ts_ms
      FROM harness_shared.coord_event_log e
     WHERE e.workspace_id = ${workspaceId}
       AND e.surface = 'messages'
       AND e.msg_id <> ${originalMsgId}
       AND e.body->>'from' = ${from}
       AND e.ts > to_timestamp(${sentAtMs}::double precision / 1000)
       AND jsonb_typeof(e.body->'to') = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(e.body->'to') t
          WHERE t = ANY(${to}::text[])
       )
     ORDER BY e.ts ASC
     LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  const ts = Number(r.ts_ms);
  return { msgId: r.msg_id, sentAtMs: Number.isFinite(ts) ? ts : sentAtMs };
}

export interface UnthreadedRecipientReply {
  /** The later message's own msg_id (for the auto-resolved note's prose). */
  msgId: string;
  /** The awaited recipient who authored the message. */
  authorId: string;
  /** When the recipient sent it (epoch ms). */
  sentAtMs: number;
}

/**
 * EI-20760420701985610: did an awaited recipient send a LATER, unthreaded
 * directed message back to the original sender? The coord inbox/reply-wake
 * path allows a recipient to answer in a fresh message (and the live incident
 * did exactly that), so an exact `related_msg_id` anti-join alone can still
 * alarm about an answered ask. Mirror unanswered-directed.ts's established
 * loose-reply semantics: only a message with no `related_msg_id`, no audience
 * selector, and the original sender in its concrete `to` array counts. A
 * reply threaded to a DIFFERENT message is deliberately not loose evidence.
 */
async function findUnthreadedRecipientReply(
  workspaceId: string,
  originalMsgId: string,
  from: string,
  to: string[],
  sentAtMs: number,
): Promise<UnthreadedRecipientReply | null> {
  if (!to.length) return null;
  const { sql } = getOrgPg();
  const rows = await sql<{ msg_id: string; author_id: string; ts_ms: string }[]>`
    -- EI-20760420701985610 recipient-reply-check: a fresh, unthreaded
    -- directed response is a reply-equivalent answer to the original ask.
    SELECT e.msg_id,
           e.body->>'from' AS author_id,
           (extract(epoch FROM e.ts) * 1000)::bigint AS ts_ms
      FROM harness_shared.coord_event_log e
     WHERE e.workspace_id = ${workspaceId}
       AND e.surface = 'messages'
       AND e.msg_id <> ${originalMsgId}
       AND e.body->>'from' = ANY(${to}::text[])
       AND e.body->>'from' IS DISTINCT FROM ${from}
       AND (e.body->>'kind' IS NULL OR e.body->>'kind' = 'message')
       AND NOT (e.body ? 'audience')
       AND NOT (e.body ? 'related_msg_id')
       AND jsonb_typeof(e.body->'to') = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(e.body->'to') recipient
          WHERE recipient = ${from}
       )
       AND e.ts > to_timestamp(${sentAtMs}::double precision / 1000)
     ORDER BY e.ts ASC
     LIMIT 1
  `;
  const r = rows[0];
  if (!r || typeof r.msg_id !== 'string' || !r.msg_id || typeof r.author_id !== 'string' || !to.includes(r.author_id)) {
    return null;
  }
  const ts = Number(r.ts_ms);
  if (!Number.isFinite(ts) || ts <= sentAtMs) return null;
  return { msgId: r.msg_id, authorId: r.author_id, sentAtMs: ts };
}

export interface ReplyEquivalentActivity {
  /** The WI-/EI- id whose thread carries the answer. */
  workItemId: string;
  /** Which awaited recipient posted it. */
  authorId: string;
  /** When they posted (epoch ms). */
  postedAtMs: number;
}

/** P-013 / EI-20330285752095560: a declared or inferred work-item effect that
 *  happened after the original ask. It is reply-equivalent evidence: the
 *  recipient completed the requested ledger change even though no coord reply
 *  or thread post was written. */
interface DirectiveReplyEquivalent {
  actuation: DirectiveActuation;
}

/** issue-thread-<id> (issue-family: bug/change) or work-item-thread-<id>
 *  (feature-family) — mirrors threadId()/`work-item-thread-${id}` in
 *  issues-engineer.ts / work-items.ts. Checking both avoids a family lookup:
 *  a given id only ever has ONE of the two threads. */
function candidateThreadIds(workItemId: string): string[] {
  return [`issue-thread-${workItemId}`, `work-item-thread-${workItemId}`];
}

function workItemIdFromThreadId(threadId: string): string {
  return threadId.replace(/^issue-thread-/, '').replace(/^work-item-thread-/, '');
}

/**
 * EI-13610: has any AWAITED recipient (`authorIds`) posted on the thread of
 * any of the referenced work-items SINCE the original message was sent? This
 * is the "reply-equivalent activity" this sweep treats as answering the
 * deadline even though it never arrived as a coord reply. Returns the single
 * earliest such post (enough to annotate/suppress the nudge with), or `[]`
 * when nothing matches (the normal false-alarm-check-came-up-empty case).
 */
async function findReplyEquivalentActivity(
  workspaceId: string,
  workItemIds: string[],
  authorIds: string[],
  sinceMs: number,
): Promise<ReplyEquivalentActivity[]> {
  if (!workItemIds.length || !authorIds.length) return [];
  const { sql } = getOrgPg();
  const threadIds = workItemIds.flatMap(candidateThreadIds);
  const rows = await sql<{ thread_id: string; author_id: string; posted_at_ms: string }[]>`
    SELECT thread_id, author_id, (extract(epoch FROM created_at) * 1000)::bigint AS posted_at_ms
      FROM harness_shared.coord_thread_posts
     WHERE workspace_id = ${workspaceId}
       AND thread_id = ANY(${threadIds})
       AND author_id = ANY(${authorIds})
       AND created_at > to_timestamp(${sinceMs}::double precision / 1000)
     ORDER BY created_at ASC
     LIMIT 1
  `;
  // Defense-in-depth (mirrors findDueReplyDeadlines' own extra `.filter`): the
  // WHERE clause above already constrains author/thread/recency, but re-check
  // in JS too rather than trusting a single enforcement layer for something
  // that suppresses a false-alarm — a stray/irrelevant row must never be
  // mistaken for a genuine reply-equivalent answer.
  const authorSet = new Set(authorIds);
  const threadSet = new Set(threadIds);
  return rows
    .filter(
      (r) => typeof r.author_id === 'string' && r.author_id && authorSet.has(r.author_id) && threadSet.has(r.thread_id),
    )
    .map((r) => {
      const postedAtMs = Number(r.posted_at_ms);
      return {
        workItemId: workItemIdFromThreadId(r.thread_id),
        authorId: r.author_id,
        postedAtMs: Number.isFinite(postedAtMs) ? postedAtMs : sinceMs,
      };
    })
    .filter((a) => a.postedAtMs > sinceMs);
}

export interface ReplyDeadlineSweepResult {
  due: number;
  nudged: number;
  /** EI-13610/EI-20760420701985610: due deadlines auto-resolved by
   *  reply-equivalent recipient activity (an unthreaded coord message or a
   *  work-item thread post; no alarm sent — a quiet, non-waking note instead). */
  autoResolved: number;
  /** EI-18689956983040659: due deadlines auto-resolved because the ORIGINAL
   *  SENDER themself sent a later directed message to the same recipient(s)
   *  (a supersede/retraction/follow-up) — no alarm sent. Counted separately
   *  from `autoResolved` since it's a distinct signal (the sender's own
   *  follow-up, not the recipient's answer). */
  superseded: number;
  /** True when the due backlog exceeded the batch limit (more remain next tick). */
  truncated: boolean;
}

/**
 * One sweep pass: find every message whose reply deadline has passed with no
 * reply yet (up to the batch limit). Before alarming:
 *  - EI-18689956983040659: check whether the ORIGINAL SENDER sent a later
 *    directed message to the same recipient(s) — a supersede/retraction the
 *    sender themself issued, which means they're no longer waiting on a
 *    reply to the original ask regardless of what the recipient does.
 *  - EI-20760420701985610: check whether any awaited recipient sent a later,
 *    unthreaded directed message back to the ORIGINAL sender — the common
 *    fresh-message reply shape that coord:send's exact-thread anti-join misses.
 *  - EI-13610: check whether any awaited recipient has since posted on the
 *    thread of a WI-/EI- id mentioned in the original message — another
 *    reply-equivalent activity a coord-only check would miss.
 * Either hit sends a quiet auto-resolved note (still carrying
 * `related_msg_id` as the idempotency marker) instead of the alarm + wake.
 * Otherwise, nudge the ORIGINAL sender once — a visible coord message + a
 * fail-soft inbox-wake so an idle sender is re-invoked NOW. Fully fail-soft
 * per message: a failure on one message never aborts the pass.
 */
export async function runReplyDeadlineSweepOnce(
  opts: { nowMs?: number; limit?: number } = {},
): Promise<ReplyDeadlineSweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? REPLY_DEADLINE_SWEEP_BATCH_LIMIT;
  const due = await findDueReplyDeadlines(nowMs, limit + 1);
  const batch = due.slice(0, limit);

  let nudged = 0;
  let autoResolved = 0;
  let superseded = 0;
  for (const d of batch) {
    try {
      // EI-21159174538438156: audience selectors are persisted on the envelope
      // before expansion discards them. If the expanded `to` list is empty but
      // audience provenance is present, the send reached nobody live, so there
      // is no recipient who could answer. Retire the deadline with a quiet
      // related-message marker; otherwise this row would alarm on every sweep.
      if (d.to.length === 0 && d.audience.length > 0) {
        await sendMessage(RECONCILE_IDENTITY, {
          to: [d.from],
          summary:
            `✅ reply deadline auto-resolved: audience ${d.audience.join(', ')} resolved to zero live recipients ` +
            `— no reply was possible (${d.summary ?? d.msgId})`,
          body:
            `Your message ${d.msgId} had a reply deadline, but its audience ` +
            `${d.audience.join(', ')} resolved to zero live recipients. The message reached nobody live, ` +
            'so no recipient could answer and no follow-up alarm is needed.',
          plan_slug: d.planSlug,
          related_msg_id: d.msgId,
        });
        autoResolved += 1;
        continue;
      }

      // EI-18689956983040659: check FIRST whether the sender superseded their
      // own ask — cheapest check (no auto-ref detection needed) and the most
      // direct signal, since it doesn't depend on the recipient doing
      // anything at all. Fail-soft: a probe failure falls through to the
      // ordinary checks, never silently swallows a genuinely-overdue one.
      let supersede: SupersedingMessage | null = null;
      try {
        supersede = await findSupersedingMessage(d.workspaceId, d.msgId, d.from, d.to, d.sentAtMs);
      } catch (e) {
        console.warn(
          `[reply-deadline-sweep] supersede probe for ${d.msgId} failed: ${e instanceof Error ? e.message : e}`,
        );
      }

      if (supersede) {
        // Quiet + non-waking: the SENDER already moved the conversation
        // forward themselves — alarming them about their own superseded ask
        // is exactly the false alarm this bug reports. related_msg_id still
        // lands so the idempotency NOT EXISTS check retires this deadline.
        await sendMessage(RECONCILE_IDENTITY, {
          to: [d.from],
          summary:
            `✅ reply deadline auto-resolved: you sent a later message (${supersede.msgId}) to the same ` +
            `recipient(s) — treating the original ask as superseded (${d.summary ?? d.msgId})`,
          body:
            `Your message ${d.msgId}${d.to.length ? ` to ${d.to.join(', ')}` : ''}` +
            `${d.planSlug ? ` (plan ${d.planSlug})` : ''} had a reply deadline with no reply, but you sent a ` +
            `later message (${supersede.msgId}) to the same recipient(s) at ` +
            `${new Date(supersede.sentAtMs).toISOString()} — treating that as a supersede/retraction of the ` +
            'original ask. No action needed unless you are still actually waiting on a reply to it.',
          plan_slug: d.planSlug,
          related_msg_id: d.msgId,
        });
        superseded += 1;
        continue;
      }

      // EI-20760420701985610: a recipient can answer in a fresh directed
      // message without copying the original msg_id. Mirror the established
      // unanswered-directed loose-reply rule, but keep it fail-soft: a probe
      // failure must fall through to the ordinary checks rather than silently
      // suppressing a genuinely overdue deadline.
      let recipientReply: UnthreadedRecipientReply | null = null;
      try {
        recipientReply = await findUnthreadedRecipientReply(d.workspaceId, d.msgId, d.from, d.to, d.sentAtMs);
      } catch (e) {
        console.warn(
          `[reply-deadline-sweep] unthreaded recipient-reply probe for ${d.msgId} failed: ${e instanceof Error ? e.message : e}`,
        );
      }

      if (recipientReply) {
        // Quiet + non-waking: the awaited recipient already answered, just not
        // by threading onto the exact ask. related_msg_id still lands as the
        // idempotency marker so this deadline retires permanently.
        await sendMessage(RECONCILE_IDENTITY, {
          to: [d.from],
          summary:
            `✅ reply deadline auto-resolved: ${recipientReply.authorId} sent a later response (${recipientReply.msgId}) ` +
            `to you — treating the original ask as answered (${d.summary ?? d.msgId})`,
          body:
            `Your message ${d.msgId}${d.to.length ? ` to ${d.to.join(', ')}` : ''}` +
            `${d.planSlug ? ` (plan ${d.planSlug})` : ''} had a reply deadline with no threaded reply, but ` +
            `${recipientReply.authorId} sent a later directed message (${recipientReply.msgId}) to you at ` +
            `${new Date(recipientReply.sentAtMs).toISOString()} — treating that fresh message as the answer. ` +
            'No action needed unless it does not actually answer the original ask.',
          plan_slug: d.planSlug,
          related_msg_id: d.msgId,
        });
        autoResolved += 1;
        continue;
      }

      // P-013 / EI-20330285752095560: an explicit expectEffect is the strongest
      // declaration of what the recipient was asked to do. When no explicit
      // effect was stamped, treat cited WI-/EI- ids as terminal expectations;
      // resolveDirectiveEffect still compares the observed close timestamp to
      // this message's sentAtMs, so a pre-existing terminal item cannot suppress
      // a real deadline alarm. The shared directive reader fails soft and returns
      // `unknown` on an unreadable/missing row; only `satisfied` suppresses.
      const workItemIds = detectBodyRefs(`${d.summary ?? ''} ${d.body ?? ''}`)
        .filter((r): r is Extract<typeof r, { kind: 'work-item' }> => r.kind === 'work-item')
        .map((r) => r.id);
      const effectSpecs: Array<DirectiveEffectSpec & { sentAtMs: number }> = d.expectEffect
        ? [{ ...d.expectEffect, sentAtMs: d.sentAtMs }]
        : workItemIds.map((itemId) => ({ kind: 'terminal' as const, itemId, sentAtMs: d.sentAtMs }));
      let directiveEffect: DirectiveReplyEquivalent | null = null;
      if (effectSpecs.length) {
        try {
          const actuations = await fetchDirectiveActuations(effectSpecs, { workspaceId: d.workspaceId });
          const satisfied = actuations.find((a) => a.verdict === 'satisfied');
          if (satisfied) directiveEffect = { actuation: satisfied };
        } catch (e) {
          console.warn(
            `[reply-deadline-sweep] directive-effect probe for ${d.msgId} failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      }

      if (directiveEffect) {
        const { actuation } = directiveEffect;
        const observedAtMs = actuation.observedAtMs;
        await sendMessage(RECONCILE_IDENTITY, {
          to: [d.from],
          summary:
            `✅ reply deadline auto-resolved: expected ${actuation.spec.kind} on ${actuation.spec.itemId} ` +
            `was satisfied (${d.summary ?? d.msgId})`,
          body:
            `Your message ${d.msgId}${d.to.length ? ` to ${d.to.join(', ')}` : ''}` +
            `${d.planSlug ? ` (plan ${d.planSlug})` : ''} had a reply deadline with no coord reply, but the ` +
            `expected ${actuation.spec.kind} effect on ${actuation.spec.itemId} was observed` +
            `${observedAtMs == null ? '' : ` at ${new Date(observedAtMs).toISOString()}`}. ` +
            `${actuation.evidence} No action needed unless the effect does not answer the original ask.`,
          plan_slug: d.planSlug,
          related_msg_id: d.msgId,
        });
        autoResolved += 1;
        continue;
      }

      // EI-13610: probe for reply-equivalent thread activity BEFORE alarming.
      // Fail-soft by design — a probe failure just falls through to the
      // ordinary alarm path (never silently swallows a genuinely-overdue one).
      let activity: ReplyEquivalentActivity | null = null;
      // detectBodyRefs is narrow (WI-/EI- ids only, per its own docstring), so
      // every hit is already `kind: 'work-item'` — the filter+narrow is just
      // to satisfy the HydratableRef union's type, not a real runtime filter.
      if (workItemIds.length && d.to.length) {
        try {
          const hits = await findReplyEquivalentActivity(d.workspaceId, workItemIds, d.to, d.sentAtMs);
          activity = hits[0] ?? null;
        } catch (e) {
          console.warn(
            `[reply-deadline-sweep] reply-equivalent probe for ${d.msgId} failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      }

      if (activity) {
        // Quiet + non-waking: the recipient already answered, just not via a
        // coord reply — a "no reply" alarm here would be the false alarm this
        // bug reports. related_msg_id still lands so the idempotency NOT
        // EXISTS check retires this deadline permanently.
        await sendMessage(RECONCILE_IDENTITY, {
          to: [d.from],
          summary:
            `✅ reply deadline auto-resolved: ${activity.authorId} posted on ${activity.workItemId} at ` +
            `${new Date(activity.postedAtMs).toISOString()} — likely answered there (${d.summary ?? d.msgId})`,
          body:
            `Your message ${d.msgId}${d.to.length ? ` to ${d.to.join(', ')}` : ''}` +
            `${d.planSlug ? ` (plan ${d.planSlug})` : ''} had a reply deadline with no coord reply, but ` +
            `${activity.authorId} posted on ${activity.workItemId}'s thread at ${new Date(activity.postedAtMs).toISOString()} ` +
            '(after this message was sent) — likely the answer, delivered via the item thread instead of a coord reply. ' +
            'No action needed unless that post does not actually answer it.',
          plan_slug: d.planSlug,
          related_msg_id: d.msgId,
        });
        autoResolved += 1;
        continue;
      }

      await sendMessage(RECONCILE_IDENTITY, {
        to: [d.from],
        summary: `⏰ no reply by deadline (~${Math.round(d.overdueMinutes)}m overdue): ${d.summary ?? d.msgId}`,
        body:
          `Your message ${d.msgId}${d.to.length ? ` to ${d.to.join(', ')}` : ''}` +
          `${d.planSlug ? ` (plan ${d.planSlug})` : ''} had a reply deadline and no reply has landed ` +
          `~${Math.round(d.overdueMinutes)}m past it. Follow up, escalate, or move on — this is a one-shot nudge, ` +
          'not a recurring alarm.',
        plan_slug: d.planSlug,
        related_msg_id: d.msgId,
      });
      nudged += 1;

      try {
        await wakeRecipients([d.from], {
          summary: `reply deadline missed on ${d.msgId} (~${Math.round(d.overdueMinutes)}m overdue)`,
          source: RECONCILE_REPLY_DEADLINE_OWNER,
          workspaceId: d.workspaceId,
        });
      } catch (e) {
        console.warn(
          `[reply-deadline-sweep] wake sender ${d.from} for ${d.msgId} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    } catch (e) {
      // A nudge failure on one message must never abort the sweep — the next
      // tick will retry it (it is still unanswered, so it stays selectable).
      console.warn(`[reply-deadline-sweep] nudge for ${d.msgId} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { due: due.length, nudged, autoResolved, superseded, truncated: due.length > batch.length };
}
