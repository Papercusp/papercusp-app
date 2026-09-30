"use client";

/**
 * OperatorChat — single-thread chat with the Operator.
 *
 * Thin host adapter around the shared `<PapercupChat>` component. The desktop
 * and portal surfaces share this renderer and backend (same SSE event format
 * — `event: delta` per token, `event: error` on failure) — only the
 * styling, configuration, and route URL differ:
 *
 *   - Operator → /api/agent-mcp/operator-converse  (lands later)
 *   - Oracle   → /api/oracle/chat (or /api/harness/<slug>/agent-chats/...)
 *
 * In this commit OperatorChat is still UI-only (no live wiring); the
 * conversation engine + route both arrive in subsequent commits and
 * plug in via the `messages` / `busy` / `onSubmit` props this
 * component already exposes.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Lightbulb, UserRound } from "lucide-react";
import { toast } from "sonner";
import { parseAsString, useQueryState } from "nuqs";
import type { ChatMessage } from "./chat/chat-types";
import type { ChatTurn, ChatTurnToolCall, ReportBlock } from "@papercusp/chat-protocol";
import {
  EMPTY_TURN,
  PAPERCUP_CHAT_CSS,
  PapercupChat,
  type PapercupChatController,
} from "@papercusp/operator-ui/papercup-chat";
import type { WorkRefKind } from "./chat/parse-work-refs";
import {
  CHAT_PLAN_POPUP_PARAM,
  CHAT_WORK_ITEM_POPUP_PARAM,
  workRefPopupTarget,
} from "./chat/chat-ref-popup-params";
import { CardAnswerError } from "./OperatorConversationProvider";
import { PendingCardsBar } from "./chat/PendingCardsBar";
import { renderCard } from "@/lib/chat-cards";
import {
  CHAT_SEED_EVENT,
  consumePendingChatSeed,
  readChatDraft,
  writeChatDraft,
} from "./inbox/chat-seed";
import { OperatorLogoMark } from "./OperatorLogoMark";
import { Tooltip } from "../harness/Tooltip";
import { FLAGS } from "@papercusp/flags";
import { useFlag } from "@/lib/flag-hooks";
import { ReportBlockCard } from "./chat/ReportBlockCard";
import { useCurrentUserIdentity } from "./use-current-user";

type ChatIconComponent = ComponentType<{ className?: string }>;

interface Props {
  /** Conversation messages, oldest first. */
  messages: ChatMessage[];
  /** True while the operator is composing/streaming. */
  busy: boolean;
  /** Peer-window generation in flight (multi-window P-009) — thinking row only. */
  peerBusy?: boolean;
  /** True while in passive mode — input still accepts text; no auto-replies. */
  passive: boolean;
  /** Disable the composer when the counterparty cannot receive a message. */
  composerDisabled?: boolean;
  /** Copy shown when the composer is disabled (for example, relaunch guidance). */
  composerDisabledMessage?: string;
  /** Override the default global-operator empty-state guidance. */
  emptyStateBody?: string;
  /**
   * The workspace-wide Scan/Review/Summarize starters belong only to the
   * global Papercup thread. Scoped Papercup callers set this false while still
   * retaining the Papercup identity and full shared chat renderer.
   */
  showQuickDraftPrompts?: boolean;
  /** Called with the user's message when they submit. */
  onSend: (content: string) => void;
  /**
   * Optional callback for the "Generate ideas" button next to Send.
   * Fires user_says_ready under the hood; works in both active and
   * passive mode. Omit to hide the button.
   * Plan: active-mode-proactive-ticks-2026-05-14.md §C.9.
   */
  onGenerateIdeas?: () => void;
  /** Optional banner above the transcript (e.g. silence-check status). */
  banner?: React.ReactNode;
  /** Optional error string to render in the .oracle-error row. */
  error?: string | null;

  /** Infinite-scroll plumbing (forwarded to PapercupChat). */
  onLoadEarlier?: () => void;
  hasMoreEarlier?: boolean;
  loadingEarlier?: boolean;
  /** Open the transcript ON the message containing this text instead of at the
   *  tail — forwarded verbatim to PapercupChat (HUD search → the matched
   *  turn). Same passthrough pattern as the infinite-scroll props above. */
  focusAnchor?: string | null;
  /** Exact message index to focus, when the caller has one (the stream's own
   *  `anchor` event). Wins over `focusAnchor`. Forwarded verbatim. */
  focusIndex?: number | null;
  /** Re-request the SAME `focusIndex` (chat-popup-turn-rail-2026-08-31 P-003).
   *  Bumped per user gesture so the turn rail's second click on the row you are
   *  already parked on scrolls again. Forwarded verbatim. */
  focusNonce?: number | null;
  /** Which message is under the top of the viewport, reported on change (P-005).
   *  Forwarded verbatim; this is what drives the turn rail's live row. */
  onTopMessageIndex?: (index: number) => void;

  /**
   * chat:ask_choice resolution. Called when the user commits a
   * selection (one click for single-select, Submit for multi-select).
   * Parent does the I/O — typically the OperatorConversation context's
   * answerChoice() which POSTs to turn-answer. Required for cards to
   * be interactive; if omitted, cards render disabled.
   */
  onAnswerChoice?: (input: {
    assistantSeq: number;
    toolIndex: number;
    picks: Array<{ option_id: string; label: string }>;
    declined?: boolean;
  }) => Promise<void> | void;

  /**
   * Active conversation id. When provided alongside `workspaceId`,
   * the chat renders a PendingCardsBar that subscribes to the
   * state-snapshot SSE stream and shows ctx.askUser cards above the
   * composer. Omit either to disable the new-card surface.
   */
  conversationId?: string;
  workspaceId?: string;

  /**
   * Display name substituted into the default empty-state title + composer
   * placeholder copy (both hardcode "Papercup" otherwise). Override when this
   * conversation ISN'T with Papercup — e.g. the direct session-chat popup
   * (owner-inbox-single-pane-2026-07-17 P-007, SessionChatModal) reuses this
   * same component for a live chat with an arbitrary su agent. The props
   * audit that generalized this component for that reuse (D-005) found every
   * OTHER prop already generic (messages/busy/onSend et al.) — this was the
   * one hardcoded bit of copy standing in the way of a second caller.
   */
  agentName?: string;

  /**
   * deterministic-status-cards-2026-07-17 P-003: drill-in router for a curator
   * status card's row `ref`. Supplied by the PARENT (OperatorChatSidebar), which
   * owns the nuqs inbox navigation — so this component stays provider-free +
   * unit-testable. Omit ⇒ card rows render without an Open action (e.g. reuse in
   * a context with no inbox to navigate to).
   */
  onDrillIn?: (ref: string) => void;

  /**
   * Openability predicate for a card ref, forwarded to ReportBlockCard. Pure
   * passthrough (same pattern as onDrillIn) — the CALLER owns the resolver and
   * the live items, so it alone can say whether a ref opens anything. Omit ⇒
   * every ref keeps rendering an Open action.
   */
  canDrillIn?: (ref: string) => boolean;

  /**
   * Per-message avatar override, forwarded straight through to
   * PapercupChat (gui-chat-session-controls-2026-07-25 P-012). Used by
   * SessionChatModal to swap the default agent-kind icon for a roster-driven
   * identity chip (handle + fleet colour + leader/member marker). Omit to
   * keep the default icon avatar — this component adds no behavior of its
   * own around it, it's a pure passthrough (same pattern as onDrillIn).
   */
  renderAvatar?: (msg: ChatMessage) => ReactNode | null | undefined;

  /**
   * The PANE's own mark — the icon a message wears when nothing more specific
   * applies, and the icon of the empty state (PapercupChat derives its
   * `fallbackIcon` from `emptyState.icon`).
   *
   * WI-6503 [owner 2026-07-27, verbatim] "remove the papercup icon from the
   * chatbox for the chatboces where the conversation isnt with papercup." This
   * used to be the CONSTANT `OperatorLogoMark` — the Papercup brand cup — so a
   * SessionChatModal conversation with an arbitrary su agent branded every
   * unstamped message as Papercup (measured live: 11 of 12 rendered avatars).
   * The `extra` starting-prompts panel below was already gated for exactly this
   * reason; the icon on the same object was not.
   *
   * It is a PROP rather than an internal `agentName === 'Papercup'` test on
   * purpose: the item requires resolving from the conversation's actual
   * participant, never a title match. The caller knows its counterparty;
   * this component does not. Omit ⇒ the Papercup mark, which is correct for
   * the one pane whose counterparty really is Papercup (OperatorChatSidebar).
   */
  paneIcon?: ChatIconComponent;

  /**
   * Optional informational row rendered under the composer
   * (gui-chat-session-controls-2026-07-25 P-007). Pure passthrough to
   * PapercupChat's `footer` prop — same pattern as renderAvatar. Omit
   * to render nothing.
   */
  footer?: ReactNode;

  /**
   * Harness scoping this conversation's WI-/EI-/F- ref pills
   * (chat-ref-pills-2026-07-26 P-008) — forwarded to PapercupChat for
   * live pill hydration (P-005) AND used by this component's OWN
   * onWorkRefActivate wiring (below) to scope the WorkItemPopupModal query.
   * Omit when the caller has no single-harness context (e.g. the
   * cross-workspace operator sidebar) — pills still render, just static
   * (no live state, no click destination), same graceful degrade
   * PapercupChat already documents for a missing harnessSlug.
   */
  harnessSlug?: string;
}

