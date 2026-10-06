/**
 * `system:improvement-human-digest` — the weekly owner drain ritual over the
 * human review queue (self-improvement-consume-edges-2026-06-12 P-022 / B-08,
 * adopting Scout's own EI-340/EI-352 proposals).
 *
 * Once a week, send the owner the TOP-5 human-lane items ordered by BLOCKING
 * IMPACT (blocking-impact.ts: `blocks` edges, inbound references, open
 * re-captures, watchdog persistence, severity × log staleness), each with its
 * "why this ranks here" reasons — so scarce owner attention always lands on
 * the highest-leverage decision first, and the queue gets a drain cadence
 * instead of compounding silently (the 06-12 audit's "flat human queue").
 *
 * NOT a revival of the removed `improvement-digest` push (operator-learning-tab
 * D-001 killed a dead-end headline notification): this one is (a) weekly, not
 * per-tick; (b) a ranked, reasoned top-5, not a count; (c) no longer a dead
 * end — the Learning tab exists to open. Read-only: it changes no state, so
 * the routine seeds ACTIVE (seed-human-digest-routine.ts).
 *
 * Delivery rides BOTH existing rails, each best-effort (a delivery failure
 * never fails the tick): the persistent coord inbox (`to: ['human']`) and
 * `notifyAttention` (desktop-native + mobile push).
 *
 * Config (routine `trigger_config`, optional):
 *   - `top_n` — how many items the digest leads with (default 5).
 *   - `needs_human_stale_days` — state-age before a per-item reminder
 *     (default 7). Reminders dedupe by work-item + state_changed_at, so a DBOS
 *     replay is silent while a genuinely new needs-human episode can notify.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { getMessageById, sendMessage } from '../../agent-tools/coordination/messages';
import { getConversationStatesByIds } from '../../agent-tools/coordination/conversations';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { ownerNotificationMessageId } from '../../agent-tools/operator/notify_owner';
import {
  NEEDS_HUMAN_LIMIT,
  readNeedsHumanWorkItems,
  type NeedsHumanWorkItemRow,
} from '../../attention/needs-human-work-items-source';
import { notifyAttentionOnce } from '../../attention-notify';
import { activeExternalBlockers, ownerAskDefaultDisclosure } from '../../external-blockers';
import { readStructuredOwnerAsk } from '../improvements/agent-review-policy';
import { readImprovementItems } from '../improvements/read-items';
import { buildDigest } from '../improvements/digest';
import { readOwnerFullAutonomyGrant } from '../improvements/full-autonomy-grant';
import type { ImpactRankedItem } from '../improvements/blocking-impact';
import { applyHumanQueueRanking } from '../../queue-ranker/human-queue';

/** Coord identity for the digest message (mirrors token-report / git-sync). */
const HUMAN_DIGEST_IDENTITY: AgentIdentity = {
  ownerId: 'system:improvement-human-digest',
  ownerLabel: 'human-queue-digest',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

const DEFAULT_TOP_N = 5;
const DEFAULT_NEEDS_HUMAN_STALE_DAYS = 7;
const DAY_MS = 86_400_000;
const TITLE_MAX = 110;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Compose the digest message. Pure. Returns null for an empty queue (no spam). */
export function composeHumanQueueDigest(
  humanQueue: readonly ImpactRankedItem[],
  opts: { topN?: number } = {},
): { summary: string; body: string } | null {
  if (humanQueue.length === 0) return null;
  const topN = Math.max(1, opts.topN ?? DEFAULT_TOP_N);
  const top = humanQueue.slice(0, topN);

  const lines = top.map((it, i) => {
    const sev = it.severity ?? 'minor';
    const age = `${Math.round(it.ageDays)}d`;
    const why = it.impact.reasons.length ? `\n   why: ${it.impact.reasons.join('; ')}` : '';
    return `${i + 1}. **${it.id}** — ${truncate(it.title, TITLE_MAX)} _[${sev} · ${age} · impact ${it.impact.score}]_${why}`;
  });

  const rest = humanQueue.length - top.length;
  const body = [
    `Your review queue, ordered by **blocking impact** — what is actually waiting on each item (downstream \`blocks\` edges, references, open re-captures, watchdog persistence), not just severity or age. The top card is the one thing to decide now.`,
    lines.join('\n'),
    rest > 0
      ? `…plus ${rest} more. Full ranked list: Learning tab → Improvements → "Needs review" lane (same order).`
      : `That's the whole queue. Full detail: Learning tab → Improvements → "Needs review" lane.`,
  ].join('\n\n');

  const summary =
    `Weekly review-queue digest: ${humanQueue.length} item(s) await your decision — ` +
    `top blocker: ${top[0].id} (impact ${top[0].impact.score}${top[0].impact.reasons[0] ? ` — ${top[0].impact.reasons[0]}` : ''}).`;

  return { summary, body };
}

export function staleNeedsHumanDeliveryKey(row: Pick<NeedsHumanWorkItemRow, 'feature_id' | 'state_changed_at'>): string {
  if (!row.state_changed_at || !Number.isFinite(Date.parse(row.state_changed_at))) {
    throw new Error(`work_item '${row.feature_id}' has no usable state_changed_at`);
  }
  return `needs-human-stale:${row.feature_id}:${new Date(row.state_changed_at).toISOString()}`;
}

const ANSWERED_CONVERSATION_REF_PREFIX = 'conversation:answered:';

function answeredConversationId(ref: string): string | null {
  if (!ref.startsWith(ANSWERED_CONVERSATION_REF_PREFIX)) return null;
  const id = ref.slice(ANSWERED_CONVERSATION_REF_PREFIX.length);
  return id.length > 0 ? id : null;
}

function conversationIdsReferencedByStaleRows(rows: readonly NeedsHumanWorkItemRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const blocker of activeExternalBlockers(row.payload)) {
      if (blocker.kind !== 'human') continue;
      const id = answeredConversationId(blocker.ref);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Suppress reminders whose active owner ask points at a resolved conversation.
 * This only edits a reminder-local payload copy; persisted blockers and the
 * work-item needs-human gate remain unchanged. A separate active structured
 * owner ask keeps the row in the reminder batch.
 */
export function filterResolvedConversationAsks(
  rows: readonly NeedsHumanWorkItemRow[],
  resolvedConversationIds: ReadonlySet<string>,
): NeedsHumanWorkItemRow[] {
  if (resolvedConversationIds.size === 0) return [...rows];

  return rows.flatMap((row) => {
    if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) return [row];
    const payload = row.payload as Record<string, unknown>;
    if (!Array.isArray(payload.externalBlockers)) return [row];

    const refsToClear = new Set<string>();
    for (const blocker of activeExternalBlockers(row.payload)) {
      const id = blocker.kind === 'human' ? answeredConversationId(blocker.ref) : null;
      if (id && resolvedConversationIds.has(id)) refsToClear.add(blocker.ref);
    }
    if (refsToClear.size === 0) return [row];

    const externalBlockers = payload.externalBlockers.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const blocker = value as Record<string, unknown>;
      return blocker.kind === 'human' &&
        blocker.status === 'active' &&
        typeof blocker.ref === 'string' &&
        refsToClear.has(blocker.ref)
        ? { ...blocker, status: 'cleared' }
        : value;
    });
    const reminderRow = { ...row, payload: { ...payload, externalBlockers } };
    return readStructuredOwnerAsk(reminderRow.payload) ? [reminderRow] : [];
  });
}

