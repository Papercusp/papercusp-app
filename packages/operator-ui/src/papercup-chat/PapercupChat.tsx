/**
 * PapercupChat — the ONE Papercup chat view, mounted by both hosts
 * (papercup-chat-one-component-one-contract-2026-09-06, D-003; P-007).
 *
 * Renders a {@link PapercupChatController} (from `usePapercupChat`): the
 * capability notice, the virtualized transcript (turn = role badge + timestamp
 * + markdown body + tool-call tags + persisted cards + provenance / "Looked at"
 * footer + host action bar), the shared `PendingCardsBar`, the error banner +
 * Retry, and the composer with a host trailing-chrome slot — the shape P-006's
 * UI IR (PapercupChat.ui-ir.json) fixes. Theming is CSS custom properties
 * (`--pc-chat-*`, the `chat-cards` pattern); the sheet is `PAPERCUP_CHAT_CSS`.
 *
 * HOST-FREE: no provider, no router, no nuqs, no fetch. Everything host-shaped
 * enters through props: navigation (`onWorkRefActivate`), workspace binding
 * (`harnessSlug`/`planSlug`, owner only), the per-message action bar and the
 * composer chrome as render slots (parity `op-action-bar`, `op-voice`,
 * `op-audience-mode` stay host chrome), local cards (`localCards`).
 *
 * ── D-005 trust matrix — enforced HERE, in the renderer, keyed by `hostTrust` ──
 *
 *   feature         public   owner     how
 *   html / comment  inert    inert     no rehype-raw: react-markdown renders raw
 *                                      HTML as TEXT (it never becomes elements)
 *   links           allowlist          `papercupChatUrlTransform` — http/https/
 *                                      mailto only; anything else is INERT text
 *   images          off      opt-in    `allowImages` (owner only) — else `[image]`
 *   tables          inert    render    the GFM table is shown as its source text
 *   work-ref pills  inert    render    `remarkWorkRefs` is not even run on public
 *   emphasis / code / lists / headings / blockquote / strikethrough / task lists
 *                   render   render
 *
 * The markdown engine and the GFM extension are the operator's own
 * (`react-markdown` + `remark-gfm`, parity `op-markdown-engine` / `op-gfm`).
 */
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AskChoiceCard,
  LocalCardHost,
  PendingCardsBar,
  ReportBlockCard,
  type ReportBlockRenderContext,
} from '@papercusp/chat-cards';
import type { CardResponse, ChatTurn, ChatTurnToolCall, OpenCardSnapshot, ReportBlock } from '@papercusp/chat-protocol';
import { remarkWorkRefs } from './remark-work-refs';
import type { WorkRefKind } from './parse-work-refs';
import { canOpenWorkRef } from './chat-ref-popup-params';
import { HydratedWorkRefPill } from './HydratedWorkRefPill';
import { MessageTimestamp } from './message-timestamp';
import {
  ASK_CAPABILITY_CONTRACT,
  ASK_CHOICE_TOOL,
  askChoiceArgsFromToolCall,
  askErrorMessage,
  type AskCapabilityContract,
  type AskProvenance,
  type AskTurnState,
  type PapercupChatController,
} from './use-papercup-chat';

// ---------------------------------------------------------------------------
// Pure helpers (parity `pt-transcript-placeholder`, `pt-capability-notice`)
// ---------------------------------------------------------------------------

export type PapercupChatHostTrust = 'owner' | 'public';

/**
 * What an EMPTY transcript is entitled to say. "Ask a question to start." is a
 * claim that this conversation has no history — also the shape of one whose
 * history is still ARRIVING, so `busy` (history loading) picks `opening`.
 */
export type AskTranscriptPlaceholder = 'invite' | 'opening' | null;

export function askTranscriptPlaceholder(input: {
  turnCount: number;
  hasLiveTurn: boolean;
  hasSurfaceError: boolean;
  busy: boolean;
}): AskTranscriptPlaceholder {
  if (input.turnCount > 0 || input.hasLiveTurn || input.hasSurfaceError) return null;
  return input.busy ? 'opening' : 'invite';
}

/** Build the public host's standing disclosure from a capability contract. */
export function askCapabilityNoticeText(contract: AskCapabilityContract = ASK_CAPABILITY_CONTRACT): string {
  const access =
    contract.machineAccess === 'full'
      ? 'full access to this machine — it can read and change files and run commands'
      : 'restricted access to this machine';
  const confirmation = contract.confirmation === 'none' ? 'with no confirmation step' : 'with a confirmation step';
  const activity =
    contract.activity === 'attached-tools-only'
      ? `Only its attached research tools (${contract.attachedTools.join(', ')}) are listed below; native file and shell activity is not itemised.`
      : 'The activity list below is not a complete record of what it did.';
  return `Papercup answers here with ${access}, ${confirmation}. ${activity}`;
}

