"use client";

/**
 * OperatorConversationProvider — owns the operator's conversation
 * state machine.
 *
 * State sub-machine (active mode):
 *
 *   ready
 *     → user submits          → generating
 *     → 10s silent             → silence_nudge ("Still with me?")
 *   silence_nudge
 *     → user submits           → generating  (silence prompts treated as ordinary turns)
 *     → 30s still silent       → silence_check ("Want me to go into passive mode?")
 *   silence_check
 *     → user says yes          → PASSIVE
 *     → user says no           → ready (resume the thread)
 *     → 30s no response        → quiet_wait     ← still active, just silent
 *   quiet_wait
 *     → ANY user engagement    → generating (operator picks up the thread)
 *   generating → operator turn arrives → ready (timer restarts)
 *
 * Passive mode: silence timers are off entirely. User input still works
 * and triggers a single reply turn. The "want active?" gate is checked
 * in the dispatcher when the operator emits a turn (turns_in_last_2min ≥ 3
 * AND now > sleep_until).
 *
 * Tag dispatch (parsed by lib/operator-converse-tags.parseOperatorTurn):
 *   - <say>       → push assistant message, restart silence timer, end turn
 *   - <set_mode>  → flip mode (sets sessionStorage + fires event)
 *   - <sleep>     → write sleep_until clock, no message
 *
 * The actual model call (`runGeneration`) is a stub here and replaced by
 * a /api/agent-mcp/operator-converse fetch in a later commit. Parser +
 * dispatcher stay the same — only the transport differs.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  parseOperatorTurn,
  readOperatorMessagesFromSession,
  readOperatorModeFromSession,
  readSleepUntilMs,
  writePendingDismissalAtMs,
  sleepTagToEpochMs,
  writeOperatorMessagesToSession,
  writeOperatorModeToSession,
  writeSleepUntilMs,
  type OperatorMode,
  type ParsedReport,
} from "@papercusp/operator-core/lib/operator-converse-tags";
import {
  adoptableSharedState,
  broadcastGenerating,
  installOperatorWindowSync,
  peerGeneratingNow,
} from "@papercusp/operator-core/lib/operator-window-sync";
import {
  getVoiceState,
  speak,
  subscribeVoiceState,
  type TranscriptSource,
} from "./voice/voice-mode";
import { useSyncQuery } from "@papercusp/sync";
import { useWorkspaceId } from "@/lib/use-workspace-id";
import type { ChatMessage, ChatToolCall } from "./chat/chat-types";
import { useStateSnapshots } from "@/lib/use-state-snapshots";
import { selectFocusedCard } from "@/lib/chat-cards/select-focused-card";
import { composeAmbiguityPrompt } from "@papercusp/operator-core/lib/voice-cards/compose-ambiguity-prompt";
import {
  attachActive as routerAttachActive,
  BUFFER_WINDOW_MS as ROUTER_BUFFER_WINDOW_MS,
  clearActive as routerClearActive,
  createRouterState,
  expirePending as routerExpirePending,
  markPending as routerMarkPending,
  resetRouter,
  routeTranscript,
} from "@papercusp/operator-core/lib/voice-cards/voice-card-router";
import { postCardResponse } from "@papercusp/operator-core/lib/post-card-response";
import {
  loadVoicePrefsClient,
  subscribeVoicePrefsClient,
} from "./voice/voice-prefs-client";
import { getConfiguredWakeWordForDisplay } from "@papercusp/operator-core/lib/voice-cards/wakeword-display";
import { setVoiceConverseHandler } from "./voice/voice-converse-handler";
import { sharedState as sharedOperatorState } from "@papercusp/operator-core/lib/operator-shared-state";
import { operatorTurnToolsRevision } from "@/lib/operator-turn-tools-revision";
import { OperatorSayStreamProjector } from "@/lib/operator-say-stream";

interface OperatorTurnRow {
  id: string;
  conversationId: string;
  seq: number;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
  /** Who authored the turn (the wire already carries it, turnRowToWire). The
   *  curator's status turns are `system`; the operator's own turns are
   *  text_typed/voice_*. deterministic-status-cards-2026-07-17 P-003. */
  source?: "text_typed" | "voice_stt" | "voice_tts" | "system";
  tools?: ChatToolCall[] | null;
  report?: ParsedReport | null;
}

function createdAtIso(createdAt: unknown): string | undefined {
  const epochMs = Number(createdAt);
  if (!Number.isFinite(epochMs)) return undefined;
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return undefined;
  }
}

/** deterministic-status-cards-2026-07-17 P-003: map a turn's `report` onto
 *  ChatMessage.report ONLY for a curator `source:'system'` turn — so `report`
 *  present ⟺ a curator status CARD (renders in the chat via ReportBlockCard).
 *  The operator's OWN `<report>` turns (text_typed/voice_tts) still route to the
 *  Inbox and never set this, keeping chat conversation. */
function reportForTurn(t: {
  source?: string | null;
  report?: ParsedReport | null;
}): ParsedReport | undefined {
  return t.source === "system" && t.report ? t.report : undefined;
}

/** One persisted-turn mapper for initial hydration, scrollback and live tail.
 * EI-22622748977343550: the three former inline copies all dropped createdAt,
 * so OperatorChat converted every missing timestamp to epoch 0. */
function turnRowToChatMessage(t: OperatorTurnRow): ChatMessage {
  return {
    role: t.role,
    content: t.text,
    id: typeof t.id === "string" ? t.id : undefined,
    seq: typeof t.seq === "number" ? t.seq : undefined,
    ts: createdAtIso(t.createdAt),
    tools: Array.isArray(t.tools) ? t.tools : undefined,
    report: reportForTurn(t),
  };
}

// ─── State + actions ────────────────────────────────────────────────────

// 2026-05-11 redesign: replaced the 3-rung ladder (silence_nudge →
// silence_check → quiet_wait) with a single-nudge model. The ladder
// generated "Still with me?" spam that annoyed users; the new model:
//   - awaiting_reply: assistant just asked something — arm ONE 30s nudge
//   - nudged: nudge fired — silent forever until user speaks or says "ready"
//   - quiet_wait: legacy state kept only for the "say ready" banner UX
type SubState =
  | "ready"
  | "generating"
  | "awaiting_reply"
  | "nudged"
  | "quiet_wait"
  | "passive_idle";

interface State {
  mode: OperatorMode;
  sub: SubState;
  messages: ChatMessage[];
  error: string | null;
  /**
   * Timestamps of the last N USER turns (assistant turns excluded).
   * Used by the 3-in-2min engagement check that gates `mayAskActiveNow`.
   * The plan calls this "fresh engagement" — operator's own turns
   * obviously don't count as the user engaging.
   */
  recentUserTurnTsMs: number[];
  /**
   * When the operator last asked "Do you want me to go back into active
   * mode?" — set when the parser detects the relevant phrase in a
   * <say>. Paired with `wantActiveDeclinedAtMs` below to enforce the
   * cooldown after the user says no.
   */
  wantActiveAskedAtMs: number;
  /**
   * When the user last declined the "want active?" prompt. Resets the
   * cooldown clock; the operator must wait either 5 fresh user turns
   * OR 10 minutes (whichever comes first) before re-asking.
   */
  wantActiveDeclinedAtMs: number;
  /** User turns recorded since the most recent decline. Resets to 0 on decline. */
  userTurnsSinceDecline: number;
  /**
   * Epoch ms of the most recent user-or-assistant turn. Anchors the
   * silence ladder's 10s nudge window so mounting an old conversation
   * doesn't immediately trigger "Still with me?". G13 of the audit.
   */
  lastTurnAtMs: number;
  /**
   * Consecutive operator-converse failures — drives exponential
   * backoff on the silence-timer so a broken route doesn't spam the
   * sidebar with retries. Reset to 0 on a successful turn. G14.
   */
  consecutiveErrorCount: number;
}

const INITIAL: State = {
  mode: "active",
  sub: "ready",
  messages: [],
  error: null,
  recentUserTurnTsMs: [],
  wantActiveAskedAtMs: 0,
  wantActiveDeclinedAtMs: 0,
  userTurnsSinceDecline: 0,
  lastTurnAtMs: 0,
  consecutiveErrorCount: 0,
};

/** Lazy-init for the reducer — pull persisted messages from sessionStorage
 *  so a refresh mid-conversation doesn't lose what the user was discussing.
 *  SSR-safe: returns empty list on the server. */
function initState(): State {
  if (typeof window === "undefined") return INITIAL;
  const persisted = readOperatorMessagesFromSession();
  if (persisted.length === 0) return INITIAL;
  // Cast is safe — readOperatorMessagesFromSession already validated
  // role + content; tools is unknown[] and ChatMessage's tools field is
  // ChatToolCall[] | undefined. Tools-only-on-Oracle data shouldn't
  // round-trip here in practice, but keep the cast loose.
  return {
    ...INITIAL,
    messages: persisted as State["messages"],
  };
}

type Action =
  | { type: "set_mode"; mode: OperatorMode }
  | { type: "set_sub"; sub: SubState }
  | { type: "append_message"; message: ChatMessage }
  | { type: "replace_message_id"; oldId: string; newId: string; seq?: number; ts?: string }
  /**
   * Backfill the persisted seq onto a local message identified by id.
   * A message created in-session (optimistic user turn, streamed
   * assistant turn) has no seq until the server echoes it back — and
   * OperatorChat's onAnswer gate (`typeof msg.seq !== 'number'`)
   * silently drops chat:ask_choice clicks on a seq-less message, so a
   * card streamed live was unanswerable until a full reload (P-011).
   */
  | { type: "set_message_seq"; id: string; seq: number; ts?: string }
  | { type: "append_assistant_delta"; id: string; text: string }
  | { type: "finalize_assistant_stream"; id: string; message: ChatMessage }
  | { type: "remove_message_id"; id: string }
  | { type: "set_error"; error: string | null }
  | { type: "record_user_turn"; tsMs: number }
  | { type: "record_want_active_asked"; tsMs: number }
  | { type: "record_want_active_declined"; tsMs: number }
  | { type: "mark_turn"; tsMs: number }
  | { type: "mark_error" }
  | { type: "reset_error_count" }
  | { type: "reset_messages" }
  | { type: "replace_messages"; messages: ChatMessage[]; lastTurnAtMs?: number }
  | { type: "prepend_messages"; messages: ChatMessage[] }
  /**
   * Surgical in-place update of a message identified by seq. Used by
   * the live-tail when a remote row's mutable fields change after the
   * row's already been loaded — chat:ask_choice's answered state is
   * the load-bearing case. Without this, Tab A clicks a card button,
   * Tab B never sees the assistant row's `tools[i].answered` set
   * because Tab B's live-tail only appends new seqs.
   */
  | { type: "update_message_tools"; seq: number; tools: ChatToolCall[] };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "set_mode": {
      // Mode flip resets the sub-state to a sensible default for the
      // new mode (passive → passive_idle; active → ready).
      const sub: SubState =
        action.mode === "passive" ? "passive_idle" : "ready";
      return { ...state, mode: action.mode, sub };
    }
    case "set_sub":
      // Fan out so the navbar chip + any other interested component
      // can reflect quiet_wait / silence_check / etc. without taking
      // the React-context route.
      try {
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("papercusp:operatorSub", {
              detail: { sub: action.sub },
            }),
          );
        }
      } catch {
        /* ignore */
      }
      return { ...state, sub: action.sub };
    case "append_message":
      return { ...state, messages: [...state.messages, action.message] };
    case "replace_message_id": {
      const idx = state.messages.findIndex((m) => m.id === action.oldId);
      if (idx < 0) return state;
      const next = state.messages.slice();
      next[idx] = {
        ...next[idx],
        id: action.newId,
        ...(typeof action.seq === "number" ? { seq: action.seq } : {}),
        ...(action.ts ? { ts: action.ts } : {}),
      };
      return { ...state, messages: next };
    }
    case "set_message_seq": {
      const idx = state.messages.findIndex((m) => m.id === action.id);
      if (
        idx < 0 ||
        (state.messages[idx].seq === action.seq &&
          (!action.ts || state.messages[idx].ts === action.ts))
      )
        return state;
      const next = state.messages.slice();
      next[idx] = {
        ...next[idx],
        seq: action.seq,
        ...(action.ts ? { ts: action.ts } : {}),
      };
      return { ...state, messages: next };
    }
    case "update_message_tools": {
      const idx = state.messages.findIndex((m) => m.seq === action.seq);
      if (idx < 0) return state;
      // Compare structurally to avoid no-op re-renders.
      const before = state.messages[idx].tools;
      const beforeSerialized = before ? JSON.stringify(before) : "";
      const afterSerialized = JSON.stringify(action.tools);
      if (beforeSerialized === afterSerialized) return state;
      const next = state.messages.slice();
      next[idx] = { ...next[idx], tools: action.tools };
      return { ...state, messages: next };
    }
    case "append_assistant_delta": {
      const last = state.messages[state.messages.length - 1];
      if (!last || last.role !== "assistant" || last.id !== action.id) {
        // Open a new assistant message and seed it with the delta.
        return {
          ...state,
          messages: [
            ...state.messages,
            {
              role: "assistant",
              content: action.text,
              id: action.id,
              ts: new Date().toISOString(),
            },
          ],
        };
      }
      const updated = [...state.messages];
      updated[updated.length - 1] = {
        ...last,
        content: last.content + action.text,
      };
      return { ...state, messages: updated };
    }
    case "finalize_assistant_stream": {
      const idx = state.messages.findIndex(
        (message) => message.id === action.id,
      );
      if (idx < 0)
        return { ...state, messages: [...state.messages, action.message] };
      const updated = state.messages.slice();
      updated[idx] = action.message;
      return { ...state, messages: updated };
    }
    case "remove_message_id": {
      if (!state.messages.some((message) => message.id === action.id))
        return state;
      return {
        ...state,
        messages: state.messages.filter((message) => message.id !== action.id),
      };
    }
    case "set_error":
      return { ...state, error: action.error };
    case "record_user_turn": {
      // Trim to the last 2 min to keep the array bounded.
      const cutoff = action.tsMs - 2 * 60 * 1000;
      const next = state.recentUserTurnTsMs.filter((t) => t >= cutoff);
      next.push(action.tsMs);
      return {
        ...state,
        recentUserTurnTsMs: next,
        userTurnsSinceDecline: state.userTurnsSinceDecline + 1,
      };
    }
    case "record_want_active_asked":
      return { ...state, wantActiveAskedAtMs: action.tsMs };
    case "record_want_active_declined":
      return {
        ...state,
        wantActiveDeclinedAtMs: action.tsMs,
        userTurnsSinceDecline: 0,
      };
    case "mark_turn":
      return state.lastTurnAtMs === action.tsMs
        ? state
        : { ...state, lastTurnAtMs: action.tsMs };
    case "mark_error":
      return {
        ...state,
        consecutiveErrorCount: state.consecutiveErrorCount + 1,
      };
    case "reset_error_count":
      return state.consecutiveErrorCount === 0
        ? state
        : { ...state, consecutiveErrorCount: 0 };
    case "reset_messages":
      return { ...state, messages: [], error: null };
    case "replace_messages":
      return {
        ...state,
        messages: action.messages,
        error: null,
        lastTurnAtMs: action.lastTurnAtMs ?? state.lastTurnAtMs,
      };
    case "prepend_messages":
      return { ...state, messages: [...action.messages, ...state.messages] };
  }
}

