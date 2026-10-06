/**
 * AdvConversationsTab — the /adv "Conversations" tab. One deduplicated curated
 * stream combines Q&A, group decisions, and agent-chat transcripts. Source
 * identity is an inline type pill, not a separate navigation tab.
 * Raw coordination events remain set apart as the subordinate diagnostic view.
 *
 *  - **Q&A** (default, `conv=threads`): the conversations substrate (questions +
 *    discussions) — the human counterpart to the agents' conversations:* tools.
 *    Reads the shared SSE named-query cache. Detail = seed + topics + thread + accepted answer + linked
 *    work-item + promote/reply/resolve actions.
 *
 *  - **Deliberations** (`conv=deliberations`): the threaded coord:thread /
 *    deliberate / vote discussions (`coord_threads` + `coord_thread_posts`),
 *    attached to an issue or a conversation. Left rail lists threads; detail
 *    renders the discussion posts in order.
 *
 *  - **Agent chats** (`conv=agentchats`): the internal detail route for
 *    multi-turn transcript rows projected into the unified stream. Live chats
 *    retain their interactive composer; archived chats remain read-only.
 *
 *  - **Raw events** (`conv=feed`): raw coordination events for debugging,
 *    newest-first, with day separators, grouped filters, URL-backed advanced
 *    kind filters, `from → to` routing, a plan chip, and click-to-expand detail.
 *    Data rides the SSE-invalidation rail via `@papercusp/sync` (`dev.coordFeed`,
 *    the same observer read the high-tier `coord:feed` tool exposes); "load
 *    older" paginates by cursor.
 *
 * All query-shaped reads use the shared SSE named-query cache. Mutations keep
 * their audited admin/tool endpoints; table-trigger invalidations push the
 * resulting state into the cached list/detail keys.
 *
 * All user-meaningful state is in the URL via nuqs (CLAUDE.md); only mid-edit
 * reply drafts + loading/busy lifecycle + the expand-set are useState.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState, useQueryStates, parseAsString, parseAsStringEnum, parseAsArrayOf } from 'nuqs';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { RichGrid, type ColumnDef, type FilterableColumn } from '@papercusp/grid-core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowLeft, ArrowUpRight, Bot, CheckCircle2, Inbox, MessageCircle, MessagesSquare, Plus, RefreshCw, Radio, Megaphone, Search, Send, SlidersHorizontal, UserRound } from 'lucide-react';
import { listCountLabel, readListTotal } from '@papercusp/operator-core/lib/sync-resolver/list-meta';
import { projectChatFailureTranscriptTurn } from '@papercusp/operator-core/lib/chat-model-failure';
import { Tooltip } from '@/app/harness/Tooltip';
import {
  useColumnFilters,
  ColumnFilterBar,
  filterCountLabel,
  type CountEvidence,
} from '@/app/harness/filters';
import { Modal } from '@/app/harness/Modal';
import ChatPanel from '@/app/harness/ChatPanel';
import { FEED_KIND_COLOR, FEED_KIND_FALLBACK } from '@/app/harness/theme';
import {
  inputStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
  sectionHeaderStyle,
  DEBOUNCE_MS,
  useDebouncedValue,
  friendlyApiError,
  ErrorBanner,
  EmptyState,
  FieldLabel,
  HintText,
  Pill,
} from '@/app/harness/picker-kit';
import { potHomeLabel } from '@/lib/pot-label';
// Relative, not `@/…`: the `@` alias points at the operator (Next) tree, so an
// intra-operator-vite import must be a relative path or it won't resolve.
//
// WI-5754: the unified-stream composition rules moved OUT of this file so the
// left rail's Conversations tab can read the same four stores without
// duplicating them. This file stays the source of the WIDE surface; what a
// conversation IS now lives in one place both surfaces import.
import {
  asConversationRefKind,
  composeUnifiedConversationRows,
  conversationEpoch,
  conversationErrText,
  conversationMatchesQuery,
  coordFetch,
  fmtConversationRel,
  fmtConversationTs,
  isSystemConversationActor,
  normalizedConversationText,
  parseAudienceRef,
  turnText,
  unifiedConversationSignature,
  type AgentChatDetail,
  type AgentChatRow,
  type AgentChatTurn,
  type AgentMessageDetail,
  type AgentMessageRow,
  type ConvDetailT,
  type ConvPost,
  type ConvRow,
  type ConversationRef,
  type DeliberationDetail,
  type ThreadPost,
  type ThreadRow,
  type UnifiedConversationRow,
} from '../conversations/unified-conversations';
import {
  ConversationRefLink,
  LinkifiedText,
  useConversationRefPopup,
} from '../conversations/ConversationRefs';
import { AuthoredFields } from '../conversations/AuthoredFields';
import AskComposer from '../conversations/AskComposer';
import '@/app/admin/coordination/coordination.css';
import '@/app/adv/harnesses/adv-panel-chrome.css';

// Re-exported for the existing test-suite import surface (and because these are
// genuinely part of this module's public contract). The definitions live in
// ../conversations/unified-conversations.
export { composeUnifiedConversationRows, isSystemConversationActor };

// The comms `list` reads cap at this many rows; the server returns the true
// `total` alongside `items`, so the rails can show "N of TOTAL" honestly.
// A conversation rail is a navigation surface, not an archive export. Fetching
// 500 rows made every source switch wait on a large response even though only a
// small virtual window is visible. The server still returns `total`, so the UI
// can say "100 of N" without downloading N.
const COMMS_LIST_LIMIT = 100;
// Each synchronized source owns an independently bounded window. The unified
// projection must retain all four windows; applying the per-source cap again
// after the merge lets a busy source starve every other conversation type.
const UNIFIED_LIST_LIMIT = COMMS_LIST_LIMIT * 4;
const UNIFIED_ROW_HEIGHT = 108;
const INITIAL_LOAD_STALL_MS = 8_000;

// Local names for the shared transport/format helpers, so the ~4k call sites in
// this file keep reading as they did while the DEFINITIONS live in one place.
const coord = coordFetch;
const fmtTs = fmtConversationTs;
const fmtRel = fmtConversationRel;
const errText = conversationErrText;

/** Shimmering placeholder rows shown while a rail / stream loads. */
function LoadingRows({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="pc-advconv__skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="pc-advconv__skeleton-row" aria-hidden />
      ))}
    </div>
  );
}

/**
 * List-fetch failure state — a friendly red banner (picker-kit ErrorBanner) with
 * a retry. Without it a rejected fetch left the skeleton up forever. The raw
 * `message` (e.g. "threads/list: HTTP 500") is mapped to friendly copy via
 * friendlyApiError; the raw text is preserved so the status code stays visible.
 */
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <ErrorBanner>
      <span style={{ display: 'block', fontWeight: 600 }}>Couldn&apos;t load</span>
      <span>{friendlyApiError(undefined, message)}</span>
      <button type="button" className="pc-coord__chip pc-advconv__retry" onClick={onRetry} style={{ marginLeft: 8 }}>
        <RefreshCw size={11} aria-hidden /> Retry
      </button>
    </ErrorBanner>
  );
}

// Stable row-chrome callbacks for the inline RichGrid lists (U1). Hoisted so
// their identity is constant across renders — RichGrid's `memo(BodyRow)` does a
// shallow prop compare, so an inline `getRowBg={() => …}` / `rowProps={() => ({…})}`
// would hand every row a fresh callback/object on each parent render and force
// ALL visible rows to re-render (e.g. on a selection toggle or an SSE invalidation
// that left a given row's data untouched). With stable references only the rows
// whose own data / selection actually changed re-render. The cards are
// fully class-styled, so the grid's own striping/border chrome is neutralized.
const gridTransparentBg = (): string => 'transparent';
const RAIL_ROW_PROPS = { style: { borderBottom: 'none', paddingBottom: 6 } } as const;
const STREAM_ROW_PROPS = { style: { borderBottom: 'none', paddingBottom: 5 } } as const;
const railRowProps = () => RAIL_ROW_PROPS;
const streamRowProps = () => STREAM_ROW_PROPS;

// ─── View switch ─────────────────────────────────────────────────────
const CONV_VIEWS = ['inbox', 'threads', 'deliberations', 'agentchats', 'messages', 'feed'] as const;
type ConvView = (typeof CONV_VIEWS)[number];

const CONVERSATION_ROUTE_PARAMS = {
  conv: parseAsStringEnum<ConvView>([...CONV_VIEWS]).withDefault('inbox'),
  conversation: parseAsString,
  thread: parseAsString,
  chat: parseAsString,
  /** The open agent↔agent coord message (conversations-agent-messages P-007).
   *  Deliberately NOT `fmsg`: that one addresses the RAW feed, and reusing it
   *  would make a curated selection and a firehose selection fight. */
  cmsg: parseAsString,
  fmsg: parseAsString,
};

const EMPTY_CONVERSATION_SELECTION = {
  conversation: null,
  thread: null,
  chat: null,
  cmsg: null,
  fmsg: null,
} as const;

interface ViewDef {
  id: ConvView;
  label: string;
  desc: string;
  // 'curated' = a distinct, materialized communication store you read.
  // 'raw' = the low-level coordination event firehose, set apart as a debug tool.
  group: 'curated' | 'raw';
  Icon: typeof MessageCircle;
}

// Source-specific ids remain accepted as INTERNAL detail routes so old deep
// links and source-owned actions keep working. Only `inbox` and `feed` render as
// navigation tabs: one curated stream plus the subordinate raw diagnostic log.
const VIEW_DEFS: ReadonlyArray<ViewDef> = [
  { id: 'inbox', label: 'Conversations', desc: 'Every curated conversation, ordered by the most recent activity.', group: 'curated', Icon: Inbox },
  { id: 'threads', label: 'Questions & discussions', desc: 'Questions and discussions between you and the agents.', group: 'curated', Icon: MessageCircle },
  { id: 'deliberations', label: 'Group decisions', desc: 'Coord threads, proposals, and votes.', group: 'curated', Icon: MessagesSquare },
  { id: 'agentchats', label: 'Agent chat', desc: "An agent's full multi-turn transcript.", group: 'curated', Icon: Bot },
  { id: 'messages', label: 'Agent messages', desc: 'Agent-to-agent coord:send traffic — who told whom what, with the reply chain.', group: 'curated', Icon: Send },
  { id: 'feed', label: 'Raw events', desc: 'The system message log — system-origin coordination (watchdog, routines, infra), newest first. The diagnostic traffic the curated conversations filter out.', group: 'raw', Icon: Radio },
];
const CURATED_VIEW_DEFS = VIEW_DEFS.filter((v) => v.id === 'inbox');
const RAW_VIEW_DEFS = VIEW_DEFS.filter((v) => v.group === 'raw');

// Per-view accent for the sidebar switcher buttons — the icon already
// distinguishes them; the accent makes the active selection legible at a glance
// (mirrors the Create sidebar's per-view button colours). 'feed' is the muted
// debug firehose, so it gets a quiet slate.
const VIEW_ACCENT: Record<ConvView, string> = {
  inbox: 'var(--accent)',
  threads: 'var(--accent)',
  deliberations: 'var(--accent)',
  agentchats: 'var(--accent)',
  messages: 'var(--accent)',
  feed: 'var(--fg-mute)',
};

/**
 * Keep the selected conversation visibly anchored in the right pane while its
 * detail query warms. A bare shimmer made a successful click look like a no-op
 * in the desktop webview, especially on the first cross-source selection.
 * Everything rendered here comes from the already-synchronized list row, so
 * this adds no second request and is replaced by the canonical detail as soon
 * as it arrives.
 */
function ConversationDetailLoading({
  row,
  label,
}: {
  row: UnifiedConversationRow | undefined;
  label: string;
}) {
  return (
    <article className="pc-coord__card pc-advconv__detail-loading" aria-busy="true">
      {row ? (
        <header className="pc-advconv__detailhead">
          <div>
            <p className="pc-advconv__detailkicker">
              <span className={`pc-advconv__unified-kind pc-advconv__unified-kind--${row.source}`}>{row.typeLabel}</span>
              {row.state ? <span className={`pc-advconv__statepill pc-advconv__statepill--${row.state}`}>{row.state}</span> : null}
            </p>
            <h2>{row.title}</h2>
          </div>
        </header>
      ) : null}
      <LoadingRows rows={4} label={label} />
    </article>
  );
}

const SOURCE_DEF = new Map(VIEW_DEFS.map((definition) => [definition.id, definition]));

const UNIFIED_FILTER_COLUMNS: readonly FilterableColumn<UnifiedConversationRow>[] = [
  { key: 'type', header: 'Type', filter: { type: 'enum', accessor: (row) => row.typeLabel } },
  { key: 'state', header: 'State', filter: { type: 'enum', accessor: (row) => row.state || null } },
  { key: 'sender', header: 'Sender', filter: { type: 'enum', accessor: (row) => row.actor ?? null } },
  { key: 'recipient', header: 'Recipient', filter: { type: 'enum', accessor: (row) => row.recipient ?? null } },
  { key: 'pot', header: 'Pot', filter: { type: 'enum', accessor: (row) => row.harnessSlug ?? null } },
  { key: 'related', header: 'Related work', filter: { type: 'enum', accessor: (row) => row.relatedRef ?? null } },
];

/**
 * The unified inbox is a projection, not a new communication store. Its rows
 * compose four focused shared SSE list queries and open the source-specific detail,
 * keeping replies/resolution/live-chat behavior on the audited paths that
 * already own it. This is intentionally a custom virtualized master-detail
 * list: the design guide calls that shape out as a non-RichGrid use case.
 */