const STARTING_PROMPTS = [
  {
    title: "Scan workspaces",
    hint: "find active harnesses and urgent issues",
    prompt: "Scan my workspaces for active harnesses and urgent issues.",
  },
  {
    title: "Review blockers",
    hint: "surface failing runs, audits, and pending answers",
    prompt:
      "Review current blockers, failing runs, audits, and pending answers.",
  },
  {
    title: "Summarize state",
    hint: "get a quick brief on what changed recently",
    prompt: "Summarize the current workspace state and what changed recently.",
  },
] as const;

function messageTurnId(message: ChatMessage, index: number): string {
  if (message.id) return message.id;
  if (typeof message.seq === "number") return `operator-seq-${message.seq}`;
  return `operator-turn-${index}`;
}

function messageCreatedAt(message: ChatMessage): number {
  if (!message.ts) return 0;
  const parsed = Date.parse(message.ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toChatTurn(message: ChatMessage, index: number): ChatTurn {
  return {
    id: messageTurnId(message, index),
    ...(typeof message.seq === "number" ? { seq: message.seq } : {}),
    role: message.role,
    text: message.content,
    createdAt: messageCreatedAt(message),
    ...(message.tools ? { tools: message.tools } : {}),
    ...(message.report ? { report: message.report } : {}),
    ...(message.planSlug !== undefined ? { planSlug: message.planSlug } : {}),
  };
}

export function OperatorChat({
  messages,
  busy,
  peerBusy,
  passive,
  onSend,
  onGenerateIdeas,
  banner,
  error,
  onLoadEarlier,
  hasMoreEarlier,
  loadingEarlier,
  focusAnchor,
  focusIndex,
  focusNonce,
  onTopMessageIndex,
  onAnswerChoice,
  conversationId,
  workspaceId,
  agentName = "Papercup",
  onDrillIn,
  canDrillIn,
  renderAvatar,
  paneIcon,
  footer,
  harnessSlug,
  composerDisabled = false,
  composerDisabledMessage,
  emptyStateBody,
  showQuickDraftPrompts = true,
}: Props) {
  // chat-ref-pills-2026-07-26 P-008 / D-002: this is the seam where a
  // WI-/EI-/F-/P- ref pill's click actually DOES something. PapercupChat
  // (P-004) only exposes the plain `onWorkRefActivate` passthrough hook —
  // this component wires it by WRITING the "which item is open" nuqs params.
  // It does not render them: `chat/ChatRefPopupHost` owns the single mount at
  // the router root (WI-6601). Distinct param names from PlansPane's own
  // `pplan` (its Plans-pane popup and this chat-triggered one can be open
  // independently without fighting over the same URL key).
  //
  // Only the SETTERS are bound — reading these here would be the per-instance
  // render this component no longer does.
  const [, setOpenWorkItem] = useQueryState(
    CHAT_WORK_ITEM_POPUP_PARAM,
    parseAsString,
  );
  const [, setOpenChatPlan] = useQueryState(
    CHAT_PLAN_POPUP_PARAM,
    parseAsString,
  );

  const handleWorkRefActivate = useCallback(
    (ref: { id: string; kind: WorkRefKind; planSlug?: string | null }) => {
      // The DECISION is shared with every other host that writes these params
      // (`workRefPopupTarget`); only the setters are ours. Two hosts disagreeing
      // about it is exactly WI-10001509, where the portal rendered a dead pill
      // because it never wired this seam at all.
      //
      // A null target means OPEN NOTHING, and both cases are deliberate: a P-
      // ref with no message plan_slug context has no plan to open (P-006's "no
      // plan context" stance), and a WI-/EI-/F- ref with no harness has nothing
      // safe to ENCODE, since workItems.detail is harness-scoped.
      //
      // Carrying THIS conversation's harness in the value is what makes the
      // single root-level renderer correct: it can otherwise only fall back to
      // the surface's `?slug`, which is the wrong harness whenever a session
      // chat for harness X is open over a board scoped to Y.
      const target = workRefPopupTarget(ref, harnessSlug);
      if (!target) return;
      if (target.param === CHAT_PLAN_POPUP_PARAM) void setOpenChatPlan(target.value);
      else void setOpenWorkItem(target.value);
    },
    [harnessSlug, setOpenChatPlan, setOpenWorkItem],
  );

  const currentUser = useCurrentUserIdentity();

  // Inbox "Discuss" hands a drafted message to this composer (chat-seed.ts):
  // consume a staged seed on mount (the usual path — the chat body was
  // unmounted while the inbox view showed), and listen for the live event in
  // case a seed arrives while mounted. Consume-once either way. A fresh seed
  // wins over a persisted draft; otherwise the draft survives REMOUNTS (body
  // swap to the inbox/pot view and back, reconnect re-keys) via the
  // per-workspace sessionStorage mirror kept in sync below.
  const [input, setInput] = useState<string>(
    () => consumePendingChatSeed() ?? readChatDraft() ?? "",
  );
  useEffect(() => {
    writeChatDraft(input);
  }, [input]);
  useEffect(() => {
    const onSeed = () => {
      const t = consumePendingChatSeed();
      if (t) setInput(t);
    };
    window.addEventListener(CHAT_SEED_EVENT, onSeed);
    return () => window.removeEventListener(CHAT_SEED_EVENT, onSeed);
  }, []);

  const unavailableCopy =
    composerDisabledMessage ??
    "This session cannot receive messages. Relaunch or resume the agent to continue.";

  // Tool-card dispatch via the chat-cards registry (phase-4 T2.1).
  // The registry maps tool names → renderers; we supply only the
  // onAnswer callback because the live-tail dispatch is consumer-
  // specific (Oracle handles it differently).
  const renderToolCard = useCallback(
    (t: ChatTurnToolCall, turn: ChatTurn, ti: number): ReactNode | null => {
      return renderCard(t.name, {
        args: t.input ?? {},
        answered: t.answered,
        onAnswer: (payload) => {
          const { picks, declined } = payload as {
            picks: Array<{ option_id: string; label: string }>;
            declined?: boolean;
          };
          // WI-5175 (owner repro 2026-07-17: "I clicked an option and nothing
          // happened"). BOTH guards below used to `return` / `console.warn`
          // silently, so an unanswerable card was indistinguishable from a dead
          // button. A click ALWAYS produces feedback now.
          if (!onAnswerChoice) {
            toast.error("This card isn't interactive here.");
            return;
          }
          if (typeof turn.seq !== "number") {
            // The message hasn't been assigned its persisted seq yet — the
            // answer has nowhere to land. Transient: it resolves once the turn
            // persists, so say "not yet", not "broken".
            toast.error("Still saving this message — try again in a moment.");
            return;
          }
          // Fire-and-forget — server-side atomicity guarantees the
          // assistant-answered + user-turn rows land together. The
          // live-tail picks them up; we don't optimistically dispatch.
          void Promise.resolve(
            onAnswerChoice({
              assistantSeq: turn.seq,
              toolIndex: ti,
              picks,
              ...(declined ? { declined: true } : {}),
            }),
          ).catch((err: unknown) => {
            const reason =
              err instanceof CardAnswerError ? err.reason : "failed";
            const message =
              err instanceof Error
                ? err.message
                : "Could not submit your answer.";
            // already_answered reconciles the card to the server's answer, so
            // it's informational — the user sees the truth appear. The rest are
            // real failures worth an error toast.
            if (reason === "already_answered") toast.info(message);
            else toast.error(message);
            // eslint-disable-next-line no-console
            console.warn("[operator-chat] answerChoice failed:", err);
          });
        },
      });
    },
    [onAnswerChoice],
  );

  // deterministic-status-cards-2026-07-17 P-003: the CURATOR's deterministic
  // status turns (ChatMessage.report, mapped only for source:'system') render
  // as a structured card here — in place of their flattened markdown lines —
  // with each row's drill-in ref as a real action (routed by the parent's
  // `onDrillIn`, which owns the nuqs inbox nav — keeping this component
  // provider-free + unit-testable). The operator's OWN <report> still routes to
  // the Inbox (its turns never set ChatMessage.report). Flag-gated: OFF →
  // renderReport returns null → the plain-text content renders byte-identically
  // (the clean kill-switch).
  const curatorCardsOn = useFlag(FLAGS.CURATOR_STATUS_CARDS);
  const renderReport = useCallback(
    (report: ReportBlock, turn?: ChatTurn): ReactNode | null => {
      if (!curatorCardsOn) return null;
      return (
        <ReportBlockCard
          report={report}
          onDrillIn={onDrillIn}
          canDrillIn={canDrillIn}
          harnessSlug={harnessSlug}
          planSlug={turn?.planSlug}
          onWorkRefActivate={handleWorkRefActivate}
        />
      );
    },
    [curatorCardsOn, onDrillIn, canDrillIn, harnessSlug, handleWorkRefActivate],
  );

  const streamingMessage = useMemo(() => {
    if (!busy) return null;
    const last = messages[messages.length - 1];
    return last?.role === "assistant" && last.id?.startsWith("opt-assistant-")
      ? last
      : null;
  }, [busy, messages]);
  const projectedMessages = useMemo(
    () => (streamingMessage ? messages.slice(0, -1) : messages),
    [messages, streamingMessage],
  );
  const turns = useMemo(
    () => projectedMessages.map(toChatTurn),
    [projectedMessages],
  );
  const sourceByTurnId = useMemo(
    () =>
      new Map(
        projectedMessages.map((message, index) => [
          messageTurnId(message, index),
          message,
        ]),
      ),
    [projectedMessages],
  );
  const live = useMemo(
    () =>
      busy || peerBusy
        ? {
            ...EMPTY_TURN,
            text: streamingMessage?.content ?? "",
            toolCalls: (streamingMessage?.tools ?? []) as ChatTurnToolCall[],
          }
        : null,
    [busy, peerBusy, streamingMessage],
  );
  const send = useCallback(
    async (text: string) => {
      if (composerDisabled) return;
      onSend(text);
    },
    [composerDisabled, onSend],
  );
  const loadEarlier = useCallback(async () => {
    await onLoadEarlier?.();
  }, [onLoadEarlier]);
  const chat = useMemo<PapercupChatController>(
    () => ({
      conversationId: conversationId ?? null,
      turns,
      live,
      streaming: busy || !!peerBusy,
      busy: busy || !!peerBusy || !!loadingEarlier,
      loadingHistory: !!loadingEarlier,
      hasMoreEarlier: !!hasMoreEarlier,
      pendingCards: [],
      cardBusy: false,
      cardError: null,
      surfaceError: null,
      unsentQuestion: "",
      retryTarget: null,
      send,
      answerCard: async () => {},
      answerPersistedCard: null,
      retry: async () => {},
      loadEarlier,
      abort: () => {},
      appendLocalTurns: () => {},
    }),
    [
      busy,
      conversationId,
      hasMoreEarlier,
      live,
      loadEarlier,
      loadingEarlier,
      peerBusy,
      send,
      turns,
    ],
  );

  const renderSharedAvatar = useCallback(
    (turn: ChatTurn): ReactNode => {
      const message = sourceByTurnId.get(turn.id) ?? {
        role: turn.role,
        content: turn.text,
      };
      const override = renderAvatar?.(message);
      if (override) return override;
      if (message.role === "user") {
        return (
          <span className="oracle-msg-avatar oracle-msg-avatar--user-identity">
            <span className="pc-sr-only">
              {currentUser ? `${currentUser.displayName} (you)` : "You"}
            </span>
            {currentUser ? (
              <span aria-hidden="true">{currentUser.initial}</span>
            ) : (
              <UserRound className="oracle-msg-icon" aria-hidden="true" />
            )}
          </span>
        );
      }
      const PaneIcon = paneIcon ?? OperatorLogoMark;
      return (
        <span className="oracle-msg-avatar" aria-hidden="true">
          <PaneIcon className="oracle-msg-icon" />
        </span>
      );
    },
    [currentUser, paneIcon, renderAvatar, sourceByTurnId],
  );

  const emptyState = (
    <div className="op-chat-empty-state" data-testid="operator-chat-empty-state">
      <div className="op-chat-empty-state__title">{agentName}</div>
      <div className="op-chat-empty-state__body">
        {composerDisabled
          ? unavailableCopy
          : passive
            ? "In passive mode. Type below to wake them."
            : (emptyStateBody ?? "Tell me what you want to inspect, scan, or unblock.")}
      </div>
      {agentName === "Papercup" && showQuickDraftPrompts ? (
        <div className="op-chat-empty-panel" aria-label="Quick draft prompts">
          <div className="op-chat-empty-panel-head">
            <OperatorLogoMark variant="compact" className="op-chat-empty-panel-logo" />
            <div className="op-chat-empty-panel-label">Quick draft prompts</div>
          </div>
          <div className="op-chat-empty-panel-list">
            {STARTING_PROMPTS.map(({ title, hint, prompt }) => (
              <button
                key={title}
                type="button"
                className="op-chat-empty-row"
                onClick={() => setInput(prompt)}
                disabled={busy || composerDisabled}
                aria-label={`${title}: ${hint}. Draft this prompt.`}
              >
                <span className="op-chat-empty-row-title">{title}</span>
                <span className="op-chat-empty-row-hint">{hint}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <style>{PAPERCUP_CHAT_CSS}</style>
      <PapercupChat
        chat={chat}
        hostTrust="owner"
        assistantLabel={agentName}
        userLabel="You"
        className="op-chat-shared"
        banner={
          <>
            {composerDisabled ? (
              <div
                className="oracle-session-composer-unavailable"
                data-testid="session-chat-composer-unavailable"
                role="status"
              >
                {unavailableCopy}
              </div>
            ) : null}
            {banner}
            {error ? (
              <div className="oracle-error" role="alert">
                {error}
              </div>
            ) : null}
          </>
        }
        footer={
          <>
            {conversationId && workspaceId ? (
              <PendingCardsBar conversationId={conversationId} workspaceId={workspaceId} />
            ) : null}
            {footer}
          </>
        }
        emptyState={emptyState}
        composerPlaceholder={
          composerDisabled
            ? unavailableCopy
            : passive
              ? `Type to wake ${agentName}…`
              : `Reply to ${agentName}…`
        }
        inputValue={input}
        onInputChange={setInput}
        composerDisabled={composerDisabled}
        allowAbort={false}
        composerChrome={
          onGenerateIdeas ? (
            <Tooltip label="Generate ideas" side="top" align="center">
              <button
                type="button"
                aria-label="Generate ideas"
                onClick={onGenerateIdeas}
                disabled={busy || composerDisabled || input.trim() !== ""}
                className="pc-button op-chat-ideas-button"
              >
                <Lightbulb aria-hidden="true" className="oracle-send-icon" />
              </button>
            </Tooltip>
          ) : undefined
        }
        renderToolCard={renderToolCard}
        renderReport={renderReport}
        renderAvatar={renderSharedAvatar}
        focusAnchor={focusAnchor}
        focusIndex={focusIndex}
        focusNonce={focusNonce}
        onTopTurnIndex={onTopMessageIndex}
        harnessSlug={harnessSlug}
        onWorkRefActivate={handleWorkRefActivate}
      />
      {/* chat-ref-pills-2026-07-26 P-008: the D-002 seam WRITES its
          destinations (`wpop`/`wppop`, above) and deliberately does NOT render
          them. Both popups are mounted exactly once, at the router root, by
          `chat/ChatRefPopupHost` — see WI-6601.

          This component used to mount them itself, gated on its own
          `harnessSlug` so the persistent sidebar instance and a harness-scoped
          one (SessionChatModal via HudView) could not double-render the same
          global param. But the sidebar is a CROSS-HARNESS surface and never
          receives a `harnessSlug`, so on any mount without a resolvable
          `?slug` that gate closed on the only instance present: the param was
          written correctly and nothing rendered it. One renderer at the root
          satisfies both ends — no duplicate, and no surface where the popup
          has no mount at all. */}
    </>
  );
}

// Keep the shared message type exported here so OperatorChatSidebar
// + the (forthcoming) OperatorConversation provider don't need to
// reach across the chat/ folder. Re-export, not redeclare.
export type { ChatMessage as OperatorChatMessage } from "./chat/chat-types";