/** Render the durable ask, not a generic "something is stale" nag. */
export function composeStaleNeedsHumanReminder(
  row: NeedsHumanWorkItemRow,
  nowMs = Date.now(),
): { title: string; summary: string; body: string; askedBy: string; deliveryKey: string } {
  const deliveryKey = staleNeedsHumanDeliveryKey(row);
  const ask = readStructuredOwnerAsk(row.payload);
  const askedBy = ask?.askedBy ?? row.taken_by?.trim() ?? 'unknown agent';
  const question = ask?.question ?? row.summary?.trim() ?? row.title?.trim() ?? row.feature_id;
  const changedAt = new Date(row.state_changed_at!).toISOString();
  const ageDays = Math.max(0, Math.floor((nowMs - Date.parse(changedAt)) / DAY_MS));
  const title = `Needs-human reminder: ${row.feature_id}`;
  const summary = `${row.feature_id} has waited ${ageDays}d in needs-human — asked by ${askedBy}.`;
  const body = [
    `**${row.feature_id}** — ${row.title?.trim() || 'Untitled work item'}`,
    `Question: ${question}`,
    `Asked by: ${askedBy}`,
    `Waiting since: ${changedAt}`,
    ...(ask ? [`Unblocked by: ${ask.unblockedBy}`, `Owner capability: ${ask.askedOf}`] : []),
    // Owner-attention ledger (EI-23783029010995961): state what happens if this
    // reminder is ignored, so silence is a disclosed outcome, not a hidden one.
    ownerAskDefaultDisclosure(row.payload),
    row.harness_slug ? `Harness: ${row.harness_slug}` : null,
  ].filter((line): line is string => Boolean(line));
  return { title, summary, body: body.join('\n'), askedBy, deliveryKey };
}