function UnifiedInboxView() {
  const [route, setRoute] = useQueryStates(CONVERSATION_ROUTE_PARAMS);
  const [search, setSearch] = useQueryState('cq', parseAsString.withDefault(''));
  const debouncedSearch = useDebouncedValue(search, DEBOUNCE_MS);
  const questions = useSyncQuery<ConvRow>({ queryName: 'conversations.questionsList', args: { limit: COMMS_LIST_LIMIT }, staleTime: 30_000 });
  const deliberations = useSyncQuery<ThreadRow>({ queryName: 'conversations.deliberationList', args: { limit: COMMS_LIST_LIMIT }, staleTime: 30_000 });
  const agentChats = useSyncQuery<AgentChatRow>({ queryName: 'conversations.agentChatList', args: { limit: COMMS_LIST_LIMIT }, staleTime: 30_000 });
  const agentMessages = useSyncQuery<AgentMessageRow>({
    queryName: 'conversations.agentMessageList',
    args: { limit: COMMS_LIST_LIMIT, q: debouncedSearch.trim() || undefined },
    staleTime: 30_000,
  });
  const rows = useMemo(
    () => composeUnifiedConversationRows(
      {
        questions: questions.data ?? [],
        deliberations: deliberations.data ?? [],
        agentChats: agentChats.data ?? [],
        agentMessages: agentMessages.data ?? [],
      },
      UNIFIED_LIST_LIMIT,
    ),
    [questions.data, deliberations.data, agentChats.data, agentMessages.data],
  );
  const conversationCountEvidence = useMemo<CountEvidence>(
    () => ({
      kind: 'window',
      count: rows.length,
      window: `the latest bounded conversation window (up to ${COMMS_LIST_LIMIT.toLocaleString('en-US')} per source)`,
    }),
    [rows.length],
  );
  const columnFilters = useColumnFilters(UNIFIED_FILTER_COLUMNS, rows, {
    ns: 'cv',
    countEvidence: conversationCountEvidence,
  });
  const filteredRows = useMemo(() => {
    const query = debouncedSearch.trim().toLocaleLowerCase();
    if (!query) return columnFilters.rows;
    return columnFilters.rows.filter((row) => [
      row.typeLabel,
      row.kind,
      row.state,
      row.title,
      row.preview,
      row.actor,
      row.recipient,
      row.harnessSlug,
      row.relatedRef,
    ].some((value) => normalizedConversationText(value).includes(query)));
  }, [columnFilters.rows, debouncedSearch]);
  const filtersActive = columnFilters.hasActive || search.trim() !== '';
  const queries = [questions, deliberations, agentChats, agentMessages];
  const loading = queries.some((query) => query.loading);
  const error = queries.find((query) => query.error)?.error ?? null;
  const invalidate = () => queries.forEach((query) => query.invalidate());
  const conversationCountLabel = filterCountLabel(
    loading && rows.length === 0
      ? { kind: 'unknown', reason: 'loading' }
      : filtersActive
        ? {
            kind: 'window',
            count: filteredRows.length,
            windowTotal: rows.length,
            window: `the latest bounded conversation window (up to ${COMMS_LIST_LIMIT.toLocaleString('en-US')} per source)`,
          }
        : conversationCountEvidence,
    'conversation',
  );
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!loading || rows.length > 0) {
      setStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setStalled(true), INITIAL_LOAD_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [loading, rows.length]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLButtonElement>({
    count: filteredRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => UNIFIED_ROW_HEIGHT,
    // The synchronized sources can reorder when activity arrives. Index keys
    // make React replace the button occupying that slot, which WebKit paints as
    // a flash. Track the conversation identity instead so a moved row remains
    // the same DOM node across invalidations.
    getItemKey: (index) => filteredRows[index]?.id ?? index,
    overscan: 10,
  });
  // `measureElement` on each mounted row already keeps variable heights exact.
  // Calling measure() for every live-sync array replacement resets the whole
  // virtual window and makes the rail visibly jump/flash during invalidations.

  const open = (row: UnifiedConversationRow) => setRoute({
    conv: row.source,
    conversation: row.source === 'threads' ? row.sourceId : null,
    thread: row.source === 'deliberations' ? row.sourceId : null,
    chat: row.source === 'agentchats' ? row.sourceId : null,
    cmsg: row.source === 'messages' ? row.sourceId : null,
    fmsg: null,
  });
  const selectedSourceId = route.conv === 'threads'
    ? route.conversation
    : route.conv === 'deliberations'
      ? route.thread
      : route.conv === 'agentchats'
        ? route.chat
        : route.conv === 'messages'
          ? route.cmsg
          : null;
  const selectedUnifiedId = selectedSourceId ? `${route.conv}:${selectedSourceId}` : null;
  const selectedRow = selectedUnifiedId ? rows.find((row) => row.id === selectedUnifiedId) : undefined;
  const closeDetail = () => setRoute({ conv: 'inbox', ...EMPTY_CONVERSATION_SELECTION });
  const detail = route.conv === 'threads' && route.conversation
    ? <ThreadsView detailOnly loadingSummary={selectedRow} />
    : route.conv === 'deliberations' && route.thread
      ? <DeliberationsView detailOnly loadingSummary={selectedRow} />
      : route.conv === 'agentchats' && route.chat
        ? <AgentChatsView detailOnly loadingSummary={selectedRow} />
        : route.conv === 'messages' && route.cmsg
          ? <AgentMessagesView detailOnly loadingSummary={selectedRow} />
          : (
          <section className="pc-coord__detail">
            <EmptyState
              style={{ minHeight: '100%' }}
              icon={<Inbox size={22} aria-hidden />}
              title="Select a conversation"
              desc="Open a conversation to review its full context."
            />
          </section>
        );

  return (
    <ConvFrame
      detailOpen={selectedUnifiedId != null}
      onBack={selectedUnifiedId ? () => void closeDetail() : undefined}
      filters={
        <>
          <div className="pc-advconv__railhead pc-advconv__railhead--unified">
            <span style={sectionHeaderStyle}>Conversations</span>
            <strong aria-label={conversationCountLabel.ariaLabel}>{conversationCountLabel.title}</strong>
            <button
              type="button"
              className="pc-coord__chip pc-advconv__refresh"
              aria-label="Reload conversations"
              disabled={loading && !stalled}
              onClick={() => {
                setStalled(false);
                void invalidate();
              }}
            >
              <RefreshCw size={11} aria-hidden />
            </button>
          </div>
          <div className="pc-advconv__unified-tools">
            <label className="pc-advconv__unified-search">
              <Search size={13} aria-hidden />
              <input
                type="search"
                value={search}
                onChange={(event) => void setSearch(event.target.value)}
                placeholder="Search conversations…"
                aria-label="Search conversations"
              />
            </label>
            <ColumnFilterBar
              layout="facets"
              controller={columnFilters.controller}
              activeChips={columnFilters.activeChips}
              hasActive={columnFilters.hasActive}
              clearAll={columnFilters.clearAll}
            />
            {filtersActive ? (
              <button
                type="button"
                className="pc-advpanel__chip pc-advconv__unified-reset"
                onClick={() => {
                  columnFilters.clearAll();
                  void setSearch('');
                }}
              >
                Reset
              </button>
            ) : null}
          </div>
        </>
      }
      list={
        <div className="pc-advconv__listscroll pc-advconv__unified" ref={listRef}>
          {loading && rows.length === 0 && !stalled ? (
            <LoadingRows rows={6} label="Loading conversations" />
          ) : stalled && rows.length === 0 ? (
            <LoadError message="Conversation sync timed out." onRetry={() => {
              setStalled(false);
              void invalidate();
            }} />
          ) : error && rows.length === 0 ? (
            <LoadError message={errText(error)} onRetry={() => void invalidate()} />
          ) : filteredRows.length === 0 ? (
            <EmptyState
              icon={<Inbox size={22} aria-hidden />}
              title={filtersActive ? 'No conversations match' : 'No conversations'}
              desc={filtersActive ? 'Clear a filter or broaden the search.' : 'No curated communication is recorded.'}
            />
          ) : (
            <div className="pc-advconv__virtual-list" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = filteredRows[item.index];
                if (!row) return null;
                const definition = SOURCE_DEF.get(row.source);
                const Icon = definition?.Icon ?? MessageCircle;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`pc-advconv__unified-row${selectedUnifiedId === row.id ? ' is-active' : ''}`}
                    data-index={item.index}
                    // Fixed-height rows do not need compositor transforms.
                    // Absolute `top` positioning avoids WebKit layer flashes
                    // when live sync moves a row to a new sorted position.
                    style={{ top: item.start }}
                    aria-label={`Open ${row.title}`}
                    aria-current={selectedUnifiedId === row.id ? 'true' : undefined}
                    onClick={() => void open(row)}
                  >
                    <span className={`pc-advconv__unified-source pc-advconv__unified-source--${row.source}`} aria-hidden><Icon size={14} /></span>
                    <span className="pc-advconv__unified-content">
                      <span className="pc-advconv__unified-topline">
                        <span className={`pc-advconv__unified-kind pc-advconv__unified-kind--${row.source}`}>{row.typeLabel}</span>
                        {row.state ? <span className={`pc-advconv__statepill pc-advconv__statepill--${row.state}`}>{row.state}</span> : null}
                        <time>{fmtRel(row.updatedAt)}</time>
                      </span>
                      <strong>{row.title}</strong>
                      {row.preview ? <span className="pc-advconv__unified-preview">{row.preview}</span> : null}
                      <span className="pc-advconv__unified-meta">
                        {row.actor ? <span>{row.actor}</span> : null}
                        {row.recipient ? <span>→ {row.recipient}</span> : null}
                        {row.harnessSlug ? <span>{potHomeLabel(row.harnessSlug)}</span> : null}
                        {row.relatedRef ? <span>{row.relatedRef}</span> : null}
                        {row.count ? <span>{row.count}</span> : null}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      }
      detail={detail}
    />
  );
}

/**
 * ConvFrame — the shared Conversations shell, mirroring the Create dock's
 * sidebar│main model (a persistent left rail that owns the primary action + the
 * view switcher + this view's filters/list, and a main pane that holds only the
 * selected item's detail). The unified list and each source-owned detail render
 * through the same frame, so the rail stays stable as the detail route changes.
 *
 * The nav reuses the globally-imported `pc-plans__*` rail classes (plans.css is
 * loaded on the /adv route) so it is visually identical to Create's sidebar.
 */
function ConvFrame({
  filters,
  list,
  detail,
  detailOpen = false,
  onBack,
  detailOnly = false,
}: {
  filters?: React.ReactNode;
  /** The sidebar list (rail|detail views). Omit for full-width stream views
   *  (Messages / Raw events), which render their list inside `detail`. */
  list?: React.ReactNode;
  detail: React.ReactNode;
  detailOpen?: boolean;
  onBack?: () => void;
  detailOnly?: boolean;
}) {
  const [route, setRoute] = useQueryStates(CONVERSATION_ROUTE_PARAMS);
  const view = route.conv;
  const [askOpen, setAskOpen] = useState(false);

  const switchView = (nextView: ConvView) => {
    // A view switch is a navigation boundary: selections belong to their source
    // view and must not survive into another source's URL. When the already-active
    // tab is clicked, preserve only its own selection while cleaning legacy/stale
    // keys left by older builds.
    const preserveActiveSelection = nextView === view;
    void setRoute({
      conv: nextView,
      ...EMPTY_CONVERSATION_SELECTION,
      conversation: preserveActiveSelection && nextView === 'threads' ? route.conversation : null,
      thread: preserveActiveSelection && nextView === 'deliberations' ? route.thread : null,
      chat: preserveActiveSelection && nextView === 'agentchats' ? route.chat : null,
      cmsg: preserveActiveSelection && nextView === 'messages' ? route.cmsg : null,
      fmsg: preserveActiveSelection && nextView === 'feed' ? route.fmsg : null,
    });
  };

  const navBtn = (d: ViewDef) => {
    const active = d.id === 'inbox' ? view !== 'feed' : view === d.id;
    return (
      <Tooltip key={d.id} label={d.desc}>
        <button
          id={`adv-conversations-tab-${d.id}`}
          type="button"
          role="tab"
          aria-label={d.label}
          aria-selected={active}
          aria-controls="adv-conversations-panel"
          className={`pc-advconv__navbtn pc-advconv__navbtn--${d.group}${active ? ' is-active' : ''}`}
          style={{ ['--nav-accent' as string]: VIEW_ACCENT[d.id] } as React.CSSProperties}
          onClick={() => switchView(d.id)}
        >
          <span className="pc-advconv__navicon" aria-hidden>
            <d.Icon size={14} />
          </span>
          <span className="pc-advconv__navlabel">{d.label}</span>
        </button>
      </Tooltip>
    );
  };

  if (detailOnly) return <>{detail}</>;

  return (
    <div className={`pc-advconv__shell${detailOpen ? ' is-detail-open' : ''}`}>
      <aside className="pc-plans__rail pc-advconv__nav">
        <div className="pc-plans__rail-actions pc-advconv__nav-actions">
          <Tooltip label="Ask the agents a question — opens a question conversation routed to topic subscribers; answers land in Conversations.">
            <button type="button" className="pc-plans__new-plan" onClick={() => setAskOpen(true)} aria-label="Ask the agents">
              <span className="pc-advconv__navicon" aria-hidden>
                <Plus size={14} />
              </span>
              <span className="pc-advconv__navlabel">Ask</span>
            </button>
          </Tooltip>
          <div className="pc-advconv__nav-switcher" role="tablist" aria-label="Conversations view">
            <div className="pc-advconv__nav-primary" role="presentation">
              {CURATED_VIEW_DEFS.map(navBtn)}
            </div>
            <div className="pc-advconv__nav-diagnostic" role="presentation">
              <span className="pc-advconv__nav-sep" role="separator" aria-orientation="horizontal" />
              {RAW_VIEW_DEFS.map(navBtn)}
            </div>
          </div>
        </div>
      </aside>
      {list != null && (
        <section className="pc-advconv__inbox" aria-label="Conversation list">
          {filters != null && <div className="pc-plans__group pc-advconv__navfilters">{filters}</div>}
          <div className="pc-advconv__navlist">{list}</div>
        </section>
      )}
      <main
        id="adv-conversations-panel"
        role="tabpanel"
        aria-labelledby={`adv-conversations-tab-${view === 'feed' ? 'feed' : 'inbox'}`}
        className={`pc-advconv__main${list == null ? ' pc-advconv__main--wide' : ''}`}
      >
        {onBack ? (
          <Tooltip label="Back to conversations">
            <button type="button" className="pc-advconv__back" aria-label="Back to conversations" onClick={onBack}>
              <ArrowLeft size={15} aria-hidden />
            </button>
          </Tooltip>
        ) : null}
        {detail}
      </main>
      <AskComposer open={askOpen} onOpenChange={setAskOpen} onAsked={() => switchView('inbox')} />
    </div>
  );
}

export default function AdvConversationsTab() {
  const [route, setRoute] = useQueryStates(CONVERSATION_ROUTE_PARAMS);
  const sourceSelection = route.conv === 'threads'
    ? route.conversation
    : route.conv === 'deliberations'
      ? route.thread
      : route.conv === 'agentchats'
        ? route.chat
        : null;
  const isInternalDetailRoute = route.conv !== 'inbox' && route.conv !== 'feed';
  const view = isInternalDetailRoute && !sourceSelection ? 'inbox' : route.conv;
  useEffect(() => {
    if (!isInternalDetailRoute || sourceSelection) return;
    void setRoute({ conv: 'inbox', ...EMPTY_CONVERSATION_SELECTION });
  }, [isInternalDetailRoute, sourceSelection, setRoute]);
  return (
    <div className="pc-coord pc-advconv pc-advconv--shell">
      {view === 'feed' ? (
        <FeedView />
      ) : (
        <UnifiedInboxView />
      )}
      <AdvConvStyles />
    </div>
  );
}

// ─── Raw events — the raw coordination event log ─────────────────────

const FEED_KINDS = [
  'message',
  'ack',
  'notify',
  'broadcast',
  'handoff',
  'handoff_accepted',
  'escalation',
  'escalation_resolved',
  'plan_event',
  'subscribe',
  'unsubscribe',
  'contract',
] as const;

const FEED_KIND_GROUPS = [
  { id: 'messages', label: 'Messages', description: 'Direct and broadcast messages', kinds: ['message', 'broadcast'] },
  { id: 'handoffs', label: 'Handoffs', description: 'Work passed between agents', kinds: ['handoff'] },
  { id: 'escalations', label: 'Escalations', description: 'Blocked work and resolutions', kinds: ['escalation', 'escalation_resolved'] },
  { id: 'plan-events', label: 'Plan events', description: 'Plan changes and lifecycle updates', kinds: ['plan_event'] },
] as const;

interface FeedRow {
  ts: string;
  msg_id: string;
  from: string;
  to: string[];
  kind: string;
  surface: string;
  broadcast: boolean;
  summary?: string;
  body?: string;
  plan_slug?: string;
  related_msg_id?: string;
  event?: string;
  detail?: string;
  choice?: string;
  next_action?: string;
  category?: string;
  _meta?: { total: number; byKind: Record<string, number>; nextCursor: string | null };
}

function dayKey(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().slice(0, 10);
}
function dayLabel(key: string): string {
  if (key === 'unknown') return 'Unknown date';
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (key === today) return 'Today';
  if (key === yest) return 'Yesterday';
  return new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function relTime(ts: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return '—';
  const delta = Date.now() - t;
  if (delta < 0) return 'just now';
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function dateStamp(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ToCell({ to, broadcast }: { to: string[]; broadcast: boolean }) {
  if (broadcast) {
    return (
      <span className="pc-advfeed__to pc-advfeed__to--broadcast">
        <Megaphone size={10} aria-hidden /> BROADCAST
      </span>
    );
  }
  const toHuman = to.includes('human');
  if (toHuman) {
    return (
      <span className="pc-advfeed__to pc-advfeed__to--human">
        <UserRound size={10} aria-hidden /> → human
      </span>
    );
  }
  return <span className="pc-advfeed__to">→ {to.length ? to.join(', ') : '∅'}</span>;
}

// U1 (operator-vite-ui-consolidation): the day-grouped feed is flattened into a
// single virtual row stream — a `day` separator row followed by its `item` rows —
// so the whole thing rides one @papercusp/grid-core RichGrid (virtualMode) instead
// of nested `.map()`s. RichGrid stays flat (no grouping primitive); the day
// separator is just another row the cell renderer special-cases. Variable-height
// rows (multi-line summaries, click-expanded detail) are handled by `measureAll`.
type FeedEntry =
  | { kind: 'day'; id: string; day: string }
  | { kind: 'item'; id: string; row: FeedRow; replies: FeedRow[] };

function FeedView() {
  // All filters in nuqs.
  const [kinds, setKinds] = useQueryState('fkind', parseAsArrayOf(parseAsString).withDefault([]));
  const [advancedKinds, setAdvancedKinds] = useQueryState('fadvanced', parseAsStringEnum(['closed', 'open']).withDefault('closed'));
  const [agent, setAgent] = useQueryState('fagent', parseAsString.withDefault(''));
  const [plan, setPlan] = useQueryState('fplan', parseAsString.withDefault(''));
  const [q, setQ] = useQueryState('fq', parseAsString.withDefault(''));
  // Debounce the free-text search so a fast-typed query only re-fires the
  // sync query once it settles (DEBOUNCE_MS) — the input stays bound to the raw
  // nuqs `q` for responsiveness; only the QUERY-driving reads use `debouncedQ`.
  const debouncedQ = useDebouncedValue(q, DEBOUNCE_MS);
  const [openMsg, setOpenMsg] = useQueryState('fmsg', parseAsString);
  // Sender scope. The feed is the RAW coordination firehose, and it defaults to
  // SYSTEM-origin envelopes (`system_only` → isSystemCoordActor, /^system…/) so it
  // doesn't duplicate the agent-authored curated streams above it.
  //
  // That default used to be HARDCODED, which silently broke every deep-link to an
  // agent-authored message (WI-4462; owner 2026-07-12: "clicking some of the
  // messages brings up the conversations tab opened to the clicked message but some
  // of them don't"). A Colony/Fleet mail click arrives as ?fmsg=<id>; if that
  // message's sender is an agent (su-… / bee-…) rather than system-*, the row is
  // filtered out server-side, so there is nothing to scroll to or expand — the tab
  // opens at the newest head looking inert, while a system-watchdog row right next
  // to it in the same list works. The scope is now URL-backed (`?fsys=system|all`,
  // default unchanged): the sidebar deep-links with fsys=all so ANY targeted
  // message resolves, and a human can flip the chip to see agent traffic too.
  const [scope, setScope] = useQueryState(
    'fsys',
    parseAsStringEnum(['system', 'all'] as const).withDefault('system'),
  );
  const systemOnly = scope !== 'all';

  // "Load older" grows the window from the top. The feed is newest-first and the
  // limit caps from the newest end, so a larger limit reaches further back while
  // the live head stays put — no second data path, all on the @papercusp/sync
  // SSE-invalidation rail. (Transient render state: the URL carries the filters,
  // not the scroll depth.)
  const PAGE = 100;
  const [limit, setLimit] = useState(PAGE);

  // 'broadcast' is a synthetic, cross-cutting UI kind (any envelope with
  // to:['*']) — it is NOT a real CoordKind the server validates, so it's applied
  // client-side. Real kinds go to the server.
  const wantBroadcast = kinds.includes('broadcast');
  const serverKinds = useMemo(() => kinds.filter((k) => k !== 'broadcast'), [kinds]);
  const feedArgs = useMemo(
    () => ({
      ...(serverKinds.length ? { kinds: serverKinds } : {}),
      ...(agent ? { owner: agent } : {}),
      ...(plan ? { plan_slug: plan } : {}),
      ...(debouncedQ.trim() ? { q: debouncedQ.trim() } : {}),
      system_only: systemOnly,
      limit,
    }),
    [serverKinds, agent, plan, debouncedQ, systemOnly, limit],
  );
  // useSyncQuery owns the actual fetch (SSE-primary, REST fallback). Hold an
  // AbortController keyed to the live feedArgs and abort it whenever the args
  // change or the view unmounts, so a stale REST-fallback request for a prior
  // search/filter can't land after the user has moved on.
  const fetchAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    fetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;
    return () => ctrl.abort();
  }, [feedArgs]);
  const head = useSyncQuery<FeedRow>({ queryName: 'dev.coordFeed', args: feedArgs, staleTime: 5_000 });

  // Reset the window whenever the FILTER set changes (not when limit changes).
  const filterKey = useMemo(
    () => JSON.stringify({ kinds, agent, plan, q: debouncedQ.trim(), scope }),
    [kinds, agent, plan, debouncedQ, scope],
  );
  useEffect(() => {
    setLimit(PAGE);
  }, [filterKey]);

  const rawRows = head.data ?? [];
  const meta = rawRows[0]?._meta;
  // Apply the synthetic 'broadcast' filter client-side when selected.
  const allRows = useMemo(
    () => (wantBroadcast ? rawRows.filter((r) => r.broadcast) : rawRows),
    [rawRows, wantBroadcast],
  );
  const signalStats = useMemo(() => {
    const byKind = meta?.byKind ?? {};
    const broadcastCount = rawRows.filter((r) => r.broadcast).length;
    const humanCount = rawRows.filter((r) => (r.to ?? []).includes('human')).length;
    const escalationCount = byKind.escalation ?? rawRows.filter((r) => r.kind === 'escalation').length;
    return { broadcastCount, humanCount, escalationCount };
  }, [meta, rawRows]);

  // Group an ack/resolution/acceptance under its parent (related_msg_id chain),
  // so a reply collapses into its root row. A row whose related_msg_id points at
  // another loaded row is a CHILD; everything else is a root.
  const { roots, childrenOf, rootIdOf } = useMemo(() => {
    const byId = new Map(allRows.map((r) => [r.msg_id, r]));
    const childrenOf = new Map<string, FeedRow[]>();
    const roots: FeedRow[] = [];
    for (const r of allRows) {
      const parentId = typeof r.related_msg_id === 'string' ? r.related_msg_id : null;
      if (parentId && byId.has(parentId)) {
        const arr = childrenOf.get(parentId) ?? [];
        arr.push(r);
        childrenOf.set(parentId, arr);
      } else {
        roots.push(r);
      }
    }
    // Children oldest-first under their parent (chronological reply order).
    for (const arr of childrenOf.values()) arr.sort((a, b) => a.ts.localeCompare(b.ts));
    // Map every loaded msg_id → the topmost loaded ancestor it renders under. A
    // reply/ack folds into its parent, so a deep-link (or Colony message click)
    // targeting a child's msg_id must open the ROOT row — there is no top-level
    // row for the child itself. Walk the related_msg_id chain, guarding cycles.
    const rootIdOf = new Map<string, string>();
    for (const r of allRows) {
      let cur = r;
      const seen = new Set<string>([r.msg_id]);
      while (true) {
        const pid = typeof cur.related_msg_id === 'string' ? cur.related_msg_id : null;
        if (!pid || seen.has(pid)) break;
        const parent = byId.get(pid);
        if (!parent) break;
        seen.add(pid);
        cur = parent;
      }
      rootIdOf.set(r.msg_id, cur.msg_id);
    }
    return { roots, childrenOf, rootIdOf };
  }, [allRows]);

  // Day separators over the root rows (already newest-first from the server).
  const grouped = useMemo(() => {
    const out: Array<{ day: string; rows: FeedRow[] }> = [];
    let cur: { day: string; rows: FeedRow[] } | null = null;
    for (const r of roots) {
      const k = dayKey(r.ts);
      if (!cur || cur.day !== k) {
        cur = { day: k, rows: [] };
        out.push(cur);
      }
      cur.rows.push(r);
    }
    return out;
  }, [roots]);

  // The server returns a non-null cursor whenever more rows exist beyond the
  // current window — that's our "has older" signal.
  const hasOlder = (meta?.nextCursor ?? null) !== null;
  const loadOlder = useCallback(() => setLimit((n) => n + PAGE), []);

  const toggleKind = (k: string) =>
    void setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);
  const toggleKindGroup = (groupKinds: readonly string[]) => {
    const active = groupKinds.some((k) => kinds.includes(k));
    const next = active
      ? kinds.filter((k) => !groupKinds.includes(k))
      : [...kinds, ...groupKinds.filter((k) => !kinds.includes(k))];
    void setKinds(next);
  };
  const groupCount = (groupKinds: readonly string[]) =>
    rawRows.filter((r) => groupKinds.some((k) => (k === 'broadcast' ? r.broadcast : r.kind === k))).length;
  const rawKindCount = (k: string) =>
    k === 'broadcast' ? rawRows.filter((r) => r.broadcast).length : (meta?.byKind?.[k] ?? rawRows.filter((r) => r.kind === k).length);
  const kindLabel = (k: string) => k.replaceAll('_', ' ');

  const filtersActive = kinds.length > 0 || !!agent || !!plan || !!debouncedQ.trim() || !systemOnly;
  const activeFilterCount =
    kinds.length + (agent ? 1 : 0) + (plan ? 1 : 0) + (debouncedQ.trim() ? 1 : 0) + (systemOnly ? 0 : 1);
  const clearFilters = () => {
    void setKinds([]);
    void setAgent('');
    void setPlan('');
    void setQ('');
    void setScope('system');
  };

  // Flatten the day groups (already day-separated, newest-first) into one virtual
  // row stream: each day contributes a `day` separator row then its root `item`
  // rows. The reply chain rides on the item as `replies` and shows inside the
  // expanded detail. RichGrid virtualizes this flat list.
  const feedEntries = useMemo<FeedEntry[]>(() => {
    const out: FeedEntry[] = [];
    for (const g of grouped) {
      out.push({ kind: 'day', id: `day:${g.day}`, day: g.day });
      for (const r of g.rows) {
        out.push({ kind: 'item', id: `item:${r.msg_id}`, row: r, replies: childrenOf.get(r.msg_id) ?? [] });
      }
    }
    return out;
  }, [grouped, childrenOf]);

  // The stream is the scroll container; RichGrid renders inline inside it.
  const streamRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: feedEntries.length,
    getScrollElement: () => streamRef.current,
    // A collapsed event row is ~one line; day separators are shorter and an
    // expanded row much taller. `measureAll` measures each real height, so the
    // estimate is only the pre-measure guess that keeps the scrollbar sane.
    estimateSize: () => 44,
    overscan: 12,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [feedEntries, rowVirtualizer]);

  // Expanded-row state = the nuqs `?fmsg=` scalar, fed in as RichGrid's selection
  // set (keyed by the entry id). The cell reads `isSelected` as "is open", so a
  // toggle only re-renders the two affected rows; `measureAll` re-measures the
  // newly-grown row. setOpenMsg uses the functional updater so the column set can
  // stay identity-stable (no `openMsg` in its deps) and per-row memo survives.
  // The row to open is the message's ROOT (a reply/ack has no top-level row of its
  // own — it folds into its parent). Resolving child→root here is what makes a
  // Colony message click land on the right conversation instead of nothing.
  const rootForOpen = openMsg ? (rootIdOf.get(openMsg) ?? openMsg) : null;
  const openSet = useMemo(() => new Set(rootForOpen ? [`item:${rootForOpen}`] : []), [rootForOpen]);

  // Deep-link landing (Colony/Swarm message click sets ?conv=feed&fagent=&fmsg=):
  // bring the target into view. Expansion is handled by `openSet`; here we (a) scroll
  // the virtualized list to the row once, and (b) if the message is older than the
  // loaded window, grow the window (bounded per target) until it appears. Without
  // this the correct row expands off-screen at the newest head and reads as "it
  // didn't open the right one."
  const openLoadRef = useRef<{ id: string | null; tries: number }>({ id: null, tries: 0 });
  const scrolledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!openMsg) {
      scrolledForRef.current = null;
      openLoadRef.current = { id: null, tries: 0 };
      return;
    }
    const target = rootForOpen ?? openMsg;
    const idx = feedEntries.findIndex((e) => e.kind === 'item' && e.row.msg_id === target);
    if (idx >= 0) {
      if (scrolledForRef.current !== openMsg) {
        scrolledForRef.current = openMsg;
        rowVirtualizer.scrollToIndex(idx, { align: 'center' });
      }
      return;
    }
    // Not in the loaded window yet — pull older pages, capped per target so a
    // genuinely-absent id can't drive an unbounded fetch loop.
    const st = openLoadRef.current;
    if (st.id !== openMsg) openLoadRef.current = { id: openMsg, tries: 0 };
    if (hasOlder && openLoadRef.current.tries < 5) {
      openLoadRef.current.tries += 1;
      loadOlder();
    }
  }, [openMsg, rootForOpen, feedEntries, hasOlder, loadOlder, rowVirtualizer]);
  const columns = useMemo<ColumnDef<FeedEntry>[]>(
    () => [
      {
        key: 'event',
        header: '',
        headerText: '',
        width: 1,
        toCopyText: (e) => (e.kind === 'item' ? e.row.summary ?? '' : dayLabel(e.day)),
        cellStyle: { display: 'block', padding: 0, overflow: 'visible' },
        render: ({ row: entry, isSelected }) =>
          entry.kind === 'day' ? (
            <div className="pc-advfeed__daysep">
              <span>{dayLabel(entry.day)}</span>
            </div>
          ) : (
            <FeedItem
              row={entry.row}
              children={entry.replies}
              open={false}
              active={isSelected}
              onToggle={() => void setOpenMsg((p) => (p === entry.row.msg_id ? null : entry.row.msg_id))}
              onPlanClick={(slug) => void setPlan(slug)}
              onAgentClick={(a) => void setAgent(a)}
            />
          ),
      },
    ],
    [setOpenMsg, setPlan, setAgent],
  );

  // The clicked row's ROOT (a reply/ack folds into its parent) is what the
  // detail pane renders — mirroring the curated Conversations master/detail:
  // left LIST rail of rows, click → open in the main detail pane (WI-4216,
  // [owner 2026-07-12] "make it work just like the curated Conversations
  // pane"). NOT a full-width inline-expand stream.
  const selectedRoot = rootForOpen ? allRows.find((r) => r.msg_id === rootForOpen) : null;

  return (
    <ConvFrame
      detailOpen={openMsg != null}
      onBack={openMsg ? () => void setOpenMsg(null) : undefined}
      filters={
        <div className="pc-advfeed__filters">
        <div className="pc-advfeed__filterhead">
          <div>
            <span>
              <SlidersHorizontal size={12} aria-hidden />
              Filter activity
            </span>
            <p>System coordination messages for debugging, newest first.</p>
          </div>
          <div className="pc-advfeed__filtermeta">
            <strong>{meta ? `${meta.total} matching` : head.loading ? 'loading…' : '0 matching'}</strong>
            <span>{roots.length} shown</span>
            <button
              type="button"
              className="pc-coord__chip pc-advfeed__refresh"
              aria-label="Reload activity log"
              disabled={head.fetching}
              onClick={() => head.invalidate()}
            >
              <RefreshCw size={11} aria-hidden />
            </button>
          </div>
        </div>
        <div className="pc-advfeed__needsline" aria-label="Activity summary">
          <span><UserRound size={11} aria-hidden /> {signalStats.humanCount} to human</span>
          <span><AlertTriangle size={11} aria-hidden /> {signalStats.escalationCount} escalation</span>
          <span><Megaphone size={11} aria-hidden /> {signalStats.broadcastCount} broadcast</span>
          <strong>{filtersActive ? `${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} active` : 'No filters'}</strong>
        </div>
        <div className="pc-coord__filters pc-advfeed__kindgroups" role="group" aria-label="Activity category filter">
          {FEED_KIND_GROUPS.map((g) => {
            const active = g.kinds.some((k) => kinds.includes(k));
            const n = groupCount(g.kinds);
            return (
              <Tooltip key={g.id} label={g.description}>
                <Pill
                  className="pc-advfeed__groupchip"
                  active={active}
                  accent="var(--advconv-accent)"
                  onClick={() => toggleKindGroup(g.kinds)}
                  aria-pressed={active}
                >
                  {g.label}
                  {n > 0 ? <span className="pc-advfeed__kindn">{n}</span> : null}
                </Pill>
              </Tooltip>
            );
          })}
          <Tooltip label="System-origin envelopes only (watchdog, git-sync, routines). Turn off to include agent-to-agent traffic — what a Fleet-sidebar message click does.">
            <Pill
              className="pc-advfeed__systoggle"
              active={systemOnly}
              accent="var(--advconv-accent)"
              onClick={() => void setScope(systemOnly ? 'all' : 'system')}
              aria-pressed={systemOnly}
              data-testid="feed-system-only-chip"
            >
              System only
            </Pill>
          </Tooltip>
          <Pill
            className="pc-advfeed__advancedtoggle"
            active={advancedKinds === 'open'}
            accent="#a78bfa"
            onClick={() => void setAdvancedKinds(advancedKinds === 'open' ? 'closed' : 'open')}
            aria-expanded={advancedKinds === 'open'}
          >
            Advanced / all kinds
          </Pill>
        </div>
        {advancedKinds === 'open' && (
          <div className="pc-coord__filters pc-advfeed__rawkinds" role="group" aria-label="Raw kind filter">
            {FEED_KINDS.map((k) => {
              // byKind is keyed by real CoordKind; 'broadcast' is synthetic and
              // cross-cuts every kind, so count it from loaded rows.
              const n = rawKindCount(k);
              const active = kinds.includes(k);
              return (
                <Pill
                  key={k}
                  className="pc-advfeed__kindchip"
                  active={active}
                  accent={FEED_KIND_COLOR[k] ?? FEED_KIND_FALLBACK}
                  onClick={() => toggleKind(k)}
                  aria-pressed={active}
                >
                  <span className="pc-advfeed__kinddot" style={{ background: FEED_KIND_COLOR[k] ?? FEED_KIND_FALLBACK }} aria-hidden />
                  {kindLabel(k)}
                  {typeof n === 'number' && n > 0 ? <span className="pc-advfeed__kindn">{n}</span> : null}
                </Pill>
              );
            })}
          </div>
        )}
        <div className="pc-advfeed__inputs">
          <label className="pc-advfeed__field">
            <span>Agent</span>
            <input
              className="pc-advfeed__input"
              style={inputStyle}
              placeholder="from or to…"
              value={agent}
              onChange={(e) => void setAgent(e.target.value)}
              aria-label="Filter by agent"
            />
          </label>
          <label className="pc-advfeed__field">
            <span>Plan</span>
            <input
              className="pc-advfeed__input"
              style={inputStyle}
              placeholder="plan slug…"
              value={plan}
              onChange={(e) => void setPlan(e.target.value)}
              aria-label="Filter by plan slug"
            />
          </label>
          <label className="pc-advfeed__field pc-advfeed__field--search">
            <span>
              <Search size={10} aria-hidden />
              Search
            </span>
            <input
              type="search"
              className="pc-advfeed__input pc-advfeed__input--search"
              style={inputStyle}
              placeholder="summary, body, event…"
              value={q}
              onChange={(e) => void setQ(e.target.value)}
              aria-label="Free-text search"
            />
          </label>
          {filtersActive && (
            <button type="button" className="pc-coord__chip pc-advfeed__clear" onClick={clearFilters}>
              clear
            </button>
          )}
        </div>
        {filtersActive && (
          <div className="pc-advfeed__scopebar" aria-label="Active feed filters">
            <span>Showing</span>
            {kinds.length > 0 && <strong>{kinds.join(', ')}</strong>}
            {!systemOnly && <strong>incl. agent traffic</strong>}
            {agent && <strong>agent: {agent}</strong>}
            {plan && <strong>plan: {plan}</strong>}
            {debouncedQ.trim() && <strong>search: {debouncedQ.trim()}</strong>}
          </div>
        )}
        </div>
      }
      list={
        <div className="pc-advfeed__stream" ref={streamRef}>
        {head.loading && allRows.length === 0 ? (
          <LoadingRows rows={6} label="Loading the coordination feed" />
        ) : head.error ? (
          <ErrorBanner>{friendlyApiError(undefined, head.error.message)}</ErrorBanner>
        ) : roots.length === 0 ? (
          <EmptyState
            icon={<Radio size={22} aria-hidden />}
            title="No matching traffic"
            desc="Clear a filter or broaden the search to return activity."
          />
        ) : (
          <RichGrid<FeedEntry>
            inline
            disableCopySupport
            headerStyle={{ display: 'none' }}
            columns={columns}
            getRowId={(e) => e.id}
            virtualMode={{
              virtualizer: rowVirtualizer,
              totalRows: feedEntries.length,
              rowAt: (i) => feedEntries[i],
              measureAll: true,
            }}
            selectedRowIds={openSet}
            getRowBg={gridTransparentBg}
            rowProps={streamRowProps}
          />
        )}
        {hasOlder && roots.length > 0 && (
          <button type="button" className="pc-advfeed__loadolder" onClick={loadOlder} disabled={head.fetching}>
            {head.fetching ? 'Loading…' : 'Load older ↓'}
          </button>
        )}
      </div>
      }
      detail={
        selectedRoot ? (
          <section className="pc-coord__detail pc-advfeed__detailpane">
            <FeedItem
              row={selectedRoot}
              children={childrenOf.get(selectedRoot.msg_id) ?? []}
              open
              active
              detail
              onToggle={() => {}}
              onPlanClick={(slug) => void setPlan(slug)}
              onAgentClick={(a) => void setAgent(a)}
            />
          </section>
        ) : (
          <section className="pc-coord__detail">
            <EmptyState
              style={{ minHeight: '100%' }}
              icon={<Radio size={22} aria-hidden />}
              title="Select a message"
              desc="Open a system-log message to view its full body and replies."
            />
          </section>
        )
      }
    />
  );
}

