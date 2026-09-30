/**
 * useInboxAttention / useInboxPendingCount — the Inbox pane's data feed
 * (EI-13037, owner ask 2026-07-16: a first-class human inbox in the GUI;
 * moved into the op-chat sidebar per the owner's placement correction —
 * the far-left sidebar is the "live running stuff" surface).
 *
 * REUSE, not re-derivation: this is the SAME `plans.attention` sync feed the
 * /adv Create→Queue renders (usePlanAttention — normalized groups, SSE-
 * invalidated), flattened to items. `effectiveTier` mirrors AdvOverviewTab's
 * selectDecisions/countAlerts wire-lag fallback (Brief 21: rows from a
 * pre-tier server arrive without `tier`) — kept in ONE place that the header
 * badge AND the pane's filter both read, so the badge can never disagree with
 * the pane's "Needs you" list.
 *
 * The badge is a LIVE COUNT of decision-tier items, not an unread-since-last-
 * seen marker: attention items are stateful (they leave the feed when
 * resolved/acked/answered), so the correct badge is derived directly from the
 * live feed — no last-seen bookkeeping to drift (owner design principle
 * 2026-07-11: make the primary value right the first time instead of layering
 * a reconciliation pass on a value that can go stale).
 */
import { useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import {
  usePlanAttention,
  flattenAttentionItems,
  type AttentionItem,
  type AttentionTier,
} from '@/app/admin/plans/plans-api';

/** Canonical tier read with the Brief 21 wire-lag fallback (mirrors
 *  AdvOverviewTab's selectDecisions/countAlerts — keep the three in sync). */
export function effectiveTier(i: AttentionItem): AttentionTier {
  if (i.tier) return i.tier;
  if (i.needsHuman) return 'decision';
  if (i.kind === 'smoke-fail' || i.kind === 'coord-escalation') return 'alert';
  return 'activity';
}

/**
 * Recency window (days) beyond which a stale ACTIVITY-tier inbox item (a
 * lifecycle/broadcast FYI, an ungraded rollup) is dropped from the human Inbox.
 * Decisions and Alerts are current-state and never expire on age.
 */
export const INBOX_STALE_DAYS = 14;

/**
 * The Inbox "truly currently active" scope predicate
 * (inbox-pane-active-scope-dates-filters-2026-07-19 P-101). The shared
 * `plans.attention` feed is the WHOLE attention firehose (~15 sources incl. every
 * non-terminal plan item across every plan) — correct for the /adv Queue, wrong
 * for a HUMAN inbox, where it renders hundreds of backlog rows that are not
 * awaiting the owner. This narrows the feed to what genuinely belongs in an inbox:
 *   - DROP the plan-item execution backlog (todo/wip/blocked plan items) — those
 *     belong in the Queue/Working tab. A needs-human plan DECISION always stays.
 *   - KEEP every Decision and Alert (owner-addressed asks + current-state signals
 *     like blocked/needs-human work-items, escalations, smoke-fails) regardless of
 *     age — a decision doesn't expire, and blocked-work drill-ins depend on it.
 *   - RECENCY-BOUND only the Activity tier (auto/lifecycle broadcasts, old FYIs,
 *     the scout-grade rollup): drop it once older than INBOX_STALE_DAYS. An item
 *     with no `occurredAt` is kept (staleness can't be proven).
 */
export function isInboxActive(i: AttentionItem, now: number = Date.now()): boolean {
  const tier = effectiveTier(i);
  // Plan-item execution backlog → the Queue, not the Inbox (a needs-human
  // plan-item is tier 'decision' and is kept by the next clause).
  if (i.kind === 'plan-item' && tier !== 'decision') return false;
  // Decisions + Alerts are current-state — always kept.
  if (tier !== 'activity') return true;
  // Activity tier: recency-bound the append-heavy broadcast/FYI stream.
  const at = i.occurredAt ? new Date(i.occurredAt).getTime() : null;
  if (at != null && Number.isFinite(at) && (now - at) / 86_400_000 > INBOX_STALE_DAYS) {
    return false;
  }
  return true;
}

/** Apply {@link isInboxActive} to a feed — the Inbox pane's scoped item set. */
export function scopeInboxItems(
  items: readonly AttentionItem[],
  now: number = Date.now(),
): AttentionItem[] {
  return items.filter((i) => isInboxActive(i, now));
}

export interface InboxAttention {
  items: AttentionItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** The complete server-side attention count, independent of the loaded page. */
  totalItemCount: number;
  /** True when the bounded feed has another page available. */
  hasMore: boolean;
  /** True while the next attention page is in flight. */
  loadingMore: boolean;
  /** Request the next bounded page. */
  loadMore: () => void;
}

/** The flattened attention feed (every kind, every tier). One shared sync
 *  cache entry with the Queue/Overview — mounting this adds no new query. */
/**
 * @param ownerAgentId WI-2144754 — narrow the feed to the items owed by ONE
 * agent, filtered server-side before the page is cut. The session popup needs
 * this: it renders "what does THIS session's agent need the human for", and a
 * client-side filter over page one of the fleet-wide feed answered that
 * question only by luck (at 145 open agent decision-escalations against a
 * 100-item page, ~a third of asks could never appear in their own popup).
 * Omit for the whole feed, which is what the Inbox pane wants.
 */
export function useInboxAttention(enabled = true, ownerAgentId?: string | null): InboxAttention {
  const q = usePlanAttention({ enabled, ownerAgentId: ownerAgentId ?? null });
  const groups = q.data?.groups;
  // Dedupe by id via the shared helper (WI-5337 fix, centralized in
  // plans-api.ts so every consumer — this pane, badge, plans-needing-you,
  // AdvOverviewTab's tiles — gets it for free; see flattenAttentionItems'
  // own doc for why a bare flatMap re-duplicates non-plan-scoped items).
  const items = useMemo(() => flattenAttentionItems(groups ?? []), [groups]);
  return {
    items,
    loading: q.loading,
    error: q.error,
    refresh: q.refresh,
    totalItemCount: q.totalItemCount,
    hasMore: q.hasMore,
    loadingMore: q.loadingMore,
    loadMore: q.loadMore,
  };
}

/**
 * The badge aggregate — `plans.attentionCounts` (WI-5955).
 *
 * Both badges below are mounted on EVERY app start, and both used to derive
 * their integer by pulling the whole unscoped `plans.attention` feed (~1MB
 * after the P-003 projection) into the client. They now read a ~100-byte
 * aggregate instead; the feed itself is fetched only by surfaces that actually
 * render items (InboxPane, SessionChatModal, the Overview tiles).
 *
 * The counts are derived SERVER-side from the same grouped feed, with the same
 * dedupe-by-id and the same `effectiveTier` fallback used here — see
 * packages/operator-core/lib/sync-resolver/attention-counts.ts, and
 * attention-counts-parity.test.ts which pins the two derivations together so
 * the badge can never disagree with the list the user then opens.
 */
interface AttentionCountsRow {
  decisionItems: number;
  decisionPlans: number;
  alerts: number;
  total: number;
  /**
   * TRUE when the server's 8s deadline fired and these counts are its graceful
   * EMPTY fallback rather than a real answer (WI-39779).
   *
   * Read it before believing a zero. The badges below render a zero by showing
   * nothing at all, so without this bit a timed-out read is presented to the
   * user as a confident "nothing needs you" — the one reading that is never
   * safe to guess.
   */
  degraded?: boolean;
}

/** Stable identity — a fresh {} each render would churn the sync query key. */
const NO_ARGS: Record<string, unknown> = {};

interface AttentionCounts {
  decisionItems: number;
  decisionPlans: number;
  alerts: number;
  total: number;
  /** The counts are the server's deadline fallback, not a real answer. */
  degraded: boolean;
}

function useAttentionCounts(): AttentionCounts {
  const q = useSyncQuery<AttentionCountsRow>({ queryName: 'plans.attentionCounts', args: NO_ARGS });
  const row = q.data?.[0];
  return {
    decisionItems: row?.decisionItems ?? 0,
    decisionPlans: row?.decisionPlans ?? 0,
    alerts: row?.alerts ?? 0,
    total: row?.total ?? 0,
    // A row that has not arrived yet is NOT "degraded" — that is `q.loading`,
    // a state the badge already handles by rendering nothing while it waits.
    // Degraded means the server answered and told us its answer is empty-by-
    // timeout. Defaulting to false keeps a pre-WI-39779 server (no field on the
    // row) reading exactly as it does today rather than flipping every badge
    // into the unknown state.
    degraded: row?.degraded === true,
  };
}

/** Live count of decision-tier ("needs you") items — drives the header badge. */
export function useInboxPendingCount(): number {
  return useAttentionCounts().decisionItems;
}

/** Live count of distinct PLANS with ≥1 decision-tier ("needs you") item —
 *  drives the Plans-face badge (owner-plans-single-pane-2026-07-17 P-001). This
 *  differs from useInboxPendingCount (which counts ITEMS): the Plans tab answers
 *  "how many plans need me", not "how many decisions are open". Shares the one
 *  counts query, so mounting both adds no second request. */
export function usePlansNeedingYouCount(): number {
  return useAttentionCounts().decisionPlans;
}

/**
 * TRUE when the counts above are the server's deadline fallback (WI-39779).
 *
 * Kept as its own hook rather than widening the two count hooks' return type:
 * every existing caller wants the number and nothing else, and a badge that
 * cares about honesty is the rare one. Shares the single counts query, so
 * calling it beside a count hook adds no request.
 *
 * A consumer that ignores this renders exactly what it rendered before — the
 * bit discloses, it does not force. What it must NOT do is present the zero as
 * fact; see OperatorChatSidebar for the intended treatment.
 */
export function useAttentionCountsDegraded(): boolean {
  return useAttentionCounts().degraded;
}
