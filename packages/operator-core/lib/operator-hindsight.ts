/**
 * operator-hindsight — the "while you were away" channel on the coord substrate
 * (plan collapse-delegate-into-workitems-2026-06-04, D-003).
 *
 * Replaces the bespoke harness_shared.delegate_inbox poll. A hindsight notification
 * (an async delegate finished, a scan surfaced suggestions) is a coord `notify`
 * addressed to the operator owner — subscribe→inject, push not poll. The voice
 * surface drains the operator's coord inbox on connect and speaks a "[While you were
 * away]" briefing.
 *
 * Non-destructive drain: rather than a DELETE/delivered-flag, the voice surface ACKS
 * each notify it surfaces (the existing coord ack mechanism, scoped to the voice
 * owner so it never suppresses the message from the operator's own curation view).
 * A re-drain excludes already-acked notifies.
 */
import { coordLog, coordSql, coordWorkspaceId, coordHasPgFastPath } from './agent-tools/coordination/log';
import { readInbox, readAckedMsgIds, appendAck } from './agent-tools/coordination/messages';
import { collectRetractedIds, suppressRetracted } from './agent-tools/coordination/retraction';
import { OPERATOR_COORD_OWNER } from './delegated-tasks';
import { newMsgId, compareByTsThenId, type CoordEnvelope } from '@papercusp/coordination/core';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** The notify_kind that marks a "while you were away" briefing line. */
export const HINDSIGHT_NOTIFY_KIND = 'operator_hindsight';

/** The ack-owner the voice surface acks AS when it drains the hindsight channel.
 *  Scoped acks (readAckedMsgIds) mean this never hides the notify from the operator. */
export const VOICE_HINDSIGHT_OWNER = 'voice-hindsight';