function FeedItem({
  row,
  children,
  open,
  active = false,
  detail = false,
  onToggle,
  onPlanClick,
  onAgentClick,
}: {
  row: FeedRow;
  children: FeedRow[];
  open: boolean;
  /** Selected/highlighted in the list rail. */
  active?: boolean;
  /** Rendered as the detail-pane instance (full-width, non-interactive header). */
  detail?: boolean;
  onToggle: () => void;
  onPlanClick: (slug: string) => void;
  onAgentClick: (a: string) => void;
}) {
  const badge = row.kind;
  const color = FEED_KIND_COLOR[row.broadcast ? 'broadcast' : badge] ?? FEED_KIND_FALLBACK;
  const summary =
    row.summary ||
    (row.kind === 'plan_event' && row.event ? `${row.event}${row.detail ? `: ${row.detail}` : ''}` : '');
  const hasDetail = !!row.body || children.length > 0 || !!row.detail || !!row.next_action;

  // The row is a grid (NOT a wrapping <button> — that can't legally contain the
  // nested from/plan filter buttons). The summary cell is the expand trigger;
  // from + plan are independent filter buttons; the rest are spans.
  return (
    <div className={`pc-advfeed__item${open ? ' is-open' : ''}${active ? ' is-active' : ''}${detail ? ' pc-advfeed__item--detail' : ''}`}>
      <div className="pc-advfeed__row">
        <span className="pc-advfeed__time" title={row.ts}>
          {clock(row.ts)}
        </span>
        <span className="pc-advfeed__badge" style={{ borderColor: color, color, ['--feed-kind-color' as string]: color }}>
          <span aria-hidden />
          {badge}
        </span>
        <span className="pc-advfeed__route">
          <button
            type="button"
            className="pc-advfeed__from"
            onClick={() => onAgentClick(row.from)}
            aria-label={`Filter to ${row.from}`}
          >
            {row.from}
          </button>
          <ToCell to={row.to ?? []} broadcast={row.broadcast} />
        </span>
        <button
          type="button"
          className="pc-advfeed__summary"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={hasDetail ? 'Expand row' : undefined}
        >
          {summary || <em className="pc-advfeed__nosum">(no summary)</em>}
        </button>
        {row.plan_slug && (
          <button
            type="button"
            className="pc-advfeed__planchip"
            onClick={() => onPlanClick(row.plan_slug!)}
            aria-label={`Filter to ${row.plan_slug}`}
          >
            {row.plan_slug}
          </button>
        )}
        {children.length > 0 && <span className="pc-advfeed__replyn">{children.length} {children.length === 1 ? 'reply' : 'replies'}</span>}
        <span className="pc-advfeed__rel">{relTime(row.ts)}</span>
      </div>
      {open && hasDetail && (
        <div className="pc-advfeed__detail">
          <div className="pc-advfeed__detailhead">
            <span>{row.surface}</span>
            <span>{dateStamp(row.ts)}</span>
            {row.event && <span>{row.event}</span>}
          </div>
          {row.body && (
            <div className="pc-advfeed__bodycard">
              <strong>Body</strong>
              <p className="pc-advfeed__body">{row.body}</p>
            </div>
          )}
          {row.next_action && (
            <div className="pc-advfeed__kv pc-advfeed__kv--action">
              <strong>next action</strong>
              <span>{row.next_action}</span>
            </div>
          )}
          {row.detail && !summary.includes(row.detail) && (
            <div className="pc-advfeed__kv">
              <strong>detail</strong>
              <span>{row.detail}</span>
            </div>
          )}
          {children.length > 0 && (
            <ol className="pc-advfeed__thread">
              {children.map((c) => (
                <li key={c.msg_id}>
                  <span className="pc-advfeed__threadrail" aria-hidden />
                  <span className="pc-advfeed__threadmeta">
                    <span
                      className="pc-advfeed__badge pc-advfeed__badge--sm"
                      style={{ borderColor: FEED_KIND_COLOR[c.kind] ?? FEED_KIND_FALLBACK, color: FEED_KIND_COLOR[c.kind] ?? FEED_KIND_FALLBACK }}
                    >
                      <span aria-hidden />
                      {c.kind}
                    </span>
                    <strong>{c.from}</strong>
                    <em>{relTime(c.ts)}</em>
                  </span>
                  <span className="pc-advfeed__threadsum">
                    {c.summary ?? (c.choice ? `choice: ${c.choice}` : c.body ?? '')}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Threads view — the conversations Q&A substrate (unchanged behaviour) ──

const CONV_STATES = ['open', 'resolved', 'closed', 'all'] as const;
type ConvStateFilter = (typeof CONV_STATES)[number];
const CONV_KINDS = ['all', 'question', 'discussion'] as const;
type ConvKindFilter = (typeof CONV_KINDS)[number];

/**
 * The Q&A thread reply box (P3 extract). Owns its own mid-edit draft (useState —
 * a draft is render-only, never user-meaningful URL state per the nuqs rule); the
 * parent keys it on the thread id so switching threads gives a fresh draft. The
 * post/resolve actions are passed in and return whether they succeeded, so the
 * draft only clears on success.
 */
function ReplyComposer({
  kind,
  busy,
  onReply,
  onResolve,
}: {
  kind: string;
  busy: boolean;
  onReply: (body: string) => Promise<boolean>;
  onResolve: (answer: string) => Promise<boolean>;
}) {
  const [reply, setReply] = useState('');
  const trimmed = reply.trim();
  return (
    <div className="pc-advconv__reply">
      <div className="pc-advconv__replyhead">
        <span>
          <MessageCircle size={13} aria-hidden />
          Thread response
        </span>
        <em>{kind === 'question' ? 'Resolve with an accepted answer when this closes the loop.' : 'Add context for everyone subscribed to this discussion.'}</em>
      </div>
      <textarea
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        placeholder={kind === 'question' ? 'Write a reply, or accept it as the answer…' : 'Write a reply…'}
        rows={2}
      />
      <div className="pc-coord__actions pc-advconv__replyactions">
        <button
          type="button"
          className="pc-advconv__replybtn"
          disabled={busy || !trimmed}
          onClick={() => { void onReply(trimmed).then((ok) => { if (ok) setReply(''); }); }}
        >
          <Send size={12} aria-hidden /> Reply
        </button>
        {kind === 'question' && (
          <button
            type="button"
            className="pc-advconv__replybtn pc-advconv__replybtn--resolve"
            disabled={busy || !trimmed}
            aria-label="Record this reply as the accepted answer and resolve the question"
            onClick={() => { void onResolve(trimmed).then((ok) => { if (ok) setReply(''); }); }}
          >
            <CheckCircle2 size={12} aria-hidden /> Accept as answer
          </button>
        )}
      </div>
    </div>
  );
}

function ThreadsView({
  detailOnly = false,
  loadingSummary,
}: {
  detailOnly?: boolean;
  loadingSummary?: UnifiedConversationRow;
} = {}) {
  const [state, setState] = useQueryState('cstate', parseAsStringEnum<ConvStateFilter>([...CONV_STATES]).withDefault('open'));
  const [kind, setKind] = useQueryState('ckind', parseAsStringEnum<ConvKindFilter>([...CONV_KINDS]).withDefault('all'));
  const [topic, setTopic] = useQueryState('ctopic', parseAsString.withDefault(''));
  const [sel, setSel] = useQueryState('conversation', parseAsString);
  const [busy, setBusy] = useState(false);
  // Refs in this view's callouts/prose open the thing they name (owner ask,
  // 2026-07-27). A `conversation` ref is a sibling row of THIS view, so it
  // re-targets the selection rather than stacking a modal on it.
  const refPopup = useConversationRefPopup('cref', null);
  const onOpenRef = useCallback(
    (ref: ConversationRef) => {
      if (ref.kind === 'conversation') {
        void setSel(ref.ref);
        return;
      }
      refPopup.open(ref);
    },
    [refPopup, setSel],
  );
  const listQuery = useSyncQuery<ConvRow>({
    queryName: 'conversations.questionsList',
    args: { limit: COMMS_LIST_LIMIT },
    // UnifiedInboxView deliberately stays mounted while a source detail is
    // open, so it already owns the warm questions list. Starting this view's
    // second list subscription in detail-only mode duplicated the read and
    // synchronously rebuilt topics/filters/virtualizer state on the click that
    // mounts the detail. The detail needs only its id-scoped query.
    enabled: !detailOnly,
    staleTime: 30_000,
  });
  const detailQuery = useSyncQuery<ConvDetailT>({
    queryName: 'conversations.questionDetail',
    args: { id: sel ?? '' },
    enabled: !!sel,
    staleTime: 30_000,
  });
  const list = listQuery.data ?? [];
  // usePollingQuery sets `placeholderData: keepPreviousData` on every
  // useSyncQuery (list AND per-id detail alike) so a filter/pagination change
  // stays warm instead of blanking. For an id-scoped DETAIL query that has a
  // sharp side effect: switching the selected thread hands back the PREVIOUS
  // thread's fully-loaded detail — mislabeled as the new selection — until the
  // new id's fetch resolves, which reads as the detail pane flashing/lagging
  // (WI-4142; the production Conversations flashing report). Guard on row
  // identity so a cross-id placeholder is never trusted as "the" detail; the
  // sel-mismatch case falls through to the loading skeleton below instead.
  const detailRow = detailQuery.data?.[0] ?? null;
  const detail = detailRow && detailRow.id === sel ? detailRow : null;
  const loading = listQuery.loading;
  const error = listQuery.error ? errText(listQuery.error) : null;

  const allTopics = useMemo(() => {
    const s = new Set<string>();
    for (const c of list) for (const t of c.topics ?? []) s.add(t);
    return [...s].sort();
  }, [list]);
  const visible = useMemo(() => list.filter((conversation) => (
    (state === 'all' || conversation.state === state)
    && (kind === 'all' || conversation.kind === kind)
    && (!topic || (conversation.topics ?? []).includes(topic))
  )), [list, state, kind, topic]);
  const act = async (verb: string, body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await coord(verb, body);
      listQuery.invalidate();
      if (sel) detailQuery.invalidate();
      return true;
    } catch (e) {
      toast.error(`Action failed: ${errText(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const canPromote = !!detail && detail.state !== 'closed' && !detail.promoted_issue_id;

  // U1 (operator-vite-ui-consolidation): the threads rail renders through the
  // shared, virtualized @papercusp/grid-core RichGrid — the same inline-virtualMode
  // template the agent-chats rail uses. `measureAll` is on because a thread row's
  // height varies (the optional topic-tag line wraps), so the virtualizer measures
  // real heights instead of trusting one estimate.
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: sel ? 0 : visible.length,
    getScrollElement: () => railScrollRef.current,
    estimateSize: () => 76,
    overscan: 10,
  });
  useEffect(() => {
    if (!sel) rowVirtualizer.measure();
  }, [visible, rowVirtualizer, sel]);
  const selectedSet = useMemo(() => new Set(sel ? [sel] : []), [sel]);
  const columns = useMemo<ColumnDef<ConvRow>[]>(
    () => [
      {
        key: 'thread',
        header: '',
        headerText: '',
        width: 1,
        toCopyText: (c) => c.title ?? c.id,
        cellStyle: { display: 'block', padding: 0, overflow: 'visible' },
        render: ({ row: c, isSelected }) => (
          <div className={`pc-coord__row${isSelected ? ' is-active' : ''}`}>
            <span className="pc-advconv__threadtop">
              <span className={`pc-coord__kind pc-coord__kind--${c.kind}`}>{c.kind}</span>
              <span className={`pc-advconv__statepill pc-advconv__statepill--${c.state}`}>{c.state}</span>
              <span className="pc-advconv__rowdate">{dateStamp(c.created_ts)}</span>
            </span>
            <span className="pc-coord__row-title">{c.title ?? c.id}</span>
            <span className="pc-coord__row-meta">
              {c.harness_slug ? potHomeLabel(c.harness_slug) : 'workspace'}
              {c.promoted_issue_id ? ` · → ${c.promoted_issue_id}` : ''}
            </span>
            {(c.topics ?? []).length > 0 && (
              <span className="pc-advconv__rowtags">
                {(c.topics ?? []).map((t) => (
                  <span key={t} className="pc-coord__tag">#{t}</span>
                ))}
              </span>
            )}
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <ConvFrame
      detailOnly={detailOnly}
      detailOpen={!!sel}
      onBack={() => void setSel(null)}
      filters={sel ? undefined : (
        <>
          <div className="pc-advconv__railhead">
            <span style={sectionHeaderStyle}>Question &amp; discussion threads</span>
          <strong>{loading && visible.length === 0 ? '…' : visible.length}</strong>
          </div>
          <div className="pc-coord__filters" role="group" aria-label="State filter">
            {CONV_STATES.map((s) => (
              <Pill key={s} active={state === s} accent="var(--advconv-accent)" aria-pressed={state === s} onClick={() => void setState(s)}>
                {s}
              </Pill>
            ))}
          </div>
          <div className="pc-coord__filters" role="group" aria-label="Kind filter">
            {CONV_KINDS.map((k) => (
              <Pill key={k} active={kind === k} accent="var(--advconv-accent)" aria-pressed={kind === k} onClick={() => void setKind(k)}>
                {k}
              </Pill>
            ))}
            <button
              type="button"
              className="pc-coord__chip pc-advconv__refresh"
              aria-label="Reload conversations"
              disabled={loading}
              onClick={() => listQuery.invalidate()}
            >
              <RefreshCw size={11} aria-hidden />
            </button>
          </div>
          {allTopics.length > 0 && (
            <div className="pc-coord__filters" role="group" aria-label="Topic filter">
              <Pill active={!topic} accent="var(--advconv-accent)" aria-pressed={!topic} onClick={() => void setTopic('')}>
                all topics
              </Pill>
              {allTopics.map((t) => (
                <Pill key={t} active={topic === t} accent="var(--advconv-accent)" aria-pressed={topic === t} onClick={() => void setTopic(topic === t ? '' : t)}>
                  #{t}
                </Pill>
              ))}
            </div>
          )}
        </>
      )}
      list={sel ? undefined : (
        <div className="pc-advconv__listscroll" ref={railScrollRef}>
          {loading && visible.length === 0 ? (
            <LoadingRows />
          ) : error && visible.length === 0 ? (
            <LoadError message={error} onRetry={() => listQuery.invalidate()} />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={<MessageCircle size={22} aria-hidden />}
              title="No threads match"
              desc="Change the state, kind, or topic filter to widen the thread rail."
            />
          ) : (
            <RichGrid<ConvRow>
              inline
              disableCopySupport
              headerStyle={{ display: 'none' }}
              columns={columns}
              getRowId={(c) => c.id}
              virtualMode={{
                virtualizer: rowVirtualizer,
                totalRows: visible.length,
                rowAt: (i) => visible[i],
                measureAll: true,
              }}
              selectedRowIds={selectedSet}
              onRowClick={(c) => void setSel(c.id)}
              getRowBg={gridTransparentBg}
              rowProps={railRowProps}
            />
          )}
        </div>
      )}
      detail={
        <section className="pc-coord__detail">
          {sel && !detail ? (
            <ConversationDetailLoading row={loadingSummary} label="Loading conversation" />
          ) : !detail ? (
          <EmptyState
            style={{ minHeight: '100%' }}
            icon={<MessageCircle size={22} aria-hidden />}
            title="Select a thread"
            desc="Open a question or discussion to review context, replies, accepted answers, and linked work-items."
          />
        ) : (
          <article className="pc-coord__card">
            <header className="pc-advconv__detailhead">
              <div>
                <p className="pc-advconv__detailkicker">
                  <span className={`pc-coord__kind pc-coord__kind--${detail.kind}`}>{detail.kind}</span>
                  <span className={`pc-advconv__statepill pc-advconv__statepill--${detail.state}`}>{detail.state}</span>
                </p>
                <h2>{detail.title ?? detail.id}</h2>
              </div>
              <div className="pc-advconv__detailstats" aria-label="Conversation metadata">
                <span><strong>{detail.subscriber_count}</strong> follower{detail.subscriber_count === 1 ? '' : 's'}</span>
                <span>{detail.scope === 'harness' && detail.harness_slug ? potHomeLabel(detail.harness_slug) : 'workspace'}</span>
                {detail.asker_id && <span>asked by {detail.asker_id}</span>}
              </div>
            </header>
            {detail.topics.length > 0 && (
              <p className="pc-coord__tags">
                {detail.topics.map((t) => (
                  <span key={t} className="pc-coord__tag">#{t}</span>
                ))}
              </p>
            )}
            {detail.body && (
              <p className="pc-coord__body">
                <LinkifiedText text={detail.body} harnessSlug={detail.harness_slug} onOpen={onOpenRef} />
              </p>
            )}
            {detail.accepted_answer && (
              <div className="pc-advconv__callout pc-advconv__callout--accepted">
                <CheckCircle2 size={15} aria-hidden />
                <div>
                  <strong>Accepted answer</strong>
                  <p>
                    <LinkifiedText
                      text={detail.accepted_answer}
                      harnessSlug={detail.harness_slug}
                      onOpen={onOpenRef}
                    />
                  </p>
                </div>
              </div>
            )}
            {detail.promoted_issue_id && (
              <div className="pc-advconv__callout pc-advconv__callout--linked">
                <ArrowUpRight size={15} aria-hidden />
                <div>
                  <strong>Linked work-item</strong>
                  <p>
                    {/* Opens the item instead of naming it (owner, 2026-07-27). */}
                    <ConversationRefLink
                      refValue={{ kind: 'issue', ref: detail.promoted_issue_id }}
                      harnessSlug={detail.harness_slug}
                      onOpen={onOpenRef}
                      size="sm"
                    />
                    <em>Promoted to an engineer issue; implementation discussion continues there.</em>
                  </p>
                </div>
              </div>
            )}
            <div className="pc-coord__actions">
              {canPromote && (
                <button type="button" disabled={busy} aria-label="Promote this conversation to an engineer issue" onClick={() => void act('conversations/promote', { conversation_id: detail.id })}>
                  <ArrowUpRight size={13} aria-hidden /> Promote to issue
                </button>
              )}
            </div>
            {detail.posts.length === 0 ? (
              <EmptyState
                icon={<MessageCircle size={22} aria-hidden />}
                title="No replies yet"
                desc="This thread is waiting for its first response."
              />
            ) : (
              <ol className="pc-coord__thread">
                {detail.posts.map((p) => (
                  <li key={p.id}>
                    <span className="pc-advconv__postmeta">
                      <strong>{p.author_id ?? 'unknown'}</strong>
                      {p.created_ts && <span>{dateStamp(p.created_ts)}</span>}
                    </span>
                    <p>
                      <LinkifiedText text={p.body} harnessSlug={detail.harness_slug} onOpen={onOpenRef} />
                    </p>
                  </li>
                ))}
              </ol>
            )}
            {refPopup.element}
            {detail.state === 'open' && (
              <ReplyComposer
                key={detail.id}
                kind={detail.kind}
                busy={busy}
                onReply={(body) => act('conversations/post', { conversation_id: detail.id, body })}
                onResolve={(answer) => act('conversations/resolve', { conversation_id: detail.id, accepted_answer: answer })}
              />
            )}
          </article>
        )}
        </section>
      }
    />
  );
}

// ─── Deliberations — coord:thread / deliberate / vote posts on an entity ────

function DeliberationsView({
  detailOnly = false,
  loadingSummary,
}: {
  detailOnly?: boolean;
  loadingSummary?: UnifiedConversationRow;
} = {}) {
  const [sel, setSel] = useQueryState('thread', parseAsString);
  const [, setConvRoute] = useQueryStates(CONVERSATION_ROUTE_PARAMS);
  const listQuery = useSyncQuery<ThreadRow>({
    queryName: 'conversations.deliberationList',
    args: { limit: COMMS_LIST_LIMIT },
    // The unified parent remains mounted and already owns this list while the
    // selected detail is visible. Avoid a duplicate subscription on the hot
    // master/detail click path; only the id-scoped detail query is needed here.
    enabled: !detailOnly,
    staleTime: 30_000,
  });
  const detailQuery = useSyncQuery<DeliberationDetail>({
    queryName: 'conversations.deliberationDetail',
    args: { id: sel ?? '' },
    enabled: !!sel,
    staleTime: 30_000,
  });
  const list = listQuery.data ?? [];
  const total = readListTotal(list);
  // See the matching guard + comment in ThreadsView: keepPreviousData means a
  // just-switched selection can hand back the PREVIOUS thread's detail row
  // mislabeled as the new one until its own fetch resolves. Only trust it once
  // its own thread_id matches the current selection (WI-4142).
  const detailRow = detailQuery.data?.[0];
  const detail = detailRow && detailRow.thread?.thread_id === sel ? detailRow : undefined;
  const head = detail?.thread ?? null;
  const posts = detail?.posts ?? [];
  const loading = listQuery.loading;
  const error = listQuery.error ? errText(listQuery.error) : null;

  // `parent_kind` is the store's OWN typed parent (issue · feature ·
  // conversation), so the ref never has to be guessed from the string shape.
  const attachedRef = useMemo<ConversationRef | null>(() => {
    const kind = asConversationRefKind(head?.parent_kind);
    return kind && head?.parent_ref ? { kind, ref: head.parent_ref } : null;
  }, [head?.parent_kind, head?.parent_ref]);
  const refPopup = useConversationRefPopup('cref', head?.harness_slug ?? null);
  const onOpenRef = useCallback(
    (ref: ConversationRef) => {
      // A thread attached to a CONVERSATION opens that conversation's own view,
      // not a work-item popup — the thing it names is a sibling surface.
      if (ref.kind === 'conversation') {
        void setConvRoute({ conv: 'threads', ...EMPTY_CONVERSATION_SELECTION, conversation: ref.ref });
        return;
      }
      refPopup.open(ref);
    },
    [refPopup, setConvRoute],
  );

  // U1 (operator-vite-ui-consolidation): the deliberations rail renders through
  // the shared, virtualized @papercusp/grid-core RichGrid (the agent-chats
  // inline-virtualMode template). `measureAll` keeps offsets exact as titles wrap.
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: sel ? 0 : list.length,
    getScrollElement: () => railScrollRef.current,
    estimateSize: () => 70,
    overscan: 10,
  });
  useEffect(() => {
    if (!sel) rowVirtualizer.measure();
  }, [list, rowVirtualizer, sel]);
  const selectedSet = useMemo(() => new Set(sel ? [sel] : []), [sel]);
  const columns = useMemo<ColumnDef<ThreadRow>[]>(
    () => [
      {
        key: 'thread',
        header: '',
        headerText: '',
        width: 1,
        toCopyText: (t) => t.title ?? t.thread_id,
        cellStyle: { display: 'block', padding: 0, overflow: 'visible' },
        render: ({ row: t, isSelected }) => (
          <div className={`pc-coord__row${isSelected ? ' is-active' : ''}`}>
            <span className="pc-advconv__threadtop">
              <span className="pc-coord__kind">{t.parent_kind ?? 'thread'}</span>
              {t.parent_ref ? <span className="pc-advconv__statepill">{t.parent_ref}</span> : null}
              <span className="pc-advconv__rowdate">{fmtTs(t.last_post_at ?? t.created_at)}</span>
            </span>
            <span className="pc-coord__row-title">{t.title ?? t.thread_id}</span>
            <span className="pc-coord__row-meta">
              {t.harness_slug ? potHomeLabel(t.harness_slug) : 'workspace'} · {t.post_count} post{t.post_count === 1 ? '' : 's'}
              {t.created_by ? ` · ${t.created_by}` : ''}
            </span>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <ConvFrame
      detailOnly={detailOnly}
      detailOpen={!!sel}
      onBack={() => void setSel(null)}
      filters={sel ? undefined : (
        <div className="pc-advconv__railhead">
          <span style={sectionHeaderStyle}>Deliberation threads</span>
          <strong>{loading && list.length === 0 ? '…' : listCountLabel(list.length, total)}</strong>
          <button type="button" className="pc-coord__chip pc-advconv__refresh" aria-label="Reload deliberations" disabled={loading} onClick={() => listQuery.invalidate()}>
            <RefreshCw size={11} aria-hidden />
          </button>
        </div>
      )}
      list={sel ? undefined : (
        <div className="pc-advconv__listscroll" ref={railScrollRef}>
          {loading && list.length === 0 ? (
            <LoadingRows />
          ) : error && list.length === 0 ? (
            <LoadError message={error} onRetry={() => listQuery.invalidate()} />
          ) : list.length === 0 ? (
            <EmptyState
              icon={<MessagesSquare size={22} aria-hidden />}
              title="No deliberations"
              desc="No coord:thread / deliberate / vote discussions recorded."
            />
          ) : (
            <RichGrid<ThreadRow>
              inline
              disableCopySupport
              headerStyle={{ display: 'none' }}
              columns={columns}
              getRowId={(t) => t.thread_id}
              virtualMode={{
                virtualizer: rowVirtualizer,
                totalRows: list.length,
                rowAt: (i) => list[i],
                measureAll: true,
              }}
              selectedRowIds={selectedSet}
              onRowClick={(t) => void setSel(t.thread_id)}
              getRowBg={gridTransparentBg}
              rowProps={railRowProps}
            />
          )}
        </div>
      )}
      detail={
        <section className="pc-coord__detail">
          {sel && !head ? (
            <ConversationDetailLoading row={loadingSummary} label="Loading deliberation" />
          ) : !head ? (
          <EmptyState
            style={{ minHeight: '100%' }}
            icon={<MessagesSquare size={22} aria-hidden />}
            title="Select a deliberation"
            desc="Open a thread to read its discussion posts."
          />
        ) : (
          <article className="pc-coord__card">
            <header className="pc-advconv__detailhead">
              <div>
                <p className="pc-advconv__detailkicker">
                  <span className="pc-coord__kind">{head.parent_kind ?? 'thread'}</span>
                  {/* "Attached to" used to be dead text naming a work item you
                      then had to go find by hand (owner ask, 2026-07-27). */}
                  {attachedRef ? (
                    <ConversationRefLink
                      refValue={attachedRef}
                      harnessSlug={head.harness_slug}
                      onOpen={onOpenRef}
                      size="sm"
                    />
                  ) : head.parent_ref ? (
                    <span className="pc-advconv__statepill">{head.parent_ref}</span>
                  ) : null}
                </p>
                <h2>{head.title ?? head.thread_id}</h2>
              </div>
              <div className="pc-advconv__detailstats" aria-label="Thread metadata">
                <span>{head.harness_slug ? potHomeLabel(head.harness_slug) : 'workspace'}</span>
                <span><strong>{posts.length}</strong> posts</span>
              </div>
            </header>
            {posts.length === 0 ? (
              <EmptyState
                icon={<MessagesSquare size={22} aria-hidden />}
                title="No posts"
                desc="This thread has no recorded posts."
              />
            ) : (
              <ol className="pc-coord__thread pc-advconv__transcript">
                {posts.map((p) => (
                  <li key={p.id} className="pc-advconv__turn">
                    <span className="pc-advconv__postmeta">
                      <strong>{p.author_id ?? 'unknown'}</strong>
                      <span>{fmtTs(p.created_at)}</span>
                    </span>
                    <p>
                      <LinkifiedText
                        text={p.body}
                        harnessSlug={p.harness_slug ?? head.harness_slug}
                        onOpen={onOpenRef}
                      />
                    </p>
                  </li>
                ))}
              </ol>
            )}
            {refPopup.element}
          </article>
        )}
        </section>
      }
    />
  );
}

// ─── Agent chats — the per-feature/per-role multi-turn transcripts ──────

function AgentChatsView({
  detailOnly = false,
  loadingSummary,
}: {
  detailOnly?: boolean;
  loadingSummary?: UnifiedConversationRow;
} = {}) {
  const [harness, setHarness] = useQueryState('acharness', parseAsString.withDefault(''));
  const [role, setRole] = useQueryState('acrole', parseAsString.withDefault(''));
  const [sel, setSel] = useQueryState('chat', parseAsString);
  const listArgs = useMemo(() => ({
    limit: COMMS_LIST_LIMIT,
    ...(harness ? { harness } : {}),
    ...(role ? { role } : {}),
  }), [harness, role]);
  const listQuery = useSyncQuery<AgentChatRow>({
    queryName: 'conversations.agentChatList',
    args: listArgs,
    // UnifiedInboxView keeps the agent-chat list warm while this detail-only
    // child mounts. A second enabled list query needlessly rebuilt its facets
    // and virtual rail during the measured click.
    enabled: !detailOnly,
    staleTime: 30_000,
  });
  const detailQuery = useSyncQuery<AgentChatDetail>({
    queryName: 'conversations.agentChatDetail',
    args: { id: sel ?? '' },
    enabled: !!sel,
    staleTime: 30_000,
  });
  const list = listQuery.data ?? [];
  const total = readListTotal(list);
  // See the matching guard + comment in ThreadsView (WI-4142): don't trust a
  // keepPreviousData cross-id placeholder — a chat switch can otherwise show
  // the PREVIOUS session's transcript mislabeled as the new selection.
  const detailRow = detailQuery.data?.[0] ?? null;
  const detail = detailRow && detailRow.id === sel ? detailRow : null;
  const loading = listQuery.loading;
  const error = listQuery.error ? errText(listQuery.error) : null;

  const harnesses = useMemo(() => [...new Set(list.map((c) => c.harness_slug).filter(Boolean))].sort() as string[], [list]);
  const roles = useMemo(() => [...new Set(list.map((c) => c.role).filter(Boolean))].sort() as string[], [list]);

  // U1 (operator-vite-ui-consolidation): the agent-chats rail renders through
  // the shared, virtualized @papercusp/grid-core RichGrid instead of a raw
  // `.map()`. RichGrid runs in `inline` mode so the sidebar `.pc-advconv__listscroll`
  // stays the scroll container; one full-width column whose `render` emits the
  // original `.pc-coord__row` card keeps the visual result identical.
  // `virtualMode` mounts only the visible window (the list pulls up to 500
  // sessions). This is the template for the other rails — see the report for
  // the grouped/expandable gap the live coord feed will hit next.
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: sel ? 0 : list.length,
    getScrollElement: () => railScrollRef.current,
    // Three stacked lines (top meta / title / meta) inside a 7px-padded card.
    // Rows are uniform height, so a matching estimate keeps virtual offsets
    // exact; RichGrid only re-measures expanded rows, which this list has none.
    estimateSize: () => 64,
    overscan: 10,
  });
  useEffect(() => {
    if (!sel) rowVirtualizer.measure();
  }, [list, rowVirtualizer, sel]);

  // RichGrid's selection set, derived from the nuqs `?chat=` scalar — drives
  // the cell's `isSelected` → `.pc-coord__row.is-active` styling.
  const selectedSet = useMemo(() => new Set(sel ? [sel] : []), [sel]);

  // One full-width column. RichGrid's cell wrapper is `display:flex` and adds
  // its own padding; we strip that via `cellStyle` and render the original
  // `.pc-coord__row` card (with its stacked-span layout from coordination.css)
  // as the cell body, so the visual result is byte-for-byte the prior markup.
  const columns = useMemo<ColumnDef<AgentChatRow>[]>(
    () => [
      {
        key: 'session',
        header: '',
        headerText: '',
        width: 1,
        toCopyText: (c) => c.title ?? c.id,
        cellStyle: { display: 'block', padding: 0, overflow: 'visible' },
        render: ({ row: c, isSelected }) => (
          <div className={`pc-coord__row${isSelected ? ' is-active' : ''}`}>
            <span className="pc-advconv__threadtop">
              <span className="pc-coord__kind">{c.role ?? 'agent'}</span>
              {c.archived_at ? <span className="pc-advconv__statepill pc-advconv__statepill--closed">archived</span> : null}
              <span className="pc-advconv__rowdate">{fmtTs(c.created_at)}</span>
            </span>
            <span className="pc-coord__row-title">{c.title ?? c.id}</span>
            <span className="pc-coord__row-meta">
              {c.harness_slug ? potHomeLabel(c.harness_slug) : 'workspace'}{c.feature_id ? ` · ${c.feature_id}` : ''} · {c.turns} turn{c.turns === 1 ? '' : 's'}
            </span>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <ConvFrame
      detailOnly={detailOnly}
      detailOpen={!!sel}
      onBack={() => void setSel(null)}
      filters={sel ? undefined : (
        <>
          <div className="pc-advconv__railhead">
            <span style={sectionHeaderStyle}>Agent chat sessions</span>
            <strong>{loading && list.length === 0 ? '…' : listCountLabel(list.length, total)}</strong>
          </div>
          {harnesses.length > 0 && (
            <div className="pc-coord__filters" role="group" aria-label="Harness filter">
              <Pill active={!harness} accent="var(--advconv-accent)" aria-pressed={!harness} onClick={() => void setHarness('')}>all</Pill>
              {harnesses.map((h) => (
                <Pill key={h} active={harness === h} accent="var(--advconv-accent)" aria-pressed={harness === h} onClick={() => void setHarness(harness === h ? '' : h)}>{h}</Pill>
              ))}
              <button type="button" className="pc-coord__chip pc-advconv__refresh" aria-label="Reload agent chats" disabled={loading} onClick={() => listQuery.invalidate()}>
                <RefreshCw size={11} aria-hidden />
              </button>
            </div>
          )}
          {roles.length > 0 && (
            <div className="pc-coord__filters" role="group" aria-label="Role filter">
              <Pill active={!role} accent="var(--advconv-accent)" aria-pressed={!role} onClick={() => void setRole('')}>all roles</Pill>
              {roles.map((r) => (
                <Pill key={r} active={role === r} accent="var(--advconv-accent)" aria-pressed={role === r} onClick={() => void setRole(role === r ? '' : r)}>{r}</Pill>
              ))}
            </div>
          )}
        </>
      )}
      list={sel ? undefined : (
        <div className="pc-advconv__listscroll" ref={railScrollRef}>
          {loading && list.length === 0 ? (
            <LoadingRows />
          ) : error && list.length === 0 ? (
            <LoadError message={error} onRetry={() => listQuery.invalidate()} />
          ) : list.length === 0 ? (
            <EmptyState
              icon={<Bot size={22} aria-hidden />}
              title="No agent chats"
              desc="No multi-turn agent chat sessions match the current filter."
            />
          ) : (
            <RichGrid<AgentChatRow>
              inline
              disableCopySupport
              // The rail was a flat list of cards with no header. RichGrid always
              // renders its sticky header row, so hide it to keep the prior look.
              // (grid-core gap: no `hideHeader` prop — noted in the U1 report.)
              headerStyle={{ display: 'none' }}
              columns={columns}
              getRowId={(c) => c.id}
              virtualMode={{
                virtualizer: rowVirtualizer,
                totalRows: list.length,
                rowAt: (i) => list[i],
              }}
              // Selection is the nuqs `?chat=` param — feed it in so the cell's
              // `isSelected` drives the original `.pc-coord__row.is-active` style.
              selectedRowIds={selectedSet}
              onRowClick={(c) => void setSel(c.id)}
              // The card look is fully class-driven (.pc-advconv
              // .pc-coord__row). Neutralize RichGrid's own per-row chrome
              // (striping bg + bottom border) so only the original styling shows;
              // the 6px inter-card gap the flex rail used becomes per-row bottom
              // padding since virtual rows are positioned edge-to-edge. Stable
              // hoisted refs so memo(BodyRow) skips untouched rows (see top of file).
              getRowBg={gridTransparentBg}
              rowProps={railRowProps}
            />
          )}
        </div>
      )}
      detail={
        <section className="pc-coord__detail">
        {sel && !detail ? (
          <ConversationDetailLoading row={loadingSummary} label="Loading chat" />
        ) : !detail ? (
          <EmptyState
            style={{ minHeight: '100%' }}
            icon={<Bot size={22} aria-hidden />}
            title="Select a chat"
            desc="Open an agent chat session to read its full transcript."
          />
        ) : (
          <article className="pc-coord__card">
            <header className="pc-advconv__detailhead">
              <div>
                <p className="pc-advconv__detailkicker">
                  <span className="pc-coord__kind">{detail.role ?? 'agent'}</span>
                  {detail.feature_id ? <span className="pc-advconv__statepill">{detail.feature_id}</span> : null}
                </p>
                <h2>{detail.title ?? detail.id}</h2>
              </div>
              <div className="pc-advconv__detailstats" aria-label="Chat metadata">
                <span>{detail.harness_slug ? potHomeLabel(detail.harness_slug) : 'workspace'}</span>
                <span><strong>{(detail.transcript ?? []).length}</strong> turns</span>
                <span>${((detail.total_cost_usd_cents ?? 0) / 100).toFixed(2)} · {(detail.total_input_tokens ?? 0) + (detail.total_output_tokens ?? 0)} tok</span>
              </div>
            </header>
            {detail.archived_at == null && detail.harness_slug ? (
              // WI-125: a LIVE chat is interactive here — the real <ChatPanel>
              // (transcript + streaming composer + archive), the same audited
              // send path the dock chat slots use. Archived chats keep the
              // read-only transcript below.
              <div className="pc-advconv__livechat" data-testid="advconv-live-chat">
                <ChatPanel
                  slug={detail.harness_slug}
                  chatId={detail.id}
                  onArchive={() => {
                    void setSel(null);
                    listQuery.invalidate();
                    detailQuery.invalidate();
                  }}
                />
              </div>
            ) : (detail.transcript ?? []).length === 0 ? (
              <EmptyState
                icon={<Bot size={22} aria-hidden />}
                title="Empty transcript"
                desc="This chat session has no recorded turns."
              />
            ) : (
              <ol className="pc-coord__thread pc-advconv__transcript">
                {(detail.transcript ?? []).map((t, i) => {
                  const projectedTurn = projectChatFailureTranscriptTurn(t);
                  return (
                    <li key={i} className={`pc-advconv__turn pc-advconv__turn--${t.role ?? 'unknown'}`}>
                      <span className="pc-advconv__postmeta">
                        <strong>{t.role ?? 'unknown'}</strong>
                        {t.ts ? <span>{fmtTs(t.ts)}</span> : null}
                      </span>
                      <p>{turnText(projectedTurn.content)}</p>
                    </li>
                  );
                })}
              </ol>
            )}
          </article>
        )}
        </section>
      }
    />
  );
}

// ─── Agent messages — agent↔agent coord:send traffic ───────────────────
//
// The highest-volume conversation type in the system (82,440 agent-authored
// envelopes; 10,633 `message` in a single week) and, until
// conversations-agent-messages-2026-07-27, one with no curated home: it existed
// only inside Raw events, which defaults to `system_only` and therefore SHOWED
// the ~1.6k system envelopes while FILTERING OUT the ~10.6k agent ones. Owner,
// 2026-07-27: "I see agents sending messages to each other all the time but I
// only see 51 chat messages and 85 decision messages."
//
// Raw events keeps its system-only default on purpose (plan D-004): with agent
// traffic curated HERE, that view is genuinely the system-diagnostic complement
// its own description already claims it is.

function AgentMessagesView({
  detailOnly = false,
  loadingSummary,
}: {
  detailOnly?: boolean;
  loadingSummary?: UnifiedConversationRow;
}) {
  const [route, setRoute] = useQueryStates(CONVERSATION_ROUTE_PARAMS);
  const sel = route.cmsg;
  // No list read here: `messages` is an INTERNAL detail route (the unified
  // inbox owns the list, and it already holds a warm `agentMessageList` cache).
  const detailQuery = useSyncQuery<AgentMessageDetail>({
    queryName: 'conversations.agentMessageDetail',
    args: { id: sel ?? '' },
    enabled: !!sel,
    staleTime: 30_000,
  });
  // The warm-previous-data guard every sibling detail view carries (WI-4142):
  // only trust a payload whose own id matches the current selection.
  const raw = detailQuery.data?.[0] ?? null;
  const detail = raw && raw.message?.msg_id === sel ? raw : null;
  const head = detail?.message;
  const replies = detail?.replies ?? [];

  const refPopup = useConversationRefPopup('cref', head?.harness_slug ?? null);
  const onOpenRef = useCallback(
    (ref: ConversationRef) => {
      if (ref.kind === 'conversation') {
        void setRoute({ conv: 'threads', ...EMPTY_CONVERSATION_SELECTION, conversation: ref.ref });
        return;
      }
      refPopup.open(ref);
    },
    [refPopup, setRoute],
  );
  const audienceRef = useMemo(() => parseAudienceRef(head?.audience), [head?.audience]);

  return (
    <ConvFrame
      detailOnly={detailOnly}
      detail={
        <section className="pc-coord__detail">
          {sel && !head ? (
            <ConversationDetailLoading row={loadingSummary} label="Loading message" />
          ) : !head ? (
            <EmptyState
              style={{ minHeight: '100%' }}
              icon={<Send size={22} aria-hidden />}
              title="Select a message"
              desc="Open an agent message to read its body and reply chain."
            />
          ) : (
            <article className="pc-coord__card">
              <header className="pc-advconv__detailhead">
                <div>
                  <p className="pc-advconv__detailkicker">
                    <span className="pc-coord__kind">{head.kind}</span>
                    {head.lifecycle ? (
                      <span className="pc-advconv__statepill">{head.lifecycle}</span>
                    ) : null}
                    {head.broadcast ? (
                      <span className="pc-advconv__statepill">
                        <Megaphone size={10} aria-hidden /> broadcast
                      </span>
                    ) : null}
                  </p>
                  <h2>{head.summary ?? loadingSummary?.title ?? head.msg_id}</h2>
                </div>
                <div className="pc-advconv__detailstats" aria-label="Message metadata">
                  <span>{head.harness_slug ? potHomeLabel(head.harness_slug) : 'workspace'}</span>
                  <span>
                    <strong>{replies.length}</strong> replies
                  </span>
                  <span>{fmtTs(head.ts)}</span>
                </div>
              </header>

              <div className="pc-advconv__detailstats" aria-label="Routing">
                <span>from {head.from}</span>
                <span>
                  {head.broadcast
                    ? 'to everyone'
                    : head.to.length === 0
                      ? 'no direct recipient'
                      : `to ${head.to.join(', ')}`}
                </span>
                {/* Audience selectors are how coord:send actually addresses; the
                    one that names an openable object becomes a real link. */}
                {audienceRef ? (
                  <span>
                    about{' '}
                    <ConversationRefLink
                      refValue={audienceRef}
                      harnessSlug={head.harness_slug}
                      onOpen={onOpenRef}
                      size="sm"
                    />
                  </span>
                ) : head.plan_slug ? (
                  <span>
                    plan{' '}
                    <ConversationRefLink
                      refValue={{ kind: 'plan', ref: head.plan_slug }}
                      harnessSlug={head.harness_slug}
                      onOpen={onOpenRef}
                      size="sm"
                    />
                  </span>
                ) : null}
              </div>

              {head.body ? (
                <p className="pc-advconv__body">
                  <LinkifiedText
                    text={head.body}
                    harnessSlug={head.harness_slug}
                    onOpen={onOpenRef}
                  />
                </p>
              ) : null}

              {/* P-033 (e): same block as the sidebar pane, from the same
                  server-side projection — two renderings of D-064's split would
                  be two chances to drift from it. */}
              <AuthoredFields authored={head.authored} />

              {replies.length === 0 ? (
                <EmptyState
                  icon={<Send size={22} aria-hidden />}
                  title="No replies"
                  desc="Nobody has acked or answered this message."
                />
              ) : (
                <ol className="pc-coord__thread pc-advconv__transcript">
                  {replies.map((r) => (
                    <li key={r.msg_id} className="pc-advconv__turn">
                      <span className="pc-advconv__postmeta">
                        <strong>{r.from || 'unknown'}</strong>
                        <span>{fmtTs(r.ts)}</span>
                      </span>
                      <p>
                        <LinkifiedText
                          text={r.body ?? r.summary}
                          harnessSlug={head.harness_slug}
                          onOpen={onOpenRef}
                        />
                      </p>
                    </li>
                  ))}
                </ol>
              )}
              {refPopup.element}
            </article>
          )}
        </section>
      }
    />
  );
}

// ─── Styles ──────────────────────────────────────────────────────────

function AdvConvStyles() {
  return (
    <style>{`
      .pc-advconv {
        --advconv-bg: var(--bg, #07101d);
        --advconv-panel: color-mix(in srgb, var(--bg-1, #0b1220), transparent 14%);
        --advconv-panel-strong: color-mix(in srgb, var(--bg-popover, #0d1829), transparent 6%);
        --advconv-border: var(--border, rgba(125, 211, 252, 0.15));
        --advconv-border-strong: var(--border-strong, rgba(125, 211, 252, 0.32));
        --advconv-accent: var(--accent);
        --advconv-accent-strong: var(--accent-strong, var(--accent));
        --advconv-accent-soft: color-mix(in oklab, var(--accent), transparent 86%);
        --advconv-accent-softer: color-mix(in oklab, var(--accent), transparent 92%);
        --advconv-good-soft: color-mix(in oklab, var(--good, #22c55e), transparent 88%);
        --advconv-warn-soft: color-mix(in oklab, var(--warn, #f59e0b), transparent 90%);
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        padding: 0;
        color: var(--fg, #dceaf6);
        background: var(--advconv-bg);
        overflow-x: auto;
        overflow-y: hidden;
      }
      /* Shell — a persistent left nav rail + a main pane, mirroring the Create
         dock's sidebar│main split. The page title now lives in the AdvShell
         header, so there is no in-body <h1>. */
      .pc-advconv__shell {
        flex: 1 1 auto;
        min-height: 0;
        display: grid;
        grid-template-columns: 64px minmax(300px, 360px) minmax(0, 1fr);
        align-items: stretch;
        background: var(--advconv-bg);
        min-width: 760px;
      }
      /* The nav reuses .pc-plans__rail (border-right + column flex + bg) for
         pixel parity with the Create sidebar; only its width is set here.

         STICKY, deliberately (P-003 / plan decisions D-001 + D-002). The shell
         below is min-width 760px inside an overflow-x:auto root, and the /adv
         content column is routinely narrower than that -- measured 2026-08-30 on
         an isolated verifier rig, the scroll container is 648px at the desktop's
         own minimum window width (tauri.conf.json minWidth 800) and 470px at a
         1200px window, so the shell scrolls horizontally by 112px and 290px
         respectively. Left unpinned the rail scrolls away with everything else:
         at 800px its left edge measured -8px at maximum scroll, i.e. navigation
         is partly off-screen exactly when the user has scrolled to read the
         detail pane. Pinning it to the scrollport keeps navigation reachable at
         every scroll offset WITHOUT touching the information architecture --
         master-detail stays invariant at every width per D-001, which rules out
         the reverted narrow-width drill-in.

         background-color is set (not background) so .pc-plans__rail's gradient
         background-image survives for pixel parity, while the rail gains an
         opaque base. The gradient alone is translucent, so a sticky rail without
         this would show the inbox sliding underneath it.

         max-height / border-bottom are reset because plans.css is imported
         globally by routes/adv/index.tsx and its
         "@media (max-width: 980px) .pc-plans__rail" rule -- written for the
         plans page's single-column collapse -- otherwise reaches this rail,
         which does NOT collapse. Measured: the rail computed max-height 522px
         (58vh) at both 900px and 800px windows while the inbox and detail panes
         were 800px tall, so the rail visibly stopped ~278px short of the bottom.
         Only max-height and border-bottom leak; border-right is already won back
         by this rule on document order (measured 1px at 800px). */
      .pc-advconv__nav {
        flex: 0 0 auto;
        width: 64px;
        min-height: 0;
        border-right: 1px solid var(--advconv-border);
        position: sticky;
        left: 0;
        z-index: 2;
        background-color: var(--advconv-bg);
        max-height: none;
        border-bottom: none;
      }
      .pc-advconv__nav-actions {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
        padding: 10px 8px;
      }
      .pc-advconv__nav-actions .pc-plans__new-plan {
        flex: 0 0 auto;
        width: 40px;
        height: 40px;
        min-height: 40px;
        justify-content: center;
        padding: 5px;
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 44%);
        background: color-mix(in oklab, var(--advconv-accent), transparent 84%);
      }
      .pc-advconv__nav-switcher {
        display: flex;
        flex-direction: column;
        gap: 7px;
        min-width: 0;
      }
      .pc-advconv__nav-primary {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
      }
      .pc-advconv__nav-diagnostic {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
        padding-top: 7px;
        border-top: 1px solid var(--advconv-border);
      }
      .pc-advconv__navbtn {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0;
        flex: 1;
        width: 40px;
        min-width: 40px;
        min-height: 40px;
        overflow: hidden;
        padding: 5px;
        /* Inactive tabs sit quiet (no box chrome) so the accent-tinted icon
           chip, the active tab, and the Ask action carry the rail's hierarchy.
           Only colors transition — geometry stays static for the webview. */
        border: 1px solid transparent;
        border-radius: 10px;
        background: transparent;
        color: var(--fg-dim, #b9d4e8);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0;
        cursor: pointer;
        transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .pc-advconv__navicon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        flex: 0 0 28px;
        border-radius: 8px;
        color: var(--nav-accent, var(--advconv-accent-strong));
        background: color-mix(in oklab, var(--nav-accent, var(--advconv-accent)), transparent 86%);
        border: 1px solid color-mix(in oklab, var(--nav-accent, var(--advconv-accent)), transparent 72%);
      }
      .pc-advconv__navlabel {
        display: none;
      }
      .pc-advconv__navbtn:hover {
        background: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 90%);
        border-color: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 58%);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__navbtn.is-active {
        background: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 84%);
        border-color: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 44%);
        color: var(--fg, #e7f7ff);
        font-weight: 700;
      }
      .pc-advconv__navbtn.is-active::before {
        content: '';
        position: absolute;
        inset: 7px auto 7px 0;
        width: 3px;
        border-radius: 0 999px 999px 0;
        background: var(--nav-accent, var(--accent));
      }
      .pc-advconv__navbtn.is-active .pc-advconv__navicon {
        background: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 72%);
        border-color: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 48%);
      }
      .pc-advconv__nav-sep {
        display: none;
      }
      .pc-advconv__navbtn--raw {
        min-height: 36px;
        color: var(--fg-mute, #7f9bb4);
        background: transparent;
        opacity: 0.78;
      }
      .pc-advconv__navbtn--raw .pc-advconv__navicon {
        width: 24px;
        height: 24px;
        flex-basis: 24px;
        border-radius: 7px;
      }
      .pc-advconv__navbtn--raw:hover,
      .pc-advconv__navbtn--raw.is-active {
        opacity: 1;
      }
      .pc-advconv__navfilters {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .pc-advconv__inbox {
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-right: 1px solid var(--advconv-border);
        background: var(--advconv-panel);
      }
      /* Sidebar blurb shown for the full-width views (no rail list) so the
         sidebar isn't an empty panel below the switcher. */
      .pc-advconv__nav-hint {
        margin: 0;
        padding: 12px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--fg-mute, #7f9bb4);
        border-top: 1px solid color-mix(in srgb, var(--advconv-border), transparent 30%);
      }
      .pc-advconv__navlist {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .pc-advconv__listscroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 8px 10px 12px;
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 35%);
      }
      .pc-advconv__main {
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: 8px;
      }
      .pc-advconv__back {
        display: none;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        margin: 0 0 6px;
        padding: 0;
        border: 1px solid var(--advconv-border);
        border-radius: 8px;
        background: var(--bg-2);
        color: var(--fg-dim);
      }
      /* Full-width stream views (Raw events / Messages) render their list INSIDE
         the detail slot, so ConvFrame omits the .pc-advconv__inbox section. The
         shell is a 3-track grid (rail | list | main); with the list section gone,
         grid auto-placement dropped main into track 2 -- the 300-360px LIST track
         -- and left the 1fr track empty. That squeezed the whole system-log feed
         into a ~300px column beside a huge blank pane, which reads as "clicking a
         row in the left pane doesn't show it in the main pane" (owner-hit
         2026-07-11). Note "flex: 1 1 auto" on .pc-advconv__main is inert here
         because main is a GRID item, not a flex item -- so the placement must be
         stated explicitly. (No backticks in this comment: the whole stylesheet is
         a JS template literal.) */
      .pc-advconv__main--wide { padding: 0; grid-column: 2 / -1; }
      .pc-advconv {
        --advconv-button-accent: var(--advconv-accent);
      }
      .pc-advconv .pc-coord__chip {
        border-color: color-mix(in oklab, var(--advconv-button-accent), transparent 68%);
        background: color-mix(in oklab, var(--advconv-button-accent), transparent 93%);
        color: var(--fg-dim, #b9d4e8);
        border-radius: 8px;
        box-shadow: none;
        transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .pc-advconv .pc-coord__chip:hover:not(:disabled) {
        border-color: color-mix(in oklab, var(--advconv-button-accent), transparent 32%);
        background: color-mix(in oklab, var(--advconv-button-accent), transparent 82%);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv .pc-coord__chip.is-active {
        border-color: color-mix(in oklab, var(--advconv-button-accent), transparent 18%);
        background: color-mix(in oklab, var(--advconv-button-accent), transparent 66%);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__rowtags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 1px; }
      .pc-advconv__refresh { margin-left: auto; display: inline-flex; align-items: center; }
      .pc-advconv__callout {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 8px;
        align-items: flex-start;
        margin: 6px 0;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
        color: var(--fg-mute, #9fb6cc);
      }
      .pc-advconv__callout > svg { margin-top: 2px; }
      .pc-advconv__callout strong {
        display: block;
        margin-bottom: 4px;
        color: var(--fg, #e7f7ff);
        font-size: 12px;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv__callout p {
        margin: 0;
        line-height: 1.5;
      }
      .pc-advconv__callout--accepted {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 68%);
        background: color-mix(in oklab, var(--good, #22c55e), transparent 92%);
      }
      .pc-advconv__callout--accepted > svg { color: var(--good, #22c55e); }
      .pc-advconv__callout--linked {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 70%);
        background: color-mix(in oklab, var(--advconv-accent), transparent 93%);
      }
      .pc-advconv__callout--linked > svg { color: var(--advconv-accent-strong); }
      .pc-advconv__callout--linked p {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .pc-advconv__callout--linked p span {
        display: inline-flex;
        padding: 2px 7px;
        border-radius: 999px;
        border: 1px solid var(--advconv-border);
        color: var(--advconv-accent-strong);
        background: var(--advconv-accent-soft);
        font-weight: 750;
      }
      .pc-advconv__callout--linked p em {
        color: var(--fg-mute, #8aa3bc);
        font-style: normal;
      }
      .pc-advconv__empty {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--fg-mute, #8aa3bc);
      }
      .pc-advconv__empty--card,
      .pc-advconv__empty--detail,
      .pc-advconv__empty--rail,
      .pc-advconv__empty--thread {
        align-items: flex-start;
        flex-direction: column;
        justify-content: center;
        min-height: 120px;
        padding: 14px;
        border-radius: 12px;
        border: 1px dashed var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 35%);
      }
      .pc-advconv__empty--detail {
        min-height: 100%;
        align-items: center;
        text-align: center;
      }
      .pc-advconv__empty--rail,
      .pc-advconv__empty--thread {
        min-height: 88px;
        padding: 12px;
        border-radius: 10px;
      }
      .pc-advconv__empty--thread {
        min-height: 72px;
        margin-top: 4px;
      }
      .pc-advconv__empty strong { color: var(--fg, #e7f7ff); font-size: 14px; }
      .pc-advconv__empty span { max-width: 420px; line-height: 1.45; }
      .pc-advconv__empty--error {
        border-color: color-mix(in oklab, var(--bad, #f87171), transparent 60%);
        background: color-mix(in oklab, var(--bad, #f87171), transparent 94%);
      }
      .pc-advconv__empty--error strong { color: var(--bad, #f87171); }
      .pc-advconv__skeleton {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 3px 1px;
      }
      .pc-advconv__skeleton-row {
        height: 42px;
        flex: 0 0 auto;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 60%);
        background: linear-gradient(
          100deg,
          color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 45%) 40%,
          color-mix(in srgb, var(--bg-3, rgba(255, 255, 255, 0.075)), transparent 30%) 50%,
          color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 45%) 60%
        );
        background-size: 200% 100%;
        animation: pc-advconv-shimmer 1.4s ease-in-out infinite;
      }
      @keyframes pc-advconv-shimmer {
        from { background-position: 200% 0; }
        to { background-position: -200% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .pc-advconv__skeleton-row { animation: none; }
      }
      .pc-advconv__reply {
        margin-top: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 9px;
        border-radius: 10px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 18%);
      }
      .pc-advconv__replyhead {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        color: var(--fg-mute, #8aa3bc);
        font-size: 11px;
      }
      .pc-advconv__replyhead span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--fg, #e7f7ff);
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv__replyhead em {
        max-width: 410px;
        text-align: right;
        font-style: normal;
        line-height: 1.35;
      }
      .pc-advconv__reply textarea {
        width: 100%; resize: vertical; min-height: 48px;
        background: color-mix(in srgb, var(--bg, #07101d), transparent 18%); color: var(--fg, #e7f7ff);
        border: 1px solid var(--advconv-border);
        border-radius: 8px; padding: 8px 9px; font: inherit; font-size: 12px;
        box-shadow: none;
      }
      .pc-advconv__reply textarea:focus { outline: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 66%); outline-offset: 2px; }
      .pc-advconv__replyactions { justify-content: flex-end; }
      .pc-advconv .pc-coord__actions button,
      .pc-advconv__replybtn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 30px;
        padding: 5px 10px;
        border: 1px solid color-mix(in oklab, var(--advconv-accent), transparent 64%);
        border-radius: 8px;
        background: color-mix(in oklab, var(--advconv-accent), transparent 90%);
        color: var(--fg, #e7f7ff);
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0;
        cursor: pointer;
        transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .pc-advconv .pc-coord__actions button:hover:not(:disabled),
      .pc-advconv__replybtn:hover:not(:disabled) {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 30%);
        background: color-mix(in oklab, var(--advconv-accent), transparent 64%);
      }
      .pc-advconv .pc-coord__actions button:disabled,
      .pc-advconv__replybtn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .pc-advconv__replybtn--resolve:not(:disabled) {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 64%);
        color: var(--fg, #e7f7ff);
        background: color-mix(in oklab, var(--good, #22c55e), transparent 90%);
      }
      .pc-advconv__replybtn--resolve:hover:not(:disabled) {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 30%);
        background: color-mix(in oklab, var(--good, #22c55e), transparent 64%);
      }

      /* The selected item's detail fills the main pane (it keeps its
         .pc-coord__detail / .pc-coord__card content; the frame is now the
         shell's main column, not a 2-pane split column). */
      .pc-advconv__main .pc-coord__detail {
        flex: 1 1 auto;
        min-height: 0;
        /* Neutralize coordination.css's .pc-coord__detail cap (max-height:74vh +
           a grey border-left + padding-left). The pre-restructure CSS overrode
           these; dropping that override let the detail get capped at 74vh, which
           left a dead gap below the card — the reported glitch. */
        max-height: none;
        overflow-y: auto;
        border: 1px solid var(--advconv-border);
        border-left: 1px solid var(--advconv-border);
        border-radius: 12px;
        background: var(--advconv-panel);
        backdrop-filter: none;
        padding: 14px;
        box-shadow: none;
      }
      /* Thin, theme-tinted scrollbars on the tab's scroll surfaces — the default
         wide gutter reads heavy against the compact rail cards. */
      .pc-advconv__listscroll,
      .pc-advconv__main .pc-coord__detail,
      .pc-advfeed__stream,
      .pc-advfeed__detailpane {
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 55%) transparent;
      }
      .pc-advconv__railhead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 1px 1px 6px;
        color: var(--fg-mute, #9fb6cc);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv__railhead strong {
        display: inline-flex;
        min-width: 28px;
        justify-content: center;
        border-radius: 999px;
        padding: 2px 7px;
        color: var(--fg, #e7f7ff);
        background: var(--advconv-accent-soft);
        border: 1px solid var(--advconv-border);
      }
      .pc-advconv__railhead--unified {
        justify-content: flex-start;
      }
      .pc-advconv__railhead--unified strong {
        margin-left: auto;
      }
      .pc-advconv__unified-tools {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .pc-advconv__unified-search {
        display: flex;
        flex: 1 1 190px;
        min-width: 0;
        align-items: center;
        gap: 6px;
        min-height: 30px;
        padding: 0 8px;
        border: 1px solid var(--advconv-border);
        border-radius: 8px;
        background: color-mix(in srgb, var(--bg, #07101d), transparent 16%);
        color: var(--fg-mute);
        transition: border-color 120ms ease;
      }
      .pc-advconv__unified-search:focus-within {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 40%);
        outline: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 76%);
        outline-offset: 1px;
      }
      .pc-advconv__unified-search input {
        width: 100%;
        min-width: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--fg);
        font: inherit;
        font-size: 11.5px;
      }
      .pc-advconv__unified-tools .pc-advpanel__filterbar {
        flex: 0 1 auto;
        min-width: 0;
      }
      /* facets layout: drop onto its own full-width line below the search, so
         the always-visible facet chips have room to wrap. */
      .pc-advconv__unified-tools .pc-advpanel__filterbar--facets {
        flex: 1 1 100%;
        padding: 2px 0 0;
        row-gap: 6px;
        column-gap: 10px;
      }
      .pc-advconv__unified-reset {
        flex: 0 0 auto;
      }
      .pc-advconv__unified {
        padding: 8px;
      }
      .pc-advconv__virtual-list {
        position: relative;
        width: 100%;
      }
      .pc-advconv__unified-row {
        position: absolute;
        left: 0;
        right: 0;
        width: 100%;
        height: ${UNIFIED_ROW_HEIGHT}px;
        overflow: clip;
        display: grid;
        grid-template-columns: 34px minmax(0, 1fr);
        gap: 9px;
        align-items: start;
        padding: 9px;
        border: 1px solid transparent;
        border-bottom-color: color-mix(in srgb, var(--advconv-border), transparent 45%);
        border-radius: 10px;
        background: transparent;
        color: var(--fg);
        text-align: left;
        cursor: pointer;
        /* Color-only transitions: top stays untransitioned so virtual-list
           reorders snap instead of animating (the WebKit flash guard above).
           (No backticks here: the stylesheet is a JS template literal.) */
        transition: background-color 120ms ease, border-color 120ms ease;
      }
      .pc-advconv__unified-row:hover,
      .pc-advconv__unified-row:focus-visible,
      .pc-advconv__unified-row.is-active {
        background: var(--advconv-accent-softer);
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 62%);
      }
      .pc-advconv__unified-row.is-active {
        background: var(--advconv-accent-soft);
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 42%);
      }
      .pc-advconv__unified-row.is-active::before {
        content: '';
        position: absolute;
        inset: 9px auto 9px 0;
        width: 3px;
        border-radius: 0 999px 999px 0;
        background: var(--advconv-accent);
      }
      .pc-advconv__unified-row:focus-visible {
        outline: 1px solid var(--advconv-accent);
        outline-offset: -1px;
      }
      /* The icon chip carries the SAME per-source accent as the type pill, so
         the rail is scannable by color before any text is read. */
      .pc-advconv__unified-source {
        --type-accent: var(--advconv-accent);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border: 1px solid color-mix(in oklab, var(--type-accent), transparent 72%);
        border-radius: 9px;
        background: color-mix(in oklab, var(--type-accent), transparent 87%);
        color: color-mix(in oklab, var(--type-accent), white 28%);
      }
      .pc-advconv__unified-source--threads { --type-accent: var(--accent-strong); }
      .pc-advconv__unified-source--deliberations { --type-accent: #a78bfa; }
      .pc-advconv__unified-source--agentchats { --type-accent: #f472b6; }
      .pc-advconv__unified-content {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .pc-advconv__unified-topline,
      .pc-advconv__unified-meta {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--fg-mute);
        font-size: 10px;
      }
      .pc-advconv__unified-topline time {
        margin-left: auto;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .pc-advconv__unified-kind {
        --type-accent: var(--advconv-accent);
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        max-width: 170px;
        overflow: hidden;
        padding: 1px 6px;
        border: 1px solid color-mix(in oklab, var(--type-accent), transparent 64%);
        border-radius: 999px;
        background: color-mix(in oklab, var(--type-accent), transparent 88%);
        color: color-mix(in oklab, var(--type-accent), white 34%);
        font-weight: 750;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-advconv__unified-kind--threads { --type-accent: var(--accent-strong); }
      .pc-advconv__unified-kind--deliberations { --type-accent: #a78bfa; }
      .pc-advconv__unified-kind--agentchats { --type-accent: #f472b6; }
      .pc-advconv__unified-content > strong {
        min-width: 0;
        overflow: hidden;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        color: var(--fg);
        font-size: 13px;
        line-height: 1.35;
      }
      .pc-advconv__unified-preview {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg-dim);
        font-size: 11.5px;
        line-height: 1.35;
      }
      .pc-advconv__unified-meta {
        overflow: hidden;
        white-space: nowrap;
        font-size: 10.5px;
      }
      .pc-advconv__unified-meta span {
        min-width: 0;
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-advconv .pc-coord__row {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 3px;
        padding: 7px 9px;
        border-radius: 8px;
        border-color: color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 48%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 38%);
        cursor: pointer;
        transition: background-color 140ms, border-color 140ms;
      }
      .pc-advconv .pc-coord__row:hover {
        background: var(--advconv-accent-softer);
        border-color: var(--advconv-border);
      }
      .pc-advconv .pc-coord__row.is-active {
        background: var(--advconv-accent-soft);
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 42%);
        box-shadow: none;
      }
      .pc-advconv .pc-coord__row.is-active::before {
        content: '';
        position: absolute;
        inset: 8px auto 8px -1px;
        width: 3px;
        border-radius: 0 999px 999px 0;
        background: var(--advconv-accent);
      }
      .pc-advconv__threadtop {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
      }
      .pc-advconv__statepill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 18px;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 72%);
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 90%);
        color: var(--fg-dim, #b9d4e8);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv__statepill--open {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 58%);
        background: var(--advconv-good-soft);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__statepill--open::before,
      .pc-advconv__statepill--resolved::before,
      .pc-advconv__statepill--closed::before,
      .pc-advconv__statepill--delivered::before,
      .pc-advconv__statepill--sent::before,
      .pc-advconv__statepill--read::before {
        content: '';
        width: 5px;
        height: 5px;
        flex: 0 0 5px;
        border-radius: 50%;
        background: currentColor;
        opacity: 0.9;
      }
      .pc-advconv__statepill--resolved {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 58%);
        background: var(--advconv-accent-soft);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__statepill--closed {
        border-color: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 80%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 48%);
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-advconv__statepill--delivered,
      .pc-advconv__statepill--sent,
      .pc-advconv__statepill--read {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 64%);
        background: var(--advconv-good-soft);
        color: var(--good, #22c55e);
      }
      /* Kind pill — bring the coordination.css base (a square, hardcoded-#9bd chip)
         in line with the site's rounded, semantic-token pills (StatusPill family).
         Question is accent-tinted so it pops against neutral discussions/roles in
         the thread rail. */
      .pc-advconv .pc-coord__kind {
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        padding: 1px 7px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 72%);
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 90%);
        color: var(--fg-dim, #b9d4e8);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv .pc-coord__kind--question {
        border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 56%);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%);
        color: var(--accent-strong, #7dd3fc);
      }
      /* Topic tags — subtle accent pills (was the hardcoded-#9bd .pc-coord__tag). */
      .pc-advconv .pc-coord__tag {
        display: inline-flex;
        align-items: center;
        padding: 1px 7px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 80%);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 92%);
        color: var(--accent-strong, #7dd3fc);
        font-size: 10px;
        font-weight: 700;
      }
      .pc-advconv__rowdate {
        margin-left: auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg-mute, #6f87a0);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
    .pc-advconv .pc-coord__row-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
      letter-spacing: 0;
    }
      .pc-advconv .pc-coord__row-meta {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
      }
      .pc-advconv .pc-coord__card {
        min-height: 100%;
        padding: 2px;
      }
      .pc-advconv__detailhead {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        padding: 0 0 10px;
        border-bottom: 1px solid var(--advconv-border);
      }
      .pc-advconv__detailkicker {
        display: flex;
        align-items: center;
        gap: 5px;
        margin: 0 0 5px;
      }
      .pc-advconv .pc-coord__card header h2 {
        font-size: 20px;
        /* line-height 1 clipped descenders and set wrapped long titles solid;
           1.25 keeps multi-line titles readable without loosening the header. */
        line-height: 1.25;
        letter-spacing: 0;
      }
      .pc-advconv__detailstats {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 4px;
        max-width: 340px;
      }
      .pc-advconv__detailstats span {
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        padding: 2px 6px;
        border-radius: 8px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 34%);
        color: var(--fg-mute, #9fb6cc);
        font-size: 11px;
      }
      .pc-advconv__detailstats strong {
        color: var(--fg, #e7f7ff);
        font-variant-numeric: tabular-nums;
      }
      .pc-advconv .pc-coord__thread li {
        position: relative;
        border-left-color: color-mix(in oklab, var(--advconv-accent), transparent 62%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 34%);
        border-radius: 0 8px 8px 0;
        padding: 8px 10px;
      }
      .pc-advconv .pc-coord__thread li::before {
        content: "";
        position: absolute;
        left: -5px;
        top: 16px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--advconv-accent);
        box-shadow: none;
      }
      .pc-advconv__postmeta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        color: var(--fg-mute, #8aa3bc);
        font-size: 11px;
      }
      .pc-advconv__postmeta strong {
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__postmeta span {
        font-variant-numeric: tabular-nums;
        color: var(--fg-mute, #7f9bb4);
      }

      /* Agent-chat transcript — role-differentiated turns */
      .pc-advconv__transcript {
        gap: 9px;
      }
      /* WI-125 live-chat embed: <ChatPanel> sizes itself with flex, so the
         wrapper must hand it a definite box (same WebKitGTK height-collapse
         gotcha as the dock — see HarnessesDock). */
      .pc-advconv__livechat {
        display: flex;
        height: min(64vh, 680px);
        min-height: 320px;
        border: 1px solid var(--advconv-border);
        border-radius: 10px;
        overflow: hidden;
      }
      .pc-advconv__livechat > * {
        flex: 1;
        min-width: 0;
      }
      .pc-advconv__turn p {
        margin: 4px 0 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-size: 12px;
        line-height: 1.5;
        color: var(--fg, #d7e7f4);
      }
      .pc-advconv__turn--user::before {
        background: var(--accent-strong, #7dd3fc) !important;
      }
      .pc-advconv__turn--assistant::before {
        background: var(--good, #6ee7b7) !important;
      }
      .pc-advconv__turn--system::before {
        background: var(--fg-mute, #8aa3bc) !important;
      }
      .pc-advconv__turn--system p {
        color: var(--fg-mute, #9fb6cd);
        font-style: italic;
      }

      /* Feed */
      .pc-advfeed { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
      .pc-advfeed__filters {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 6px 8px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--bg, #07101d), transparent 12%);
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 88%);
      }
      .pc-advfeed__filterhead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 1px 2px 2px;
        color: var(--fg-mute, #8aa3bc);
        font-size: 11px;
      }
      .pc-advfeed__filterhead > div:first-child {
        min-width: 0;
      }
      .pc-advfeed__filterhead span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--fg, #e7f7ff);
        font-weight: 850;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advfeed__filterhead p { display: none; }
      .pc-advfeed__filtermeta {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
        flex-wrap: wrap;
      }
      .pc-advfeed__filtermeta strong,
      .pc-advfeed__filtermeta span,
      .pc-advfeed__needsline strong {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 2px 7px;
        border-radius: 7px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
        color: var(--fg, #e7f7ff);
        font-size: 10px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .pc-advfeed__filtermeta span {
        background: transparent;
        color: var(--fg-mute, #9fb6cc);
      }
      .pc-advfeed__needsline {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
        padding: 0;
      }
      .pc-advfeed__needsline span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-height: 22px;
        padding: 3px 7px;
        border-radius: 7px;
        color: var(--fg-dim, #b9d4e8);
        background: color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 93%);
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        font-size: 10px;
        font-weight: 700;
      }
      .pc-advfeed__needsline strong {
        margin-left: auto;
      }
      .pc-advfeed__kindgroups {
        gap: 4px;
      }
      .pc-advfeed__groupchip,
      .pc-advfeed__advancedtoggle {
        --advconv-button-accent: var(--advconv-accent);
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-height: 28px;
        padding: 4px 8px;
        border-radius: 7px;
        font-size: 11px;
        font-weight: 700;
      }
      .pc-advfeed__advancedtoggle { --advconv-button-accent: var(--accent); }
      .pc-advfeed__rawkinds {
        padding-top: 2px;
      }
      .pc-advfeed__kindchip {
        --advconv-button-accent: var(--fg-mute, #94a3b8);
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-height: 26px;
        padding: 3px 7px;
        border-radius: 7px;
        font-size: 10.5px;
        font-weight: 700;
      }
      .pc-advfeed__kinddot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
      .pc-advfeed__kindn {
        font-variant-numeric: tabular-nums; font-size: 10px; opacity: 0.8;
        background: color-mix(in srgb, var(--bg-3, rgba(255, 255, 255, 0.075)), transparent 20%); border-radius: 6px; padding: 0 4px; margin-left: 2px;
      }
      .pc-advfeed__inputs { display: flex; gap: 5px; flex-wrap: wrap; align-items: flex-end; }
      .pc-advfeed__field {
        display: flex;
        flex-direction: column;
        gap: 3px;
        flex: 0 1 142px;
        min-width: 118px;
        max-width: 150px;
      }
      .pc-advfeed__field > span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--fg-mute, #7890a8);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advfeed__field--search {
        flex: 0 1 220px;
        max-width: 240px;
      }
      .pc-advfeed__input {
        width: 100%;
        height: 28px;
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
        color: var(--fg, #e7f7ff);
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        border-radius: 8px;
        padding: 4px 7px;
        font: inherit;
        font-size: 11.5px;
        min-width: 0;
      }
      .pc-advfeed__input::placeholder { color: color-mix(in srgb, var(--accent-soft, #94a3b8), transparent 60%); }
      .pc-advfeed__input:focus { outline: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 66%); outline-offset: 1px; }
      .pc-advfeed__clear { min-height: 28px; }
      .pc-advfeed__scopebar {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
        padding-top: 2px;
        font-size: 11px;
        color: var(--fg-mute, #8aa3bc);
      }
      .pc-advfeed__scopebar > span {
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-advfeed__scopebar strong {
        display: inline-flex;
        align-items: center;
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 2px 7px;
        border-radius: 7px;
        border: 1px solid var(--advconv-border);
        background: var(--advconv-accent-soft);
        color: var(--fg, #e7f7ff);
        font-weight: 700;
      }

      .pc-advfeed__stream {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 3px 1px 8px;
      }
      .pc-advfeed__daysep {
        position: sticky; top: 0; z-index: 1;
        font-size: 10px; letter-spacing: 0; text-transform: uppercase;
        color: var(--fg-mute, #7890a8); padding: 4px 2px 1px;
        background: linear-gradient(var(--advconv-bg), color-mix(in srgb, var(--advconv-bg), transparent 18%));
      }
      .pc-advfeed__daysep span {
        display: inline-flex;
        padding: 2px 7px;
        border-radius: 7px;
        background: var(--advconv-accent-softer);
        border: 1px solid var(--advconv-border);
      }
      .pc-advfeed__item { border-radius: 6px; }
      .pc-advfeed__item.is-open { background: var(--advconv-accent-softer); }
      .pc-advfeed__row {
        width: 100%; display: grid;
        grid-template-columns: auto auto minmax(120px, 1fr) minmax(0, 2fr) auto auto auto;
        align-items: center; gap: 6px; text-align: left;
        padding: 6px 8px;
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 40%);
        font-size: 12px; color: var(--fg, #dceaf6);
        border: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 58%);
        border-radius: 8px;
        transition: background-color 140ms, border-color 140ms;
      }
      .pc-advfeed__row:hover {
        background: var(--advconv-accent-softer);
        border-color: var(--advconv-border);
      }
      .pc-advfeed__item.is-open .pc-advfeed__row {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 58%);
        background: var(--advconv-accent-soft);
      }
      /* ── Master/detail (WI-4216, owner 2026-07-12 "make it work just like
         the curated Conversations pane"). The feed renders inside ConvFrame's
         list rail (compact clickable rows) + main detail pane (the opened
         message), instead of a full-width inline-expand stream. ── */
      .pc-advfeed__item.is-active .pc-advfeed__row {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 25%);
        background: var(--advconv-accent-soft);
        box-shadow: inset 2px 0 0 0 var(--advconv-accent);
      }
      /* In the ~320px list rail, wrap the horizontal 7-col row into a compact
         stacked card so the summary is readable, not squeezed into a sliver. */
      .pc-advconv__navlist .pc-advfeed__row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 3px 6px;
      }
      .pc-advconv__navlist .pc-advfeed__rel { order: 3; margin-left: auto; }
      .pc-advconv__navlist .pc-advfeed__route { order: 4; min-width: 0; flex-wrap: wrap; }
      .pc-advconv__navlist .pc-advfeed__summary {
        order: 5;
        flex: 1 1 100%;
        white-space: normal;
        text-overflow: clip;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .pc-advconv__navlist .pc-advfeed__planchip { order: 6; }
      .pc-advconv__navlist .pc-advfeed__replyn { order: 7; }
      /* Detail-pane instance: full width, always-expanded, non-interactive header. */
      .pc-advfeed__detailpane { overflow-y: auto; padding: 10px 12px; min-height: 0; }
      .pc-advfeed__item--detail { background: transparent; }
      .pc-advfeed__item--detail .pc-advfeed__row { cursor: default; }
      .pc-advfeed__item--detail .pc-advfeed__summary { white-space: normal; cursor: default; }
      .pc-advfeed__time { font-variant-numeric: tabular-nums; font-size: 10px; color: var(--fg-mute, #7890a8); }
      .pc-advfeed__badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 7px;
        border: 1px solid currentColor; background: color-mix(in srgb, currentColor 12%, transparent);
        white-space: nowrap; text-transform: lowercase;
      }
      .pc-advfeed__badge > span {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--feed-kind-color, currentColor);
        box-shadow: none;
      }
      .pc-advfeed__badge--sm { font-size: 10px; padding: 0 5px; }
      .pc-advfeed__route { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font-size: 10.5px; }
      .pc-advfeed__from {
        border: none; background: none; color: var(--fg, #cfe8ff); font: inherit; font-size: 10.5px;
        font-weight: 600; cursor: pointer; padding: 0; max-width: 120px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-advfeed__from:hover { text-decoration: underline; }
      .pc-advfeed__to { color: var(--fg-mute, #8aa3bc); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
      .pc-advfeed__to--broadcast { color: var(--advconv-accent-strong); font-weight: 600; display: inline-flex; align-items: center; gap: 3px; }
      .pc-advfeed__to--human { color: var(--warn, #f59e0b); font-weight: 600; display: inline-flex; align-items: center; gap: 3px; }
      .pc-advfeed__summary {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg, #dceaf6);
        border: none; background: none; font: inherit; font-size: 11.5px; text-align: left;
        cursor: pointer; padding: 0; min-width: 0;
      }
      .pc-advfeed__summary:hover { color: var(--fg, #e7f7ff); }
      .pc-advfeed__nosum { color: var(--fg-mute, #5f7488); }
      .pc-advfeed__planchip {
        font-size: 10px; padding: 1px 6px; border-radius: 7px; white-space: nowrap;
        border: 1px solid color-mix(in oklab, var(--advconv-accent), transparent 58%);
        color: var(--advconv-accent-strong);
        background: var(--advconv-accent-softer);
        cursor: pointer; font: inherit;
      }
      .pc-advfeed__planchip:hover { background: var(--advconv-accent-soft); }
      .pc-advfeed__replyn { font-size: 10px; color: var(--fg-mute, #8aa3bc); white-space: nowrap; }
      .pc-advfeed__rel { font-size: 10px; color: var(--fg-mute, #6f87a0); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .pc-advfeed__detail {
        margin: 0 6px 3px 28px;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 11.5px;
        border: 1px solid var(--advconv-border);
        border-left: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 58%);
        background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 18%);
        border-radius: 0 8px 8px 0;
        box-shadow: none;
      }
      .pc-advfeed__detailhead {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
      }
      .pc-advfeed__detailhead span {
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        padding: 1px 6px;
        border-radius: 7px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 34%);
        color: var(--fg-mute, #8aa3bc);
        font-size: 10px;
        font-weight: 700;
      }
      .pc-advfeed__bodycard,
      .pc-advfeed__kv {
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
      }
      .pc-advfeed__bodycard strong,
      .pc-advfeed__kv strong {
        display: block;
        margin-bottom: 3px;
        color: var(--fg, #e7f7ff);
        font-size: 10px;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advfeed__body { white-space: pre-wrap; color: var(--fg, #dceaf6); margin: 0; line-height: 1.42; }
      .pc-advfeed__kv { color: var(--fg-mute, #9fb6cc); margin: 0; }
      .pc-advfeed__kv span { color: var(--fg-mute, #b6c8d8); line-height: 1.45; }
      .pc-advfeed__kv--action {
        border-color: color-mix(in oklab, var(--warn, #f59e0b), transparent 70%);
        background: color-mix(in oklab, var(--warn, #f59e0b), transparent 93%);
      }
      .pc-advfeed__kv--action strong { color: var(--warn, #f59e0b); }
      .pc-advfeed__thread {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .pc-advfeed__thread li {
        position: relative;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: start;
        gap: 6px 8px;
        padding: 6px 8px 6px 2px;
        font-size: 10.5px;
      }
      .pc-advfeed__threadrail {
        width: 9px;
        height: 9px;
        margin-top: 4px;
        border-radius: 50%;
        background: var(--advconv-accent);
        box-shadow: none;
      }
      .pc-advfeed__threadmeta {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
      }
      .pc-advfeed__threadmeta strong { color: var(--fg, #e7f7ff); font-size: 10.5px; }
      .pc-advfeed__threadmeta em { color: var(--fg-mute, #6f87a0); font-style: normal; margin-left: auto; white-space: nowrap; }
      .pc-advfeed__threadsum {
        grid-column: 2;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg-mute, #aebfd0);
      }
      .pc-advfeed__loadolder {
        margin: 5px auto; padding: 5px 12px; border-radius: 7px; font-size: 11px; cursor: pointer;
        border: 1px solid var(--border, rgba(125,211,252,0.2)); background: transparent; color: var(--fg-mute, #9fb6cc); font: inherit;
      }
      .pc-advfeed__loadolder:hover { color: var(--fg, #e7f7ff); border-color: var(--advconv-border-strong); background: var(--advconv-accent-soft); }
      .pc-advfeed__refresh { flex: 0 0 auto; }
      @media (max-width: 920px) {
        /* Desktop master-detail is invariant at every supported window size:
           selecting a row updates the right pane and never replaces the left
           inbox. Narrow windows scroll horizontally instead of changing the
           information architecture underneath the user. */
        .pc-advconv__detailhead { flex-direction: column; }
        .pc-advconv__detailstats { justify-content: flex-start; max-width: none; }
        .pc-advconv__replyhead { flex-direction: column; }
        .pc-advconv__replyhead em { max-width: none; text-align: left; }
        .pc-advfeed__refresh { justify-content: center; }
        .pc-advfeed__row {
          grid-template-columns: auto auto minmax(0, 1fr) auto;
        }
        .pc-advfeed__summary {
          grid-column: 3 / -1;
        }
        .pc-advfeed__planchip,
        .pc-advfeed__replyn,
        .pc-advfeed__rel {
          grid-column: auto;
        }
      }
      @media (max-width: 620px) {
        .pc-advconv__nav-actions { padding: 7px 8px; gap: 5px; }
        .pc-advconv__nav-actions .pc-plans__new-plan,
        .pc-advconv__navbtn,
        .pc-advconv__navbtn--raw {
          min-width: 40px;
          width: 40px;
          min-height: 40px;
          justify-content: center;
          padding: 5px;
        }
        .pc-advconv__navlabel { display: none; }
        .pc-advconv__navicon,
        .pc-advconv__navbtn--raw .pc-advconv__navicon {
          width: 28px;
          height: 28px;
          flex-basis: 28px;
        }
        .pc-advconv__main { padding: 6px; }
        .pc-advconv__main--wide { padding: 0; }
        .pc-advconv__main .pc-coord__detail { border-radius: 10px; padding: 9px; }
        .pc-advfeed__filterhead,
        .pc-advfeed__filtermeta,
        .pc-advfeed__needsline {
          align-items: stretch;
          flex-direction: column;
        }
        .pc-advfeed__needsline strong { margin-left: 0; }
        .pc-advfeed__inputs { flex-direction: column; }
        .pc-advfeed__field,
        .pc-advfeed__field--search {
          width: 100%;
          max-width: none;
        }
        .pc-advfeed__clear { width: 100%; justify-content: center; }
        .pc-advfeed__row {
          grid-template-columns: auto minmax(0, 1fr);
          gap: 6px;
        }
        .pc-advfeed__time,
        .pc-advfeed__badge,
        .pc-advfeed__route,
        .pc-advfeed__summary,
        .pc-advfeed__planchip,
        .pc-advfeed__replyn,
        .pc-advfeed__rel {
          grid-column: auto;
        }
        .pc-advfeed__summary { grid-column: 1 / -1; }
        .pc-advfeed__detail { margin-left: 8px; }
      }
    `}</style>
  );
}