/** Tool names for the "Looked at:" line — consecutive repeats collapsed, so an
 *  agent that reads four work-items in a row reads as one activity. */
export function lookedAtTools(calls: readonly ChatTurnToolCall[] | null | undefined): string[] {
  const out: string[] = [];
  for (const call of calls ?? []) {
    if (call.name === ASK_CHOICE_TOOL) continue;
    if (out[out.length - 1] === call.name) continue;
    out.push(call.name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown (D-005)
// ---------------------------------------------------------------------------

/** URL schemes a chat link may carry. Everything else — `javascript:`, `data:`,
 *  `vbscript:`, `file:`, a relative path that would resolve against the HOST's
 *  origin — is rendered as inert text. */
export const CHAT_LINK_PROTOCOLS = ['https:', 'http:', 'mailto:'] as const;

/** react-markdown `urlTransform`: an allowlisted absolute URL passes through
 *  verbatim; anything else becomes '' and the `a`/`img` overrides go inert. */
export function papercupChatUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  return (CHAT_LINK_PROTOCOLS as readonly string[]).includes(parsed.protocol) ? trimmed : '';
}

/**
 * Markdown is a hard break on a single `\n` (2026-07-25 owner screenshot: a
 * standard parser collapses a lone newline into a space — chat turns rely on
 * single newlines as real line breaks). The two-trailing-spaces token is the
 * CommonMark hard break, injected rather than pulling in a plugin for one rule.
 */
export function withHardBreaks(text: string): string {
  return text.replace(/\n/g, '  \n');
}

// Hoisted so the plugin lists are REFERENTIALLY STABLE across renders — an
// inline literal denies react-markdown any chance to skip work on an
// unchanged message.
const OWNER_REMARK_PLUGINS = [remarkGfm, remarkWorkRefs];
const PUBLIC_REMARK_PLUGINS = [remarkGfm];

interface HastNodeLike {
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

export interface ChatMarkdownProps {
  content: string;
  hostTrust: PapercupChatHostTrust;
  /** Owner-only opt-in for `<img>` (D-005 `md-images`: public=off owner=opt-in). */
  allowImages?: boolean;
  harnessSlug?: string;
  planSlug?: string | null;
  onWorkRefActivate?: (ref: { id: string; kind: WorkRefKind; planSlug?: string | null }) => void;
}

/**
 * One message's markdown. MEMOIZED — the composer's text re-renders the whole
 * tree on every keystroke, and a full parse per visible message per character
 * is the measured typing lag (owner bug 2026-07-27). `useDeferredValue` keeps a
 * streaming message's re-parse non-urgent so a keystroke preempts it.
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  content,
  hostTrust,
  allowImages = false,
  harnessSlug,
  planSlug,
  onWorkRefActivate,
}: ChatMarkdownProps) {
  const deferred = useDeferredValue(content);
  const source = withHardBreaks(deferred);
  const isOwner = hostTrust === 'owner';
  const components = useMemo<Components>(() => {
    const map: Record<string, unknown> = {
      p: ({ children }: { children?: ReactNode }) => <p className="pc-chat__p">{children}</p>,
      a: ({ children, href }: { children?: ReactNode; href?: string }) =>
        href ? (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ) : (
          <span className="pc-chat__link-inert" data-trust="inert">
            {children}
          </span>
        ),
      img: ({ src, alt }: { src?: string; alt?: string }) =>
        isOwner && allowImages && src ? (
          <img className="pc-chat__img" src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span className="pc-chat__img-inert" data-trust="inert">
            [image{alt ? `: ${alt}` : ''}]
          </span>
        ),
      // D-005 `md-work-refs`: the pill is the owner's; on the public host the
      // plugin never runs, and this override is the belt to that braces.
      workrefpill: ({ node }: { node?: HastNodeLike }) => {
        const id = typeof node?.properties?.refId === 'string' ? node.properties.refId : '';
        const kind: WorkRefKind = node?.properties?.refKind === 'plan-item' ? 'plan-item' : 'work-item';
        if (!id) return null;
        if (!isOwner) return <span data-trust="inert">{id}</span>;
        return (
          <HydratedWorkRefPill
            id={id}
            kind={kind}
            harnessSlug={harnessSlug ?? ''}
            planSlug={planSlug}
            size="xs"
            onActivate={
              // WI-10001541: a seam being wired is NOT the same question as this
              // ref having somewhere to go. Gate on the shared decision so a ref
              // that opens nothing renders as inert text rather than a dead button.
              onWorkRefActivate && canOpenWorkRef({ id, kind, planSlug }, harnessSlug)
                ? () => onWorkRefActivate({ id, kind, planSlug })
                : undefined
            }
          />
        );
      },
    };
    if (!isOwner) {
      // D-005 `md-tables`: public=inert — the table is shown as the text it was.
      map.table = ({ node }: { node?: HastNodeLike }) => {
        const start = node?.position?.start.offset;
        const end = node?.position?.end.offset;
        const raw = typeof start === 'number' && typeof end === 'number' ? source.slice(start, end) : '[table]';
        return (
          <pre className="pc-chat__table-inert" data-trust="inert">
            {raw}
          </pre>
        );
      };
    }
    return map as Components;
  }, [isOwner, allowImages, harnessSlug, planSlug, onWorkRefActivate, source]);

  return (
    <ReactMarkdown
      remarkPlugins={isOwner ? OWNER_REMARK_PLUGINS : PUBLIC_REMARK_PLUGINS}
      components={components}
      urlTransform={papercupChatUrlTransform}
    >
      {source}
    </ReactMarkdown>
  );
});

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface PapercupChatProps {
  chat: PapercupChatController;
  hostTrust: PapercupChatHostTrust;
  /** Owner-only opt-in for inline images (D-005). Ignored on the public host. */
  allowImages?: boolean;
  /** Harness scoping work-ref pill hydration (owner). */
  harnessSlug?: string;
  /** The conversation's plan context for P-NNN pills (owner). */
  planSlug?: string | null;
  /** What a work-ref pill click does — the host's navigation (owner). */
  onWorkRefActivate?: (ref: { id: string; kind: WorkRefKind; planSlug?: string | null }) => void;
  /**
   * The standing capability disclosure. Default: the public host shows
   * `askCapabilityNoticeText()`, the owner host shows none. Pass `null` to
   * suppress, a string to replace.
   */
  capabilityNotice?: string | null;
  capabilityContract?: AskCapabilityContract;
  assistantLabel?: string;
  userLabel?: string;
  composerPlaceholder?: string;
  /** Host-injected per-turn actions (parity `op-action-bar`) — optional. */
  renderActionBar?: (turn: ChatTurn) => ReactNode;
  /** Host-owned avatar/chip rendered before a committed turn. */
  renderAvatar?: (turn: ChatTurn) => ReactNode;
  /** Host-injected trailing composer chrome: voice / audience / faces — optional. */
  composerChrome?: ReactNode;
  /** Host override for a tool call's card; return null to fall through. */
  renderToolCard?: (tool: ChatTurnToolCall, turn: ChatTurn, index: number) => ReactNode | null;
  /** Host override for a turn's report card (default: chat-cards ReportBlockCard). */
  renderReport?: (report: ReportBlock, turn?: ChatTurn) => ReactNode;
  /** Client-side cards (the host's `askUserLocal` queue) — rendered by chat-cards' LocalCardHost. */
  localCards?: readonly OpenCardSnapshot[];
  onLocalCardResponse?: (response: CardResponse) => void;
  /** Controlled composer (a host that owns the draft, e.g. for voice STT). */
  inputValue?: string;
  onInputChange?: (value: string) => void;
  autoFocus?: boolean;
  className?: string;
  /** Host chrome above the transcript (mode/error/unavailable banners). */
  banner?: ReactNode;
  /** Host-specific empty state. Defaults to the compact shared invitation. */
  emptyState?: ReactNode;
  /** Hide the composer when the counterparty cannot receive a message. */
  composerDisabled?: boolean;
  /** A streaming host with no abort seam keeps Send disabled instead of showing a dead Stop button. */
  allowAbort?: boolean;
  /** Open the transcript on an exact turn or a text anchor. */
  focusIndex?: number | null;
  focusAnchor?: string | null;
  focusNonce?: number | null;
  /** Report which committed turn is currently at the top of the viewport. */
  onTopTurnIndex?: (index: number) => void;
  /** Rendered under the transcript, above the composer (a host's footer). */
  footer?: ReactNode;
}

type Row = { kind: 'turn'; key: string; turn: ChatTurn } | { kind: 'live'; key: 'live'; live: AskTurnState };

const ESTIMATED_ROW_PX = 72;

function roleLabel(role: ChatTurn['role'], assistantLabel: string, userLabel: string): string {
  if (role === 'user') return userLabel;
  if (role === 'system') return 'System';
  return assistantLabel;
}

function ToolTags({ calls, showInput }: { calls: readonly ChatTurnToolCall[]; showInput: boolean }) {
  const tags = calls.filter((c) => c.name !== ASK_CHOICE_TOOL);
  if (tags.length === 0) return null;
  return (
    <ul className="pc-chat__tools" aria-label="Tools used">
      {tags.map((c, i) => (
        <li
          key={`${c.callId ?? c.name}-${i}`}
          className="pc-chat__tool"
          title={showInput && c.input !== undefined ? safeStringify(c.input) : undefined}
        >
          {c.name}
        </li>
      ))}
    </ul>
  );
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch {
    return String(value);
  }
}

function Provenance({ provenance }: { provenance: AskProvenance | null | undefined }) {
  if (!provenance || (!provenance.engine && !provenance.model)) return null;
  return (
    <span className="pc-chat__provenance" data-engine={provenance.engine} data-model={provenance.model}>
      Answered by {[provenance.engine, provenance.model].filter(Boolean).join(' · ')}
    </span>
  );
}

function LookedAt({ calls }: { calls: readonly ChatTurnToolCall[] | null | undefined }) {
  const names = lookedAtTools(calls);
  if (names.length === 0) return null;
  return <span className="pc-chat__looked-at">Looked at: {names.join(', ')}</span>;
}

interface TurnRowProps {
  row: Row;
  index: number;
  start: number;
  measureElement: (el: HTMLElement | null) => void;
  hostTrust: PapercupChatHostTrust;
  allowImages: boolean;
  harnessSlug?: string;
  planSlug?: string | null;
  onWorkRefActivate?: PapercupChatProps['onWorkRefActivate'];
  assistantLabel: string;
  userLabel: string;
  renderActionBar?: PapercupChatProps['renderActionBar'];
  renderAvatar?: PapercupChatProps['renderAvatar'];
  renderToolCard?: PapercupChatProps['renderToolCard'];
  renderReport: (report: ReportBlock, turn?: ChatTurn) => ReactNode;
  answerPersistedCard: PapercupChatController['answerPersistedCard'];
  cardBusy: boolean;
  focused: boolean;
}

const TurnRow = memo(function TurnRow(props: TurnRowProps) {
  const { row, index, start, measureElement, hostTrust, allowImages, harnessSlug, planSlug, onWorkRefActivate } = props;
  const { assistantLabel, userLabel, renderActionBar, renderAvatar, renderToolCard, renderReport, answerPersistedCard, cardBusy, focused } = props;
  const isOwner = hostTrust === 'owner';
  const style = { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${start}px)` } as const;

  if (row.kind === 'live') {
    const live = row.live;
    return (
      <div
        data-index={index}
        data-turn="live"
        data-state={live.done ? 'done' : 'streaming'}
        ref={measureElement}
        className="pc-chat__turn pc-chat__turn--assistant pc-chat__turn--live"
        style={style}
      >
        <span className="pc-chat__role pc-chat__sr-only" data-role="assistant">
          {assistantLabel}
        </span>
        <ToolTags calls={live.toolCalls} showInput={isOwner} />
        {live.text ? (
          <div className="pc-chat__body">
            <ChatMarkdown
              content={live.text}
              hostTrust={hostTrust}
              allowImages={allowImages}
              harnessSlug={harnessSlug}
              planSlug={planSlug}
              onWorkRefActivate={onWorkRefActivate}
            />
          </div>
        ) : (
          !live.done && (
            <div className="pc-chat__streaming" role="status" aria-live="polite">
              <span className="pc-chat__spinner" aria-hidden="true" />
              <span>Papercup is thinking…</span>
            </div>
          )
        )}
        {live.errorCode ? (
          <p className="pc-chat__turn-error" role="alert">
            {askErrorMessage(live.errorCode, 'turn', live.retryAfterMs)}
          </p>
        ) : null}
        <div className="pc-chat__turn-footer">
          <Provenance provenance={live.provenance} />
          <LookedAt calls={live.toolCalls} />
        </div>
      </div>
    );
  }

  const turn = row.turn;
  const tools = turn.tools ?? [];
  const cards: ReactNode[] = [];
  tools.forEach((call, ti) => {
    const hostCard = renderToolCard?.(call, turn, ti);
    if (hostCard) {
      // Same wrapper as the built-in branch below. A host that supplies
      // `renderToolCard` (the operator, via the chat-cards registry) reaches the
      // SAME shared card as a host that does not (the portal) — so the wrapper
      // must be the same addressable element too, or the one rendered card is
      // only findable on one host. WI-10001780 was filed as "the persisted
      // chat:ask_choice card does not replay on the operator host" off exactly
      // that gap: a `.pc-chat__card` probe read 0 against this bare <div> while
      // the card was rendering fine.
      cards.push(<div key={`host-${ti}`} className="pc-chat__card">{hostCard}</div>);
      return;
    }
    const args = askChoiceArgsFromToolCall(call);
    if (!args) return;
    // Public hosts supply an ownership-checked adapter too. Markdown trust
    // must not disable that capability when replaying the same saved card.
    const canAnswer = !call.answered && !!answerPersistedCard;
    cards.push(
      <div key={`ask-${ti}`} className="pc-chat__card">
        <AskChoiceCard
          args={args}
          answered={call.answered ? { picks: call.answered.picks, at: call.answered.at } : undefined}
          hideOptions={!canAnswer && !call.answered}
          disableWhenAnswered={cardBusy}
          allowDecline={false}
          onAnswer={
            canAnswer
              ? (commit) => void answerPersistedCard?.({ turn, toolIndex: ti, picks: commit.picks })
              : undefined
          }
        />
      </div>,
    );
  });

  return (
    <div
      data-index={index}
      data-turn={turn.id}
      data-role={turn.role}
      data-message-index={index}
      data-focus-match={focused ? 'true' : undefined}
      ref={measureElement}
      className={`pc-chat__turn pc-chat__turn--${turn.role} oracle-msg oracle-msg-${turn.role}${turn.error ? ' pc-chat__turn--error' : ''}${focused ? ' pc-chat__turn--focus-match' : ''}`}
      style={style}
    >
      <div className="pc-chat__message-line">
        {renderAvatar ? <div className="pc-chat__avatar">{renderAvatar(turn)}</div> : null}
        <MessageTimestamp ts={turn.createdAt} />
        <div className="pc-chat__message-content">
          <span className="pc-chat__role pc-chat__sr-only" data-role={turn.role}>
            {roleLabel(turn.role, assistantLabel, userLabel)}
          </span>
          <ToolTags calls={tools} showInput={isOwner} />
          {turn.report ? (
            <div className="pc-chat__report">{renderReport(turn.report, turn)}</div>
          ) : turn.error ? (
            <p className="pc-chat__turn-error" role="alert">
              {turn.text}
            </p>
          ) : turn.text ? (
            <div className="pc-chat__body">
              <ChatMarkdown
                content={turn.text}
                hostTrust={hostTrust}
                allowImages={allowImages}
                harnessSlug={harnessSlug}
              planSlug={turn.planSlug ?? planSlug}
                onWorkRefActivate={onWorkRefActivate}
              />
            </div>
          ) : turn.role === 'assistant' && cards.length === 0 ? (
            <p className="pc-chat__body pc-chat__body--empty" role="status">
              <em>{tools.length > 0 ? 'Papercup ran its tools but returned no answer for this turn.' : 'Papercup returned no answer for this turn.'} Ask again to retry.</em>
            </p>
          ) : null}
          {cards}
          <div className="pc-chat__turn-footer">
            <Provenance provenance={turn.provenance} />
            <LookedAt calls={tools} />
            {renderActionBar ? <div className="pc-chat__actions">{renderActionBar(turn)}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * `p` becomes the card's OWN item-text span rather than a `<p>`: the card
 * renders each line inside its `<li>`, and a block element there breaks the
 * report layout. Same class the raw-text fallback used, so nothing shifts.
 */
const REPORT_ITEM_COMPONENTS: Record<string, unknown> = {
  p: ({ children }: { children?: ReactNode }) => (
    <span className="report-block-item-text">{children}</span>
  ),
};

/**
 * One report line's text, under the SAME D-005 trust matrix as a message body:
 * emphasis / code / lists render at BOTH trust levels, work-ref pills are owner
 * only (`remarkWorkRefs` is not run on public).
 *
 * WHY THIS EXISTS (WI-10000848, owner-reported 2026-09-08). The shared card's
 * fallback is `<span>{item.text}</span>` — raw text. So every host that had not
 * hand-written its own `renderReport` showed an agent's `**Done**` as literal
 * asterisks and every `WI-…` as dead text, while the operator's own adapter
 * (apps/operator/app/_components/chat/ReportBlockCard.tsx) wired the seam and
 * looked correct. That asymmetry WAS the bug: report lines are the surface most
 * likely to carry refs, and the default silently dropped them.
 *
 * The default now CARRIES the behaviour — a host opts OUT by passing its own
 * `renderReport`, instead of having to know to opt in.
 */
function ReportItemText({
  text,
  hostTrust,
  harnessSlug,
  planSlug,
  onWorkRefActivate,
}: {
  text: string;
  hostTrust: PapercupChatHostTrust;
  harnessSlug?: string;
  planSlug?: string | null;
  onWorkRefActivate?: (ref: { id: string; kind: WorkRefKind; planSlug?: string | null }) => void;
}): ReactNode {
  const isOwner = hostTrust === 'owner';
  const components = useMemo<Components>(() => {
    const map: Record<string, unknown> = { ...REPORT_ITEM_COMPONENTS };
    if (isOwner) {
      map.workrefpill = ({ node }: { node?: HastNodeLike }) => {
        const id = typeof node?.properties?.refId === 'string' ? node.properties.refId : '';
        const kind: WorkRefKind = node?.properties?.refKind === 'plan-item' ? 'plan-item' : 'work-item';
        if (!id) return null;
        return (
          <HydratedWorkRefPill
            id={id}
            kind={kind}
            harnessSlug={harnessSlug ?? ''}
            planSlug={planSlug}
            size="xs"
            onActivate={
              // WI-10001541: a seam being wired is NOT the same question as this
              // ref having somewhere to go. Gate on the shared decision so a ref
              // that opens nothing renders as inert text rather than a dead button.
              onWorkRefActivate && canOpenWorkRef({ id, kind, planSlug }, harnessSlug)
                ? () => onWorkRefActivate({ id, kind, planSlug })
                : undefined
            }
          />
        );
      };
    }
    return map as Components;
  }, [isOwner, harnessSlug, planSlug, onWorkRefActivate]);

  return (
    <ReactMarkdown
      remarkPlugins={isOwner ? OWNER_REMARK_PLUGINS : PUBLIC_REMARK_PLUGINS}
      components={components}
      urlTransform={papercupChatUrlTransform}
    >
      {withHardBreaks(text)}
    </ReactMarkdown>
  );
}

export function PapercupChat(props: PapercupChatProps) {
  const {
    chat,
    hostTrust,
    allowImages = false,
    harnessSlug,
    planSlug,
    onWorkRefActivate,
    capabilityContract,
    assistantLabel = 'Papercup',
    userLabel = 'You',
    composerPlaceholder = 'Ask Papercup…',
    renderActionBar,
    renderAvatar,
    composerChrome,
    renderToolCard,
    renderReport: renderReportProp,
    localCards,
    onLocalCardResponse,
    inputValue,
    onInputChange,
    autoFocus,
    className,
    banner,
    emptyState,
    composerDisabled = false,
    allowAbort = true,
    focusIndex,
    focusAnchor,
    focusNonce,
    onTopTurnIndex,
    footer,
  } = props;
  const isOwner = hostTrust === 'owner';
  const capabilityNotice =
    props.capabilityNotice !== undefined ? props.capabilityNotice : isOwner ? null : askCapabilityNoticeText(capabilityContract);

  // Built HERE rather than hoisted: the default needs THIS host's trust level
  // and workspace binding to decide whether a `WI-…` in a report line becomes a
  // live pill or stays text (WI-10000848). A host wanting different chrome
  // still wins by passing its own `renderReport`.
  const renderReport = useMemo<(report: ReportBlock, turn?: ChatTurn) => ReactNode>(
    () =>
      renderReportProp ??
      ((report: ReportBlock) => (
        <ReportBlockCard
          report={report}
          renderItemText={(context: ReportBlockRenderContext) => (
            <ReportItemText
              text={context.item.text}
              hostTrust={hostTrust}
              harnessSlug={harnessSlug}
              planSlug={planSlug}
              onWorkRefActivate={onWorkRefActivate}
            />
          )}
        />
      )),
    [renderReportProp, hostTrust, harnessSlug, planSlug, onWorkRefActivate],
  );

  // Composer draft — controlled when the host owns it, local otherwise.
  const [draft, setDraft] = useState('');
  const text = inputValue ?? draft;
  const setText = useCallback(
    (v: string) => {
      if (onInputChange) onInputChange(v);
      if (inputValue === undefined) setDraft(v);
    },
    [onInputChange, inputValue],
  );

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = chat.turns.map((turn) => ({ kind: 'turn', key: turn.id, turn }));
    if (chat.live) out.push({ kind: 'live', key: 'live', live: chat.live });
    return out;
  }, [chat.turns, chat.live]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const getScrollElement = useCallback(() => scrollerRef.current, []);
  const estimateSize = useCallback(() => ESTIMATED_ROW_PX, []);
  const getItemKey = useCallback((i: number) => rows[i]?.key ?? i, [rows]);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement, estimateSize, overscan: 8, getItemKey });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // ── Follow the tail (WI-4692): follow starts ON; a real user scroll away
  // from the bottom turns it off; scrolling back turns it on. While following,
  // every content change re-pins — with a bounded rAF settle loop, because
  // estimated rows measure larger than their estimate and the bottom moves.
  const followRef = useRef(true);
  const programmaticRef = useRef(false);
  const pinFramesRef = useRef(0);
  const pinActiveRef = useRef(false);
  const pinToBottom = useCallback(() => {
    pinFramesRef.current = 45;
    if (pinActiveRef.current) return;
    if (typeof requestAnimationFrame === 'undefined') return;
    pinActiveRef.current = true;
    const step = () => {
      const sc = scrollerRef.current;
      if (!sc || pinFramesRef.current <= 0 || !followRef.current) {
        pinActiveRef.current = false;
        return;
      }
      pinFramesRef.current -= 1;
      const target = sc.scrollHeight - sc.clientHeight;
      if (Math.abs(sc.scrollTop - target) > 1) {
        programmaticRef.current = true;
        sc.scrollTop = target;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);

  const resolvedFocusIndex = useMemo(() => {
    if (typeof focusIndex === 'number' && focusIndex >= 0 && focusIndex < chat.turns.length) return focusIndex;
    if (!focusAnchor) return -1;
    const needle = focusAnchor.replace(/\s+/g, ' ').trim().toLowerCase();
    if (needle.length < 8) return -1;
    const hay = chat.turns.map((turn) => turn.text.replace(/\s+/g, ' ').trim().toLowerCase());
    for (let len = needle.length; len >= 12; len = Math.floor(len / 2)) {
      const part = needle.slice(0, len).trim();
      if (part.length < 8) break;
      const index = hay.findIndex((text) => text.includes(part));
      if (index >= 0) return index;
    }
    return -1;
  }, [chat.turns, focusAnchor, focusIndex]);

  const focusKey = resolvedFocusIndex >= 0 ? `${resolvedFocusIndex}:${focusNonce ?? ''}` : null;
  const focusedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusKey || resolvedFocusIndex < 0 || focusedForRef.current === focusKey) return;
    focusedForRef.current = focusKey;
    followRef.current = false;
    virtualizer.scrollToIndex(resolvedFocusIndex, { align: 'start' });
  }, [focusKey, resolvedFocusIndex, virtualizer]);
  const liveTextLength = chat.live?.text.length ?? 0;
  useEffect(() => {
    if (followRef.current) pinToBottom();
  }, [rows.length, liveTextLength, chat.pendingCards.length, pinToBottom]);
  const onScroll = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    if (programmaticRef.current) {
      programmaticRef.current = false;
      return;
    }
    followRef.current = sc.scrollHeight - sc.clientHeight - sc.scrollTop < 24;
    if (onTopTurnIndex) {
      const first = virtualizer.getVirtualItems()[0]?.index ?? (rows.length > 0 ? 0 : -1);
      onTopTurnIndex(Math.min(first, chat.turns.length - 1));
    }
  }, [chat.turns.length, onTopTurnIndex, rows.length, virtualizer]);

  const submit = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      const question = text.trim();
      if (!question || chat.streaming) return;
      setText('');
      void chat.send(question);
    },
    [text, chat, setText],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        submit();
      }
    },
    [submit],
  );

  const placeholder = askTranscriptPlaceholder({
    turnCount: chat.turns.length,
    hasLiveTurn: chat.live !== null,
    hasSurfaceError: chat.surfaceError !== null,
    busy: chat.loadingHistory,
  });
  const surfaceErrorCode = chat.surfaceError?.code ?? null;
  const operatorDown =
    surfaceErrorCode !== null &&
    (surfaceErrorCode.startsWith('portal_operator_') || surfaceErrorCode === 'portal_chat_operator_unreachable');
  const lastTurn = chat.turns[chat.turns.length - 1];
  const surfaceState = chat.streaming
    ? 'streaming'
    : operatorDown
      ? 'operator-down'
      : chat.surfaceError || lastTurn?.error
        ? 'refused'
        : 'idle';

  return (
    <div
      className={`pc-chat${className ? ` ${className}` : ''}`}
      data-host-trust={hostTrust}
      data-state={surfaceState}
      data-testid="papercup-chat"
    >
      {banner ? <div className="pc-chat__banner">{banner}</div> : null}
      {capabilityNotice ? (
        <p
          className="pc-chat__notice"
          role="note"
          data-capability-tools={(capabilityContract ?? ASK_CAPABILITY_CONTRACT).attachedTools.join(',')}
        >
          {capabilityNotice}
        </p>
      ) : null}

      <div className="pc-chat__scroller" ref={scrollerRef} onScroll={onScroll} data-testid="papercup-chat-transcript">
        {chat.hasMoreEarlier ? (
          <button
            type="button"
            className="pc-chat__load-earlier"
            disabled={chat.loadingHistory}
            onClick={() => void chat.loadEarlier()}
          >
            {chat.loadingHistory ? 'Loading…' : 'Load earlier messages'}
          </button>
        ) : null}
        {!chat.hasMoreEarlier && chat.turns.length > 0 ? (
          <div className="pc-chat__history-boundary" role="status">
            Beginning of conversation
          </div>
        ) : null}
        {placeholder === 'invite' && emptyState ? (
          <div className="pc-chat__placeholder" data-placeholder={placeholder} role="status">
            {emptyState}
          </div>
        ) : placeholder ? (
          <p className="pc-chat__placeholder" data-placeholder={placeholder} role="status">
            {placeholder === 'opening' ? 'Opening this conversation…' : 'Ask a question to start.'}
          </p>
        ) : null}
        <div className="pc-chat__list" style={{ height: totalSize, position: 'relative' }} role="log" aria-live="polite">
          {virtualItems.map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            return (
              <TurnRow
                key={row.key}
                row={row}
                index={vi.index}
                start={vi.start}
                measureElement={virtualizer.measureElement}
                hostTrust={hostTrust}
                allowImages={isOwner && allowImages}
                harnessSlug={harnessSlug}
                planSlug={planSlug}
                onWorkRefActivate={onWorkRefActivate}
                assistantLabel={assistantLabel}
                userLabel={userLabel}
                renderActionBar={renderActionBar}
                renderAvatar={renderAvatar}
                renderToolCard={renderToolCard}
                renderReport={renderReport}
                answerPersistedCard={chat.answerPersistedCard}
                cardBusy={chat.cardBusy}
                focused={row.kind === 'turn' && vi.index === resolvedFocusIndex}
              />
            );
          })}
        </div>
      </div>

      <div className="pc-chat__tail">
        {localCards && localCards.length > 0 && onLocalCardResponse ? (
          <LocalCardHost cards={localCards} onResponse={onLocalCardResponse} renderReport={renderReport} className="pc-chat__local-cards" />
        ) : null}
        {chat.pendingCards.length > 0 ? (
          <PendingCardsBar
            cards={chat.pendingCards}
            busy={chat.cardBusy}
            error={chat.cardError}
            onResponse={(response) => void chat.answerCard(response)}
            renderReport={renderReport}
            className="pc-chat__pending-cards"
          />
        ) : chat.cardError ? (
          <p className="pc-chat__error" role="alert">
            {chat.cardError}
          </p>
        ) : null}
      </div>

      {chat.surfaceError ? (
        <div className="pc-chat__error" role="alert" data-error-code={chat.surfaceError.code ?? undefined}>
          <span>{askErrorMessage(chat.surfaceError.code, chat.surfaceError.context, chat.surfaceError.retryAfterMs)}</span>
          {chat.retryTarget ? (
            <button type="button" className="pc-chat__retry" onClick={() => void chat.retry()}>
              {chat.retryTarget === 'question' ? 'Retry question' : 'Retry'}
            </button>
          ) : null}
        </div>
      ) : null}

      {footer}

      {!composerDisabled ? <form className="pc-chat__composer" onSubmit={submit} data-testid="papercup-chat-composer">
        <textarea
          className="pc-chat__input"
          data-testid="composer"
          rows={1}
          value={text}
          placeholder={composerPlaceholder}
          aria-label="Message Papercup"
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {composerChrome ? <div className="pc-chat__composer-chrome">{composerChrome}</div> : null}
        {chat.streaming && allowAbort ? (
          <button type="button" className="pc-chat__stop" onClick={chat.abort} aria-label="Stop">
            Stop
          </button>
        ) : (
          <button type="submit" className="pc-chat__send" data-testid="send" disabled={!text.trim() || chat.streaming} aria-label="Send">
            Send
          </button>
        )}
      </form> : null}
    </div>
  );
}