const VOICE_IDENTITY: AgentIdentity = {
  ownerId: VOICE_HINDSIGHT_OWNER,
  ownerLabel: 'voice',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface HindsightItem {
  headline: string;
  kind: string;
}

/**
 * Push one hindsight notification into the operator's coord inbox. Used when a live
 * voice session was NOT available to receive it directly (async delegate completion,
 * scan completion). `kind` is a free-form sub-tag for the rendering side.
 *
 * TWO deliveries per notification (operator-chat-sidebar-revival-2026-07-13 P-008):
 *   1. The coord `notify` — the voice surface drains + speaks it on connect
 *      ("[While you were away] …"). Unchanged.
 *   2. A `system` turn appended to the SHARED operator conversation — the thread the
 *      desktop chat sidebar / phone / TUI all render live. Before this, hindsight was
 *      voice-drain-ONLY: with the native dock testing-gated dark (D-004) and voice
 *      off, a settled deep-dive answer or handoff landing sat invisibly in the coord
 *      inbox and the typed-turn user never saw it. The thread append makes the answer
 *      land where the user actually asked the question. Fail-soft both ways: a
 *      thread-append failure never loses the coord notify (and vice versa).
 */
export async function notifyOperatorHindsight(headline: string, kind = 'delegate-complete'): Promise<void> {
  const env: CoordEnvelope = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: 'substrate',
    to: [OPERATOR_COORD_OWNER],
    kind: 'notify',
    summary: headline,
    notify_kind: HINDSIGHT_NOTIFY_KIND,
    hindsight_kind: kind,
  };
  await coordLog.appendLine('messages', OPERATOR_COORD_OWNER, env).catch(() => {});
  // Leg 2: land it in the shared conversation thread. Dynamic imports — this module
  // is coord-substrate-level; PG conversations must not become a static dep of it.
  try {
    const [{ getOrCreateActiveConversation, appendTurn }, { notifySyncInvalidate }] =
      await Promise.all([import('./operator-conversations'), import('./sync-sse')]);
    const conversation = await getOrCreateActiveConversation();
    await appendTurn({
      conversationId: conversation.id,
      role: 'system',
      text: `[While you were away] ${headline}`,
      source: 'system',
    });
    void notifySyncInvalidate('operatorTurns.page', {
      conversationId: conversation.id,
    }).catch(() => {});
  } catch (err) {
    console.warn(
      '[operator-hindsight] shared-thread append failed (coord notify still delivered):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/*
 * EI-19323045109346905 — these two readInbox callers were DELIBERATELY NOT converted
 * to the bounded `window` read (measured 2026-08-02): a `window` stopping rule is
 * POST-FILTER (readInboxWindow pages until `enough(visible(rows))` returns true), so
 * it only wins when the caller's filter matches DENSELY. This filter selects one
 * notify_kind that is ALSO unacked — live count of `operator_hindsight` rows in
 * coord_event_log: 0, against ~2,245 notify rows overall (the channel is dormant —
 * `notifyOperatorHindsight` has production callers, but the read side currently has
 * none outside tests). Zero matches is the pathological input for a post-filter
 * rule: `enough` never fires, so `window` would walk all INBOX_MAX_PAGES (25) pages
 * every call — strictly worse than the single unbounded query it replaced.
 *
 * EI-19323414462286091 / EI-19325897270823423 / EI-19314819320465915 — that
 * unbounded query was itself the bug, independently of `window`: measured
 * 2026-08-02, these two callers were the #1 per-agent-turn DB-load driver
 * (~35% of live DB time, ~984ms/call) — readInbox's PG fast path has NO SQL-level
 * kind/notify_kind predicate at all (`kinds` is applied by filterInbox in JS
 * *after* transfer), so every peek/drain call transferred and JSON-parsed all
 * ~20,708 rows addressed to the operator (workspace-verified 2026-08-02) just to
 * answer "is there a pending hindsight notify" for a channel with zero matches.
 * That parallel unbounded scan (3 worker rows with identical durations in
 * pg_stat_activity) is what a live probe caught causing periodic >10s DB-backed MCP
 * tool stalls fleet-wide (EI-19323414462286091's mcp-proxy-watchdog evidence).
 *
 * The fix below is the third lever the comment above always pointed at ("a
 * targeted COUNT for peek... not `enough`"), generalized to both callers:
 * `readHindsightNotifyEnvelopes` pushes `notify_kind = HINDSIGHT_NOTIFY_KIND` into
 * SQL directly. This is safe where the generic `kinds`/recipient push-down
 * EI-19323045109346905 already ruled out (fact:workspace:
 * dead-end:readinbox-push-filters-into-sql) is NOT: that trap is about filters
 * broadcasts blow through (kinds/excludeOwn removed 0.08% of rows because ~99.8%
 * of the unbounded set is '*' broadcasts) — notify_kind='operator_hindsight' is a
 * rare, specific system tag unrelated to broadcast fan-out, genuinely selective
 * today AND by construction going forward. Migration 736 gives the predicate its
 * own partial index so the push-down is a real index scan, not planner luck.
 * Retraction correctness (the OTHER trap that pushed-SQL-filters risk — a retract
 * notice doesn't carry notify_kind, so filtering it out of the row set the same
 * way would un-suppress a retracted target) is preserved by a second, narrow
 * query scoped to just the (typically empty) candidate msg_ids.
 */

/**
 * Bounded, notify_kind-scoped replacement for
 * `readInbox(ownerId, { kinds: ['notify'] })` restricted to hindsight notifies —
 * see the block comment above for why this push-down is safe where the general
 * case is not. Falls back to the full unbounded `readInbox` on any error or when
 * the PG fast path is unavailable (tests / fs-backed coordLog), matching
 * readInbox's own fail-soft shape.
 */
async function readHindsightNotifyEnvelopes(ownerId: string): Promise<CoordEnvelope[]> {
  if (!coordHasPgFastPath()) return readInbox(ownerId, { kinds: ['notify'] });
  try {
    const sql = coordSql();
    const workspaceId = coordWorkspaceId();
    const rows = await sql<{ body: unknown }[]>`
      SELECT body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId}
         AND surface = 'messages'
         AND (body ->> 'notify_kind') = ${HINDSIGHT_NOTIFY_KIND}
         AND jsonb_typeof(body->'to') = 'array'
         -- Keep recipient membership in PostgreSQL's native JSONB "?" form so
         -- coord_event_log_msgs_to_gin can answer this predicate without a
         -- parallel sequential scan of the whole messages surface.
         AND ((body->'to') ? ${ownerId} OR (body->'to') ? '*')
       ORDER BY id DESC
       LIMIT 2000
    `;
    const candidates = rows.map(
      (r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) as CoordEnvelope,
    );
    if (candidates.length === 0) return candidates;
    const msgIds = candidates
      .map((c) => c.msg_id)
      .filter((id): id is string => typeof id === 'string');
    const retractRows = msgIds.length
      ? await sql<{ body: unknown }[]>`
          SELECT body
            FROM harness_shared.coord_event_log
           WHERE workspace_id = ${workspaceId}
             AND surface = 'messages'
             AND (body ? 'retracts')
             AND (body ->> 'retracts') = ANY(${msgIds}::text[])
        `
      : [];
    const retractLines = retractRows.map((r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body));
    // The SQL order is DESC (LIMIT degrades by forgetting the OLDEST rows, same
    // rationale as readInbox's own fast path) — re-sort ascending to match
    // filterInbox's output order (compareByTsThenId), since callers here render
    // headlines chronologically and readInbox callers get that ordering for free.
    return suppressRetracted(candidates, collectRetractedIds(retractLines)).sort(compareByTsThenId);
  } catch {
    // Fall through to the authoritative full-surface read below.
    return readInbox(ownerId, { kinds: ['notify'] });
  }
}

/**
 * Drain the operator's pending hindsight notifications (those not yet acked by the
 * voice surface), acking each so it does not replay on the next connect. Returns the
 * headlines for the "[While you were away]" briefing.
 */
export async function drainOperatorHindsight(): Promise<HindsightItem[]> {
  const [inbox, acked] = await Promise.all([
    readHindsightNotifyEnvelopes(OPERATOR_COORD_OWNER),
    readAckedMsgIds(VOICE_HINDSIGHT_OWNER),
  ]);
  const fresh = inbox.filter(
    (m) => m.kind === 'notify' && m.notify_kind === HINDSIGHT_NOTIFY_KIND && !acked.has(m.msg_id),
  );
  for (const m of fresh) {
    const from = typeof m.from === 'string' ? m.from : 'substrate';
    await appendAck(VOICE_IDENTITY, m.msg_id, from).catch(() => {});
  }
  return fresh.map((m) => ({
    headline: typeof m.summary === 'string' ? m.summary : '',
    kind: typeof m.hindsight_kind === 'string' ? m.hindsight_kind : 'delegate-complete',
  })).filter((x) => x.headline);
}

/** Count of undrained hindsight notifications (peek). */
export async function peekOperatorHindsight(): Promise<{ pending: number }> {
  const [inbox, acked] = await Promise.all([
    readHindsightNotifyEnvelopes(OPERATOR_COORD_OWNER),
    readAckedMsgIds(VOICE_HINDSIGHT_OWNER),
  ]);
  const pending = inbox.filter(
    (m) => m.kind === 'notify' && m.notify_kind === HINDSIGHT_NOTIFY_KIND && !acked.has(m.msg_id),
  ).length;
  return { pending };
}
