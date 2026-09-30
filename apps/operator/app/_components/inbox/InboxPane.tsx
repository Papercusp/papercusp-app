"use client";

/**
 * InboxPane (EI-13037, owner ask 2026-07-16 + placement correction) — the
 * owner's HUMAN INBOX as the op-chat sidebar's third view (`?opcv=inbox`),
 * beside the Papercup chat: everything addressed to YOU — coord messages
 * (`coord:send { to: ['human'] }`), escalations, standing approvals, agent
 * questions, operator reports — with the actions to answer them inline.
 *
 * inbox-pane-active-scope-dates-filters-2026-07-19 (owner ask 2026-07-19):
 *   - SCOPE (P-101): the shared `plans.attention` feed is the whole attention
 *     firehose (~15 sources incl. every non-terminal plan item across every
 *     plan) — correct for the /adv Queue, wrong for a human inbox where it
 *     rendered hundreds of backlog rows not awaiting the owner (the "328" bug).
 *     `scopeInboxItems` narrows it to genuinely-active, owner-addressed items
 *     (drops the plan-item execution backlog + recency-bounds stale activity).
 *   - DATES (P-2xx): each row shows a relative date (from `AttentionItem.occurredAt`)
 *     with an absolute-time tooltip; ties sort by recency.
 *   - FILTER/SEARCH (P-3xx): QueueFilterBar-style per-kind facet chips + counts,
 *     plus a text search over title/body/owner/plan.
 *   - SORT (WI-40982): a sort picker whose orders run over the ALREADY-FILTERED
 *     set — the tier chip, the kind facets and the search all narrow first, and
 *     the chosen order is applied last to whatever survived.
 *
 * REUSE, not re-derivation:
 *   - data: useInboxAttention → the SAME `plans.attention` sync feed the
 *     Queue + Overview render (shared cache entry, SSE-invalidated);
 *   - detail: the Queue's own exported OtherDetail — the unified
 *     AskChoiceCard + triage audit + QueueCardActions — rendered inline inside
 *     the selected row, with the full body before its actions, so acting from
 *     the sidebar IS acting in the Queue;
 *   - tier semantics: effectiveTier (mirrors AdvOverviewTab's fallback).
 *
 * "Discuss" here opens the item's durable Papercup thread INLINE (P-018 /
 * D-014): the card's discuss pick writes the scoped `?opcid` target and mounts
 * WorkItemDiscussion directly beneath the expanded item. The workspace-global
 * Papercup transcript is never seeded or selected by this path.
 *
 * Filter + selection + search + sort live in the URL (nuqs `?opci` / `?opcis` /
 * `?opcq` / `?opck` / `?opcsort`) so the pane is deep-linkable and
 * agent-driveable (ui:get_state / ui:dispatch), per the nuqs-by-default policy.
 *
 * The kind facets are ALWAYS OPEN (owner ask 2026-08-23, WI-40982). The old
 * `?opcf` disclosure and its "Kinds" toggle button are GONE: the facet chips
 * are the pane's cheapest read of what is actually waiting, and hiding them
 * behind a click bought nothing. The toolbar slot the toggle vacated now holds
 * the sort picker. A stale `?opcf=…` deep link is inert.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useQueryState,
  useQueryStates,
  parseAsString,
  parseAsStringLiteral,
} from "nuqs";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ClipboardList,
  ChevronRight,
  Inbox as InboxIcon,
  MessageCircle,
  Search,
  X,
} from "lucide-react";
import { Select } from "@/app/harness/Select";
import { Tooltip } from "@/app/harness/Tooltip";
import { OtherDetail, KIND_LABEL } from "@/app/admin/plans/PlanOtherList";
import { whyLine } from "@/app/admin/plans/queue-authorizer";
import {
  TIER_LABEL,
  type AttentionActionId,
  type AttentionItem,
  type AttentionTier,
} from "@/app/admin/plans/plans-api";
import {
  effectiveTier,
  scopeInboxItems,
  useInboxAttention,
} from "./use-inbox-pending";
import InboxBulkStrip from "./InboxBulkStrip";
import InboxBriefing from "./InboxBriefing";
import InboxBulkRecommendation from "./InboxBulkRecommendation";
import {
  INBOX_BULK_RUN_PARAM,
  canonicalInboxDisposition,
  useBulkRunOps,
  useInboxBulkRun,
  type BulkRunItem,
} from "./use-inbox-bulk-run";
import { attentionWorkItemId } from "./attention-work-item-ref";
import { useFlag } from "@/lib/flag-hooks";
import { useLexicon } from "@/lib/useLexicon";
import { FLAGS } from "@papercusp/flags";
import SessionChatModal from "../chat/SessionChatModal";
import {
  CHAT_WORK_ITEM_POPUP_PARAM,
  decodeScopedRef,
  encodeScopedRef,
} from "../chat/chat-ref-popup-params";
import WorkItemDiscussion, {
  WORK_ITEM_DISCUSSION_PARAM,
} from "../work-items/WorkItemDiscussion";
// The Queue detail card's styles (pc-items__*, pc-tier/pc-kind badges). Global
// (non-module) CSS — importing it here makes the pane self-sufficient on
// every route.
import "@/app/admin/plans/plans.css";
import "./inbox-pane.css";

const FILTERS = ["needs", "alerts", "all"] as const;
type InboxFilter = (typeof FILTERS)[number];

/** Row-badge wording for a bulk run's per-item outcomes (P-006). `pending` is
 *  deliberately absent: an item the resolver has not reached yet gets no badge,
 *  because a badge reading "pending" on every row is noise that hides the ones
 *  that actually moved. */
const BULK_OUTCOME_LABEL: Record<string, string> = {
  auto_resolved: "resolved",
  recommended: "for review",
  skipped: "skipped",
  failed: "failed",
  dismissed: "dismissed",
};

const FILTER_LABEL: Record<InboxFilter, string> = {
  needs: "Needs you",
  alerts: "Alerts",
  all: "All",
};

/** Decisions first, then alerts — the order the owner should read. */
const TIER_RANK: Record<AttentionTier, number> = {
  decision: 0,
  alert: 1,
  handled: 2,
  activity: 3,
};

/** Sort orders this pane offers (WI-40982). `priority` is the pane's original
 *  order and stays the default: tier first, newest within a tier. */
