/**
 * ConversationsTab — the curated conversation stream, in the steering rail.
 *
 * WHY (owner ask 2026-07-25): "a new tab … called conversations that mimics the
 * functionality of our conversations tab but can be displayed well in this much
 * narrower pane." /adv's Conversations is a three-column shell (nav │ list │
 * detail) with 108px rows and a six-column facet bar. None of that geometry
 * survives at the rail's 300–384px, so this is the SAME data and the SAME write
 * paths in a single column that DRILLS IN rather than splitting:
 *
 *   • rows are three lines (~68px) — source · state · age, title, then
 *     who → whom · pot · work-item. Every field on the wide row survives;
 *     roughly nine are visible where /adv shows five.
 *   • source identity is a 2px STRIPE + short label, not a text pill. The pill
 *     ("Questions & discussions") would eat a third of a narrow row. The three
 *     hues are an analogous sweep off the app accent, deliberately avoiding
 *     good/warn/bad — those stay reserved for STATE, so a stripe can never be
 *     misread as a warning.
 *   • the facet bar collapses to one search box + three counted source chips.
 *   • detail REPLACES the list, with a back control and an ↗ escape to /adv.
 *
 * NOT here, deliberately:
 *   • Composing a question. That lives in the rail's Agents tab (owner,
 *     2026-07-25: "the ask tab should be in the agents pane not the
 *     conversations pane") — see AskAgentPane. This pane reads; it never asks.
 *   • The raw coordination-event firehose, and the live agent-chat composer:
 *     both are debugging-desk work that belongs where there is room.
 *   • The Q&A source (owner, 2026-07-27: "remove the q&a tab no one is using
 *     that feature"). The rail stops READING `conversations.questionsList`;
 *     /adv keeps it, because the store is live (94 conversations updated in
 *     the last 30 days) and the Agents-tab Ask composer still writes into it —
 *     so this is a per-surface opt-out, not a retirement (plan D-001).
 *     `QuestionDetail` below survives on purpose: a `?lsc=threads:<id>` deep
 *     link handed out before today must still open something.
 *
 * The fourth source, ADDED here (plan D-002): agent↔agent `coord:send` traffic.
 * It is the highest-volume conversation type in the system — 82,440 envelopes,
 * 10,633 in a single week — and had no curated home at all, which is exactly
 * why this pane read as near-empty (owner: "I see agents sending messages to
 * each other all the time but I only see 51 chat messages and 85 decision
 * messages").
 *
 * Replying to (and resolving) an OPEN question stays here, because that is
 * answering the thing you just read, not composing a new one — and it goes
 * through the same audited conversations/post + conversations/resolve calls
 * /adv uses.
 *
 * What a conversation IS — the three reads, the dedup, the system-actor filter —
 * comes from components/conversations/unified-conversations, shared with /adv so
 * the two panes cannot drift.
 *
 * State is in the URL via nuqs (CLAUDE.md): `?lsc=<source>:<id>` selection,
 * `?lscq` search, `?lscs` source filter — deep-linkable and agent-driveable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringLiteral } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Inbox,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  RefreshCw,
  Search,
  Send,
} from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Tooltip } from '@/app/harness/Tooltip';
import { readListTotal } from '@papercusp/operator-core/lib/sync-resolver/list-meta';
// Relative, not `@/…`: the `@` alias points at the operator (Next) tree, so an
// intra-operator-vite import must be a relative path or it won't resolve.
import {
  asConversationRefKind,
  composeUnifiedConversationRows,
  conversationErrText,
  conversationMatchesQuery,
  coordFetch,
  fmtConversationAge,
  fmtConversationTs,
  parseAudienceRef,
  SOURCE_LABEL,
  turnText,
  type AgentChatDetail,
  type AgentChatRow,
  type AgentMessageDetail,
  type AgentMessageRow,
  type ConvDetailT,
  type ConversationRef,
  type ConversationSource,
  type DeliberationDetail,
  type ThreadRow,
  type UnifiedConversationRow,
} from '../conversations/unified-conversations';
import {
  ConversationRefLink,
  LinkifiedText,
  useConversationRefPopup,
} from '../conversations/ConversationRefs';
import { AuthoredFields } from '../conversations/AuthoredFields';

/** The rail is a navigation surface, not an archive export — one bounded window
 *  per source, merged. Matches /adv's per-source cap so both read the same slice. */