async function deliverStaleNeedsHumanReminder(ctx: SystemActionCtx, row: NeedsHumanWorkItemRow): Promise<void> {
  const reminder = composeStaleNeedsHumanReminder(row);
  const msgId = ownerNotificationMessageId(ctx.workspaceId, reminder.deliveryKey);

  // Persistent human inbox. The deterministic msg id is the replay guard on
  // this rail; pre-reading avoids turning an expected replay into a warning.
  try {
    if (!(await getMessageById(msgId))) {
      await sendMessage(HUMAN_DIGEST_IDENTITY, {
        to: ['human'],
        msgId,
        summary: reminder.summary,
        body: reminder.body,
        expectsReply: false,
        harnessSlug: row.harness_slug ?? undefined,
        extra: {
          ownerNotification: true,
          deliveryKey: reminder.deliveryKey,
          workItemId: row.feature_id,
          stateChangedAt: row.state_changed_at,
          askedBy: reminder.askedBy,
        },
      });
    }
  } catch (e) {
    console.warn(
      `[human-queue-digest] ${row.feature_id} stale-needs-human inbox send failed:`,
      e instanceof Error ? e.message : e,
    );
  }

  // Mobile/desktop attention rail has its own durable per-channel claims. A
  // failure above must never suppress this independent delivery attempt.
  try {
    await notifyAttentionOnce({
      workspaceId: ctx.workspaceId,
      harnessSlug: row.harness_slug ?? undefined,
      kind: 'needs-human',
      title: reminder.title,
      body: reminder.summary,
      importance: 'high',
      dedupeKey: reminder.deliveryKey,
      data: {
        workItemId: row.feature_id,
        stateChangedAt: row.state_changed_at,
        askedBy: reminder.askedBy,
      },
    });
  } catch (e) {
    console.warn(
      `[human-queue-digest] ${row.feature_id} stale-needs-human attention notify failed:`,
      e instanceof Error ? e.message : e,
    );
  }
}

registerSystemAction('improvement-human-digest', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const topN =
    Number.isFinite(Number(cfg.top_n)) && Number(cfg.top_n) > 0 ? Number(cfg.top_n) : DEFAULT_TOP_N;
  const staleDays =
    Number.isFinite(Number(cfg.needs_human_stale_days)) && Number(cfg.needs_human_stale_days) > 0
      ? Number(cfg.needs_human_stale_days)
      : DEFAULT_NEEDS_HUMAN_STALE_DAYS;

  const items = await readImprovementItems({ state: 'open' });
  // The OWNER FULL-AUTONOMY grant (Phase 2): the weekly human-queue digest must not list a
  // protected-surface kind=bug as "awaiting your decision" while the loop auto-implements it.
  const ownerFullAutonomy = await readOwnerFullAutonomyGrant(ctx.workspaceId);
  const digest = await applyHumanQueueRanking(buildDigest(items, { ownerFullAutonomy }), { candidates: items });
  const composed = composeHumanQueueDigest(digest.humanQueue, { topN });
  if (!composed) {
    console.log('[human-queue-digest] improvement human queue empty');
  } else {
    // Persistent inbox rail — the digest the owner can read later.
    try {
      await sendMessage(HUMAN_DIGEST_IDENTITY, { to: ['human'], summary: composed.summary, body: composed.body });
    } catch (e) {
      console.warn('[human-queue-digest] inbox send failed:', e instanceof Error ? e.message : e);
    }

    // Attention rail — desktop-native + mobile push, so the weekly ritual is seen.
    try {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention({
        kind: 'needs-human',
        title: 'Weekly review-queue digest',
        body: composed.summary,
        importance: 'normal',
        workspaceId: ctx.workspaceId,
        data: { queue: digest.humanQueue.length, top: digest.humanQueue[0]?.id ?? null },
      });
    } catch (e) {
      console.warn('[human-queue-digest] attention notify failed:', e instanceof Error ? e.message : e);
    }

    console.log(`[human-queue-digest] ${composed.summary}`);
  }

  // EI-13766 requirement 3: this leg is deliberately independent of whether
  // the improvement review queue above was empty. Metadata writes cannot make
  // an old owner ask look young because the source ages on state_changed_at.
  const stateChangedBefore = new Date(Date.now() - staleDays * DAY_MS);
  const staleRows = await readNeedsHumanWorkItems({
    workspaceId: ctx.workspaceId,
    stateChangedBefore,
    oldestFirst: true,
    limit: NEEDS_HUMAN_LIMIT,
  });
  let reminderRows = staleRows;
  const conversationIds = conversationIdsReferencedByStaleRows(staleRows);
  if (conversationIds.length > 0) {
    try {
      const states = await getConversationStatesByIds(conversationIds, ctx.workspaceId);
      const resolvedIds = new Set(states.filter((state) => state.state === 'resolved').map((state) => state.id));
      reminderRows = filterResolvedConversationAsks(staleRows, resolvedIds);
    } catch (e) {
      console.warn(
        '[human-queue-digest] conversation lifecycle lookup failed; stale reminders kept:',
        e instanceof Error ? e.message : e,
      );
    }
  }
  for (const row of reminderRows) {
    try {
      await deliverStaleNeedsHumanReminder(ctx, row);
    } catch (e) {
      // One malformed federated/legacy row never suppresses reminders for the
      // rest of the weekly batch.
      console.warn(
        `[human-queue-digest] ${row.feature_id} stale-needs-human reminder skipped:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  console.log(`[human-queue-digest] stale needs-human reminders considered: ${reminderRows.length}`);
});