export const INBOX_SORTS = [
  { id: "priority", label: "Priority" },
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "kind", label: "Kind" },
  { id: "agent", label: "Agent" },
  { id: "title", label: "Title A–Z" },
] as const;

export type InboxSort = (typeof INBOX_SORTS)[number]["id"];

export const INBOX_SORT_IDS = INBOX_SORTS.map((s) => s.id) as InboxSort[];

export const DEFAULT_INBOX_SORT: InboxSort = "priority";

export function inboxSortLabel(sort: InboxSort): string {
  return INBOX_SORTS.find((s) => s.id === sort)?.label ?? sort;
}

/** Epoch ms for an item's timestamp, or null when it has none / an unparseable
 *  one. Null is "unknown", never "old" — see the ordering rules below. */
function occurredMs(i: AttentionItem): number | null {
  const t = i.occurredAt ? new Date(i.occurredAt).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Newest first. An undated row sorts AFTER every dated one in BOTH directions:
 *  a missing timestamp means "we don't know when", so promoting it to the top of
 *  the oldest-first list would be an invented fact. */
function byNewest(a: AttentionItem, b: AttentionItem): number {
  const at = occurredMs(a);
  const bt = occurredMs(b);
  if (at !== null && bt !== null) return bt - at;
  if (at !== bt) return at === null ? 1 : -1;
  return 0;
}

function byOldest(a: AttentionItem, b: AttentionItem): number {
  const at = occurredMs(a);
  const bt = occurredMs(b);
  if (at !== null && bt !== null) return at - bt;
  if (at !== bt) return at === null ? 1 : -1;
  return 0;
}

/** Case-insensitive text order; an EMPTY key sorts last rather than first, so a
 *  row with no agent/title never leads the list. */
function byText(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function agentKey(i: AttentionItem): string {
  return (i.ownerLabel ?? i.ownerAgentId ?? "").trim();
}

function kindKey(i: AttentionItem): string {
  return KIND_LABEL[i.kind] ?? i.kind ?? "";
}

/** Comparator for one inbox order. Pure — exported for unit tests. */
export function compareInboxItems(
  sort: InboxSort,
): (a: AttentionItem, b: AttentionItem) => number {
  switch (sort) {
    case "newest":
      return byNewest;
    case "oldest":
      return byOldest;
    case "kind":
      return (a, b) => byText(kindKey(a), kindKey(b)) || byNewest(a, b);
    case "agent":
      return (a, b) => byText(agentKey(a), agentKey(b)) || byNewest(a, b);
    case "title":
      return (a, b) => byText(a.title ?? "", b.title ?? "") || byNewest(a, b);
    case "priority":
    default:
      // The pane's original order: decisions on top, then alerts; newest within
      // a tier.
      return (a, b) =>
        TIER_RANK[effectiveTier(a)] - TIER_RANK[effectiveTier(b)] ||
        byNewest(a, b);
  }
}

/** Order a filtered item set. STABLE: ties keep the server's order via the idx
 *  decoration, so an undated backlog never reshuffles between renders. */
export function sortInboxItems(
  items: readonly AttentionItem[],
  sort: InboxSort = DEFAULT_INBOX_SORT,
): AttentionItem[] {
  const cmp = compareInboxItems(sort);
  return items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => cmp(a.item, b.item) || a.idx - b.idx)
    .map((x) => x.item);
}

/** A relative "how long ago" label from an ISO timestamp — "just now", "5m",
 *  "3h", "2d", "3w", else an absolute short date. Null timestamp → null. */
export function formatRelativeDate(
  iso: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Absolute timestamp for the date tooltip. */
function formatAbsoluteDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleString();
}

/** Lowercase haystack for the text search (title + body + owner + plan/harness). */
function searchHaystack(i: AttentionItem): string {
  return [
    i.title,
    i.body,
    i.ownerLabel,
    i.ownerAgentId,
    i.planSlug,
    i.harnessSlug,
    KIND_LABEL[i.kind] ?? i.kind,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function InboxRowIcon({ kind }: { kind: AttentionItem["kind"] }) {
  if (kind === "plan-item")
    return <ClipboardList size={17} aria-hidden="true" />;
  if (kind === "blocked-session" || kind === "conversation") {
    return <MessageCircle size={17} aria-hidden="true" />;
  }
  return <InboxIcon size={17} aria-hidden="true" />;
}

/**
 * The expanded row's detail — OtherDetail's actions plus, when `?opcid` targets
 * this row, the inline WorkItemDiscussion.
 *
 * WI-41602 gave both surfaces a focus contract for the ACTIVE close. This owns
 * the PASSIVE half (WI-41640): the same subtree is removed with no close
 * handler when the live `plans.attention` feed drops the row under the owner,
 * when `onResolved` collapses the selection from a button inside it (hand
 * resolve and bulk accept both land there), or when the virtualizer recycles a
 * scrolled-away row. Keyboard focus then falls to <body> and the owner is
 * stranded outside the pane.
 *
 * Two cleanups, deliberately:
 *  - LAYOUT records whether focus was inside. React runs layout destroys while
 *    the deleted subtree is still attached, so `contains` is still accurate.
 *  - PASSIVE performs the restore, once the DOM has settled and `isConnected`
 *    can distinguish a surviving row from one removed in the same commit.
 *
 * ReportTakeoverLayer treats `activeElement === body` as proof of a strand;
 * that is sound there because the takeover focuses ITSELF on mount. This
 * subtree never does, so body here can equally mean "the owner had focus
 * nowhere" — and this pane is a sidebar the live feed mutates unprompted, so
 * seizing focus on that reading would be worse than the bug being fixed.
 */
function InboxExpandedDetail({
  itemId,
  landmarkRef,
  children,
}: {
  itemId: string;
  landmarkRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const detailRef = useRef<HTMLDivElement | null>(null);
  const heldFocus = useRef(false);

  useLayoutEffect(() => {
    const detail = detailRef.current;
    if (!detail) return;
    return () => {
      const active = document.activeElement;
      heldFocus.current =
        active instanceof HTMLElement &&
        active !== document.body &&
        detail.contains(active);
    };
  }, []);

  useEffect(
    () => () => {
      if (!heldFocus.current) return;
      heldFocus.current = false;
      const usable = (node: HTMLElement | null | undefined) =>
        node && node.isConnected && !node.closest("[inert]") ? node : null;
      // The row survives a collapse (setSel(null)) but not a feed removal.
      const target =
        usable(document.getElementById(`inbox-row-${itemId}`)) ??
        usable(landmarkRef.current);
      target?.focus({ preventScroll: true });
    },
    [itemId, landmarkRef],
  );

  return (
    <div
      ref={detailRef}
      id={`inbox-expanded-${itemId}`}
      className="op-inbox__detail"
      data-testid={`inbox-expanded-${itemId}`}
    >
      {children}
    </div>
  );
}

/**
 * The detail pane's head — split mode only (inbox-three-column-resolver-states
 * P-008 / D-003). Measured live 2026-09-05: the aside rendered OtherDetail's
 * chips, why-line and body with NO heading, so the selected item's title
 * appeared nowhere in the pane. This follows the accepted item-open frame:
 * tier/category eyebrow, title, id-first reporter meta, then the reason this
 * item needs the owner as a pill. Missing optional segments are omitted.
 */
function InboxDetailHead({ item }: { item: AttentionItem }) {
  const t = useLexicon();
  const rel = formatRelativeDate(item.occurredAt);
  const abs = formatAbsoluteDate(item.occurredAt);
  const owner = item.ownerLabel ?? item.ownerAgentId;
  const displayId = attentionWorkItemId(item) ?? item.itemRef ?? item.id;
  const why = whyLine(item, t);
  const segments: Array<{ key: string; node: ReactNode }> = [
    { key: "id", node: displayId },
  ];
  if (owner) segments.push({ key: "owner", node: <>reported by {owner}</> });
  if (rel) {
    segments.push({
      key: "when",
      node: (
        <time dateTime={item.occurredAt} title={abs ?? undefined}>
          {rel}
        </time>
      ),
    });
  }
  return (
    <header className="op-inbox__detail-head" data-testid="inbox-detail-head">
      <p className="op-inbox__detail-eyebrow" data-testid="inbox-detail-eyebrow">
        <strong data-testid="inbox-detail-eyebrow-tier">
          {TIER_LABEL[item.tier] ?? item.tier}
        </strong>
        {item.category ? (
          <>
            <span className="op-inbox__detail-eyebrow-sep" aria-hidden="true">
              ·
            </span>
            <span data-testid="inbox-detail-eyebrow-category">{item.category}</span>
          </>
        ) : null}
      </p>
      <h2 className="op-inbox__detail-title" data-testid="inbox-detail-title">
        {item.title}
      </h2>
      <p className="op-inbox__detail-meta" data-testid="inbox-detail-meta">
        {segments.map((s, idx) => (
          <Fragment key={s.key}>
            {idx > 0 ? (
              <span className="op-inbox__detail-meta-sep" aria-hidden="true">
                ·
              </span>
            ) : null}
            <span data-testid={`inbox-detail-meta-${s.key}`}>{s.node}</span>
          </Fragment>
        ))}
      </p>
      {why ? (
        <span className="op-inbox__detail-why" data-testid="inbox-detail-why">
          <span aria-hidden="true">●</span>
          {why}
        </span>
      ) : null}
    </header>
  );
}

/**
 * The metadata rail — split mode only (P-008 / D-003). The item-open spec's
 * six context rows (state · importance · kind · harness · topic · waiting) sit
 * beside the body at full contrast instead of a strewn chip row whose tail
 * washed out at the pane's far edge. Tier stays in the eyebrow above the
 * title. OtherDetail is told `metadataPlacement="host"` so the same facts are
 * not shown twice; the chip classes ride along on the values so their colour
 * coding is unchanged.
 */
function InboxDetailRail({ item }: { item: AttentionItem }) {
  const rows: Array<{ key: string; label: string; value: ReactNode }> = [
    {
      key: "status",
      label: "State",
      value: (
        <span className={`pc-count pc-count--${item.status}`}>{item.status}</span>
      ),
    },
    {
      key: "importance",
      label: "Importance",
      value: (
        <span className={`pc-imp pc-imp--${item.importance}`}>
          {item.importance}
        </span>
      ),
    },
    {
      key: "kind",
      label: "Kind",
      value: (
        <span className={`pc-kind pc-kind--${item.kind}`}>
          {KIND_LABEL[item.kind] ?? item.kind}
        </span>
      ),
    },
  ];
  if (item.harnessSlug) {
    rows.push({
      key: "harness",
      label: "Harness",
      value: <span className="pc-pill pc-pill--harness">{item.harnessSlug}</span>,
    });
  }
  if (item.category) {
    rows.push({
      key: "topic",
      label: "Topic",
      value: (
        <span
          className={`pc-category${item.whyGated === "protected" ? " pc-category--protected" : ""}`}
          title={`autonomy category: ${item.category}`}
        >
          {item.whyGated === "protected" ? "🔒 " : ""}
          {item.category}
        </span>
      ),
    });
  }
  const occurredAt = item.occurredAt;
  const waiting = formatRelativeDate(occurredAt);
  if (waiting && occurredAt) {
    rows.push({
      key: "waiting",
      label: "Waiting",
      value: (
        <time dateTime={occurredAt} title={formatAbsoluteDate(occurredAt) ?? undefined}>
          {waiting}
        </time>
      ),
    });
  }
  return (
    <dl
      className="op-inbox__detail-rail"
      data-testid="inbox-detail-rail"
      aria-label="Item metadata"
    >
      {rows.map((r) => (
        <div
          key={r.key}
          className="op-inbox__detail-rail-row"
          data-testid={`inbox-detail-rail-${r.key}`}
        >
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * How the pane lays out its list and the selected item's detail
 * (portal-work-two-pane-2026-09-01 D-001).
 *  - `stack` — the chat-sidebar disclosure: the detail expands inline under
 *    its row. The default, and the sidebar's layout is unchanged by it.
 *  - `split` — list on the left, the selected item's detail in a right-hand
 *    aside. Used only by the operator-vite `/inbox` full-page route the cloud
 *    portal embeds. Selection is the same `?opcis` either way.
 */
export type InboxPaneLayout = "stack" | "split";

export default function InboxPane({
  layout = "stack",
}: {
  layout?: InboxPaneLayout;
} = {}) {
  const split = layout === "split";
  const {
    items,
    loading,
    error,
    refresh,
    hasMore,
    loadingMore,
    loadMore,
    totalItemCount,
  } = useInboxAttention();
  const [filter, setFilter] = useQueryState(
    "opci",
    parseAsStringLiteral(FILTERS).withDefault("needs"),
  );
  const [sel, setSel] = useQueryState("opcis", parseAsString);
  // Free-text search over the scoped feed (deep-linkable/agent-driveable).
  const [query, setQuery] = useQueryState(
    "opcq",
    parseAsString.withDefault(""),
  );
  // Selected kind facets — comma-joined kind ids (a QueueFilterBar-style
  // per-kind narrowing). Empty ⇒ all kinds.
  const [kindsParam, setKindsParam] = useQueryState(
    "opck",
    parseAsString.withDefault(""),
  );
  // Sort order over the filtered set (WI-40982).
  const [sort, setSort] = useQueryState(
    "opcsort",
    parseAsStringLiteral(INBOX_SORT_IDS).withDefault(DEFAULT_INBOX_SORT),
  );
  // The BULK RESOLVE run being shown (inbox-bulk-resolve-2026-08-23 P-006).
  // In the URL like every other pane selection, so a run is deep-linkable and
  // agent-driveable; empty ⇒ the strip reads the workspace's LATEST run, which
  // is what "is there a run I should be showing?" actually means on open.
  const [bulkRunId, setBulkRunId] = useQueryState(
    INBOX_BULK_RUN_PARAM,
    parseAsString,
  );
  // The "chat-grade session context" popup (P-007): which agent's live session
  // to show, keyed by ownerAgentId.
  const [chatOwner, setChatOwner] = useQueryState("opcsession", parseAsString);
  const [, setOpenWorkItem] = useQueryState(
    CHAT_WORK_ITEM_POPUP_PARAM,
    parseAsString,
  );
  const [discussionRef, setDiscussionRef] = useQueryState(
    WORK_ITEM_DISCUSSION_PARAM,
    parseAsString,
  );
  const discussionTarget = useMemo(
    () => decodeScopedRef(discussionRef),
    [discussionRef],
  );
  // The Queue lives on /adv (?tab=plans&view=queue) — MERGE-write the params
  // when already there; hard-navigate otherwise (this sidebar is global).
  const [, setQueueParams] = useQueryStates({
    tab: parseAsString,
    view: parseAsString,
  });
  const openQueue = useCallback(() => {
    if (window.location.pathname.startsWith("/adv")) {
      void setQueueParams({ tab: "plans", view: "queue" });
    } else {
      window.location.assign("/adv?tab=plans&view=queue");
    }
  }, [setQueueParams]);

  const onDiscuss = useCallback(
    (i: AttentionItem) => {
      const workItemId = attentionWorkItemId(i);
      if (!workItemId || !i.harnessSlug) return false;
      void setDiscussionRef(encodeScopedRef(i.harnessSlug, workItemId));
      return true; // handled — suppress the Queue's legacy DiscussPanel
    },
    [setDiscussionRef],
  );

  const onResolved = useCallback(() => {
    // A resolved row is about to leave the live feed. Return the narrow layout
    // to its list rather than stranding it on a stale detail, then invalidate
    // the shared attention cache for every host.
    void setSel(null);
    refresh();
  }, [refresh, setSel]);

  const onNavigate = useCallback(
    (i: AttentionItem, actionId: AttentionActionId) => {
      if (
        (actionId === "message-owner" || actionId === "chat") &&
        i.ownerAgentId
      ) {
        void setChatOwner(i.ownerAgentId);
        return true;
      }
      if (actionId === "open") {
        const workItemId = attentionWorkItemId(i);
        if (workItemId && i.harnessSlug) {
          void setOpenWorkItem(encodeScopedRef(i.harnessSlug, workItemId));
          return true;
        }
        openQueue();
        return true;
      }
      if (actionId === "view-log") {
        // The Queue owns the source-specific smoke/log drill-ins. This is an
        // honest navigation, not the previous toast-only pseudo-action.
        openQueue();
        return true;
      }
      return false;
    },
    [openQueue, setChatOwner, setOpenWorkItem],
  );

  // P-101: narrow the shared attention firehose to genuinely-active, owner-
  // addressed items BEFORE anything else reads it — so the chip counts, the
  // kind facets, and the list all agree and never show the backlog again.
  const scoped = useMemo(() => scopeInboxItems(items), [items]);

  const selectedKinds = useMemo(
    () =>
      new Set(
        kindsParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    [kindsParam],
  );
  const q = query.trim().toLowerCase();

  const toggleKind = useCallback(
    (kind: string) => {
      const next = new Set(selectedKinds);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      void setKindsParam([...next].join(","));
    },
    [selectedKinds, setKindsParam],
  );

  // Tier-chip counts (Needs / Alerts / All) over the SCOPED set.
  const counts = useMemo(() => {
    const c: Record<InboxFilter, number> = {
      needs: 0,
      alerts: 0,
      all: scoped.length,
    };
    for (const i of scoped) {
      const tier = effectiveTier(i);
      if (tier === "decision") c.needs += 1;
      else if (tier === "alert") c.alerts += 1;
    }
    return c;
  }, [scoped]);

  // Kind facets present in the scoped set (id + label + count) — data-driven so
  // every emitted kind (incl. the P-005 owner-gate kinds absent from the client
  // union) shows a chip, in tier-then-count order.
  const kindFacets = useMemo(() => {
    const byKind = new Map<string, number>();
    for (const i of scoped) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
    return [...byKind.entries()]
      .map(([id, count]) => ({
        id,
        count,
        label: KIND_LABEL[id as AttentionItem["kind"]] ?? id,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [scoped]);

  // Best-effort friendly label for the SessionChatModal title.
  const chatOwnerLabel = useMemo(
    () => scoped.find((i) => i.ownerAgentId === chatOwner)?.ownerLabel ?? null,
    [scoped, chatOwner],
  );

  const lastScrolledSel = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const masterRef = useRef<HTMLElement | null>(null);
  // Split mode's detail column — the focus landmark InboxExpandedDetail falls
  // back to when the aside's subtree is passively removed (at narrow widths the
  // list column is display:none while an item is selected, so the master
  // section is not a safe target there).
  const asideRef = useRef<HTMLElement | null>(null);

  // Resolve selection against the SCOPED feed, not the filtered list. The
  // selected row is admitted below even when a deep link's tier/kind/search
  // filter would otherwise hide it, so inspection remains inline without
  // silently clearing the owner's current filters.
  const selectedItem = useMemo(
    () => scoped.find((item) => item.id === sel) ?? null,
    [scoped, sel],
  );

  const visible = useMemo(() => {
    const filtered = scoped.filter((i) => {
      const tier = effectiveTier(i);
      if (filter === "needs" && tier !== "decision") return false;
      if (filter === "alerts" && tier !== "alert") return false;
      if (selectedKinds.size > 0 && !selectedKinds.has(i.kind)) return false;
      if (q && !searchHaystack(i).includes(q)) return false;
      return true;
    });
    // Sort runs LAST, over the already-filtered set (WI-40982), so changing the
    // order can never re-admit a row the tier/kind/search filters excluded.
    const ordered = sortInboxItems(filtered, sort);
    if (selectedItem && !ordered.some((item) => item.id === selectedItem.id)) {
      return [selectedItem, ...ordered];
    }
    return ordered;
  }, [scoped, filter, selectedKinds, q, selectedItem, sort]);

  /* ── BULK RESOLVE (inbox-bulk-resolve-2026-08-23, P-006) ─────────────────
     The strip and the per-row recommendations read the SAME run: one sync
     subscription here, passed down, so the band and the rows can never disagree
     about a run's phase. Flag-gated as a unit — OFF makes the pane render
     exactly what it rendered before this existed.

     Declared after `visible` because the strip acts on the pane's CURRENT
     filtered set, which is what `visible` is. */
  const bulkEnabled = useFlag(FLAGS.INBOX_BULK_RESOLVE);
  const bulk = useInboxBulkRun(bulkRunId, { enabled: bulkEnabled });
  const { acceptRecommendation } = useBulkRunOps();
  const [acceptingCount, setAcceptingCount] = useState(0);

  // Provenance for the record — what the pane SAID it was showing when the owner
  // clicked. Never the source of the run's membership (the posted ids are), so a
  // filter that has moved since cannot silently change which items get acted on.
  const bulkFilterSnapshot = useMemo(
    () => ({
      tier: filter,
      kinds: [...selectedKinds],
      query: query.trim() || null,
      shownCount: visible.length,
    }),
    [filter, selectedKinds, query, visible.length],
  );

  const acceptOneRecommendation = useCallback(
    // `draftOverride` is the owner's EDIT of the drafted reply. It replaces the
    // resolver's text for this accept, so "Edit then Accept" delivers what they
    // actually wrote — a draft the owner corrected and that was then sent
    // unedited would be the worst possible outcome of offering the edit at all.
    async (
      item: AttentionItem,
      rec: BulkRunItem,
      draftOverride?: string | null,
    ) => {
      if (!bulk.run) return { ok: false, error: "no active run" };
      setAcceptingCount((n) => n + 1);
      try {
        const effective =
          draftOverride === undefined
            ? rec
            : { ...rec, draftAnswer: draftOverride };
        const res = await acceptRecommendation(bulk.run.runId, item, effective);
        // A resolved row is about to leave the live feed — the same cleanup a
        // hand resolve does, through the same callback.
        if (res.ok) onResolved();
        return res;
      } finally {
        setAcceptingCount((n) => Math.max(0, n - 1));
      }
    },
    [bulk.run, acceptRecommendation, onResolved],
  );

  // Virtualize the row list (WI-5339): even scoped, the inbox can hold many rows.
  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (i) => visible[i]?.id ?? i,
    // ResizeObserver callbacks can synchronously trigger another measurement
    // while an expanded inbox row is settling. TanStack's animation-frame
    // path keeps that feedback out of the browser's resize notification phase.
    useAnimationFrameWithResizeObserver: true,
  });

  // owner-inbox D-012: expanding/collapsing a disclosure must preserve the
  // list's scroll position. ReactVirtualizerOptions does not expose this core
  // switch, but the returned Virtualizer's public typed property does.
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);

  // Scroll a freshly deep-linked selection (opcis) into view.
  useEffect(() => {
    if (!sel) {
      lastScrolledSel.current = null;
      return;
    }
    if (sel === lastScrolledSel.current) return;
    const idx = visible.findIndex((i) => i.id === sel);
    if (idx >= 0) {
      rowVirtualizer.scrollToIndex(idx, { align: "center" });
      lastScrolledSel.current = sel;
    }
  }, [sel, visible, rowVirtualizer]);

  // The selected row's detail — OtherDetail plus the `?opcid` discussion. In
  // stack mode it renders inline under its row (the sidebar disclosure); in
  // split mode the SAME subtree renders once in the aside, so the row's
  // `aria-controls` keeps resolving to `inbox-expanded-<id>` wherever it lives.
  const renderExpandedDetail = (i: AttentionItem) => {
    const discussion = (() => {
      const workItemId = attentionWorkItemId(i);
      const harnessMatches =
        !discussionTarget.harness ||
        discussionTarget.harness === i.harnessSlug;
      if (
        !workItemId ||
        !i.harnessSlug ||
        discussionTarget.id !== workItemId ||
        !harnessMatches
      ) {
        return null;
      }
      return (
        <WorkItemDiscussion
          harnessSlug={i.harnessSlug}
          workItemId={workItemId}
          title={i.title}
          onClose={() => {
            // The discussion's focused Close button is about to unmount.
            // Return to a surviving element before clearing the URL so focus
            // never falls to <body> (including report-originated handoffs):
            // the selected row in stack mode; in split mode the aside, which
            // keeps hosting the item's detail (and the row may be hidden at
            // narrow widths).
            const row = document.getElementById(`inbox-row-${i.id}`);
            (split ? (asideRef.current ?? row) : row)?.focus({
              preventScroll: true,
            });
            void setDiscussionRef(null);
          }}
          focusWhenInteractive
        />
      );
    })();
    // Split (P-008 / D-003): title + meta line lead, the card's body sits at a
    // ~58ch measure with its six chips re-homed as the labelled rail beside
    // it, and the discussion spans beneath both (grid areas in inbox-pane.css
    // under `.op-inbox__aside`). Stack is the unchanged sidebar disclosure.
    return (
      <InboxExpandedDetail
        itemId={i.id}
        landmarkRef={split ? asideRef : masterRef}
      >
        {split ? <InboxDetailHead item={i} /> : null}
        <OtherDetail
          key={i.id}
          item={i}
          actionsPlacement="after-body"
          metadataPlacement={split ? "host" : "toolbar"}
          whyPlacement={split ? "host" : "card"}
          bodyPresentation={split ? "item-open" : "plain"}
          onResolved={onResolved}
          onDiscuss={onDiscuss}
          onNavigate={onNavigate}
        />
        {split ? <InboxDetailRail item={i} /> : null}
        {split && discussion ? (
          <div className="op-inbox__detail-discussion">{discussion}</div>
        ) : (
          discussion
        )}
      </InboxExpandedDetail>
    );
  };

  // Tier scopes + kind facets are ONE element tree rendered in ONE of two
  // places (inbox-three-column-resolver-states-2026-09-06 P-002, D-001): inside
  // the controls block in stack mode — the ~360px chat sidebar has nowhere else
  // to put them, and its box tree stays byte-identical — or in the rail column
  // in split mode. Same class names, test ids and handlers either way.
  const tierScopes = (
    <div className="op-inbox__chips" aria-label="Inbox filter">
      {FILTERS.map((f) => (
        <button
          key={f}
          type="button"
          className={`op-inbox__chip${filter === f ? " is-active" : ""}`}
          aria-pressed={filter === f}
          data-testid={`inbox-filter-${f}`}
          onClick={() => void setFilter(f)}
        >
          {FILTER_LABEL[f]}
          <span className="op-inbox__chip-count">{counts[f]}</span>
        </button>
      ))}
    </div>
  );
  // Always open (WI-40982) — no disclosure, no toggle. Still conditional on
  // HAVING facets: an empty scoped feed has no kinds to chip.
  const kindFacetChips =
    kindFacets.length > 0 ? (
      <div className="op-inbox__facets" aria-label="Filter by kind">
        {selectedKinds.size > 0 ? (
          <button
            type="button"
            className="op-inbox__facet op-inbox__facet--clear"
            onClick={() => void setKindsParam("")}
            data-testid="inbox-facet-clear"
          >
            Clear kinds
          </button>
        ) : null}
        {kindFacets.map((k) => {
          const active = selectedKinds.has(k.id);
          return (
            <button
              key={k.id}
              type="button"
              className={`op-inbox__facet${active ? " is-active" : ""}`}
              aria-pressed={active}
              data-testid={`inbox-facet-${k.id}`}
              onClick={() => toggleKind(k.id)}
            >
              <span className="op-inbox__facet-label">{k.label}</span>
              <span className="op-inbox__facet-count">{k.count}</span>
            </button>
          );
        })}
      </div>
    ) : null;
  // BULK RESOLVE (D-002: same ops, same persisted run — only WHERE it renders
  // changes). Stack: the command strip between masthead and controls. Split:
  // the compact card at the foot of the rail (P-003). Never both.
  const bulkStripProps = bulkEnabled
    ? {
        visible,
        filterSnapshot: bulkFilterSnapshot,
        run: bulk.run,
        items: bulk.items,
        recommendations: bulk.recommendations,
        unreached: bulk.unreached,
        isRunning: bulk.isRunning,
        isReview: bulk.isReview,
        onRunStarted: (runId: string) => void setBulkRunId(runId),
        onReview: (runId: string) => void setBulkRunId(runId),
      }
    : null;
  // The "N need you" count — the stack masthead's badge, and the rail head's.
  const needsCount = (
    <span
      className="op-inbox__masthead-count"
      aria-label={`${counts.needs} ${counts.needs === 1 ? "item needs" : "items need"} you`}
      data-testid="inbox-masthead-count"
    >
      <span className="op-inbox__masthead-count-value">{counts.needs}</span>
      <span className="op-inbox__masthead-count-label">need you</span>
    </span>
  );

  // P-004 (inbox-three-column-resolver-states-2026-09-06): the load-more
  // window strip and the foot are list-column chrome in STACK only. In split
  // they render inside the aside's unselected state — the briefing P-005
  // grows — with the same class names, test ids and handlers, so beneath the
  // rows the column carries nothing rigid: the rows' floor is the column's.
  const windowStrip =
    hasMore || loadingMore ? (
      <div
        className="op-inbox__window"
        role="status"
        data-testid="inbox-attention-window"
      >
        <span>
          Showing {items.length} of {totalItemCount} attention items. Load more to include
          older activity.
        </span>
        {loadMore ? (
          <button
            type="button"
            className="op-inbox__window-button"
            onClick={loadMore}
            disabled={loadingMore}
            data-testid="inbox-load-more"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    ) : null;
  const foot = (
    <div className="op-inbox__foot">
      <span>{visible.length} shown</span>
      <button
        type="button"
        className="op-inbox__queue-link"
        data-testid="inbox-open-queue"
        onClick={openQueue}
      >
        Open full queue →
      </button>
    </div>
  );

  // `data-has-selection` is presence-only: the narrow-width split CSS swaps
  // which column is shown on it (list without a selection, detail with one).
  // The `op-inbox__column` wrapper is display:contents in stack mode, so the
  // sidebar's box tree is unchanged; in split mode it is the list column, and
  // the rail (split only) is the grid column before it.
  return (
    <div
      className={`op-inbox${split ? " op-inbox--split" : ""}`}
      data-testid="inbox-tab"
      data-layout={layout}
      data-has-selection={split && selectedItem ? "" : undefined}
    >
      {split ? (
        /* COLUMN 1 — the rail (P-002). What used to stack in the list's own
           column and starve it of height: the masthead collapsed to
           `Inbox` + count, the tier scopes, the kind facets. Search + sort stay
           with the list; the bulk card joins the rail in P-003. */
        <nav
          className="op-inbox__rail"
          data-testid="inbox-rail"
          aria-label="Inbox scopes and filters"
        >
          <header className="op-inbox__rail-head">
            <span className="op-inbox__rail-icon" aria-hidden="true">
              <InboxIcon size={14} />
            </span>
            <strong className="op-inbox__rail-title">Inbox</strong>
            {needsCount}
          </header>
          {tierScopes}
          {kindFacetChips ? (
            <>
              <p className="op-inbox__rail-label" aria-hidden="true">
                Kinds
              </p>
              {kindFacetChips}
            </>
          ) : null}
          {bulkStripProps ? (
            <div className="op-inbox__rail-bulk" data-testid="inbox-rail-bulk">
              <InboxBulkStrip {...bulkStripProps} variant="card" />
            </div>
          ) : null}
        </nav>
      ) : null}
      <div className="op-inbox__column">
      {/* tabIndex -1 (never tab-reachable): the stable landmark
          InboxExpandedDetail returns keyboard focus to when a passively removed
          row leaves no surviving row button. The pane styles focus rings with
          :focus-visible, so a programmatic focus paints nothing. */}
      <section
        ref={masterRef}
        tabIndex={-1}
        className="op-inbox__master"
        data-testid="inbox-master"
        aria-label="Resolution inbox items"
      >
        {/* Stack only: in split the masthead collapses to the rail head
            (`Inbox` + count), so its ~90px never competes with the rows. */}
        {split ? null : (
          <header className="op-inbox__masthead">
            <span className="op-inbox__masthead-icon" aria-hidden="true">
              <InboxIcon size={18} />
            </span>
            <span className="op-inbox__masthead-copy">
              <span className="op-inbox__masthead-eyebrow">
                Resolution inbox
              </span>
              <strong>Needs you</strong>
              <span className="op-inbox__masthead-subtitle">
                Resolve every owner-blocked item in one place.
              </span>
            </span>
            {needsCount}
          </header>
        )}
        {/* BULK RESOLVE command strip (P-006, direction A): between the masthead
          and the toolbar — above the filters it acts on, so what it will act on
          is what is on screen when it is pressed. */}
        {bulkStripProps && !split ? (
          <InboxBulkStrip {...bulkStripProps} />
        ) : null}
        <section
          className="op-inbox__controls"
          aria-label="Inbox search and filters"
        >
          <div className="op-inbox__controls-head">
            <span className="op-inbox__controls-label">Find and focus</span>
            {/* P-009 (inbox-three-column-resolver-states-2026-09-06): in split
                the list column carries ONE total — the rows in the current
                scope — because "N need you / N still open / N assessed / N
                tracked" were four different populations stacked with nothing
                saying so (the 31 Aug board's note); those live in the briefing
                and the rail. Stack keeps its "N of M shown". */}
            <span
              className="op-inbox__controls-scope"
              data-testid="inbox-visible-scope"
            >
              {split
                ? `${visible.length} ${visible.length === 1 ? "item" : "items"}`
                : `${visible.length} of ${counts.all} shown`}
            </span>
          </div>
          {/* Search + kind-facet filter (mimics the Queue's QueueFilterBar). */}
          <div className="op-inbox__toolbar">
            <div className="op-inbox__search">
              <Search
                size={13}
                aria-hidden="true"
                className="op-inbox__search-icon"
              />
              <input
                type="text"
                className="op-inbox__search-input"
                placeholder="Search blockers…"
                value={query}
                data-testid="inbox-search"
                aria-label="Search inbox"
                onChange={(e) => void setQuery(e.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  className="op-inbox__search-clear"
                  aria-label="Clear search"
                  data-testid="inbox-search-clear"
                  onClick={() => void setQuery("")}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {/* Sort picker — the shared Radix Select (native <select> is banned by
              _lints/design-primitives), standing where the retired "Kinds" toggle
              was. A fixed toolbar slot: putting it down with the facet chips
              would let it move every time the chip row rewraps. */}
            <Select
              value={sort}
              onChange={(v) =>
                void setSort(v === DEFAULT_INBOX_SORT ? null : (v as InboxSort))
              }
              options={INBOX_SORTS.map((s) => ({
                value: s.id,
                label: s.label,
              }))}
              ariaLabel="Sort inbox"
              testId="inbox-sort"
              triggerClassName="op-inbox__sort"
              align="end"
              triggerChildren={
                <>
                  <ArrowUpDown size={13} aria-hidden="true" />
                  <span className="op-inbox__sort-label">
                    {inboxSortLabel(sort)}
                  </span>
                  <ChevronDown size={11} aria-hidden="true" />
                </>
              }
            />
          </div>

          {/* Stack: the scopes + facets live here. Split: in the rail. */}
          {split ? null : tierScopes}
          {split ? null : kindFacetChips}
        </section>

        {/* Stack: the window strip sits above the rows. Split: in the aside's
            unselected state (P-004) — never a rigid sibling of the list. */}
        {split ? null : windowStrip}

        {error ? (
          <div className="op-inbox__error" role="alert">
            <span>Could not load the Resolution Inbox: {error}</span>
            <button type="button" onClick={refresh}>
              Retry
            </button>
          </div>
        ) : null}
        {loading && items.length === 0 ? (
          <div className="op-inbox__loading" data-testid="inbox-loading">
            Loading blockers…
          </div>
        ) : null}
        {!loading && !error && visible.length === 0 ? (
          <div className="op-inbox__empty" data-testid="inbox-empty">
            <InboxIcon
              size={20}
              className="op-inbox__empty-icon"
              aria-hidden="true"
            />
            <strong>
              {q || selectedKinds.size > 0 ? "No matches" : "Inbox zero"}
            </strong>
            <span>
              {q || selectedKinds.size > 0
                ? "Nothing matches the current filters."
                : filter === "needs"
                  ? "Nothing needs you. New decisions and owner walls will land here."
                  : "Nothing here right now."}
            </span>
          </div>
        ) : null}

        <div className="op-inbox__list" ref={listRef}>
          <div
            style={{
              height: rowVirtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const i = visible[vi.index]!;
              const isSel = i.id === sel;
              const tier = effectiveTier(i);
              const bulkRow = bulkEnabled ? bulk.byItemId.get(i.id) : undefined;
              const meta = [
                i.ownerLabel ?? i.ownerAgentId,
                i.planSlug ?? i.harnessSlug,
              ]
                .filter(Boolean)
                .join(" · ");
              const rel = formatRelativeDate(i.occurredAt);
              const abs = formatAbsoluteDate(i.occurredAt);
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    paddingBottom: 4,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <div
                    className={`op-inbox__row op-inbox__row--${tier}${isSel ? " is-selected" : ""}`}
                  >
                    <div className="op-inbox__row-summary">
                      <span className="op-inbox__row-icon" aria-hidden="true">
                        <InboxRowIcon kind={i.kind} />
                      </span>
                      {/* A `div` (not `button`) — the row nests a real chat-launch
                  <button>, and nested interactive elements are invalid HTML. */}
                      <div
                        id={`inbox-row-${i.id}`}
                        role="button"
                        tabIndex={0}
                        className="op-inbox__rowbtn"
                        data-testid={`inbox-row-${i.id}`}
                        aria-expanded={isSel}
                        aria-controls={`inbox-expanded-${i.id}`}
                        onClick={() => void setSel(isSel ? null : i.id)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          void setSel(isSel ? null : i.id);
                        }}
                      >
                        <span className="op-inbox__rowhead">
                          <span
                            className={`op-inbox__tierdot op-inbox__tierdot--${tier}`}
                            title={TIER_LABEL[tier]}
                            aria-label={TIER_LABEL[tier]}
                          />
                          <span className="op-inbox__kind">
                            {KIND_LABEL[i.kind] ?? i.kind}
                          </span>
                          {meta ? (
                            <span className="op-inbox__meta">{meta}</span>
                          ) : null}
                          <span className="op-inbox__rowhead-spacer" />
                          {/* What the bulk run did to THIS row. Shown for every non-
                      pending outcome, including `skipped` and `failed`: an item
                      the resolver could not judge must read differently from one
                      it never looked at. */}
                          {bulkRow && bulkRow.outcome !== "pending" ? (
                            <span
                              className={`op-inbox__rowstate op-inbox__rowstate--${canonicalInboxDisposition(bulkRow)}`}
                              data-testid={`inbox-bulk-state-${i.id}`}
                              title={
                                bulkRow.recommendation?.rationale ??
                                bulkRow.rationale ??
                                bulkRow.error ??
                                undefined
                              }
                            >
                              {bulkRow.recommendation?.label ??
                                BULK_OUTCOME_LABEL[bulkRow.outcome] ??
                                "needs review"}
                            </span>
                          ) : null}
                          {rel ? (
                            <Tooltip label={abs ?? rel}>
                              <span
                                className="op-inbox__date"
                                data-testid={`inbox-date-${i.id}`}
                              >
                                {rel}
                              </span>
                            </Tooltip>
                          ) : null}
                          {i.ownerAgentId ? (
                            <Tooltip label="Open live chat with the originating agent">
                              <button
                                type="button"
                                className="op-inbox__chat-button"
                                data-testid={`inbox-chat-open-${i.id}`}
                                aria-label={`Open live chat with ${i.ownerLabel ?? i.ownerAgentId}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void setChatOwner(i.ownerAgentId ?? null);
                                }}
                              >
                                <MessageCircle size={13} aria-hidden="true" />
                              </button>
                            </Tooltip>
                          ) : null}
                        </span>
                        <span className="op-inbox__title">{i.title}</span>
                        <span className="op-inbox__status">{i.status}</span>
                        <ChevronRight
                          className="op-inbox__row-chevron"
                          size={16}
                          aria-hidden="true"
                        />
                      </div>
                    </div>
                    {/* The pre-picked resolution, in the row it belongs to (D-003).
                  Rendered whenever this row still carries a recommendation —
                  NOT gated on selection: the review pass is reading several at
                  once, and making the owner expand each one to see what was
                  recommended would turn a one-screen review into N clicks. */}
                    {bulkRow?.outcome === "recommended" && bulk.isReview ? (
                      <InboxBulkRecommendation
                        item={i}
                        rec={bulkRow}
                        busy={acceptingCount > 0}
                        onAccept={(draftOverride) =>
                          acceptOneRecommendation(i, bulkRow, draftOverride)
                        }
                        onDiscuss={() => void onDiscuss(i)}
                      />
                    ) : null}
                    {/* Stack mode: the disclosure opens under its row. Split
                        mode renders the same subtree in the aside instead. */}
                    {isSel && !split ? renderExpandedDetail(i) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Stack: the foot closes the master. Split: it follows the window
            strip in the aside's unselected state (P-004). */}
        {split ? null : foot}
      </section>
      </div>

      {split ? (
        <aside
          ref={asideRef}
          tabIndex={-1}
          className="op-inbox__aside"
          data-testid="inbox-aside"
          aria-label="Selected inbox item"
        >
          {selectedItem ? (
            <>
              {/* Shown by CSS at narrow widths only, where the list column is
                  hidden while an item is selected — this is the way back. */}
              <button
                type="button"
                className="op-inbox__aside-back"
                data-testid="inbox-aside-back"
                onClick={() => void setSel(null)}
              >
                <ChevronLeft size={14} aria-hidden="true" />
                Back to list
              </button>
              {renderExpandedDetail(selectedItem)}
            </>
          ) : (
            /* P-005: the briefing — headline count, four tiles, the last run's
               readout + grouped rows, the primary action — from state the pane
               already holds (D-002). P-004's feed block (the window strip
               "Showing N of M · Load more" and the foot "N shown · Open full
               queue") rides in last, so the list column keeps only search +
               sort + rows. */
            <InboxBriefing
              needs={counts.needs}
              tracked={totalItemCount}
              run={bulkEnabled ? bulk.run : null}
              runItems={bulkEnabled ? bulk.items : []}
              unreached={bulkEnabled ? bulk.unreached : undefined}
              isRunning={bulkEnabled ? bulk.isRunning : false}
              onReview={(runId) => void setBulkRunId(runId)}
              // P-006: the live view's "Keep working the list" hands focus to
              // the first row — the aside is not a takeover, the list is right
              // there — so a keyboard owner has a way back out of it.
              onKeepWorking={() => {
                const first =
                  listRef.current?.querySelector<HTMLElement>(
                    ".op-inbox__rowbtn",
                  ) ?? null;
                (first ?? listRef.current)?.focus();
              }}
              feed={
                <div
                  className="op-inbox__aside-feed"
                  data-testid="inbox-aside-feed"
                >
                  {windowStrip}
                  {foot}
                </div>
              }
            />
          )}
        </aside>
      ) : null}

      <SessionChatModal
        sessionOwnerId={chatOwner}
        ownerLabel={chatOwnerLabel}
        onClose={() => void setChatOwner(null)}
      />
    </div>
  );
}