const LIST_LIMIT = 100;
const UNIFIED_LIMIT = LIST_LIMIT * 4;

/** `threads` (Q&A) is absent by design — see the header note / plan D-001. */
const SOURCES = ['all', 'messages', 'deliberations', 'agentchats'] as const;
type SourceFilter = (typeof SOURCES)[number];

/** Short chip labels — "Questions & discussions" does not fit a 300px chip row. */
const CHIP_LABEL: Record<SourceFilter, string> = {
  all: 'All',
  messages: 'Messages',
  deliberations: 'Decisions',
  agentchats: 'Chat',
};

/** The stripe label on a row: shorter still, because it shares the top line
 *  with a state pill and the age. `threads` stays mapped so a legacy
 *  `?lsc=threads:<id>` deep link still renders a labelled detail. */
const STRIPE_LABEL: Record<ConversationSource, string> = {
  threads: 'Q&A',
  deliberations: 'Decision',
  agentchats: 'Agent chat',
  messages: 'Message',
};

const SOURCE_ICON: Record<ConversationSource, typeof MessageCircle> = {
  threads: MessageCircle,
  deliberations: MessagesSquare,
  agentchats: Bot,
  messages: Send,
};

/** Which /adv route + params open this row on the wide surface. */
function advSearchFor(row: UnifiedConversationRow): Record<string, string> {
  const key =
    row.source === 'threads'
      ? 'conversation'
      : row.source === 'deliberations'
        ? 'thread'
        : row.source === 'messages'
          ? 'cmsg'
          : 'chat';
  return { tab: 'conversations', conv: row.source, [key]: row.sourceId };
}

/**
 * The rail's own related-work ref for a row, when it has one it can open.
 * `relatedKind` is set by the composer from each store's own typed parent — a
 * ref with no kind is text we cannot safely route, so it renders plain.
 */
function rowRef(row: UnifiedConversationRow): ConversationRef | null {
  return row.relatedRef && row.relatedKind ? { kind: row.relatedKind, ref: row.relatedRef } : null;
}

/** State pills carry the semantic colours; the source stripe never does. */
function stateClass(state: string): string {
  const s = state.toLowerCase();
  if (s === 'resolved' || s === 'answered' || s === 'done') return 'is-good';
  if (s === 'open' || s === 'pending') return 'is-warn';
  return 'is-neutral';
}

/** `?lsc=threads:conv-abc` ⇄ { source, id }. A compound scalar, not JSON —
 *  CLAUDE.md's rule for encoding a selection in the URL. */
function parseSelection(raw: string | null): { source: ConversationSource; id: string } | null {
  if (!raw) return null;
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  const source = raw.slice(0, at) as ConversationSource;
  const id = raw.slice(at + 1);
  if (!id || !(source in SOURCE_LABEL)) return null;
  return { source, id };
}

// ─── list ───────────────────────────────────────────────────────────────────

function ConversationRow({
  row,
  onOpen,
}: {
  row: UnifiedConversationRow;
  onOpen: (row: UnifiedConversationRow) => void;
}) {
  const Icon = SOURCE_ICON[row.source];
  return (
    <button
      type="button"
      className={`pclsb-conv__row pclsb-conv__row--${row.source}`}
      data-testid={`conversation-row-${row.id}`}
      aria-label={`Open ${row.title}`}
      onClick={() => onOpen(row)}
    >
      <span className="pclsb-conv__top">
        <Icon size={11} aria-hidden className="pclsb-conv__srcicon" />
        <span className="pclsb-conv__src">{STRIPE_LABEL[row.source]}</span>
        {row.state ? (
          <span className={`pclsb-conv__state ${stateClass(row.state)}`}>{row.state}</span>
        ) : row.count ? (
          <span className="pclsb-conv__state is-neutral">{row.count}</span>
        ) : null}
        <time className="pclsb-conv__age">{fmtConversationAge(row.updatedAt)}</time>
      </span>
      <span className="pclsb-conv__title">{row.title}</span>
      <span className="pclsb-conv__meta">
        {row.actor ? <span>{row.actor}</span> : null}
        {row.harnessSlug ? (
          <>
            <span className="sep">·</span>
            <span>{row.harnessSlug}</span>
          </>
        ) : null}
        {row.relatedRef ? (
          <>
            <span className="sep">·</span>
            <span className="ref">{row.relatedRef}</span>
          </>
        ) : null}
      </span>
    </button>
  );
}