// ─── Cadence helper ─────────────────────────────────────────────────────

const TURNS_PER_WINDOW_THRESHOLD = 3;
const WINDOW_MS = 2 * 60 * 1000;

/**
 * Decline cooldown — after the user says no to "want active?", the
 * operator must wait either 5 fresh user turns OR 10 minutes (whichever
 * comes first) before re-asking. Per the active-mode plan.
 */
const DECLINE_COOLDOWN_MS = 10 * 60 * 1000;
const DECLINE_COOLDOWN_TURNS = 5;

/**
 * Returns true when the operator may ask "want me back to active?" —
 * all of:
 *   (a) mode === 'passive' (otherwise the question makes no sense)
 *   (b) sleep timer expired (don't disturb during a self-quiet)
 *   (c) ≥3 USER turns in the last 2 min (the "fresh engagement" signal)
 *   (d) cooldown after a prior decline has elapsed (5 user turns OR 10 min)
 *
 * Exposed to the route as the `[may_ask_active]` prompt context marker.
 */
export function mayAskActiveNow(
  state: State,
  nowMs: number = Date.now(),
): boolean {
  if (state.mode !== "passive") return false;
  if (readSleepUntilMs() > nowMs) return false;
  const cutoff = nowMs - WINDOW_MS;
  const inWindow = state.recentUserTurnTsMs.filter((t) => t >= cutoff).length;
  if (inWindow < TURNS_PER_WINDOW_THRESHOLD) return false;
  // Cooldown gate: skip if neither the time nor the turn-count threshold
  // has been met since the most recent decline.
  if (state.wantActiveDeclinedAtMs > 0) {
    const sinceDecline = nowMs - state.wantActiveDeclinedAtMs;
    if (
      sinceDecline < DECLINE_COOLDOWN_MS &&
      state.userTurnsSinceDecline < DECLINE_COOLDOWN_TURNS
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Heuristic: does the assistant's `<say>` body contain the
 * "want me back to active?" question? Used to seed the decline-detection
 * window — when the next user turn is a "no", we know to record it.
 */
const WANT_ACTIVE_RE =
  /(want.*back.*active|back into active|go.*active.*mode)/i;
export function sayContainsWantActive(say: string): boolean {
  return WANT_ACTIVE_RE.test(say);
}

/**
 * Heuristic: does the user's reply read as a "no" to a recent
 * want-active prompt? Conservative — better to miss a decline (and
 * have the operator re-ask sooner) than to mis-detect (and cool down
 * when the user actually said yes).
 */
const DECLINE_RE =
  /^(no\b|nah\b|nope\b|not (yet|now|really)|keep (it )?(quiet|passive)|stay (passive|quiet)|leave it)/i;
export function userReplyDeclinesActive(text: string): boolean {
  return DECLINE_RE.test(text.trim());
}

/**
 * Plan: "Only flip yourself to passive when the user says, in plain
 * words, that they want quiet."  Examples in the prompt:
 *   - explicit dismissal: "stop", "shut up", "leave me alone", "I'm busy"
 *   - redirect to silence: "let me think", "let me work", "I need quiet"
 *   - frustration with the cadence: "you're talking too much", "ease off"
 *
 * The prompt asks the brain to emit <set_mode>passive</set_mode> when
 * it detects these. The plan flagged: "no server-side enforcement —
 * if the LLM forgets the tag, no fallback." This heuristic IS that
 * fallback — when the user's message matches AND the model's response
 * didn't include the tag, we force the flip.
 *
 * Conservative — better to miss a dismissal (chat keeps talking) than
 * to mis-detect (user types "stop sharing that screen" and we go
 * passive). Two layers of conservatism:
 *
 *   1. The phrase must START the message (with at most a brief
 *      filler like "hey", "ok", "wait"), OR be the entire message
 *      (length ≤ ~50 chars). A long sentence that incidentally
 *      contains "i'm busy" deep in it isn't a dismissal — it's
 *      context ("I'm busy with the worker right now, can you
 *      check on it?").
 *   2. Question marks anywhere → not a dismissal. Questions are
 *      engagement, not pushback ("are you busy with that?", "let me
 *      think — what are the options?").
 */
const DISMISS_PHRASE_RE =
  /(shut up|leave me alone|stop talking|stop asking|ease off|be quiet|go quiet|i'?m busy|i am busy|let me (think|work|focus)|i need (quiet|silence)|you'?re talking too much|too much talking)/i;
const SHORT_UTTERANCE_MAX = 50;
const PREAMBLE_RE = /^(hey|ok(ay)?|wait|listen|um|uh|so|well)[,!\s.]+/i;
export function userDismissesOperator(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Questions are engagement, not pushback.
  if (trimmed.includes("?")) return false;
  // Strip a brief conversational preamble so "ok, leave me alone"
  // still matches at start.
  const stripped = trimmed.replace(PREAMBLE_RE, "");
  // Whole message short and matches → dismissal.
  if (
    stripped.length <= SHORT_UTTERANCE_MAX &&
    DISMISS_PHRASE_RE.test(stripped)
  ) {
    return true;
  }
  // Long message must START with the phrase to count.
  const headRe = new RegExp("^" + DISMISS_PHRASE_RE.source, "i");
  return headRe.test(stripped);
}

// ─── Silence-timer config ───────────────────────────────────────────────

/**
 * Detect whether an assistant turn is awaiting a user reply. Used by
 * the silence-timer effect: nudges only fire when the operator actually
 * asked something. If the operator just answered a question and didn't
 * pose one back, we stay silent indefinitely — no "still with me?"
 * spam.
 *
 * Rules:
 *   - Trimmed text ends with '?' → awaits
 *   - Used chat:ask_choice → awaits (definitionally)
 *   - Otherwise → does NOT await
 */
export function detectAwaitingReply(
  say: string | null | undefined,
  tools?: ReadonlyArray<{ name?: string }> | null,
): boolean {
  if (tools && tools.some((t) => t?.name === "chat:ask_choice")) return true;
  if (!say) return false;
  const trimmed = say.trim().replace(/[*_`~]+$/g, "");
  return trimmed.endsWith("?");
}

/**
 * Detect a "ready"-style user utterance. Triggers a `user_says_ready`
 * generation that surfaces 2-3 concrete suggestions instead of waiting
 * for the user to specify what they want. Compromise between
 * "operator pesters" and "user must be explicit".
 */
const USER_READY_RE =
  /^\s*(ready|next|what's next\??|whats next\??|what now\??|go|continue|keep going|let's go|lets go|resume|what should i (do|work on)( next)?\??)\s*[.!?]*\s*$/i;
export function detectUserReadyTrigger(text: string): boolean {
  return USER_READY_RE.test(text);
}

// 2026-05-11 redesign — single 30s nudge after an assistant question.
// No further escalation; after the nudge fires the conversation stays
// quiet until the user types/speaks (or says "ready" to get suggestions).
const SILENCE_AFTER_QUESTION_MS = 30_000;

// ─── Generation transport ───────────────────────────────────────────────

export interface GenerationRequest {
  /** Conversation history at request time. */
  messages: ChatMessage[];
  /** Why we're calling — fed to the prompt as context. */
  trigger:
    | "user_message"
    | "quiet_wait_resume"
    | "open_canvas"
    | "user_says_ready"
    | "user_welcomed"
    | "continue";
  /** True when we're allowed to ask "want active?" this turn. */
  mayAskActive: boolean;
  /** Display name set on `user_welcomed` so brain greets by name. */
  welcomedUser?: { displayName: string };
  /**
   * Output surface for this turn. 'voice' when EL/Realtime is connected
   * so the brain knows text-only affordances (chat:ask_choice buttons)
   * are invisible to the user — must reply in plain say() instead.
   */
  modality: "voice" | "text";
  /** AbortSignal for cancellation (e.g. mode flip mid-generation). */
  signal: AbortSignal;
  /**
   * Conversation id, threaded to the server only for continue-chain
   * ledger writes (plan §5.3 — apps/operator/lib/operator-continue-chains.ts).
   * The converse tool itself derives state from `messages`.
   */
  conversationId?: string | null;
  /**
   * True when the provider auto-fired this turn — either a <continue/>
   * chain step or the V8 terminal-question auto-fire. The route uses
   * it to distinguish user-driven `user_says_ready` from V8 auto-fire
   * for the ledger.
   */
  isAutoFire?: boolean;
  /** Audience persona overlay: 'engineer' (default) or 'novice'. */
  audienceMode?: "engineer" | "novice";
}

export interface GenerationStream {
  /** Async iterator yielding raw turn-output chunks. The caller buffers
   *  the chunks, parses with parseOperatorTurn(), then dispatches. */
  chunks: AsyncIterable<string>;
  /** Mutated by the chunks iterator as tool_call SSE events arrive.
   *  Read by the caller after `chunks` exhausts; attached to the
   *  resulting assistant message so the sidebar can render chips. */
  tools?: { name: string; input?: unknown }[];
}

/**
 * Function the provider calls to get a stream of operator output.
 * Stubbed in this commit; replaced by a fetch to /api/agent-mcp/operator-converse
 * (or, in voice mode, the realtime-session's turn output) in the next commit.
 */
export type GenerationFn = (
  req: GenerationRequest,
) => Promise<GenerationStream>;

/**
 * Default GenerationFn — POSTs to /api/agent-mcp/operator-converse and
 * yields the SSE delta-event payload as raw chunks. The buffered chunks
 * are parsed by parseOperatorTurn() back at the call site once the
 * stream completes.
 *
 * Same wire format Oracle's chat uses (event: delta with { text }), so
 * a future Voice path can plug in a different GenerationFn that drains
 * the realtime-session's turn output the same way.
 */
/**
 * Project the UI's rich `ChatMessage` onto the converse tool's WIRE shape.
 *
 * WI-6508 — owner-reported: chat died with a wall of `messages.N: Unrecognized
 * keys: "id", "seq", "report"`, one line per message, ~200 lines of it.
 *
 * `ChatMessage` is a RENDERING model and has grown presentation/persistence
 * fields over time — `id` (optimistic-write dedup), `seq` (operator_turns.seq
 * for chat:ask_choice), `report` (the curator status card), `tools`, `agent`,
 * `declined`. The converse tool's `messages` arg accepts exactly `{ role,
 * content }` and is STRICT (`additionalProperties:false`, the deliberate
 * EI-10883 contract: an undeclared arg is rejected rather than silently
 * ignored). Every field added to the render model was therefore a live grenade
 * for the chat wire, and nothing connected the two — the provider passed
 * `req.messages` through verbatim.
 *
 * The strictness is right and is NOT what to loosen: the whole point of
 * EI-10883 is that a tool quietly ignoring an arg is indistinguishable from
 * honouring it. The missing piece was this projection. Keep it EXPLICIT
 * (name each wire field) rather than deleting known-bad keys — a destructuring
 * omit would re-break the moment someone adds field number seven, which is
 * exactly how this got here.
 */
export function toConverseWireMessages(
  messages: readonly ChatMessage[],
): { role: ChatMessage["role"]; content: string }[] {
  return messages.map((m) => ({ role: m.role, content: m.content ?? "" }));
}

const defaultGenerationFn: GenerationFn = async (req) => {
  // Lazy import — avoids dragging the sessionStorage path into SSR.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getOrCreateClientId } =
    require("@papercusp/operator-core/lib/ui/client-id") as typeof import("@papercusp/operator-core/lib/ui/client-id");
  const uiClientId = getOrCreateClientId();
  const res = await fetch("/api/agent-mcp/operator-converse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // WI-6508: project onto the wire shape — never ship the render model.
      messages: toConverseWireMessages(req.messages),
      trigger: req.trigger,
      mayAskActive: req.mayAskActive,
      modality: req.modality,
      welcomed_user: req.welcomedUser
        ? { display_name: req.welcomedUser.displayName }
        : undefined,
      uiClientId: uiClientId || undefined,
      // V8 continue-chain ledger fields. Optional; route handles
      // missing values gracefully.
      conversationId: req.conversationId ?? undefined,
      isAutoFire: req.isAutoFire ?? undefined,
      audienceMode: req.audienceMode,
    }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(text || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const tools: { name: string; input?: unknown }[] = [];

  return {
    tools,
    chunks: (async function* () {
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frame parse — split on blank line.
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventMatch = frame.match(/^event:\s*(.+)$/m);
          const dataMatch = frame.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const event = eventMatch[1].trim();
          if (
            event !== "delta" &&
            event !== "done" &&
            event !== "error" &&
            event !== "tool_call"
          )
            continue;
          let data: unknown;
          try {
            data = JSON.parse(dataMatch[1]);
          } catch {
            continue;
          }

          if (event === "delta") {
            const text = (data as { text?: unknown })?.text;
            if (typeof text === "string") yield text;
          } else if (event === "tool_call") {
            const d = data as { name?: unknown; input?: unknown };
            if (typeof d?.name === "string") {
              tools.push({ name: d.name, input: d.input });
              // Surface tool_call to listeners in real time so the
              // voice-card router (plan §C.1a) can arm `pending` the
              // moment the brain emits chat:ask_choice — before the
              // state-snapshot lands. Without this signal the
              // provider only sees the card AFTER the snapshot
              // arrives, opening a race where a fast STT answer
              // would be dispatched as user_message instead of
              // resolving the card.
              if (typeof window !== "undefined") {
                try {
                  window.dispatchEvent(
                    new CustomEvent("papercusp:operatorToolCall", {
                      detail: {
                        name: d.name,
                        input: d.input,
                        tsMs: Date.now(),
                      },
                    }),
                  );
                } catch {
                  /* ignore */
                }
              }
            }
          } else if (event === "error") {
            const msg = (data as { message?: unknown })?.message;
            throw new Error(typeof msg === "string" ? msg : "stream error");
          } else if (event === "done") {
            return;
          }
        }
      }
    })(),
  };
};

// ─── Context ────────────────────────────────────────────────────────────

interface OperatorConversationContextValue {
  mode: OperatorMode;
  sub: SubState;
  messages: ChatMessage[];
  error: string | null;
  busy: boolean;
  /** A PEER window (main app ↔ Quick Panel) has a generation in flight on
   *  this same conversation — render a typing indicator so the reply that
   *  is about to appear doesn't come out of nowhere (P-009). */
  peerBusy: boolean;

  /**
   * True only after the initial persisted-turn window for the active
   * conversation has resolved. Callers that conditionally bootstrap an empty
   * scoped thread must wait for this bit; `messages.length === 0` before
   * hydration is not evidence that the durable conversation is empty.
   */
  historyHydrated: boolean;

  /** User-initiated send. Always allowed; restarts silence timer.
   *  `opts.spoken` marks a voice-initiated turn so the assistant reply
   *  is spoken back (voice → converse bridge, Phase 1). */
  sendUserMessage: (text: string, opts?: { spoken?: boolean }) => void;

  /**
   * Explicit "I want suggestions now" trigger — fires the same path as
   * the user typing "ready" or the active-mode terminal-turn auto-fire.
   * Works in active and passive mode (passive users can opt in
   * manually). Wired to the "Generate ideas" button in the composer.
   * Plan: active-mode-proactive-ticks-2026-05-14.md §C.9.
   */
  generateIdeas: () => void;

  /** Imperative mode flip from the navbar toggle / set_mode tag. */
  flipMode: (mode: OperatorMode) => void;

  /** Banner text for the chat surface (e.g. silence-check status). */
  bannerText: string | null;

  /** True when at least one earlier turn exists below the oldest currently-loaded one. */
  hasMoreEarlier: boolean;
  /** True while a loadEarlier() fetch is in flight. */
  loadingEarlier: boolean;
  /**
   * Fetch and prepend the next batch of older turns. Idempotent while
   * a prior fetch is in flight; no-op when hasMoreEarlier is false.
   */
  loadEarlier: () => Promise<void>;

  /**
   * Resolve a chat:ask_choice card by POSTing the picked option(s)
   * to /api/operator/conversations/:id/turn-answer. The endpoint
   * atomically marks the assistant's tool as answered AND inserts
   * the user turn (text=joined-labels, source='card_pick'). On
   * success, the live-tail picks up both rows — no local mutation
   * needed.
   *
   * WI-5175: rejects with a typed {@link CardAnswerError} so the caller can
   * TELL THE USER what happened. A click that silently does nothing is the
   * bug this shape exists to prevent (owner repro 2026-07-17: clicked an
   * option, nothing happened, no feedback anywhere). On a 409 the local card
   * is reconciled to the server's `answered` state before the throw.
   *
   * picks is always an array — length 1 for single-select cards,
   * ≥1 for multi-select (args.multi=true).
   */
  answerChoice: (input: {
    assistantSeq: number;
    toolIndex: number;
    picks: Array<{ option_id: string; label: string }>;
    declined?: boolean;
  }) => Promise<void>;

  /**
   * Active conversation id, or null when no conversation is selected.
   * Consumed by PendingCardsBar to scope /card-response POSTs to the
   * active chat.
   */
  conversationId: string | null;
}

/** The server's persisted answer for a card (turn-answer's 409 payload). */
export interface CardAnsweredState {
  picks: Array<{ option_id: string; label: string }>;
  declined?: boolean;
  at: number;
}

/**
 * Why a card answer did not land — WI-5175.
 *
 * Every one of these used to be swallowed (a silent early return, or a
 * `console.warn` the user never sees), so a click on a card that could not be
 * answered was indistinguishable from a dead button. The `reason` lets the UI
 * say the right thing:
 *   already_answered — someone/something already answered it (card reconciled)
 *   expired          — the server no longer holds this question
 *   no_conversation  — no active conversation to answer into
 *   not_ready        — the card is not answerable YET (seq not yet backfilled)
 *   failed           — anything else; `message` carries the server's reason
 */
export type CardAnswerFailure =
  | "already_answered"
  | "expired"
  | "no_conversation"
  | "not_ready"
  | "failed";

export class CardAnswerError extends Error {
  readonly reason: CardAnswerFailure;
  readonly answered: CardAnsweredState | null;
  constructor(
    message: string,
    reason: CardAnswerFailure,
    answered: CardAnsweredState | null = null,
  ) {
    super(message);
    this.name = "CardAnswerError";
    this.reason = reason;
    this.answered = answered;
  }
}

const OperatorConversationContext =
  createContext<OperatorConversationContextValue | null>(null);

export function useOperatorConversation(): OperatorConversationContextValue {
  const v = useContext(OperatorConversationContext);
  if (!v) {
    throw new Error(
      "useOperatorConversation must be used inside OperatorConversationProvider",
    );
  }
  return v;
}

interface ProviderProps {
  children: ReactNode;
  /** Optional override — tests inject a fake generation fn here. */
  generationFn?: GenerationFn;
  /**
   * Default/global keeps the one workspace Papercup thread and its ambient
   * mode/voice/proactive ownership. A work-item target is an isolated nested
   * runtime and MUST carry a concrete server-resolved id before it can write.
   */
  target?: OperatorConversationTarget;
}

export type OperatorConversationTarget =
  | { kind: "global" }
  | { kind: "work-item"; conversationId: string | null };

const GLOBAL_CONVERSATION_TARGET: OperatorConversationTarget = {
  kind: "global",
};

export function OperatorConversationProvider({
  children,
  generationFn = defaultGenerationFn,
  target = GLOBAL_CONVERSATION_TARGET,
}: ProviderProps) {
  const isGlobalTarget = target.kind === "global";
  const explicitConversationId =
    target.kind === "work-item" && target.conversationId?.trim()
      ? target.conversationId.trim()
      : null;
  const [state, dispatch] = useReducer(reducer, INITIAL, () =>
    isGlobalTarget ? initState() : { ...INITIAL },
  );
  const workspaceId = useWorkspaceId();

  // ── Voice-card router state (plan §C.1 / §C.1a) ───────────────────
  // Plain object mutated through helpers in lib/voice-cards/voice-card-router.
  // Mutation across renders is intentional — the router models a small
  // state machine, not React state. Buffer-window timer lives alongside.
  const routerStateRef = useRef(createRouterState());
  const routerBufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Live mirror of voice-prefs.audienceMode. Updated via subscribeVoicePrefsClient.
  const audienceModeRef = useRef<"engineer" | "novice">("engineer");

  // Live mirror of voice-prefs.cardAnsweringEnabled. Updated via
  // subscribeVoicePrefsClient so toggling the pref OFF mid-session
  // immediately tears down any armed voice card (plan §C.10 / audit
  // gap #2 fix).
  const cardAnsweringEnabledRef = useRef<boolean>(true);

  // ── Grace timer for EL teardown after a silence nudge ────────────
  //
  // After fireSilenceNudge() opens the Ready card, arm a one-shot
  // timer. If the user doesn't resolve the card within
  // silenceNudgeGraceSecs, dispatch a window event that voice-mode.ts
  // listens for and tears down the active EL session. Wake-word
  // listener (if configured) takes over via the existing wakeGated
  // path. Plan: silence-nudge-reliability-2026-05-14.md §C.2.
  //
  // Declared up here (not next to fireSilenceNudge) so the useEffects
  // and useCallbacks below that reference it in their deps arrays
  // don't TDZ on first render.
  //
  // Cancelled by:
  //   - Card resolution (focused-card useEffect)
  //   - User typing (sendUserMessage cancels)
  //   - User speaking (onVoiceUserTurn cancels)
  //   - Voice deactivation (voiceActive useEffect cancels)
  const nudgeGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armNudgeGraceTimer = useCallback(() => {
    if (nudgeGraceTimerRef.current) clearTimeout(nudgeGraceTimerRef.current);
    const prefs = loadVoicePrefsClient();
    const graceSecs = Math.max(
      0,
      Math.min(120, prefs.silenceNudgeGraceSecs ?? 30),
    );
    if (graceSecs === 0) return; // pref-disabled
    nudgeGraceTimerRef.current = setTimeout(() => {
      nudgeGraceTimerRef.current = null;
      // Only meaningful if voice is still active. Text-only is a no-op.
      if (!voiceActiveRef.current) return;
      // Hand off to voice-mode. The handler tears down the EL session
      // and arms wake-word if configured (existing wakeGated flow).
      if (typeof window !== "undefined") {
        try {
          window.dispatchEvent(
            new CustomEvent("papercusp:voiceSilenceTeardown", {
              detail: { wakeword: getConfiguredWakeWordForDisplay(prefs) },
            }),
          );
        } catch {
          /* ignore */
        }
      }
    }, graceSecs * 1000);
  }, []);
  const cancelNudgeGraceTimer = useCallback(() => {
    if (nudgeGraceTimerRef.current) {
      clearTimeout(nudgeGraceTimerRef.current);
      nudgeGraceTimerRef.current = null;
    }
  }, []);

  // ── Active-mode proactive responses (plan: active-mode-proactive-ticks) ──
  //
  // Chain tracking for `<continue/>`: capped to prevent runaway. Reset
  // whenever the user provides input (text or voice transcript).
  const continueChainCountRef = useRef<number>(0);
  const continueChainStartedAtMsRef = useRef<number>(0);
  // Cool-off after silence-nudge teardown — suppresses terminal-turn
  // auto-fire for ~5 min so we don't immediately bombard the user
  // after they just got the "say wake word when ready" prompt.
  const lastELTeardownMsRef = useRef<number>(0);
  const resetContinueChain = useCallback(() => {
    continueChainCountRef.current = 0;
    continueChainStartedAtMsRef.current = 0;
  }, []);

  // PG-backed conversation identity. Loaded on mount; survives refresh
  // and is shared between the text path and (later) the EL voice path.
  // SessionStorage is kept as a paint-cache so refresh has no flash —
  // PG hydration overwrites it once the GET resolves.
  const conversationIdRef = useRef<string | null>(explicitConversationId);
  // Mirror conv ID into React state so useSyncQuery's `enabled` flips when
  // it lands. The ref alone is fine for the imperative POST path but a
  // hook gate needs reactive state.
  const [convId, setConvId] = useState<string | null>(explicitConversationId);

  // Infinite-scroll cursors. We track the oldest + newest turn `seq`
  // we've materialized into `state.messages` so we can:
  //   - fetch the next batch of older turns starting just below
  //     `oldestLoadedSeqRef`,
  //   - and let the live-tail Zero subscription only append turns whose
  //     `seq > newestLoadedSeqRef` (so prepending older history doesn't
  //     trigger the optimistic-write dedup heuristic).
  // The ref pair is the source of truth for the loadEarlier fetcher;
  // `hasMoreEarlier` mirrors it into reactive state for the chat UI.
  //
  // `hydratedRef` gates the live-tail reconciler until the initial
  // windowed fetch has set the cursors — otherwise a Zero subscription
  // that returns 100 turns before our REST hydrate lands would flood
  // the chat with the entire tail before the windowed view replaces it.
  const oldestLoadedSeqRef = useRef<number | null>(null);
  const newestLoadedSeqRef = useRef<number | null>(null);
  const hydratedRef = useRef(false);
  const [hydratedConversationId, setHydratedConversationId] = useState<
    string | null
  >(null);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  // WINDOWING (no-http-anywhere-2026-07-28 P-008 / D-027: "per-row slimming is
  // exhausted, the next cut is windowing"). These two are deliberately
  // DIFFERENT sizes — they pay for different things:
  //
  //   INITIAL_PAGE — the MOUNT cost, paid on EVERY route. `ChromeShell` mounts
  //   the chat sidebar on every non-chromeless route, so this read is chrome:
  //   it is fetched whether or not the user ever looks at the chat.
  //   PAGE_SIZE   — the SCROLLBACK cost, paid only when the user actually
  //   scrolls up (loadEarlier → beforeSeq). Kept at 200 so one scroll still
  //   restores the "all in memory" feel the 200/page tuning below was after.
  //
  // ⚠ This used to read "PG fetch is loopback, so the bottleneck is React
  // reconciliation on prepend, not bandwidth" — and used that to justify
  // INITIAL_PAGE = 200. MEASURED 2026-08-03 on :3055 (`window.__sync_metrics__`,
  // git tab, live 19,128-turn conversation): that mount cost **448 KB and
  // 605 ms**, on a route that renders no chat scrollback at all. Loopback makes
  // bandwidth cheap, not free, and it says nothing about the 448 KB of JSON the
  // client still parses. The window is what was never re-measured.
  //
  // 200 was itself a vestige: it was chosen to MATCH the old
  // `operatorTurns.byConversation` { limit: 200 } so the two would collapse to
  // one react-query key (see the live-tail note below). That query was deleted
  // by EI-19372323793235963, so nothing has required this to be 200 since —
  // the live tail reads `initialPage` off THIS hook and follows whatever it is.
  //
  // 60 keeps ~3-4 sidebar viewports instantly available (so the common
  // read-recent-history case still never hits the network) at ~1/3 the mount
  // cost. Re-measure with /tmp/qsettle.sh before changing it; quote the number.
  const INITIAL_PAGE = 60;
  const PAGE_SIZE = 200;

  type TurnPage = { turns: OperatorTurnRow[]; hasMoreEarlier: boolean };
  const conversationSync = useSyncQuery<{ id: string }>({
    queryName: "operatorConversations.current",
    args: { workspaceId },
    enabled: isGlobalTarget,
    staleTime: 30_000,
  });
  const currentConversation = conversationSync.data?.[0];
  useEffect(() => {
    if (!isGlobalTarget) return;
    if (
      !currentConversation?.id ||
      currentConversation.id === conversationIdRef.current
    )
      return;
    conversationIdRef.current = currentConversation.id;
    setConvId(currentConversation.id);
    hydratedRef.current = false;
    setHydratedConversationId(null);
  }, [currentConversation?.id, isGlobalTarget]);

  // A nested work-item host owns its explicit id. Switching rows clears the
  // prior transcript immediately; waiting for the new query before clearing
  // would briefly render one work item's messages under another item.
  useEffect(() => {
    if (isGlobalTarget) return;
    if (conversationIdRef.current === explicitConversationId) return;
    conversationIdRef.current = explicitConversationId;
    setConvId(explicitConversationId);
    hydratedRef.current = false;
    setHydratedConversationId(null);
    hydratedConversationRef.current = null;
    oldestLoadedSeqRef.current = null;
    newestLoadedSeqRef.current = null;
    setHasMoreEarlier(false);
    setOlderBeforeSeq(null);
    setLoadingEarlier(false);
    dispatch({ type: "replace_messages", messages: [] });
  }, [explicitConversationId, isGlobalTarget]);

  const initialPageSync = useSyncQuery<TurnPage>({
    queryName: "operatorTurns.page",
    args: { conversationId: convId ?? "", limit: INITIAL_PAGE },
    enabled: !!convId,
    staleTime: 30_000,
  });
  const initialPage = initialPageSync.data?.[0];
  const hydratedConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!convId || !initialPage || hydratedConversationRef.current === convId)
      return;
    const turns = initialPage.turns ?? [];
    hydratedConversationRef.current = convId;
    if (turns.length > 0) {
      oldestLoadedSeqRef.current = turns[0].seq;
      newestLoadedSeqRef.current = turns[turns.length - 1].seq;
      setHasMoreEarlier(initialPage.hasMoreEarlier);
      dispatch({
        type: "replace_messages",
        messages: turns.map(turnRowToChatMessage),
        lastTurnAtMs: turns[turns.length - 1].createdAt ?? 0,
      });
    } else {
      oldestLoadedSeqRef.current = null;
      newestLoadedSeqRef.current = null;
      setHasMoreEarlier(false);
      dispatch({ type: "replace_messages", messages: [] });
    }
    hydratedRef.current = true;
    setHydratedConversationId(convId);
  }, [convId, initialPage]);

  const [olderBeforeSeq, setOlderBeforeSeq] = useState<number | null>(null);
  const olderPageSync = useSyncQuery<TurnPage>({
    queryName: "operatorTurns.page",
    args: {
      conversationId: convId ?? "",
      beforeSeq: olderBeforeSeq ?? 0,
      limit: PAGE_SIZE,
    },
    enabled: !!convId && olderBeforeSeq !== null,
    staleTime: 60_000,
  });
  const consumedOlderPageRef = useRef<string | null>(null);
  useEffect(() => {
    const page = olderPageSync.data?.[0];
    if (!page || olderBeforeSeq === null || !convId) return;
    const key = `${convId}:${olderBeforeSeq}`;
    if (consumedOlderPageRef.current === key) return;
    consumedOlderPageRef.current = key;
    if (page.turns.length === 0) {
      setHasMoreEarlier(false);
    } else {
      oldestLoadedSeqRef.current = page.turns[0].seq;
      setHasMoreEarlier(page.hasMoreEarlier);
      dispatch({
        type: "prepend_messages",
        messages: page.turns.map(turnRowToChatMessage),
      });
    }
    setOlderBeforeSeq(null);
    setLoadingEarlier(false);
  }, [convId, olderBeforeSeq, olderPageSync.data]);

  const loadEarlier = useCallback(async (): Promise<void> => {
    if (
      !conversationIdRef.current ||
      loadingEarlier ||
      oldestLoadedSeqRef.current === null ||
      !hasMoreEarlier
    )
      return;
    setLoadingEarlier(true);
    setOlderBeforeSeq(oldestLoadedSeqRef.current);
  }, [hasMoreEarlier, loadingEarlier]);

  // Cross-tab live tail — the SAME query as the hydration fetch above, not a
  // second one. It used to be `operatorTurns.byConversation` { limit: 200 },
  // which resolves through the identical listTurnsRecent() call as
  // `operatorTurns.page` { limit: INITIAL_PAGE }; with INITIAL_PAGE === 200 the
  // two fetched the same ~200 turns concurrently in two shapes on every mount
  // (the duplicate ~770 KB pair measured twice in D-012 of
  // no-http-anywhere-2026-07-28). Reading `initialPage` here collapses them to
  // one cache key and one request.
  //
  // Liveness is unaffected by the shared query's staleTime: invalidateQueries
  // marks the entry stale and refetches ACTIVE observers regardless of
  // staleTime, and the SSE invalidations for this conversation carry
  // { conversationId } only — which deep-partial-matches this key (verified
  // against @tanstack/query-core 5.100.5: a { conversationId } filter matches
  // { conversationId, limit } and does NOT match another conversation).
  //
  // The reconciler appends only turns whose seq is strictly greater than
  // `newestLoadedSeqRef`. The previous "count > local.length" heuristic
  // doesn't survive infinite-scroll: prepending older history would
  // make the heuristic always think the remote is behind.
  //
  // INITIAL_PAGE bounds the tail: it is a window, not the conversation depth —
  // the user-facing depth is bounded only by how far they scroll back. Older
  // turns land via loadEarlier() against PG.
  const remoteTurns = initialPage?.turns ?? [];
  // Row count is not a sufficient revision: answering an already-rendered
  // choice card mutates tools[i].answered in place while the tail length stays
  // constant. Track the mutable projection explicitly so cross-tab updates and
  // persisted reloads reconcile without waiting for another appended turn.
  const remoteToolsRevision = operatorTurnToolsRevision(remoteTurns);
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (!Array.isArray(remoteTurns) || remoteTurns.length === 0) return;
    const sorted = [...remoteTurns].sort((a, b) => a.seq - b.seq);
    const since = newestLoadedSeqRef.current;
    // Dedup by id: if a remote row's id matches an already-loaded
    // message (optimistic uuid or real PG id), skip the append. G19.
    const localIds = new Set(
      state.messages.map((m) => m.id).filter((x): x is string => !!x),
    );
    // B4: content-based dedup fallback for the optimistic-write race.
    // The optimistic id is local-only (PG never sees it); when Zero
    // echoes the inserted row back BEFORE persistTurn's .then() swaps
    // the id, the seq-cursor guard can't distinguish "real new turn"
    // from "echo of the local optimistic". Match by (role, content)
    // against the most recent few optimistic-prefixed messages and
    // swap the id in place rather than appending.
    const optimisticByKey = new Map<string, string>();
    for (
      let i = state.messages.length - 1;
      i >= Math.max(0, state.messages.length - 8);
      i--
    ) {
      const m = state.messages[i];
      if (m.id && m.id.startsWith("opt-")) {
        optimisticByKey.set(`${m.role}\x00${m.content}`, m.id);
      }
    }
    let lastTurnTs = 0;
    // Build a quick seq → local-tools index so we can detect cross-tab
    // updates to mutable fields on already-loaded rows (specifically:
    // chat:ask_choice's answered state). Without this, Tab B never
    // sees the assistant row's tools[i].answered after Tab A clicks
    // the card button.
    const localToolsBySeq = new Map<number, ChatToolCall[] | undefined>();
    for (const m of state.messages) {
      if (typeof m.seq === "number") localToolsBySeq.set(m.seq, m.tools);
    }
    for (const t of sorted) {
      if (since !== null && t.seq <= since) {
        // Already-loaded row: check if its mutable fields (tools) have
        // changed and dispatch a surgical update if so. Cross-tab
        // chat:ask_choice answered-state lives in this branch.
        if (Array.isArray(t.tools) && typeof t.seq === "number") {
          const local = localToolsBySeq.get(t.seq);
          const remoteJson = JSON.stringify(t.tools);
          const localJson = local ? JSON.stringify(local) : "";
          if (remoteJson !== localJson) {
            dispatch({
              type: "update_message_tools",
              seq: t.seq,
              tools: t.tools as ChatToolCall[],
            });
          }
        }
        continue;
      }
      if (typeof t.id === "string" && localIds.has(t.id)) {
        // Backfill seq onto the id-matched local row (the streamed
        // assistant turn after persistTurn's id-swap) — the reducer
        // no-ops when it already matches.
        if (typeof t.seq === "number") {
          dispatch({
            type: "set_message_seq",
            id: t.id,
            seq: t.seq,
            ts: createdAtIso(t.createdAt),
          });
        }
        newestLoadedSeqRef.current = t.seq;
        continue;
      }
      const optKey = `${t.role}\x00${t.text}`;
      const optId = optimisticByKey.get(optKey);
      if (optId) {
        dispatch({
          type: "replace_message_id",
          oldId: optId,
          newId: t.id,
          ...(typeof t.seq === "number" ? { seq: t.seq } : {}),
          ...(createdAtIso(t.createdAt) ? { ts: createdAtIso(t.createdAt) } : {}),
        });
        optimisticByKey.delete(optKey);
        newestLoadedSeqRef.current = t.seq;
        continue;
      }
      dispatch({
        type: "append_message",
        message: turnRowToChatMessage(t),
      });
      newestLoadedSeqRef.current = t.seq;
      if (oldestLoadedSeqRef.current === null)
        oldestLoadedSeqRef.current = t.seq;
      const ts = t.createdAt ?? Date.now();
      if (ts > lastTurnTs) lastTurnTs = ts;
      // B3: cross-tab user turns also count toward engagement. Without
      // this, a user typing in one tab while another tab is open
      // would never satisfy mayAskActiveNow()'s 3-in-2min threshold.
      if (t.role === "user") {
        dispatch({ type: "record_user_turn", tsMs: ts });
      }
    }
    if (lastTurnTs > 0) dispatch({ type: "mark_turn", tsMs: lastTurnTs });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteTurns.length, remoteToolsRevision, convId]);

  // Persist messages on every change. SessionStorage is per-tab and
  // resets on app reopen, matching the mode + sleep semantics. The
  // cap inside writeOperatorMessagesToSession bounds the footprint.
  useEffect(() => {
    if (!isGlobalTarget) return;
    writeOperatorMessagesToSession(state.messages);
  }, [isGlobalTarget, state.messages]);

  // PG turn write. Called from sendUserMessage and from runGeneration once
  // the assistant turn is parsed. We don't block the UI on the network — the
  // optimistic React state has already updated — but the write itself must
  // never silently skip (WI-4838: a spoken reply was heard while BOTH sides
  // of the exchange vanished because conversationIdRef was still null and
  // the old code returned early, and any fetch failure was swallowed).
  //   - No conversation id yet → POST to the literal `active` id; the server
  //     resolves the window's active conversation and we ADOPT the returned
  //     id so later writes (and the turns hydration) use it directly.
  //   - Transient failure → bounded retry; exhausted → surface on the chat
  //     error banner instead of dropping the turn invisibly.
  const persistTurn = useCallback(
    (
      role: "user" | "assistant",
      text: string,
      source: "text_typed" | "voice_stt" | "voice_tts" = "text_typed",
      optimisticId?: string,
      tools?: ChatToolCall[],
      report?: ParsedReport | null,
    ) => {
      // After insert: bump cursor (seq dedup) AND swap optimistic uuid
      // for the real PG id (G19 id dedup). Either one alone has a race
      // window where the Zero push could double-render the optimistic
      // local message; together they're robust.
      // `tools` (added 2026-05-11 for chat:ask_choice) is omitted when
      // undefined so the server route can default to NULL.
      const body: Record<string, unknown> = { role, text, source };
      if (tools && tools.length > 0) body.tools = tools;
      if (report) body.report = report;
      const payload = JSON.stringify(body);

      const attempt = async (): Promise<void> => {
        const MAX_TRIES = 3;
        for (let i = 1; i <= MAX_TRIES; i++) {
          // Re-read per try — an earlier try (or the sync query) may have
          // resolved the id in the meantime.
          const target =
            conversationIdRef.current ?? (isGlobalTarget ? "active" : null);
          if (!target) {
            dispatch({
              type: "set_error",
              error:
                "This work-item conversation is still resolving and was not written.",
            });
            return;
          }
          try {
            const r = await fetch(
              `/api/operator/conversations/${target}/turns`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: payload,
              },
            );
            if (!r.ok) throw new Error(`persist ${r.status}`);
            const j = (await r.json()) as {
              turn?: { id?: string; seq?: number; createdAt?: number };
              conversationId?: string;
            };
            // Adopt the server-resolved conversation when we posted to
            // `active` (the sync-query effect's `=== current` guard makes
            // the later sync delivery of the same id a no-op).
            if (
              target === "active" &&
              typeof j.conversationId === "string" &&
              !conversationIdRef.current
            ) {
              conversationIdRef.current = j.conversationId;
              setConvId(j.conversationId);
            }
            const seq = j?.turn?.seq;
            const realId = j?.turn?.id;
            const persistedTs = createdAtIso(j?.turn?.createdAt);
            if (typeof seq === "number") {
              if (
                newestLoadedSeqRef.current === null ||
                seq > newestLoadedSeqRef.current
              ) {
                newestLoadedSeqRef.current = seq;
              }
              if (oldestLoadedSeqRef.current === null)
                oldestLoadedSeqRef.current = seq;
            }
            if (optimisticId && typeof realId === "string") {
              dispatch({
                type: "replace_message_id",
                oldId: optimisticId,
                newId: realId,
                ...(typeof seq === "number" ? { seq } : {}),
                ...(persistedTs ? { ts: persistedTs } : {}),
              });
            } else if (optimisticId && typeof seq === "number") {
              dispatch({
                type: "set_message_seq",
                id: optimisticId,
                seq,
                ...(persistedTs ? { ts: persistedTs } : {}),
              });
            }
            return;
          } catch (err) {
            if (i === MAX_TRIES) {
              // The turn is still visible locally (optimistic state +
              // sessionStorage cache) but did NOT reach the shared thread —
              // other windows/devices won't see it. Say so.
              console.warn("[conversation] persist failed after retries:", err);
              dispatch({
                type: "set_error",
                error:
                  "A message could not be saved to the conversation — it may be missing on other windows.",
              });
              return;
            }
            await new Promise((res) => setTimeout(res, 300 * i));
          }
        }
      };
      void attempt();
    },
    [isGlobalTarget],
  );

  // Multi-window coherence (P-008): another window may have appended turns
  // to the shared conversation that this window's sync tail hasn't delivered
  // yet — a generation built purely from local state would answer blind to
  // them. Before a user send, take one fast, BOUNDED look at the persisted
  // tail and splice anything newer than our cursor into the outbound history
  // (chronologically before the just-typed message). Display catch-up stays
  // the sync reconciler's job — this only feeds the brain; on timeout the
  // send proceeds with local history exactly as before.
  const freshenHistory = useCallback(
    async (history: ChatMessage[], timeoutMs = 250): Promise<ChatMessage[]> => {
      try {
        const target =
          conversationIdRef.current ?? (isGlobalTarget ? "active" : null);
        if (!target) return history;
        const r = await fetch(
          `/api/operator/conversations/${target}/turns?limit=30`,
          {
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!r.ok) return history;
        const page = (await r.json()) as {
          turns?: Array<{
            id?: string;
            seq?: number;
            role?: string;
            text?: string;
          }>;
        };
        const cutoff = newestLoadedSeqRef.current;
        const known = new Set(history.map((m) => m.id).filter(Boolean));
        const missed = (page.turns ?? []).filter(
          (t) =>
            typeof t.seq === "number" &&
            (cutoff === null || t.seq > cutoff) &&
            (t.role === "user" || t.role === "assistant") &&
            typeof t.text === "string" &&
            t.text.trim() !== "" &&
            !(typeof t.id === "string" && known.has(t.id)),
        );
        if (missed.length === 0) return history;
        // NOTE: this SSE-history backfill reconciler projects only
        // {id,seq,role,text} (no source/report), so it can't carry a curator
        // card — that's fine, the card arrives via the primary live-tail
        // (append_message) path; this is a text-only catch-up backstop.
        const mapped: ChatMessage[] = missed.map((t) => ({
          role: t.role as "user" | "assistant",
          content: t.text as string,
          id: typeof t.id === "string" ? t.id : undefined,
        }));
        // Deliberately NOT bumping newestLoadedSeqRef: the sync reconciler
        // still owes these turns to the UI and dedupes them by id/seq.
        return [...history.slice(0, -1), ...mapped, ...history.slice(-1)];
      } catch {
        return history;
      }
    },
    [isGlobalTarget],
  );

  // Hydrate mode from sessionStorage on mount. If the session is
  // empty (fresh app open, no prior toggle), fall back to the user's
  // operatorActiveOnStartup voice-pref setting (default true). If the
  // pref fetch fails, default to 'active' so the operator-as-collaborator
  // experience works even without persisted prefs.
  useEffect(() => {
    if (!isGlobalTarget) return;
    const seedFromSession = readOperatorModeFromSession();
    if (seedFromSession) {
      // Mid-session value is authoritative.
      if (seedFromSession !== state.mode)
        dispatch({ type: "set_mode", mode: seedFromSession });
    } else {
      // First time this WINDOW. A live peer window (main app ↔ Quick Panel
      // share one conversation) outranks the prefs seed — two sidebars
      // showing different operator modes is the multi-window confusion
      // P-007 kills. Only a mirror with a fresh lease counts; a dead app
      // run's mirror is ignored and we seed from prefs as before.
      const adopted = adoptableSharedState();
      if (adopted) {
        writeOperatorModeToSession(adopted.mode);
        if (adopted.sleepUntilMs > 0) writeSleepUntilMs(adopted.sleepUntilMs);
        if (adopted.mode !== state.mode)
          dispatch({ type: "set_mode", mode: adopted.mode });
        try {
          window.dispatchEvent(
            new CustomEvent("papercusp:operatorMode", {
              detail: { mode: adopted.mode },
            }),
          );
        } catch {
          /* ignore */
        }
      } else {
        // Seed from the root-fed preference cache.
        writeOperatorModeToSession("active");
        const wantActive =
          loadVoicePrefsClient().operatorActiveOnStartup !== false;
        if (!wantActive) {
          writeOperatorModeToSession("passive");
          dispatch({ type: "set_mode", mode: "passive" });
          try {
            window.dispatchEvent(
              new CustomEvent("papercusp:operatorMode", {
                detail: { mode: "passive" },
              }),
            );
          } catch {
            /* ignore */
          }
        }
      }
    }

    // Subscribe to mode-change events fired by the navbar toggle
    // (and the set_mode tag dispatcher / voice path).
    const onModeEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ mode: OperatorMode }>).detail;
      if (detail?.mode === "active" || detail?.mode === "passive") {
        dispatch({ type: "set_mode", mode: detail.mode });
      }
    };
    window.addEventListener(
      "papercusp:operatorMode",
      onModeEvent as EventListener,
    );

    // Voice-engagement signal: STT delivers a user transcript →
    // count toward `recentUserTurnTsMs` so passive-mode's
    // mayAskActiveNow() satisfies the 3-in-2min threshold from
    // voice-only sessions too. Plan called this out as a known gap
    // at commit-time; now wired. Also marks the silence-ladder
    // freshness clock so it stays active after a voice exchange.
    const onVoiceUserTurn = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          tsMs?: number;
          text?: string;
          confidence?: number;
          transcriptSource?: TranscriptSource;
        }>
      ).detail;
      const tsMs = typeof detail?.tsMs === "number" ? detail.tsMs : Date.now();
      const text = typeof detail?.text === "string" ? detail.text : "";
      const confidence =
        typeof detail?.confidence === "number" ? detail.confidence : undefined;
      // Producer origin (localWhisper vs providerSTT) — observable on the
      // uniform pane seam (P-001). Not branched on today; engagement +
      // card-routing are source-agnostic.
      void detail?.transcriptSource;

      // Phase 2: voice-card routing (plan §C.1).
      // Try resolving an in-flight chat:ask_choice card first; only
      // fall through to engagement-tracking when the router doesn't
      // claim the transcript. The router is voice-only — it bails
      // immediately when nothing is armed.
      if (text) {
        const outcome = routeTranscript(
          routerStateRef.current,
          { text, tsMs, confidence },
          composeAmbiguityPrompt,
        );
        if (outcome.kind === "buffered") {
          // Snapshot-arrival race: wait for it. Router timer (armed
          // on tool_call) will flush if no snapshot lands within
          // BUFFER_WINDOW_MS. Don't touch engagement state — the
          // turn isn't real yet.
          return;
        }
        if (outcome.kind === "submit" || outcome.kind === "decline") {
          const conv = conversationIdRef.current;
          if (conv) {
            void postCardResponse(conv, {
              correlationId: outcome.correlationId,
              workspaceId,
              action: outcome.kind,
              payload: outcome.kind === "submit" ? outcome.payload : undefined,
            });
          }
          // Still record engagement for the silence ladder.
          dispatch({ type: "record_user_turn", tsMs });
          dispatch({ type: "mark_turn", tsMs });
          return;
        }
        if (outcome.kind === "ambiguous") {
          // Speak the disambiguation prompt; leave router active. The
          // user's next utterance gets re-parsed. After MAX rounds the
          // router falls through automatically.
          try {
            speak(outcome.prompt, "system:operator", "polite");
          } catch {
            /* ignore */
          }
          return;
        }
        // fall_through: original behavior below.
      }

      dispatch({ type: "record_user_turn", tsMs });
      dispatch({ type: "mark_turn", tsMs });
      // User spoke (whatever they said) — they're engaged, cancel
      // any pending silence-nudge grace timer so EL stays up.
      cancelNudgeGraceTimer();
      // Voice input ends any active `<continue/>` chain too.
      resetContinueChain();
      // E1: bridge text-path's server-side dismissal enforcement into
      // the voice path. The voice tag observer reads this stamp on the
      // next assistant flush and force-flips to passive if the brain
      // forgot to emit <set_mode>passive</set_mode>.
      if (
        text &&
        stateRef.current.mode === "active" &&
        userDismissesOperator(text)
      ) {
        writePendingDismissalAtMs(tsMs);
      }
    };
    window.addEventListener(
      "papercusp:operatorUserTurn",
      onVoiceUserTurn as EventListener,
    );

    return () => {
      window.removeEventListener(
        "papercusp:operatorMode",
        onModeEvent as EventListener,
      );
      window.removeEventListener(
        "papercusp:operatorUserTurn",
        onVoiceUserTurn as EventListener,
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGlobalTarget]);

  // ── In-flight generation tracking ───────────────────────────────────
  const inFlightRef = useRef<AbortController | null>(null);

  // Mirror of state.messages + state.mode used inside runGeneration to
  // sidestep stale-closure issues. React's useReducer batches dispatches,
  // and runGeneration is often called immediately after an append (e.g.
  // the user just sent a message) — at that moment, state.messages still
  // reflects the PREVIOUS render. The ref is updated on every render
  // below so the runner always sees the latest committed state.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  // Voice-active mirror so runGeneration (which is declared before
  // useState voiceActive) can read the current value without a re-bind.
  // Initialized eagerly from the voice subscription so the very first
  // turn after voice connects sees the right modality.
  const voiceActiveRef = useRef<boolean>(false);

  // ── Generation runner ──────────────────────────────────────────────
  // Drains the stream, buffers chunks into a single string, parses tags
  // at end (NOT incrementally — the wire format is one tag-document per
  // turn; partial parses would produce wrong results). Dispatches the
  // parsed side effects.
  //
  // Optional `messagesOverride` lets the caller pass an explicit
  // history that includes a turn just dispatched in the same tick
  // (state hasn't committed yet).
  const runGeneration = useCallback(
    async (
      trigger: GenerationRequest["trigger"],
      opts?: {
        messagesOverride?: ChatMessage[];
        welcomedUser?: { displayName: string };
        /**
         * True when this turn was dispatched by the runtime itself
         * (terminal-turn auto-fire in active mode). Prevents an
         * infinite loop where a terminal user_says_ready turn auto-
         * fires another user_says_ready. Plan §C.5 / §D.4.
         */
        isAutoFire?: boolean;
        /**
         * True when the user turn that triggered this generation was
         * SPOKEN (local-STT voice → converse bridge). The assistant
         * reply is then spoken back via speak(), restoring "voice ≡
         * text on one brain" (sentinel-tui-shared-backend Phase 1).
         * Typed turns leave this false so text-chat replies stay silent.
         */
        spokenReply?: boolean;
      },
    ) => {
      if (!isGlobalTarget && !conversationIdRef.current) {
        dispatch({
          type: "set_error",
          error:
            "This work-item conversation is still resolving. No message was sent.",
        });
        return;
      }
      // Multi-window coherence (P-009): an AUTO-fired generation (terminal
      // tick, welcome, chained continue descending from one) yields while
      // ANOTHER window is mid-generation — two spontaneous brains on one
      // thread read as the operator talking over itself. User sends are
      // never deferred.
      if (isGlobalTarget && opts?.isAutoFire && peerGeneratingNow()) {
        console.debug(
          "[operator] auto-fire deferred — a peer window is generating",
        );
        return;
      }

      // Abort any in-flight generation first (e.g. user sent a new message
      // mid-thinking, or a mode flip happened).
      inFlightRef.current?.abort();
      const ctrl = new AbortController();
      inFlightRef.current = ctrl;

      dispatch({ type: "set_sub", sub: "generating" });
      dispatch({ type: "set_error", error: null });
      // Cross-window typing indicator + auto-fire deferral beacon (P-009).
      if (isGlobalTarget) broadcastGenerating(true);
      let lastGenBeatMs = Date.now();
      const sayProjector = new OperatorSayStreamProjector();
      let streamedAssistantId: string | null = null;
      let streamedAssistantCommitted = false;

      const snapshot = stateRef.current;
      const history = opts?.messagesOverride ?? snapshot.messages;

      try {
        const stream = await generationFn({
          messages: history,
          trigger,
          mayAskActive: isGlobalTarget ? mayAskActiveNow(snapshot) : false,
          modality: isGlobalTarget && voiceActiveRef.current ? "voice" : "text",
          welcomedUser: opts?.welcomedUser,
          signal: ctrl.signal,
          // V8 continue-chain ledger plumbing — server records one
          // row per chain turn so deterministic asserts can verify caps.
          conversationId: conversationIdRef.current ?? undefined,
          isAutoFire: opts?.isAutoFire,
          audienceMode: audienceModeRef.current,
        });

        let buf = "";
        for await (const chunk of stream.chunks) {
          if (ctrl.signal.aborted) return;
          buf += chunk;
          const visibleDelta = sayProjector.push(chunk);
          if (visibleDelta) {
            streamedAssistantId ??= `opt-assistant-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
            dispatch({
              type: "append_assistant_delta",
              id: streamedAssistantId,
              text: visibleDelta,
            });
          }
          // Keep the cross-window beacon fresh through a long stream
          // (peers treat a stale beacon as a crashed writer).
          if (Date.now() - lastGenBeatMs > 5_000) {
            lastGenBeatMs = Date.now();
            if (isGlobalTarget) broadcastGenerating(true);
          }
        }
        if (ctrl.signal.aborted) return;

        const parsed = parseOperatorTurn(buf);

        // The turn is meaningful if EITHER the model wrote `<say>` OR
        // it called a tool. Pre-2026-05-11 we only dispatched/persisted
        // when parsed.say was non-empty, which silently swallowed
        // tool-call-only turns (e.g. chat:ask_choice). The card never
        // appeared because the assistant row was never appended.
        // Now: a non-empty tool array also qualifies.
        const collectedTools =
          stream.tools && stream.tools.length > 0
            ? stream.tools.slice()
            : undefined;
        // The report is PERSISTED (it is the Inbox's durable store — the
        // operator-report attention source reads operator_turns.report) but
        // NOT threaded onto the chat message: chat renders conversation
        // only. report-cards-inbox-reconciliation-2026-06-05 D-002.
        const report = parsed.report ?? undefined;
        const turnHasContent = !!parsed.say || !!collectedTools || !!report;

        if (turnHasContent) {
          const sayContent = parsed.say ?? "";
          // EI-22620210089467846: a tool-only assistant turn has no visible
          // <say> delta, so streamedAssistantId is still null here. Give that
          // row an optimistic identity anyway. persistTurn can then replace
          // it with the PG id + seq that OperatorChat requires before a
          // chat:ask_choice card can submit its answer. Without an id the
          // sync cursor advanced past the persisted row while the local card
          // remained permanently seq-less (every click said "still saving").
          const assistantMessageId =
            streamedAssistantId ??
            `opt-assistant-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
          const assistantMessage: ChatMessage = {
            role: "assistant",
            content: sayContent,
            id: assistantMessageId,
            ts: new Date().toISOString(),
          };
          if (collectedTools) assistantMessage.tools = collectedTools;
          if (streamedAssistantId) {
            dispatch({
              type: "finalize_assistant_stream",
              id: streamedAssistantId,
              message: assistantMessage,
            });
          } else {
            dispatch({ type: "append_message", message: assistantMessage });
          }
          // Voice ≡ text: when the user turn that triggered this
          // generation was SPOKEN (local-STT → converse bridge), speak
          // the assistant's reply back so a spoken turn gets a spoken
          // answer from the SAME operator:converse brain. Only the
          // <say> content is spoken — tool calls / reports are silent.
          // Guarded by `spokenReply` (NOT just voiceActiveRef) so a
          // turn the user TYPED while voice happens to be on stays
          // silent. (sentinel-tui-shared-backend-and-cards Phase 1.)
          if (isGlobalTarget && opts?.spokenReply && sayContent.trim()) {
            try {
              speak(sayContent.trim(), "system:operator", "polite");
            } catch {
              /* TTS unavailable — aria-live still published */
            }
          }
          // Engagement check tracks USER turns only. Assistant turns
          // (a) probe for the want-active phrase to seed G2's decline
          // window, AND (b) RESET that seed on subsequent non-want-active
          // turns so a "no" to a later "want passive?" check doesn't
          // get misclassified as declining active. G12 of the audit.
          if (parsed.say && sayContainsWantActive(parsed.say)) {
            dispatch({ type: "record_want_active_asked", tsMs: Date.now() });
          } else if (parsed.say) {
            dispatch({ type: "record_want_active_asked", tsMs: 0 });
          }
          dispatch({ type: "mark_turn", tsMs: Date.now() });
          // Persist text + tools + report. Empty say is fine for
          // tool/report-only turns; persistTurn writes whatever we send.
          // The server-side turns route accepts tools + report alongside
          // text (POST /api/operator/conversations/:id/turns).
          persistTurn(
            "assistant",
            sayContent,
            isGlobalTarget && opts?.spokenReply ? "voice_tts" : "text_typed",
            assistantMessageId,
            collectedTools,
            report,
          );
          streamedAssistantCommitted = true;
        } else if (streamedAssistantId) {
          dispatch({ type: "remove_message_id", id: streamedAssistantId });
        }
        // Successful turn → clear backoff. G14.
        dispatch({ type: "reset_error_count" });

        if (isGlobalTarget && parsed.sleep) {
          writeSleepUntilMs(sleepTagToEpochMs(parsed.sleep));
        }

        // <spawn role="..."> tags are dispatched SERVER-SIDE: the
        // /api/agent-mcp/operator-converse handler (agent-tools/operator/
        // converse.ts) parses this same turn and fires spawnAgentInHarness
        // (cup:spawn) directly. The old client-side fire-and-forget POST to
        // /api/plugins/orchestrator/spawn was removed 2026-06-06
        // (archive-legacy-orchestrator-deadcode P-010): that endpoint 404'd
        // (the @papercupai/orchestrator-spawn plugin is not installed) AND
        // firing it here would double-spawn against the server path.

        // Server-side disengagement enforcement: if the user's last
        // turn (the one that triggered this generation) explicitly
        // dismissed the operator AND the model's response didn't
        // include <set_mode>passive</set_mode>, force the flip. Plan
        // flagged the gap; this closes it.
        let effectiveMode = isGlobalTarget ? parsed.setMode : undefined;
        if (
          isGlobalTarget &&
          !effectiveMode &&
          stateRef.current.mode === "active"
        ) {
          const lastUser = [...history]
            .reverse()
            .find((m) => m.role === "user");
          if (lastUser && userDismissesOperator(lastUser.content)) {
            effectiveMode = "passive";
          }
        }
        if (effectiveMode) {
          // Persist + fanout via the same channel the navbar toggle uses,
          // so subscribers update in lockstep.
          writeOperatorModeToSession(effectiveMode);
          try {
            window.dispatchEvent(
              new CustomEvent("papercusp:operatorMode", {
                detail: { mode: effectiveMode },
              }),
            );
          } catch {
            /* ignore */
          }
          // Reducer also moves to the right sub-state via set_mode.
          dispatch({ type: "set_mode", mode: effectiveMode });
          return;
        }

        // End-of-turn sub-state (2026-05-11 redesign, updated 2026-05-14):
        //   silence_after_question is no longer a trigger — silence
        //     nudges are emitted directly by the server via
        //     /silence-nudge, and the provider transitions sub→'nudged'
        //     synchronously inside fireSilenceNudge (no LLM round-trip).
        //   user_message / open_canvas / user_says_ready / quiet_wait_resume:
        //     If the assistant's reply awaits a response (parsed say
        //     ends with '?' or used chat:ask_choice), → 'awaiting_reply'
        //     (arms ONE 30s nudge). Otherwise → 'ready' (no timer).
        const awaitingReply = detectAwaitingReply(parsed.say, collectedTools);
        let endSub: SubState;
        if (stateRef.current.mode === "passive") {
          endSub = "passive_idle";
        } else if (awaitingReply) {
          endSub = "awaiting_reply";
        } else {
          endSub = "ready";
        }
        dispatch({ type: "set_sub", sub: endSub });

        // ── Active-mode proactive responses ────────────────────────
        // Three end-of-turn outcomes (plan §C.1):
        //   1. <continue/> + no <sleep>: auto-fire 'continue' trigger
        //      to chain the next step. Capped by maxConsecutiveContinues
        //      and maxContinueChainSecs to prevent runaway.
        //   2. terminal (no continue, no sleep, not awaiting_reply,
        //      active mode, voice off, ticks enabled, no EL cool-off,
        //      not itself an auto-fire): auto-fire 'user_says_ready'
        //      to scan and surface suggestions.
        //   3. <sleep> or awaiting_reply or passive: no auto-fire.
        //
        // Build the history for auto-fired turns explicitly: the
        // append_message dispatch above is async (React state
        // commit), so stateRef.current.messages may not yet include
        // the assistant turn we just produced. Mirror what
        // sendUserMessage does — manually append the assistant
        // message we just emitted. (Round-4 audit bug fix.)
        const justEmittedAssistant: ChatMessage | null = turnHasContent
          ? collectedTools
            ? {
                role: "assistant" as const,
                content: parsed.say ?? "",
                tools: collectedTools,
              }
            : { role: "assistant" as const, content: parsed.say ?? "" }
          : null;
        const nextHistoryForAutoFire: ChatMessage[] = justEmittedAssistant
          ? [...stateRef.current.messages, justEmittedAssistant]
          : stateRef.current.messages;

        const prefs = loadVoicePrefsClient();
        if (parsed.continue && !parsed.sleep) {
          // Continue chain.
          const nowMs = Date.now();
          if (continueChainCountRef.current === 0) {
            continueChainStartedAtMsRef.current = nowMs;
          }
          continueChainCountRef.current += 1;
          const maxCount = Math.max(
            1,
            Math.min(20, prefs.maxConsecutiveContinues ?? 5),
          );
          const maxSecs = Math.max(
            30,
            Math.min(1800, prefs.maxContinueChainSecs ?? 300),
          );
          const elapsedSecs =
            (nowMs - continueChainStartedAtMsRef.current) / 1000;
          if (
            continueChainCountRef.current <= maxCount &&
            elapsedSecs <= maxSecs
          ) {
            // Fire the chained turn with the latest history (including
            // the assistant turn we just emitted — see comment above
            // about React state lag).
            //
            // Propagate isAutoFire — if the current turn was itself an
            // auto-fire (terminal → user_says_ready), the continue chain
            // it spawns inherits that flag. Without this, a misbehaving
            // user_says_ready that emits <continue/> would chain into a
            // terminal turn, which would re-trigger terminal-auto-fire
            // and create an oscillation loop (audit round 3).
            void runGeneration("continue", {
              messagesOverride: nextHistoryForAutoFire,
              isAutoFire: opts?.isAutoFire,
              // Keep speaking chain steps that descend from a spoken turn.
              spokenReply: opts?.spokenReply,
            });
            return; // do NOT also fire terminal auto-fire below
          }
          // Cap hit — drop the chain, wait for user.
          // eslint-disable-next-line no-console
          console.warn("[operator] <continue/> chain capped", {
            count: continueChainCountRef.current,
            elapsedSecs,
            maxCount,
            maxSecs,
          });
          resetContinueChain();
        }

        // Terminal auto-fire: only in active mode, voice off, with the
        // ticks pref on, no EL cool-off active, no active brain-emitted
        // sleep, operator not paused, and NOT itself an auto-fire
        // (anti-loop guard).
        //
        // sleepUntilMs gate (audit round-1): the brain's <sleep> tag
        // writes sleepUntilMs and tells the operator to stay quiet for
        // N minutes. The silence-after-question effect respects that
        // gate; this auto-fire must too, or a terminal turn AFTER a
        // sleep tag would re-engage the user against their wishes.
        //
        // paused gate (audit round-3): the workspace-level paused
        // state means "autonomous actions disabled." Plan §A non-goal
        // explicitly says: do not run when paused. Read from
        // sharedState (operator-shared-state) — different store from
        // state.mode (active/passive).
        const isTerminal =
          isGlobalTarget &&
          !parsed.continue &&
          !parsed.sleep &&
          !awaitingReply &&
          stateRef.current.mode === "active" &&
          !sharedOperatorState.paused &&
          !voiceActiveRef.current &&
          (prefs.proactiveTicksEnabled ?? true) === true &&
          readSleepUntilMs() <= Date.now() &&
          !opts?.isAutoFire;
        if (isTerminal) {
          const ELCoolOffMs = 5 * 60 * 1000;
          const sinceTeardown = Date.now() - lastELTeardownMsRef.current;
          if (
            lastELTeardownMsRef.current === 0 ||
            sinceTeardown > ELCoolOffMs
          ) {
            // Reset the continue chain — this is a terminal turn,
            // chain is over.
            resetContinueChain();
            void runGeneration("user_says_ready", {
              messagesOverride: nextHistoryForAutoFire,
              isAutoFire: true,
            });
            return;
          }
        }

        // User-input reaching the brain — reset the chain so the next
        // continue starts fresh. (Continues we just fired above
        // already returned early; we only get here for non-continue
        // outcomes.)
        if (!parsed.continue) {
          resetContinueChain();
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        // A generation can fail after the user turn has already been written
        // but before an assistant turn exists. Keep the refusal in the same
        // durable conversation so a restart/reload cannot turn the failed
        // request into a silent gap (EI-22586012826782354). Do not add a
        // second assistant row when the normal response was already handed
        // to persistTurn and a later bookkeeping step happened to throw.
        if (!streamedAssistantCommitted) {
          if (streamedAssistantId) {
            dispatch({ type: "remove_message_id", id: streamedAssistantId });
          }
          const refusalId = `opt-assistant-failure-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
          const refusalText = `The operator could not complete this turn: ${msg}`;
          dispatch({
            type: "append_message",
            message: {
              role: "assistant",
              content: refusalText,
              id: refusalId,
              ts: new Date().toISOString(),
            },
          });
          persistTurn(
            "assistant",
            refusalText,
            isGlobalTarget && opts?.spokenReply ? "voice_tts" : "text_typed",
            refusalId,
          );
        }
        dispatch({ type: "set_error", error: msg });
        dispatch({ type: "mark_error" });
        dispatch({
          type: "set_sub",
          sub: stateRef.current.mode === "passive" ? "passive_idle" : "ready",
        });
      } finally {
        if (
          ctrl.signal.aborted &&
          streamedAssistantId &&
          !streamedAssistantCommitted
        ) {
          dispatch({ type: "remove_message_id", id: streamedAssistantId });
        }
        // Clear the cross-window beacon ONLY when no newer generation took
        // over (a chained runGeneration replaced inFlightRef synchronously
        // in its prologue — its own lifecycle owns the beacon then).
        if (inFlightRef.current === ctrl) {
          if (isGlobalTarget) broadcastGenerating(false);
        }
        // G15 — aborted with no follow-up taking over → reset sub so
        // the chat doesn't get stranded in 'generating'.
        if (ctrl.signal.aborted && inFlightRef.current === ctrl) {
          dispatch({
            type: "set_sub",
            sub: stateRef.current.mode === "passive" ? "passive_idle" : "ready",
          });
          inFlightRef.current = null;
        }
      }
    },
    [generationFn, isGlobalTarget, persistTurn],
  );

  // ── Silence timers ──────────────────────────────────────────────────
  // Active mode only. When `sub === 'ready'` and 10s elapsed → nudge.
  // When 'silence_nudge' and 30s more → silence_check. When
  // 'silence_check' and 30s more → quiet_wait.
  //
  // Voice gate: when a voice session owns the mic, the user IS speaking
  // (or being spoken to) — the chat sidebar must NOT also fire silence
  // nudges. Otherwise the voice agent says "X" while the chat
  // independently writes "Still with me?" / "Want me to go passive?",
  // and the unified-conversation log fills with two parallel monologues
  // ("Bug B" of the voice/text divergence audit).
  const [voiceActive, setVoiceActive] = useState(() => {
    if (!isGlobalTarget) return false;
    try {
      return getVoiceState().mode !== "off";
    } catch {
      return false;
    }
  });
  // Ref mirror so runGeneration (declared above) can read the current
  // value without a useCallback re-bind on every voice state change.
  // Provider mounts BEFORE the first generation runs, so the initial
  // ref value matches the first useState init.
  useEffect(() => {
    voiceActiveRef.current = isGlobalTarget && voiceActive;
  }, [isGlobalTarget, voiceActive]);
  useEffect(() => {
    if (!isGlobalTarget) return;
    return subscribeVoiceState((s) => setVoiceActive(s.mode !== "off"));
  }, [isGlobalTarget]);

  // ── Cross-window operator-state sync (multi-window-chat-coherence) ──
  // Mode/sleep flips made in a peer window (main app ↔ Quick Panel) land
  // here via localStorage `storage` events; peer in-flight generations
  // surface as `peerBusy` (typing indicator + auto-fire deferral).
  const [peerBusy, setPeerBusy] = useState(false);
  useEffect(() => {
    if (!isGlobalTarget) return;
    return installOperatorWindowSync({
      onModeFromPeer: (mode) => {
        writeOperatorModeToSession(mode);
        dispatch({ type: "set_mode", mode });
        try {
          window.dispatchEvent(
            new CustomEvent("papercusp:operatorMode", { detail: { mode } }),
          );
        } catch {
          /* ignore */
        }
      },
      onSleepFromPeer: (sleepUntilMs) => {
        // writeSleepUntilMs also fans out the local sleep CustomEvent the
        // chip + silence timers listen for; re-mirroring the same value is
        // loop-safe (the peer's listener sees no change).
        writeSleepUntilMs(sleepUntilMs);
      },
      onMirrorCleared: () => {
        // A peer window's reload-reset (G16) is operator-wide: re-seed to
        // the same fresh-session state that window just reset to.
        writeOperatorModeToSession("active");
        writeSleepUntilMs(0);
        dispatch({ type: "set_mode", mode: "active" });
        try {
          window.dispatchEvent(
            new CustomEvent("papercusp:operatorMode", {
              detail: { mode: "active" },
            }),
          );
        } catch {
          /* ignore */
        }
      },
      onPeerGenerating: setPeerBusy,
    });
  }, [isGlobalTarget]);

  // ── Voice-card router lifecycle (plan §C.1a + C.6) ────────────────
  //
  // The router has two arming paths:
  //   1. SSE `tool_call` for chat:ask_choice → pending (1 s buffer
  //      window for transcripts that fire before the state-snapshot).
  //   2. State-snapshot drops a card with voiceAnswerable:true →
  //      promote pending → active (drains buffered transcripts).
  //
  // The router is voice-only — when voice deactivates, the whole
  // router resets so a future text card never accidentally inherits
  // stale active state. The router also re-syncs to the focused card
  // on every state-snapshot tick: when the focused card disappears
  // (server resolved it / aborted / workspace switch), active clears.
  const { cards: openCards } = useStateSnapshots();
  const focusedCard = useMemo(() => selectFocusedCard(openCards), [openCards]);

  // Arm-pending listener: surfaces from defaultGenerationFn when a
  // chat:ask_choice tool_call SSE event lands. Voice-active gates the
  // arming; if the user is text-only, the router stays asleep.
  useEffect(() => {
    if (!isGlobalTarget) return;
    const onToolCall = (e: Event) => {
      const detail = (e as CustomEvent<{ name?: string; tsMs?: number }>)
        .detail;
      if (!detail || detail.name !== "chat:ask_choice") return;
      if (!voiceActiveRef.current) return;
      const nowMs = typeof detail.tsMs === "number" ? detail.tsMs : Date.now();
      routerMarkPending(routerStateRef.current, nowMs);
      if (routerBufferTimerRef.current)
        clearTimeout(routerBufferTimerRef.current);
      routerBufferTimerRef.current = setTimeout(() => {
        // Buffer expired without a state-snapshot. Flush buffered
        // transcripts back through the user-turn path so the brain
        // doesn't lose them.
        const drained = routerExpirePending(routerStateRef.current);
        for (const tx of drained) {
          if (typeof window === "undefined") continue;
          window.dispatchEvent(
            new CustomEvent("papercusp:operatorUserTurn", {
              // Buffered transcripts only ever enter the router from the
              // provider pane-relay (the sole emitter of operatorUserTurn), so
              // replays are providerSTT (P-001 uniform seam).
              detail: {
                text: tx.text,
                source: "voice_stt",
                tsMs: tx.tsMs,
                confidence: tx.confidence,
                transcriptSource: "providerSTT" as TranscriptSource,
              },
            }),
          );
        }
      }, ROUTER_BUFFER_WINDOW_MS);
    };
    window.addEventListener(
      "papercusp:operatorToolCall",
      onToolCall as EventListener,
    );
    return () => {
      window.removeEventListener(
        "papercusp:operatorToolCall",
        onToolCall as EventListener,
      );
    };
  }, [isGlobalTarget]);

  // Sync active ref to the focused card from state-snapshot.
  // Also publishes 'operator:cardOpen' window events (per
  // correlationId, dedup'd) so OperatorVoiceAnnouncer can speak the
  // prompt when the panel is closed. The announcer event fires
  // regardless of voiceAnswerable — even announce-only cards should
  // be spoken when voice is on.
  const announcedCardsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isGlobalTarget) return;
    if (!voiceActiveRef.current) {
      routerClearActive(routerStateRef.current);
      return;
    }
    if (focusedCard === null) {
      routerClearActive(routerStateRef.current);
      return;
    }
    // Announce on first sighting (any kind, any voiceAnswerable). The
    // announcer respects its own prefs gate.
    if (!announcedCardsRef.current.has(focusedCard.correlationId)) {
      announcedCardsRef.current.add(focusedCard.correlationId);
      if (typeof window !== "undefined") {
        try {
          window.dispatchEvent(
            new CustomEvent("operator:cardOpen", {
              detail: {
                correlationId: focusedCard.correlationId,
                prompt: focusedCard.prompt,
                fallbackText: focusedCard.fallbackText,
              },
            }),
          );
        } catch {
          /* ignore */
        }
      }
    }
    // Honor voiceAnswerable: only opt-in cards arm the router.
    // Master kill-switch: voice.cardAnsweringEnabled pref. When
    // false, the user wants cards spoken (announcer above) but
    // never resolved by voice; they must click.
    const presentation = focusedCard.presentation;
    const optIn =
      presentation !== undefined &&
      presentation.kind === "radio" &&
      (presentation as unknown as { voiceAnswerable?: boolean })
        .voiceAnswerable === true;
    const cardAnsweringEnabled = cardAnsweringEnabledRef.current;
    if (!optIn || !cardAnsweringEnabled) {
      routerClearActive(routerStateRef.current);
      return;
    }
    // Same card already armed? No-op (don't churn ambiguity counter).
    if (
      routerStateRef.current.active?.correlationId === focusedCard.correlationId
    ) {
      return;
    }
    const drained = routerAttachActive(routerStateRef.current, {
      correlationId: focusedCard.correlationId,
      runId: focusedCard.runId,
      card: focusedCard,
    });
    // Replay any buffered transcripts now that the card is active.
    if (drained.length > 0 && typeof window !== "undefined") {
      for (const tx of drained) {
        window.dispatchEvent(
          new CustomEvent("papercusp:operatorUserTurn", {
            // Buffered transcripts only ever enter the router from the
            // provider pane-relay (the sole emitter of operatorUserTurn), so
            // replays are providerSTT (P-001 uniform seam).
            detail: {
              text: tx.text,
              source: "voice_stt",
              tsMs: tx.tsMs,
              confidence: tx.confidence,
              transcriptSource: "providerSTT" as TranscriptSource,
            },
          }),
        );
      }
    }
    if (routerBufferTimerRef.current) {
      clearTimeout(routerBufferTimerRef.current);
      routerBufferTimerRef.current = null;
    }
  }, [focusedCard, isGlobalTarget]);

  // Drop announce-dedup entries for cards that have closed, so a
  // future re-emit at the same correlationId would re-announce.
  // (correlationIds are typically unique-per-card, so this mostly
  // matters for the test surface where ids may be reused.)
  useEffect(() => {
    if (!isGlobalTarget) return;
    const open = new Set(openCards.map((c) => c.correlationId));
    for (const id of Array.from(announcedCardsRef.current)) {
      if (!open.has(id)) announcedCardsRef.current.delete(id);
    }
  }, [isGlobalTarget, openCards]);

  // Voice-off → reset everything.
  useEffect(() => {
    if (!isGlobalTarget) return;
    if (!voiceActive) {
      resetRouter(routerStateRef.current);
      if (routerBufferTimerRef.current) {
        clearTimeout(routerBufferTimerRef.current);
        routerBufferTimerRef.current = null;
      }
      // Voice off → no EL to tear down. Cancel any in-flight grace
      // timer; the user must engage via click or by toggling voice
      // back on.
      cancelNudgeGraceTimer();
    }
  }, [isGlobalTarget, voiceActive, cancelNudgeGraceTimer]);

  // Card resolution OR no open card cancels the grace timer. This
  // covers both 'user clicked Ready' and 'card auto-cancelled
  // server-side at 120s'. The focused-card effect already runs on
  // every state-snapshot tick, so this hook is the natural place.
  useEffect(() => {
    if (!isGlobalTarget) return;
    if (focusedCard === null) {
      cancelNudgeGraceTimer();
    }
  }, [focusedCard, isGlobalTarget, cancelNudgeGraceTimer]);

  // Track EL teardowns for the proactive-tick cool-off (plan §C.8).
  // When the silence-nudge grace timer tears down EL, we don't want
  // a terminal turn auto-fire to immediately bombard the user.
  useEffect(() => {
    if (!isGlobalTarget) return;
    const onTeardown = () => {
      lastELTeardownMsRef.current = Date.now();
    };
    window.addEventListener(
      "papercusp:voiceSilenceTeardown",
      onTeardown as EventListener,
    );
    return () => {
      window.removeEventListener(
        "papercusp:voiceSilenceTeardown",
        onTeardown as EventListener,
      );
    };
  }, [isGlobalTarget]);

  // Live voice-prefs subscription. Tears down the active router ref
  // Seed audienceModeRef from prefs cache and keep it live.
  useEffect(() => {
    if (!isGlobalTarget) return;
    audienceModeRef.current = loadVoicePrefsClient().audienceMode ?? "engineer";
    const unsub = subscribeVoicePrefsClient((next) => {
      audienceModeRef.current = next.audienceMode ?? "engineer";
    });
    return unsub;
  }, [isGlobalTarget]);

  // when cardAnsweringEnabled flips OFF mid-session (plan §C.10 +
  // audit gap #2). Hydration also calls the listener so the initial
  // value reflects the server cache, not the DEFAULT_CLIENT_PREFS
  // bootstrap.
  useEffect(() => {
    if (!isGlobalTarget) return;
    // Seed from current cache.
    cardAnsweringEnabledRef.current =
      loadVoicePrefsClient().cardAnsweringEnabled !== false;
    const unsub = subscribeVoicePrefsClient((next) => {
      const enabled = next.cardAnsweringEnabled !== false;
      const wasEnabled = cardAnsweringEnabledRef.current;
      cardAnsweringEnabledRef.current = enabled;
      if (wasEnabled && !enabled) {
        // Flipped off — tear down any armed card immediately.
        routerClearActive(routerStateRef.current);
      }
    });
    return unsub;
  }, [isGlobalTarget]);

  // Sleep gate. The LLM emits `<sleep>{minutes}</sleep>` when the user
  // says "give me a minute" / "I'm busy" — the silence-nudge timer must
  // respect that or the operator keeps asking "Still with me?" while
  // the user explicitly asked for quiet. We mirror sessionStorage's
  // sleepUntilMs into reactive state so the effect re-arms when the
  // sleep deadline passes (or when the user wakes the operator via
  // the navbar chip).
  const [sleepUntilMs, setSleepUntilMsState] = useState(() => {
    if (!isGlobalTarget) return 0;
    try {
      return readSleepUntilMs();
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    if (!isGlobalTarget) return;
    const refresh = () => setSleepUntilMsState(readSleepUntilMs());
    refresh();
    window.addEventListener("papercusp:operatorSleep", refresh);
    return () => window.removeEventListener("papercusp:operatorSleep", refresh);
  }, [isGlobalTarget]);
  // When sleep expires in the future, schedule a wake-up so the silence
  // timer re-arms automatically. Cleared on every effect re-run.
  useEffect(() => {
    if (!isGlobalTarget) return;
    if (sleepUntilMs <= 0) return;
    const remaining = sleepUntilMs - Date.now();
    if (remaining <= 0) {
      setSleepUntilMsState(0);
      return;
    }
    const t = setTimeout(() => setSleepUntilMsState(0), remaining + 100);
    return () => clearTimeout(t);
  }, [isGlobalTarget, sleepUntilMs]);

  // G13/G14 — silence ladder respects freshness + applies error backoff.
  // SILENCE_FRESHNESS_MS: only run the ladder if the most recent turn
  // was within this window (5min). Outside it, the chat is stale and
  // nudges would feel out-of-context.
  // errorMul: exponential backoff on the silence-timer wait when
  // operator-converse keeps failing. Cap at 2^6 = 64x so the worst
  // case is ~10min between nudges.
  const SILENCE_FRESHNESS_MS = 5 * 60 * 1000;
  const errorMul =
    state.consecutiveErrorCount > 0
      ? Math.pow(2, Math.min(state.consecutiveErrorCount, 6))
      : 1;

  // Fire the deterministic silence-nudge card. Replaces the
  // previous brain-driven runGeneration('silence_after_question')
  // which was unreliable — the brain often emitted prose instead
  // of invoking chat:ask_choice. Now the server opens a synthetic
  // chat:ask_choice card directly, no LLM round-trip.
  //
  // Plan: silence-nudge-reliability-2026-05-14.md §C.1
  const fireSilenceNudge = useCallback(async () => {
    if (!isGlobalTarget) return;
    const id = conversationIdRef.current;
    if (!id) return;
    const prefs = loadVoicePrefsClient();
    const wakeword = getConfiguredWakeWordForDisplay(prefs);
    try {
      await fetch(
        `/api/operator/conversations/${encodeURIComponent(id)}/silence-nudge`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            workspaceId,
            voiceActive: voiceActiveRef.current,
            ...(wakeword ? { wakeword } : {}),
          }),
        },
      );
      // Arm the grace timer AFTER the POST succeeds — no point
      // arming if the card didn't actually open.
      armNudgeGraceTimer();
    } catch (e) {
      // Best-effort: if the silence-nudge endpoint fails, we don't
      // retry — the user can still type or speak to re-engage.
      // eslint-disable-next-line no-console
      console.warn("[silence-nudge] POST failed:", e);
    }
    // Transition sub to 'nudged' so the next render doesn't re-arm
    // the timer (same terminal state as the legacy brain-driven path).
    dispatch({ type: "set_sub", sub: "nudged" });
  }, [isGlobalTarget, workspaceId, armNudgeGraceTimer]);

  useEffect(() => {
    if (!isGlobalTarget) return;
    if (state.mode !== "active") return;
    if (voiceActive) return; // voice owns the conversation; no nudge filler
    if (sleepUntilMs > Date.now()) return; // operator self-quieted via <sleep> tag
    const sinceLast = Date.now() - state.lastTurnAtMs;
    if (state.lastTurnAtMs === 0 || sinceLast > SILENCE_FRESHNESS_MS) return;
    // New ladder: ONLY arm a nudge when the last assistant turn was
    // explicitly awaiting a reply. After the nudge fires, transition to
    // 'nudged' and stay quiet — no further escalation, no "still with me?"
    // spam. The user can say "ready" / "next" to re-engage with
    // suggestions, or just type what they want.
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (state.sub === "awaiting_reply") {
      const wait = Math.max(
        0,
        SILENCE_AFTER_QUESTION_MS * errorMul - sinceLast,
      );
      timer = setTimeout(() => void fireSilenceNudge(), wait);
    }
    // 'ready' and 'nudged' are quiet states — no timer.
    return () => {
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.mode,
    state.sub,
    state.lastTurnAtMs,
    errorMul,
    voiceActive,
    sleepUntilMs,
    isGlobalTarget,
  ]);

  // G10 — opening utterance on fresh chat. Fires ONCE on mount when the
  // sidebar is empty AND mode is active AND voice is off AND not sleeping.
  // The ref guard prevents the effect from re-firing on dep changes
  // (e.g. another flag flipping during the in-flight generation).
  const openCanvasFiredRef = useRef(false);
  useEffect(() => {
    if (!isGlobalTarget) return;
    if (openCanvasFiredRef.current) return;
    if (!hydratedRef.current) return;
    if (state.mode !== "active") return;
    if (voiceActive) return;
    if (sleepUntilMs > Date.now()) return;
    if (state.sub !== "ready") return;

    // Welcome flow: the login page set sessionStorage on success.
    // Consume the flag and fire user_welcomed (overrides open_canvas
    // even when messages exist — login is a fresh conversational moment).
    // Plan 4.8.
    let welcomedName: string | null = null;
    try {
      welcomedName = sessionStorage.getItem("papercusp_just_logged_in");
      if (welcomedName) sessionStorage.removeItem("papercusp_just_logged_in");
    } catch {
      /* sessionStorage unavailable */
    }
    if (welcomedName) {
      openCanvasFiredRef.current = true;
      void runGeneration("user_welcomed", {
        welcomedUser: { displayName: welcomedName },
      });
      return;
    }

    // Fall-through: only auto-fire open_canvas on truly empty conversation.
    if (state.messages.length > 0) return;
    openCanvasFiredRef.current = true;
    void runGeneration("open_canvas");
  }, [
    state.mode,
    state.sub,
    state.messages.length,
    voiceActive,
    sleepUntilMs,
    runGeneration,
    isGlobalTarget,
  ]);

  // ── Public actions ──────────────────────────────────────────────────

  const sendUserMessage = useCallback(
    (text: string, sendOpts?: { spoken?: boolean }) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!isGlobalTarget && !conversationIdRef.current) {
        dispatch({
          type: "set_error",
          error:
            "This work-item conversation is still resolving. No message was sent.",
        });
        return;
      }
      // Optimistic id — swapped for the real PG id once the POST
      // returns (see persistTurn). The live-tail Zero reconciler
      // dedupes by id, so a fast Zero echo won't double-render the
      // user's message. G19.
      const optimisticId = `opt-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
      const nowMs = Date.now();
      const userMsg: ChatMessage = {
        role: "user",
        content: trimmed,
        id: optimisticId,
        ts: new Date(nowMs).toISOString(),
      };
      dispatch({ type: "append_message", message: userMsg });
      dispatch({ type: "record_user_turn", tsMs: nowMs });
      dispatch({ type: "mark_turn", tsMs: nowMs });
      // User typed — they're engaged, no need to tear EL down. Cancel
      // any pending silence-nudge grace timer.
      cancelNudgeGraceTimer();
      // User input ends any active `<continue/>` chain.
      resetContinueChain();
      // Decline detection: if the operator just asked "want active?"
      // (within the last 60s) AND the user's reply reads as a "no",
      // record the decline so mayAskActiveNow() applies the cooldown.
      const askedAt = stateRef.current.wantActiveAskedAtMs;
      if (
        askedAt > 0 &&
        nowMs - askedAt < 60_000 &&
        userReplyDeclinesActive(trimmed)
      ) {
        dispatch({ type: "record_want_active_declined", tsMs: nowMs });
      }
      // Spoken turns carry their real source (WI-4838 defect B): 'voice_stt'
      // keeps voice turns distinguishable in the store (forensics, rendering).
      persistTurn(
        "user",
        trimmed,
        isGlobalTarget && sendOpts?.spoken === true
          ? "voice_stt"
          : "text_typed",
        optimisticId,
      );
      // Trigger resolution (priority order):
      //   - "ready"-style utterance → user_says_ready (surfaces 2-3
      //     concrete suggestions from workspace inventory)
      //   - was in quiet_wait/nudged → quiet_wait_resume (reference
      //     where we left off)
      //   - otherwise → user_message (default)
      let trigger: GenerationRequest["trigger"] = "user_message";
      if (detectUserReadyTrigger(trimmed)) {
        trigger = "user_says_ready";
      } else if (
        stateRef.current.sub === "quiet_wait" ||
        stateRef.current.sub === "nudged"
      ) {
        trigger = "quiet_wait_resume";
      }
      // Pass the explicit history including the just-dispatched user
      // turn so the model sees what the user actually said. State hasn't
      // committed yet on this tick; reading state.messages would miss it.
      const nextHistory = [...stateRef.current.messages, userMsg];
      // Voice-initiated turns request spoken replies. The freshness merge
      // (P-008) is bounded to 250ms — imperceptible on a loopback fetch,
      // and the send falls back to local history on any failure.
      void (async () => {
        const merged = await freshenHistory(nextHistory);
        void runGeneration(trigger, {
          messagesOverride: merged,
          spokenReply: isGlobalTarget && sendOpts?.spoken === true,
        });
      })();
    },
    [
      runGeneration,
      persistTurn,
      freshenHistory,
      cancelNudgeGraceTimer,
      resetContinueChain,
      isGlobalTarget,
    ],
  );

  // Voice-IN seam (plan voice-public-release-readiness D-001, owner-ratified
  // 2026-07-12): register this conversation's sendUserMessage so VoiceAppBridge
  // routes final STT transcripts into the SAME fast Papercup converse brain +
  // shared thread as typed text (spoken:true → the reply is spoken back via the
  // active TTS engine, e.g. kokoro). Replaces the retired writeToSentinelPane dock
  // path, which required a dev zellij pui-dock and dropped every turn on a normal
  // desktop ("Agent did not respond").
  useEffect(() => {
    if (!isGlobalTarget) return;
    setVoiceConverseHandler(sendUserMessage);
    return () => setVoiceConverseHandler(null);
  }, [isGlobalTarget, sendUserMessage]);

  const generateIdeas = useCallback(() => {
    if (!isGlobalTarget && !conversationIdRef.current) {
      dispatch({
        type: "set_error",
        error:
          "This work-item conversation is still resolving. No request was sent.",
      });
      return;
    }
    // Explicit user request — reset the chain (it's a new ask) and
    // dispatch user_says_ready. Works in both active and passive
    // modes because it's user-initiated. NOT marked as isAutoFire
    // (so if its terminal output triggers the terminal-auto-fire
    // path, that's fine — the user asked).
    resetContinueChain();
    cancelNudgeGraceTimer();
    void runGeneration("user_says_ready");
  }, [
    runGeneration,
    resetContinueChain,
    cancelNudgeGraceTimer,
    isGlobalTarget,
  ]);

  const flipMode = useCallback(
    (mode: OperatorMode) => {
      if (!isGlobalTarget) {
        dispatch({ type: "set_mode", mode });
        return;
      }
      writeOperatorModeToSession(mode);
      // Flipping TO active wakes the operator if it was sleeping —
      // otherwise the user-visible chip says "Active" while the silence
      // timers stay parked. Per the active-mode plan, flipping to
      // active means "I'm here, talk to me." Sleep event fires so the
      // chip's reactive sleepUntilMs state clears immediately. B5.
      if (mode === "active") {
        writeSleepUntilMs(0);
        try {
          window.dispatchEvent(new Event("papercusp:operatorSleep"));
        } catch {
          /* ignore */
        }
      }
      try {
        window.dispatchEvent(
          new CustomEvent("papercusp:operatorMode", { detail: { mode } }),
        );
      } catch {
        /* ignore */
      }
      dispatch({ type: "set_mode", mode });
    },
    [isGlobalTarget],
  );

  // Banner text for transient sub-states (silence prompts).
  const bannerText = useMemo<string | null>(() => {
    if (state.sub === "quiet_wait")
      return "Operator is quiet — type to pick up where you left off.";
    return null;
  }, [state.sub]);

  // chat:ask_choice card click → POST turn-answer. The endpoint is still
  // authoritative, but we now mirror the answered-state + picked user turn
  // locally on success so the sidebar updates immediately instead of waiting
  // for the live-tail invalidate round-trip.
  const answerChoice = useCallback(
    async (input: {
      assistantSeq: number;
      toolIndex: number;
      picks: Array<{ option_id: string; label: string }>;
      declined?: boolean;
    }): Promise<void> => {
      const id = conversationIdRef.current;
      if (!id)
        throw new CardAnswerError("no active conversation", "no_conversation");
      const r = await fetch(`/api/operator/conversations/${id}/turn-answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!r.ok) {
        // WI-5175: a failed answer must be RECONCILABLE, not just thrown as an
        // opaque string. A 409 means the server already holds an answer for this
        // card (another window, the voice router, or a duplicate click) — parse
        // its `answered` payload so the caller can settle the card to the TRUTH
        // instead of leaving it live and unexplained. Every other status carries
        // the server's own message so the toast can say what actually happened.
        const raw = await r.text().catch(() => "");
        let parsed: { error?: string; answered?: unknown } | null = null;
        try {
          parsed = raw
            ? (JSON.parse(raw) as { error?: string; answered?: unknown })
            : null;
        } catch {
          /* non-JSON body — fall back to the raw text below */
        }
        if (r.status === 409) {
          const answered = (parsed?.answered ??
            null) as CardAnsweredState | null;
          if (answered) {
            // Settle the local card to the server's answer so the UI stops
            // pretending the question is still open.
            const existingTools = stateRef.current.messages.find(
              (m) => m.seq === input.assistantSeq,
            )?.tools;
            if (existingTools && existingTools[input.toolIndex]) {
              dispatch({
                type: "update_message_tools",
                seq: input.assistantSeq,
                tools: existingTools.map((tool, index) =>
                  index === input.toolIndex ? { ...tool, answered } : tool,
                ),
              });
            }
          }
          throw new CardAnswerError(
            "This question was already answered.",
            "already_answered",
            answered,
          );
        }
        if (r.status === 404) {
          throw new CardAnswerError(
            "This question has expired — it's no longer open.",
            "expired",
          );
        }
        throw new CardAnswerError(
          parsed?.error ??
            `turn-answer failed (${r.status})${raw ? `: ${raw.slice(0, 120)}` : ""}`,
          "failed",
        );
      }

      const answeredAt = Date.now();
      const existing = stateRef.current.messages.find(
        (m) => m.seq === input.assistantSeq,
      );
      let nextHistory = stateRef.current.messages;
      if (existing?.tools && existing.tools[input.toolIndex]) {
        const nextTools = existing.tools.map((tool, index) =>
          index === input.toolIndex
            ? {
                ...tool,
                answered: {
                  picks: input.picks,
                  ...(input.declined ? { declined: true } : {}),
                  at: answeredAt,
                },
              }
            : tool,
        );
        dispatch({
          type: "update_message_tools",
          seq: input.assistantSeq,
          tools: nextTools,
        });
        nextHistory = nextHistory.map((msg) =>
          msg.seq === input.assistantSeq ? { ...msg, tools: nextTools } : msg,
        );
      }

      const joined = input.declined
        ? "Skipped"
        : input.picks.map((p) => p.label).join(" · ");
      const optimisticId = `opt-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
      const userMsg: ChatMessage = {
        role: "user",
        content: joined,
        id: optimisticId,
        ts: new Date(answeredAt).toISOString(),
      };
      dispatch({ type: "append_message", message: userMsg });
      dispatch({ type: "record_user_turn", tsMs: answeredAt });
      dispatch({ type: "mark_turn", tsMs: answeredAt });
      const askedAt = stateRef.current.wantActiveAskedAtMs;
      if (
        askedAt > 0 &&
        answeredAt - askedAt < 60_000 &&
        userReplyDeclinesActive(joined)
      ) {
        dispatch({ type: "record_want_active_declined", tsMs: answeredAt });
      }

      let trigger: GenerationRequest["trigger"] = "user_message";
      if (detectUserReadyTrigger(joined)) {
        trigger = "user_says_ready";
      } else if (
        stateRef.current.sub === "quiet_wait" ||
        stateRef.current.sub === "nudged"
      ) {
        trigger = "quiet_wait_resume";
      }
      void runGeneration(trigger, {
        messagesOverride: [...nextHistory, userMsg],
      });
    },
    [runGeneration],
  );

  const value: OperatorConversationContextValue = useMemo(
    () => ({
      mode: state.mode,
      sub: state.sub,
      messages: state.messages,
      error: state.error,
      busy: state.sub === "generating",
      peerBusy,
      historyHydrated: !!convId && hydratedConversationId === convId,
      sendUserMessage,
      generateIdeas,
      flipMode,
      bannerText,
      hasMoreEarlier,
      loadingEarlier,
      loadEarlier,
      answerChoice,
      conversationId: convId,
    }),
    [
      state.mode,
      state.sub,
      state.messages,
      state.error,
      peerBusy,
      hydratedConversationId,
      sendUserMessage,
      generateIdeas,
      flipMode,
      bannerText,
      hasMoreEarlier,
      loadingEarlier,
      loadEarlier,
      answerChoice,
      convId,
    ],
  );

  return (
    <OperatorConversationContext.Provider value={value}>
      {children}
    </OperatorConversationContext.Provider>
  );
}