// ─── detail bodies, one per source ──────────────────────────────────────────

/** Every detail body takes the surface's ref opener, so a reference in a
 *  callout or a post body opens the thing it names (owner, 2026-07-27). */
interface DetailBodyProps {
  id: string;
  summary?: UnifiedConversationRow;
  onOpenRef: (ref: ConversationRef) => void;
}

function QuestionDetail({ id, summary, onOpenRef }: DetailBodyProps) {
  const q = useSyncQuery<ConvDetailT>({
    queryName: 'conversations.questionDetail',
    args: { id },
    enabled: !!id,
    staleTime: 30_000,
  });
  // usePollingQuery keeps previous data warm, so a just-switched selection can
  // hand back the PREVIOUS conversation's detail mislabeled as this one. Only
  // trust a row whose own id matches (the /adv guard, WI-4142).
  const raw = q.data?.[0] ?? null;
  const detail = raw && raw.id === id ? raw : null;

  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reply.trim();

  async function act(verb: 'conversations/post' | 'conversations/resolve') {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await coordFetch(
        verb,
        verb === 'conversations/post'
          ? { conversation_id: id, body: trimmed }
          : { conversation_id: id, accepted_answer: trimmed },
      );
      setReply('');
      q.invalidate();
    } catch (e) {
      setError(conversationErrText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <div className="pclsb-conv__detail">
        {summary ? <h2 className="pclsb-conv__h">{summary.title}</h2> : null}
        <p className="pclsb-conv__loading">Loading conversation…</p>
      </div>
    );
  }

  const open = detail.state === 'open';
  return (
    <>
      <div className="pclsb-conv__detail">
        <div className="pclsb-conv__kicker">
          <span className="pclsb-conv__src">{SOURCE_LABEL.threads}</span>
          <span className={`pclsb-conv__state ${stateClass(detail.state)}`}>{detail.state}</span>
        </div>
        <h2 className="pclsb-conv__h">{detail.title ?? detail.id}</h2>
        <div className="pclsb-conv__stats">
          {detail.asker_id ? <span>asked by {detail.asker_id}</span> : null}
          <span>{detail.scope === 'harness' && detail.harness_slug ? detail.harness_slug : 'workspace'}</span>
          <span>
            {detail.subscriber_count} follower{detail.subscriber_count === 1 ? '' : 's'}
          </span>
        </div>

        {detail.topics.length > 0 && (
          <div className="pclsb-conv__tags">
            {detail.topics.map((t) => (
              <span key={t} className="pclsb-conv__tag">
                #{t}
              </span>
            ))}
          </div>
        )}

        {detail.body && (
          <p className="pclsb-conv__body">
            <LinkifiedText text={detail.body} harnessSlug={detail.harness_slug} onOpen={onOpenRef} />
          </p>
        )}

        {detail.accepted_answer && (
          <div className="pclsb-conv__callout is-good">
            <CheckCircle2 size={13} aria-hidden />
            <div>
              <b>Accepted answer</b>
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
          <div className="pclsb-conv__callout is-link">
            <ArrowUpRight size={13} aria-hidden />
            <div>
              <b>Linked work-item</b>
              <p>
                <ConversationRefLink
                  refValue={{ kind: 'issue', ref: detail.promoted_issue_id }}
                  harnessSlug={detail.harness_slug}
                  onOpen={onOpenRef}
                  size="sm"
                />
              </p>
            </div>
          </div>
        )}

        <div className="pclsb-conv__seclabel">
          {detail.posts.length === 0
            ? 'replies'
            : `${detail.posts.length} ${detail.posts.length === 1 ? 'reply' : 'replies'}`}
        </div>
        {detail.posts.length === 0 ? (
          <p className="pclsb-conv__empty">No replies yet.</p>
        ) : (
          detail.posts.map((p) => (
            <div key={p.id} className="pclsb-conv__post">
              <span className="who">
                <b>{p.author_id ?? 'unknown'}</b>
                {p.created_ts ? <span>{fmtConversationTs(p.created_ts)}</span> : null}
              </span>
              <p>
                <LinkifiedText text={p.body} harnessSlug={detail.harness_slug} onOpen={onOpenRef} />
              </p>
            </div>
          ))
        )}
      </div>

      {open ? (
        <div className="pclsb-conv__replybox">
          {error && (
            <p className="pclsb-conv__err" role="alert">
              {error}
            </p>
          )}
          <textarea
            className="pclsb-conv__textarea"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={detail.kind === 'question' ? 'Reply, or accept as the answer…' : 'Write a reply…'}
            rows={2}
            aria-label="Reply"
          />
          <div className="pclsb-conv__crow">
            <button
              type="button"
              className="pclsb-conv__btn is-primary"
              disabled={busy || !trimmed}
              onClick={() => void act('conversations/post')}
              data-testid="conversation-reply"
            >
              <Send size={11} aria-hidden /> Reply
            </button>
            {detail.kind === 'question' && (
              <button
                type="button"
                className="pclsb-conv__btn is-good"
                disabled={busy || !trimmed}
                aria-label="Record this reply as the accepted answer and resolve the question"
                onClick={() => void act('conversations/resolve')}
                data-testid="conversation-accept"
              >
                <CheckCircle2 size={11} aria-hidden /> Accept
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="pclsb-conv__readonly">
          <CheckCircle2 size={11} aria-hidden /> {detail.state} — reopening happens in the full view.
        </p>
      )}
    </>
  );
}

function DeliberationDetailBody({ id, summary, onOpenRef }: DetailBodyProps) {
  const q = useSyncQuery<DeliberationDetail>({
    queryName: 'conversations.deliberationDetail',
    args: { id },
    enabled: !!id,
    staleTime: 30_000,
  });
  const raw = q.data?.[0];
  const detail = raw && raw.thread?.thread_id === id ? raw : undefined;
  const head = detail?.thread;
  const posts = detail?.posts ?? [];
  // `parent_kind` is the store's OWN typed parent (issue · feature ·
  // conversation), so no guessing from the ref string is needed.
  const attachedRef: ConversationRef | null = useMemo(() => {
    const kind = asConversationRefKind(head?.parent_kind);
    return kind && head?.parent_ref ? { kind, ref: head.parent_ref } : null;
  }, [head?.parent_kind, head?.parent_ref]);

  return (
    <>
      <div className="pclsb-conv__detail">
        <div className="pclsb-conv__kicker">
          <span className="pclsb-conv__src">{SOURCE_LABEL.deliberations}</span>
        </div>
        <h2 className="pclsb-conv__h">{head?.title ?? summary?.title ?? id}</h2>
        {head ? (
          <div className="pclsb-conv__stats">
            {head.created_by ? <span>opened by {head.created_by}</span> : null}
            {head.harness_slug ? <span>{head.harness_slug}</span> : null}
            <span>
              {head.post_count} post{head.post_count === 1 ? '' : 's'}
            </span>
          </div>
        ) : null}

        {head?.parent_ref && (
          <div className="pclsb-conv__callout is-link">
            <ArrowUpRight size={13} aria-hidden />
            <div>
              <b>Attached to</b>
              <p>
                {head.parent_kind ? `${head.parent_kind} · ` : ''}
                {/* The owner's headline case: this used to be dead text naming a
                    work item you then had to go find by hand. */}
                {attachedRef ? (
                  <ConversationRefLink
                    refValue={attachedRef}
                    harnessSlug={head.harness_slug}
                    onOpen={onOpenRef}
                    size="sm"
                  />
                ) : (
                  head.parent_ref
                )}
              </p>
            </div>
          </div>
        )}

        {!detail ? (
          <p className="pclsb-conv__loading">Loading discussion…</p>
        ) : posts.length === 0 ? (
          <p className="pclsb-conv__empty">No posts on this thread yet.</p>
        ) : (
          <>
            <div className="pclsb-conv__seclabel">
              {posts.length} post{posts.length === 1 ? '' : 's'}
            </div>
            {posts.map((p) => (
              <div key={p.id} className="pclsb-conv__post">
                <span className="who">
                  <b>{p.author_id ?? 'unknown'}</b>
                  <span>{fmtConversationTs(p.created_at)}</span>
                </span>
                <p>
                  <LinkifiedText text={p.body} harnessSlug={p.harness_slug} onOpen={onOpenRef} />
                </p>
              </div>
            ))}
          </>
        )}
      </div>
      <p className="pclsb-conv__readonly">
        <MessagesSquare size={11} aria-hidden /> Read-only — agents deliberate through coord:thread.
      </p>
    </>
  );
}

function AgentChatDetailBody({ id, summary, onOpenRef }: DetailBodyProps) {
  const q = useSyncQuery<AgentChatDetail>({
    queryName: 'conversations.agentChatDetail',
    args: { id },
    enabled: !!id,
    staleTime: 30_000,
  });
  const raw = q.data?.[0] ?? null;
  const detail = raw && raw.id === id ? raw : null;
  const turns = detail?.transcript ?? [];

  return (
    <>
      <div className="pclsb-conv__detail">
        <div className="pclsb-conv__kicker">
          <span className="pclsb-conv__src">{SOURCE_LABEL.agentchats}</span>
          {detail && (
            <span className={`pclsb-conv__state ${detail.archived_at == null ? 'is-good' : 'is-neutral'}`}>
              {detail.archived_at == null ? 'live' : 'archived'}
            </span>
          )}
        </div>
        <h2 className="pclsb-conv__h">{detail?.title ?? summary?.title ?? id}</h2>
        {detail && (
          <div className="pclsb-conv__stats">
            {detail.role ? <span>role {detail.role}</span> : null}
            {detail.feature_id ? <span>{detail.feature_id}</span> : null}
            {detail.harness_slug ? <span>{detail.harness_slug}</span> : null}
            <span>
              {detail.turns} turn{detail.turns === 1 ? '' : 's'}
            </span>
          </div>
        )}

        {!detail ? (
          <p className="pclsb-conv__loading">Loading transcript…</p>
        ) : turns.length === 0 ? (
          <p className="pclsb-conv__empty">No turns recorded — the session opened but never exchanged a message.</p>
        ) : (
          <>
            <div className="pclsb-conv__seclabel">transcript</div>
            {turns.map((t, i) => (
              <div
                key={i}
                className={`pclsb-conv__post pclsb-conv__turn${t.role === 'assistant' ? ' is-agent' : ''}`}
              >
                <span className="who">
                  <b>{t.role ?? 'turn'}</b>
                  {t.ts ? <span>{fmtConversationTs(t.ts)}</span> : null}
                </span>
                <p>
                  <LinkifiedText
                    text={turnText(t.content)}
                    harnessSlug={detail.harness_slug}
                    onOpen={onOpenRef}
                  />
                </p>
              </div>
            ))}
          </>
        )}
      </div>
      <p className="pclsb-conv__readonly">
        <ArrowUpRight size={11} aria-hidden /> Read-only — the live composer stays in the full view.
      </p>
    </>
  );
}

/**
 * An agent↔agent coord message and its reply chain.
 *
 * A `coord:send` envelope carries strictly more routing than the other three
 * sources — who it went to, which audience SELECTORS it targeted, the lifecycle
 * beat it declared, and the plan it was declared against — and that routing is
 * the whole point of reading agent traffic ("who told whom what"). So the head
 * shows it explicitly rather than flattening it into one prose line.
 */
function AgentMessageDetailBody({ id, summary, onOpenRef }: DetailBodyProps) {
  const q = useSyncQuery<AgentMessageDetail>({
    queryName: 'conversations.agentMessageDetail',
    args: { id },
    enabled: !!id,
    staleTime: 30_000,
  });
  // usePollingQuery keeps previous data warm, so a just-switched selection can
  // hand back the PREVIOUS message mislabeled as this one (the /adv guard).
  const raw = q.data?.[0] ?? null;
  const detail = raw && raw.message?.msg_id === id ? raw : null;
  const head = detail?.message;
  const replies = detail?.replies ?? [];
  const audienceRef = useMemo(() => parseAudienceRef(head?.audience), [head?.audience]);

  return (
    <>
      <div className="pclsb-conv__detail">
        <div className="pclsb-conv__kicker">
          <span className="pclsb-conv__src">{SOURCE_LABEL.messages}</span>
          {head?.kind ? <span className="pclsb-conv__state is-neutral">{head.kind}</span> : null}
          {head?.lifecycle ? (
            <span className="pclsb-conv__state is-neutral">{head.lifecycle}</span>
          ) : null}
        </div>
        <h2 className="pclsb-conv__h">{head?.summary ?? summary?.title ?? id}</h2>
        {head ? (
          <div className="pclsb-conv__stats">
            <span>from {head.from}</span>
            <span>
              {head.broadcast
                ? 'broadcast'
                : head.to.length === 0
                  ? 'no direct recipient'
                  : `to ${head.to.join(', ')}`}
            </span>
            {head.harness_slug ? <span>{head.harness_slug}</span> : null}
            <span>{fmtConversationTs(head.ts)}</span>
          </div>
        ) : null}

        {/* Audience SELECTORS are how coord:send actually addresses — an
            `@object:issue:WI-1` is the message's related work, and the only one
            of these that names an openable object gets a real link. */}
        {head && head.audience.length > 0 && (
          <div className="pclsb-conv__tags">
            {head.audience.map((a) => (
              <span key={a} className="pclsb-conv__tag">
                {a}
              </span>
            ))}
          </div>
        )}

        {audienceRef && (
          <div className="pclsb-conv__callout is-link">
            <ArrowUpRight size={13} aria-hidden />
            <div>
              <b>About</b>
              <p>
                <ConversationRefLink
                  refValue={audienceRef}
                  harnessSlug={head?.harness_slug}
                  onOpen={onOpenRef}
                  size="sm"
                />
              </p>
            </div>
          </div>
        )}

        {head?.plan_slug && !audienceRef && (
          <div className="pclsb-conv__callout is-link">
            <ArrowUpRight size={13} aria-hidden />
            <div>
              <b>Plan</b>
              <p>
                <ConversationRefLink
                  refValue={{ kind: 'plan', ref: head.plan_slug }}
                  harnessSlug={head.harness_slug}
                  onOpen={onOpenRef}
                  size="sm"
                />
              </p>
            </div>
          </div>
        )}

        {head?.body && (
          <p className="pclsb-conv__body">
            <LinkifiedText text={head.body} harnessSlug={head.harness_slug} onOpen={onOpenRef} />
          </p>
        )}

        {/* P-033 (e): the fields the sender authored ABOUT this message. `body`
            above is a flattened projection of them, so without this the structure
            was invisible on the one surface built to read a message in full. */}
        <AuthoredFields authored={head?.authored} />

        {!detail ? (
          <p className="pclsb-conv__loading">Loading message…</p>
        ) : replies.length === 0 ? (
          <p className="pclsb-conv__empty">No replies — nobody acked or answered this yet.</p>
        ) : (
          <>
            <div className="pclsb-conv__seclabel">
              {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
            </div>
            {replies.map((r) => (
              <div key={r.msg_id} className="pclsb-conv__post">
                <span className="who">
                  <b>{r.from || 'unknown'}</b>
                  <span>{fmtConversationTs(r.ts)}</span>
                </span>
                <p>
                  <LinkifiedText
                    text={r.body ?? r.summary}
                    harnessSlug={head?.harness_slug}
                    onOpen={onOpenRef}
                  />
                </p>
              </div>
            ))}
          </>
        )}
      </div>
      <p className="pclsb-conv__readonly">
        <Megaphone size={11} aria-hidden /> Read-only — agents talk through coord:send.
      </p>
    </>
  );
}

// ─── the pane ───────────────────────────────────────────────────────────────

export default function ConversationsTab({ active }: { active: boolean }) {
  const [selection, setSelection] = useQueryState('lsc', parseAsString.withDefault(''));
  const [search, setSearch] = useQueryState('lscq', parseAsString.withDefault(''));
  const [source, setSource] = useQueryState(
    'lscs',
    parseAsStringLiteral(SOURCES).withDefault('all'),
  );
  const navigate = useNavigate();

  // The curated stores — the SAME cached reads /adv consumes, so opening this
  // tab after visiting /adv (or the reverse) hits a warm cache rather than
  // re-fetching. All gate on `active`: an unopened tab costs nothing.
  // `conversations.questionsList` is deliberately NOT read here (D-001).
  const deliberations = useSyncQuery<ThreadRow>({
    queryName: 'conversations.deliberationList',
    args: { limit: LIST_LIMIT },
    enabled: active,
    staleTime: 30_000,
  });
  const agentChats = useSyncQuery<AgentChatRow>({
    queryName: 'conversations.agentChatList',
    args: { limit: LIST_LIMIT },
    enabled: active,
    staleTime: 30_000,
  });
  const agentMessages = useSyncQuery<AgentMessageRow>({
    queryName: 'conversations.agentMessageList',
    args: { limit: LIST_LIMIT, q: search.trim() || undefined },
    enabled: active,
    staleTime: 30_000,
  });
  const rows = useMemo(
    () =>
      composeUnifiedConversationRows(
        {
          deliberations: deliberations.data ?? [],
          agentChats: agentChats.data ?? [],
          agentMessages: agentMessages.data ?? [],
        },
        UNIFIED_LIMIT,
      ),
    [deliberations.data, agentChats.data, agentMessages.data],
  );

  const counts = useMemo(() => {
    const c: Record<SourceFilter, number> = {
      all: rows.length,
      messages: 0,
      deliberations: 0,
      agentchats: 0,
    };
    // A legacy `threads` row can only arrive via a deep link, never the list.
    for (const r of rows) if (r.source in c) c[r.source as SourceFilter] += 1;
    return c;
  }, [rows]);

  /**
   * The TRUE store count behind each capped window (`_meta.total`, attached
   * server-side by attachListMeta).
   *
   * Without this the pane lies: every source reads `LIMIT 100`, so "Decisions
   * 85" was rendered while 5,744 threads existed, and the number read as "that
   * is all there is" (owner, 2026-07-27). A capped source now renders `85+`.
   */
  const totals = useMemo(
    () => ({
      messages: readListTotal(agentMessages.data),
      deliberations: readListTotal(deliberations.data),
      agentchats: readListTotal(agentChats.data),
    }),
    [agentMessages.data, deliberations.data, agentChats.data],
  );
  const capped = (s: SourceFilter): boolean =>
    s !== 'all' && (totals[s] ?? 0) > (counts[s] ?? 0);

  const visible = useMemo(
    () =>
      rows.filter(
        (r) => (source === 'all' || r.source === source) && conversationMatchesQuery(r, search),
      ),
    [rows, source, search],
  );

  const queries = [deliberations, agentChats, agentMessages];
  const loading = queries.some((q) => q.loading);
  const error = queries.find((q) => q.error)?.error ?? null;
  const invalidate = () => queries.forEach((q) => q.invalidate());

  const selected = parseSelection(selection || null);
  const selectedRow = selected
    ? rows.find((r) => r.id === `${selected.source}:${selected.id}`)
    : undefined;

  /**
   * The ref → popup host (owner ask, 2026-07-27). `?lscref` is the rail's own
   * namespace so it cannot collide with /adv's when both are mounted.
   *
   * A `conversation` ref is NOT a popup: the thing it names is another row of
   * THIS pane, so it re-targets the selection in place — drilling sideways,
   * not stacking a modal over the pane you are already reading.
   */
  const refPopup = useConversationRefPopup('lscref', selectedRow?.harnessSlug ?? null);
  const onOpenRef = useCallback(
    (ref: ConversationRef) => {
      if (ref.kind === 'conversation') {
        void setSelection(`threads:${ref.ref}`);
        return;
      }
      refPopup.open(ref);
    },
    [refPopup, setSelection],
  );

  // A list scroll position is worth keeping across a drill-in/back round trip:
  // returning to the top of a 200-row stream after reading one conversation is
  // the single most irritating thing a drill-in navigation can do.
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollMemo = useRef(0);
  useEffect(() => {
    if (selected) return;
    const el = listRef.current;
    if (el && scrollMemo.current) el.scrollTop = scrollMemo.current;
  }, [selected]);

  const openRow = (row: UnifiedConversationRow) => {
    scrollMemo.current = listRef.current?.scrollTop ?? 0;
    void setSelection(`${row.source}:${row.sourceId}`);
  };

  if (!active) return null;

  // ── detail mode ──────────────────────────────────────────────────────────
  if (selected) {
    const openWide = () => {
      const row = selectedRow ?? {
        source: selected.source,
        sourceId: selected.id,
      } as UnifiedConversationRow;
      // MERGE over the live URL: the rail's own state (?lsb/?lst/?lsc) rides in
      // the same search string, so a wholesale replace would collapse the rail.
      void navigate({ to: '/adv', search: (prev: Record<string, unknown>) => ({ ...prev, ...advSearchFor(row) }) });
    };
    return (
      <TooltipPrimitive.Provider delayDuration={250}>
      <div className="pclsb-conv" data-testid="conversations-pane">
        <div className="pclsb-conv__backrow">
          <button
            type="button"
            className="pclsb-conv__back"
            onClick={() => void setSelection(null)}
            data-testid="conversation-back"
          >
            <ArrowLeft size={11} aria-hidden /> Conversations
          </button>
          <span className="pclsb-conv__spacer" />
          {/* The shared Tooltip primitive, not a native `title=` — the design
              lint bans title-only tooltips on buttons (they are invisible to
              touch and slow to appear). */}
          <Tooltip label="Open in the full Conversations view" side="right">
            <button
              type="button"
              className="pclsb-conv__chip"
              aria-label="Open in the full Conversations view"
              onClick={openWide}
              data-testid="conversation-open-wide"
            >
              <ArrowUpRight size={11} aria-hidden />
            </button>
          </Tooltip>
        </div>
        {selected.source === 'threads' ? (
          <QuestionDetail id={selected.id} summary={selectedRow} onOpenRef={onOpenRef} />
        ) : selected.source === 'deliberations' ? (
          <DeliberationDetailBody id={selected.id} summary={selectedRow} onOpenRef={onOpenRef} />
        ) : selected.source === 'messages' ? (
          <AgentMessageDetailBody id={selected.id} summary={selectedRow} onOpenRef={onOpenRef} />
        ) : (
          <AgentChatDetailBody id={selected.id} summary={selectedRow} onOpenRef={onOpenRef} />
        )}
        {refPopup.element}
      </div>
      </TooltipPrimitive.Provider>
    );
  }

  // ── list mode ────────────────────────────────────────────────────────────
  const filtered = source !== 'all' || search.trim() !== '';
  return (
    <div className="pclsb-conv" data-testid="conversations-pane">
      <div className="pclsb-conv__bar">
        <span className="pclsb-conv__bartitle">Conversations</span>
        <span className="pclsb-conv__count" data-testid="conversations-count">
          {loading && rows.length === 0 ? '…' : filtered ? `${visible.length} of ${rows.length}` : rows.length}
        </span>
        <button
          type="button"
          className="pclsb-conv__chip"
          aria-label="Reload conversations"
          disabled={loading}
          onClick={() => invalidate()}
        >
          <RefreshCw size={11} aria-hidden />
        </button>
      </div>

      <label className="pclsb-conv__search">
        <Search size={11} aria-hidden />
        <input
          type="search"
          value={search}
          onChange={(e) => void setSearch(e.target.value || null)}
          placeholder="Search conversations…"
          aria-label="Search conversations"
        />
      </label>

      <div className="pclsb-conv__chips" role="group" aria-label="Filter by source">
        {SOURCES.map((s) => (
          <button
            key={s}
            type="button"
            className={`pclsb-conv__chipbtn pclsb-conv__chipbtn--${s}${source === s ? ' is-on' : ''}`}
            aria-pressed={source === s}
            onClick={() => void setSource(s === 'all' ? null : s)}
            data-testid={`conversations-filter-${s}`}
          >
            <span className="dot" aria-hidden />
            {CHIP_LABEL[s]}
            {/* `85+` — the window is capped at LIST_LIMIT per source, so a bare
                count would read as the store total (it is not). */}
            <span className="ct">
              {counts[s]}
              {capped(s) ? '+' : ''}
            </span>
          </button>
        ))}
      </div>

      <div className="pclsb-conv__list" ref={listRef}>
        {loading && rows.length === 0 ? (
          <p className="pclsb-conv__loading">Loading conversations…</p>
        ) : error && rows.length === 0 ? (
          <div className="pclsb-conv__error" role="alert">
            <p>Couldn&apos;t load conversations.</p>
            <p>{conversationErrText(error)}</p>
            <button type="button" className="pclsb-conv__btn" onClick={() => invalidate()}>
              Retry
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="pclsb-conv__blank">
            <Inbox size={20} aria-hidden />
            <b>{filtered ? 'No conversations match' : 'No conversations'}</b>
            <span>
              {filtered
                ? 'Clear the search or pick another source.'
                : 'Nothing curated is recorded yet. Ask an agent something from the Agents tab.'}
            </span>
          </div>
        ) : (
          visible.map((row) => <ConversationRow key={row.id} row={row} onOpen={openRow} />)
        )}
      </div>
    </div>
  );
}
