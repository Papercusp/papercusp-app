/**
 * usePapercupChat — the ONE transport hook behind the shared Papercup chat
 * (papercup-chat-one-component-one-contract-2026-09-06, D-003 / D-008; P-007).
 *
 * Both hosts (the operator desktop sidebar and the cloud portal's chat dock)
 * mount `PapercupChat` over this hook. The hook is HOST-FREE: it never knows a
 * route, a fetch, an EventSource or a provider. It takes a {@link PapercupChatAdapter}
 * — three functions the host writes once — and folds the chat-protocol
 * `ChatEvent` frames the adapter yields into transcript state. The portal's
 * adapter (P-008) streams its host proxy's converse SSE; the operator's (P-009)
 * adapts `OperatorConversationProvider`'s existing stream. Both speak D-008's
 * measured wire (`delta` / `tool_call` / `provenance` / `card` / `error` /
 * `done`), so the reducer below is written ONCE against `ChatEvent`.
 *
 * The pure helpers ported from the portal's `ask-papercup.tsx` keep their
 * names EXACTLY (PARITY.md `pt-*` rows point at them): `reduceAskFrame`,
 * `askTurnRefusalState`, `askErrorMessage`, `askRetryTarget`,
 * `askCompletedTurn`, `ASK_CAPABILITY_CONTRACT`. Where the portal's reducer
 * took raw `(event, data)` strings, the shared one takes a typed frame;
 * {@link parsePapercupFrame} is the string-to-frame step for a wire caller.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseChatEvent,
  decodeCardOptions,
  type CardResponse,
  type ChatEvent,
  type ChatTurn,
  type ChatTurnProvenance,
  type ChatTurnToolCall,
  type ChatTurnsPage,
  type OpenCardSnapshot,
} from '@papercusp/chat-protocol';

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * The `error` frame as the hosts ACTUALLY send it: chat-protocol's union carries
 * `message` only, but both hosts also put a stable `code` (and, for a refused
 * turn, `retryAfterMs`) on the wire so the UI never has to parse prose. The
 * shared reducer reads them when present and falls back to the message.
 */
export interface PapercupChatErrorFrame {
  type: 'error';
  message: string;
  code?: string;
  retryAfterMs?: number | null;
  /** Epoch ms a capped model account's usage limit lifts (WI-10003494). */
  resetAt?: number;
}

export type PapercupChatFrame = Exclude<ChatEvent, { type: 'error' }> | PapercupChatErrorFrame;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Normalise one received SSE `(eventName, data)` pair into a frame. `data` may
 * be the raw data line (a JSON string) or an already-parsed object. Malformed
 * or unknown frames return null — a stream reader that dies on one bad frame
 * loses the whole turn, so callers drop nulls and keep reading.
 */
export function parsePapercupFrame(eventName: string, data: unknown): PapercupChatFrame | null {
  let value: unknown = data;
  if (typeof data === 'string') {
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const record = asRecord(value);
  if (!record) return null;
  const base = parseChatEvent(eventName, record);
  if (!base) return null;
  if (base.type !== 'error') return base;
  const code = typeof record.code === 'string' && record.code ? record.code : undefined;
  const retryAfterMs =
    typeof record.retryAfterMs === 'number' && Number.isSafeInteger(record.retryAfterMs) && record.retryAfterMs > 0
      ? record.retryAfterMs
      : null;
  const resetAt =
    typeof record.resetAt === 'number' && Number.isSafeInteger(record.resetAt) && record.resetAt > 0
      ? record.resetAt
      : null;
  return {
    type: 'error',
    message: base.message,
    ...(code ? { code } : {}),
    retryAfterMs,
    ...(resetAt !== null ? { resetAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// The in-flight turn
// ---------------------------------------------------------------------------

/** Which agent answered — announced before the first token (parity `pt-provenance`). */
export type AskProvenance = ChatTurnProvenance;

/**
 * The in-flight turn, folded from the frame stream.
 *
 * Separate from the persisted transcript because it is a different thing: the
 * transcript is what the host stored, this is what is arriving. They are
 * reconciled once, when the turn ends ({@link askCompletedTurn}).
 */
export interface AskTurnState {
  /** Assistant text so far. */
  text: string;
  /** Announced tool calls, in order, with their inputs when the emitter sent them. */
  toolCalls: ChatTurnToolCall[];
  /** Announced at the start of the turn, before the first token. */
  provenance: AskProvenance | null;
  /** A stable failure code from the host, never upstream prose. */
  errorCode: string | null;
  /** The host's failure sentence, kept only as the fallback for an unknown code. */
  errorMessage: string | null;
  /** Host-provided backoff for a refused turn; null when the failure has none. */
  retryAfterMs: number | null;
  /** When a capped model account's usage limit lifts (epoch ms); absent/null when unknown. */
  resetAt?: number | null;
  /** Current last-write-wins interactive card state for this turn. */
  cards: OpenCardSnapshot[];
  /** The turn ended — cleanly or not. */
  done: boolean;
}

export const EMPTY_TURN: AskTurnState = {
  text: '',
  toolCalls: [],
  provenance: null,
  errorCode: null,
  errorMessage: null,
  retryAfterMs: null,
  cards: [],
  done: false,
};

/** The generic code for a failure the host gave no code for. */
export const CHAT_TURN_FAILED = 'chat_turn_failed';
/** The client's OWN code for "the adapter threw before/while streaming" — the
 *  operator was not reachable at all, or the stream died mid-turn. */
export const CHAT_TRANSPORT_FAILED = 'portal_chat_operator_unreachable';
/** The client's code for a turn the viewer cancelled. */
export const CHAT_TURN_ABORTED = 'chat_turn_aborted';

function isOpenCardSnapshot(value: unknown): value is OpenCardSnapshot {
  const card = asRecord(value);
  return (
    !!card &&
    typeof card.correlationId === 'string' &&
    card.correlationId.length > 0 &&
    typeof card.prompt === 'string' &&
    typeof card.createdAt === 'number' &&
    Number.isFinite(card.createdAt)
  );
}

/**
 * Fold ONE frame into the in-flight turn state. Pure.
 *
 * `session` and `navigate` are not content: the hook forwards `navigate` to the
 * host's `onNavigate` and both leave the state untouched here. An unrecognised
 * frame is dropped for the same reason the host drops it: nobody chose to
 * render it.
 */
export function reduceAskFrame(state: AskTurnState, frame: PapercupChatFrame): AskTurnState {
  switch (frame.type) {
    case 'delta':
      return frame.text ? { ...state, text: state.text + frame.text } : state;
    case 'provenance': {
      const engine = frame.engine || '';
      const model = frame.model || '';
      if (!engine && !model) return state;
      return { ...state, provenance: { engine, model, accountRoute: frame.accountRoute ?? null } };
    }
    case 'tool_call': {
      if (!frame.name) return state;
      const call: ChatTurnToolCall = { name: frame.name };
      if (frame.input !== undefined) call.input = frame.input;
      if (frame.callId) call.callId = frame.callId;
      return { ...state, toolCalls: [...state.toolCalls, call] };
    }
    case 'tool_result':
      // The transcript renders the CALL; a result's ok/summary is not persisted
      // on `ChatTurnToolCall`, so it changes nothing the view would show.
      return state;
    case 'card': {
      if (!isOpenCardSnapshot(frame.card)) return state;
      const card = frame.card;
      return {
        ...state,
        cards: [...state.cards.filter((current) => current.correlationId !== card.correlationId), card],
      };
    }
    case 'card_closed':
      return frame.correlationId
        ? { ...state, cards: state.cards.filter((card) => card.correlationId !== frame.correlationId) }
        : state;
    case 'state': {
      const snapshot = asRecord(frame.snapshot);
      const openCards = snapshot?.openCards;
      if (!Array.isArray(openCards)) return state;
      return { ...state, cards: openCards.filter(isOpenCardSnapshot) };
    }
    case 'error':
      return {
        ...state,
        errorCode: frame.code ?? CHAT_TURN_FAILED,
        errorMessage: frame.message || null,
        retryAfterMs: frame.retryAfterMs ?? null,
        resetAt: frame.resetAt ?? null,
        done: true,
      };
    case 'done':
      return { ...state, done: true };
    default:
      return state;
  }
}

/** Convert an untrusted JSON refusal body (a non-2xx response) into the same
 *  state a failed live turn renders. Ported verbatim from the portal. */
export function askTurnRefusalState(value: unknown): AskTurnState {
  const record = asRecord(value);
  const refused = record?.ok === false;
  const errorCode = refused && typeof record.error === 'string' && record.error ? record.error : CHAT_TURN_FAILED;
  const retryAfterMs =
    refused &&
    typeof record.retryAfterMs === 'number' &&
    Number.isSafeInteger(record.retryAfterMs) &&
    record.retryAfterMs > 0
      ? record.retryAfterMs
      : null;
  return { ...EMPTY_TURN, errorCode, retryAfterMs, done: true };
}

/**
 * Thrown by an adapter's `sendTurn` when the host REFUSED the turn (a non-2xx
 * response with a JSON body) — as opposed to the stream failing. The hook maps
 * `body` through {@link askTurnRefusalState}, so the refusal's `error` code and
 * `retryAfterMs` reach the transcript exactly as the portal rendered them.
 */
export class ChatTurnRefusedError extends Error {
  readonly body: unknown;
  readonly status: number | null;
  constructor(body: unknown, status: number | null = null) {
    super('chat turn refused');
    this.name = 'ChatTurnRefusedError';
    this.body = body;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Error taxonomy (parity `pt-error-taxonomy`) — ported verbatim from the portal
// ---------------------------------------------------------------------------

/**
 * What the viewer was doing when the failure arrived. ONE code means different
 * things in different places, so a single generic sentence cannot serve all
 * three: a refused CARD answer is not "that turn did not complete" — no turn
 * was taken; the viewer answered a question the AGENT asked.
 */
export type AskFailureContext = 'turn' | 'conversation' | 'card';

/** The one sentence for every way the operator can be out of reach. */
const OPERATOR_DOWN = 'Papercup is not reachable right now. Try again in a moment.';

/** "Oct 3, 5:30 PM" in the viewer's own locale and time zone; null when unknown or invalid. */
export function formatResetAt(resetAt: number | null | undefined): string | null {
  if (typeof resetAt !== 'number' || !Number.isSafeInteger(resetAt) || resetAt <= 0) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function askGenericFailure(context: AskFailureContext): string {
  switch (context) {
    case 'conversation':
      return 'This conversation did not open. Try again.';
    case 'card':
      return 'That answer was not accepted. Try answering again.';
    case 'turn':
      return 'That turn did not complete. Try asking again.';
  }
}

/**
 * The sentence shown for a failure code.
 *
 * The host sends codes precisely so prose does not cross the boundary, which
 * makes this mapping the UI's job. An unrecognised code gets the honest generic
 * FOR ITS CONTEXT — never the raw code, which is an internal identifier.
 *
 * The vocabulary is the HOST'S: every literal below was read out of the portal
 * host's producers (`apps/host/src/agent-chats.ts`, `chat-turn-guard.ts`); the
 * operator host's adapter (P-009) maps its own failures onto the same codes so
 * the one component says the same thing on both hosts. A code with NO writer
 * gets no arm here. `portal_operator_status_<N>` embeds the upstream status in
 * the code, so it is a prefix test, not a case label.
 */
export function askErrorMessage(
  code: string | null,
  context: AskFailureContext,
  retryAfterMs: number | null = null,
  resetAt: number | null = null,
): string {
  if (code === null) return askGenericFailure(context);
  if (code.startsWith('portal_operator_status_')) return OPERATOR_DOWN;
  switch (code) {
    case 'portal_chat_content_required':
      return 'Type a question first.';
    case 'portal_chat_context_must_be_string':
      return 'Papercup could not read that request. Try again.';
    case 'portal_chat_context_too_long':
    case 'portal_chat_title_too_long':
      return 'That question is too long to send.';
    case 'portal_chat_not_found':
      return 'This conversation is no longer available.';
    case 'portal_chat_turn_concurrency_limited':
      return 'Papercup is already answering as many questions as this workspace allows. Try again when one finishes.';
    case 'portal_chat_turn_rate_limited': {
      const seconds =
        typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
          ? Math.max(1, Math.ceil(retryAfterMs / 1_000))
          : null;
      return seconds === null
        ? 'Too many questions were started recently. Wait a moment and try again.'
        : `Too many questions were started recently. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
    }
    // The host's report, and the client's own guess when it cannot reach the
    // host at all. Different events, same thing to say about them.
    case 'portal_operator_unreachable':
    case CHAT_TRANSPORT_FAILED:
      return OPERATOR_DOWN;
    case CHAT_TURN_ABORTED:
      return 'You stopped that turn.';
    // WI-10003494: the workspace's AI account, not Papercup, is why the turn failed.
    // Written by the portal host's error-frame projection (apps/host/src/agent-chats.ts).
    case 'portal_chat_model_usage_limited': {
      const until = formatResetAt(resetAt);
      return until
        ? `This workspace's AI account has reached its usage limit until ${until}. Connect a different account for this workspace, or try again then.`
        : "This workspace's AI account has reached its usage limit. Connect a different account for this workspace, or try again later.";
    }
    case 'portal_chat_model_auth_required':
      return "This workspace's AI account is signed out or its access was revoked. Sign it in again, then ask again.";
    case 'portal_chat_model_rate_limited': {
      const seconds =
        typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
          ? Math.max(1, Math.ceil(retryAfterMs / 1_000))
          : null;
      return seconds === null
        ? "This workspace's AI service is busy right now. Wait a moment and try again."
        : `This workspace's AI service is busy right now. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
    }
    case 'portal_chat_card_workspace_unbound':
      return 'This conversation is not connected to a workspace, so it cannot take that answer.';
    case 'portal_chat_card_response_invalid':
    case 'portal_chat_card_response_value_required':
      return 'That answer was not accepted. Try answering again.';
    default:
      return askGenericFailure(context);
  }
}

/**
 * What the transcript records for a turn that has ENDED. A turn can end having
 * produced nothing at all (the host closes the stream on an upstream drop
 * WITHOUT an `error` frame), and a blank bubble under the question is
 * indistinguishable from an answer that was genuinely empty — so say so. A
 * tool-only turn is not empty: interactive tools can deliberately return no
 * prose, and their card/tool UI is the answer.
 */
export function askCompletedTurn(final: AskTurnState): { content: string; error: boolean } {
  if (final.errorCode) {
    return { content: askErrorMessage(final.errorCode, 'turn', final.retryAfterMs, final.resetAt ?? null), error: true };
  }
  if (final.text.trim()) return { content: final.text, error: false };
  if (final.toolCalls.length > 0) return { content: '', error: false };
  return { content: 'That turn ended without an answer.', error: true };
}

/**
 * What a "Try again" button beside a whole-surface failure would actually
 * retry (parity `pt-retry`). Total, and returns what would be retried rather
 * than a boolean, so the view can label the button with the thing it does.
 */
export type AskRetryTarget = 'conversation' | 'question' | null;

export function askRetryTarget(input: {
  hasSurfaceError: boolean;
  chatId: string | null;
  unsentQuestion: string;
}): AskRetryTarget {
  if (!input.hasSurfaceError) return null;
  // Re-opening a conversation we already have an id for is the cheaper, more
  // faithful retry, so it outranks re-asking.
  if (input.chatId) return 'conversation';
  return input.unsentQuestion.trim() ? 'question' : null;
}

// ---------------------------------------------------------------------------
// Capability contract (parity `pt-capability-contract`)
// ---------------------------------------------------------------------------

/**
 * The capability facts the PUBLIC host's standing notice is allowed to state.
 *
 * Deliberately a small, user-facing contract rather than a copy of the
 * operator's spawn options. The portal's `tests/ask-capability-contract.test.tsx`
 * pins `attachedTools` to the writer's attached-tool allowlist; when the portal
 * mounts this component over converse (P-008) that guard re-pins against the
 * converse public toolset (`selectConverseTools`, parity `op-tool-working-set`).
 * A host passes its own contract to `askCapabilityNoticeText` when it differs.
 */
export const ASK_CAPABILITY_CONTRACT = {
  /** Native file/shell tools run with the operator's full machine access. */
  machineAccess: 'full',
  /** The public chat route does not expose an approval round-trip. */
  confirmation: 'none',
  /** The visible activity line contains attached MCP tools only. */
  activity: 'attached-tools-only',
  /** The attached research tools the public host itemises. */
  attachedTools: ['work_items:get', 'work_items:list', 'plans:get', 'docs:search', 'memory:search', 'voice:say'],
} as const;

export type AskCapabilityContract = {
  machineAccess: 'full' | 'restricted';
  confirmation: 'none' | 'required';
  activity: 'attached-tools-only' | 'partial';
  attachedTools: readonly string[];
};

// ---------------------------------------------------------------------------
// Persisted-card helpers (the operator's `chat:ask_choice` tool rows)
// ---------------------------------------------------------------------------

/** The `chat:ask_choice` tool input, as the converse backend records it. */
export interface AskChoiceToolInput {
  question: string;
  options: Array<{ id: string; label: string; hint?: string; style?: 'default' | 'primary' | 'danger' }>;
  multi?: boolean;
}

export const ASK_CHOICE_TOOL = 'chat:ask_choice';

/** Parse a persisted `chat:ask_choice` call's input into card args, or null. */
export function askChoiceArgsFromToolCall(call: ChatTurnToolCall): AskChoiceToolInput | null {
  if (call.name !== ASK_CHOICE_TOOL) return null;
  const input = asRecord(call.input);
  if (!input || typeof input.question !== 'string') return null;
  // The tool accepts arrays and JSON-encoded arrays. Persisted tool calls
  // contain the original wire input, before the handler normalizes it.
  const rawOptions = decodeCardOptions(input.options);
  if (!rawOptions) return null;
  const options: AskChoiceToolInput['options'] = [];
  for (const raw of rawOptions) {
    const o = asRecord(raw);
    if (!o || typeof o.id !== 'string' || typeof o.label !== 'string') continue;
    const style = o.style === 'primary' || o.style === 'danger' || o.style === 'default' ? o.style : undefined;
    options.push({
      id: o.id,
      label: o.label,
      ...(typeof o.hint === 'string' ? { hint: o.hint } : {}),
      ...(style ? { style } : {}),
    });
  }
  if (options.length === 0) return null;
  return { question: input.question, options, ...(input.multi === true ? { multi: true } : {}) };
}

// ---------------------------------------------------------------------------
// The adapter — the host's three answers
// ---------------------------------------------------------------------------

export interface SendTurnOptions {
  /** Aborted when the viewer stops the turn or the conversation changes. */
  signal: AbortSignal;
}

export interface PersistedCardAnswer {
  turn: ChatTurn;
  toolIndex: number;
  picks: Array<{ option_id: string; label: string }>;
  declined?: boolean;
}

export interface PapercupChatAdapter {
  /**
   * Load persisted history, oldest-first within the page. Omit on a host with
   * no history store (the transcript then holds only this session's turns).
   * `beforeSeq` asks for the page BEFORE that turn (infinite scroll upward).
   */
  loadHistory?: (opts: { beforeSeq?: number; limit: number }) => Promise<ChatTurnsPage>;
  /**
   * Send one user turn and stream its frames until the turn ends. Throw
   * {@link ChatTurnRefusedError} for a host refusal; any other throw is a
   * transport failure. The iterable may end without a `done` frame — the hook
   * closes the turn either way.
   */
  sendTurn: (text: string, opts: SendTurnOptions) => AsyncIterable<PapercupChatFrame> | Promise<AsyncIterable<PapercupChatFrame>>;
  /** Answer an open (state-channel) card. Reject with a `code` string or an Error. */
  answerCard: (response: CardResponse) => Promise<void>;
  /**
   * Answer a `chat:ask_choice` persisted on an earlier turn (the operator's
   * turn-answer endpoint). Omit on a host that never persists cards; the view
   * then renders those tool rows read-only.
   */
  answerPersistedCard?: (answer: PersistedCardAnswer) => Promise<void>;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface UsePapercupChatOptions {
  adapter: PapercupChatAdapter;
  /**
   * The conversation this transcript shows. Changing it resets the transcript
   * and reloads history; `null` means "no conversation open yet" — the first
   * `send` still goes through (the adapter opens one) and history is skipped.
   */
  conversationId: string | null;
  /** History page size (default 50). */
  historyPageSize?: number;
  /** A `navigate` frame's destination — the host decides what to do with it. */
  onNavigate?: (href: string) => void;
  /** Fired once per committed assistant turn (voice hosts read the answer aloud). */
  onAssistantTurn?: (turn: ChatTurn) => void;
}

export interface SurfaceError {
  code: string | null;
  context: AskFailureContext;
  retryAfterMs: number | null;
}

/** Everything `PapercupChat` renders from and calls back into. */
export interface PapercupChatController {
  conversationId: string | null;
  /** Committed transcript, oldest first. */
  turns: ChatTurn[];
  /** The in-flight assistant turn, or null between turns. */
  live: AskTurnState | null;
  /** A turn is streaming. */
  streaming: boolean;
  /** Any request is in flight (streaming, history load, card answer). */
  busy: boolean;
  loadingHistory: boolean;
  hasMoreEarlier: boolean;
  /** Open cards for the live turn (last-write-wins state channel). */
  pendingCards: readonly OpenCardSnapshot[];
  cardBusy: boolean;
  cardError: string | null;
  /** A whole-surface failure (history did not load) — rendered as the error banner. */
  surfaceError: SurfaceError | null;
  /** The question a failed `send` never delivered — offered back for retry. */
  unsentQuestion: string;
  retryTarget: AskRetryTarget;
  send: (text: string) => Promise<void>;
  answerCard: (response: CardResponse) => Promise<void>;
  answerPersistedCard: ((answer: PersistedCardAnswer) => Promise<void>) | null;
  /** Retry whatever `retryTarget` names; no-op when it is null. */
  retry: () => Promise<void>;
  loadEarlier: () => Promise<void>;
  /** Stop the streaming turn; what arrived so far is committed. */
  abort: () => void;
  /**
   * Append turns that arrived OUTSIDE the text transport — a voice session's
   * settled STT/TTS segments (both hosts fold these into the same transcript).
   * They are local until the host persists them; ids must be stable so a
   * repeat delivery is a no-op.
   */
  appendLocalTurns: (turns: readonly ChatTurn[]) => void;
}

let localIdCounter = 0;
function localId(prefix: string): string {
  localIdCounter += 1;
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}-${localIdCounter}-${rand}`;
}

function errorCodeOf(err: unknown): string | null {
  if (typeof err === 'string') return err;
  const record = asRecord(err);
  if (record && typeof record.code === 'string') return record.code;
  return null;
}

export function usePapercupChat(options: UsePapercupChatOptions): PapercupChatController {
  const { adapter, conversationId, historyPageSize = 50, onNavigate, onAssistantTurn } = options;

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [live, setLive] = useState<AskTurnState | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [cardBusy, setCardBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [surfaceError, setSurfaceError] = useState<SurfaceError | null>(null);
  const [unsentQuestion, setUnsentQuestion] = useState('');

  // Latest-call references so async continuations never read a stale closure.
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onAssistantTurnRef = useRef(onAssistantTurn);
  onAssistantTurnRef.current = onAssistantTurn;

  // A generation stamp per conversation: a result that arrives after the
  // conversation changed belongs to a transcript that is no longer shown.
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  const loadHistoryPage = useCallback(
    async (beforeSeq: number | undefined, mode: 'replace' | 'prepend') => {
      const load = adapterRef.current.loadHistory;
      if (!load) return;
      const gen = generationRef.current;
      setLoadingHistory(true);
      if (mode === 'replace') setSurfaceError(null);
      try {
        const page = await load({ beforeSeq, limit: historyPageSize });
        if (gen !== generationRef.current) return;
        setHasMoreEarlier(page.hasMoreEarlier);
        setTurns((prev) => (mode === 'replace' ? page.turns : [...page.turns, ...prev]));
      } catch (err) {
        if (gen !== generationRef.current) return;
        const code = err instanceof ChatTurnRefusedError ? askTurnRefusalState(err.body).errorCode : errorCodeOf(err);
        setSurfaceError({ code: code ?? CHAT_TRANSPORT_FAILED, context: 'conversation', retryAfterMs: null });
      } finally {
        if (gen === generationRef.current) setLoadingHistory(false);
      }
    },
    [historyPageSize],
  );

  // Conversation switch: abort any stream, reset, reload.
  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    setTurns([]);
    setLive(null);
    setHasMoreEarlier(false);
    setCardBusy(false);
    setCardError(null);
    setSurfaceError(null);
    setUnsentQuestion('');
    if (conversationId) void loadHistoryPage(undefined, 'replace');
    return () => {
      abortRef.current?.abort();
    };
  }, [conversationId, loadHistoryPage]);

  const send = useCallback(async (text: string) => {
    const question = text.trim();
    if (!question || streamingRef.current) return;
    const gen = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    streamingRef.current = true;

    const userTurn: ChatTurn = {
      id: localId('local-user'),
      role: 'user',
      text: question,
      createdAt: Date.now(),
      source: 'text_typed',
    };
    setTurns((prev) => [...prev, userTurn]);
    setUnsentQuestion(question);
    setCardError(null);
    let state: AskTurnState = EMPTY_TURN;
    setLive(state);

    try {
      const stream = await adapterRef.current.sendTurn(question, { signal: controller.signal });
      for await (const frame of stream) {
        if (gen !== generationRef.current) return;
        if (!frame) continue;
        if (frame.type === 'navigate') {
          onNavigateRef.current?.(frame.href);
          continue;
        }
        state = reduceAskFrame(state, frame);
        setLive(state);
        if (state.done) break;
      }
      if (!state.done) state = { ...state, done: true };
    } catch (err) {
      if (gen !== generationRef.current) return;
      if (err instanceof ChatTurnRefusedError) {
        state = { ...askTurnRefusalState(err.body), text: state.text, toolCalls: state.toolCalls, provenance: state.provenance };
      } else if (controller.signal.aborted) {
        // The viewer stopped it: keep what arrived; an empty turn says so.
        state = state.text.trim()
          ? { ...state, done: true }
          : { ...state, errorCode: CHAT_TURN_ABORTED, done: true };
      } else {
        state = { ...state, errorCode: CHAT_TRANSPORT_FAILED, errorMessage: null, done: true };
      }
    } finally {
      if (gen === generationRef.current) {
        streamingRef.current = false;
        if (abortRef.current === controller) abortRef.current = null;
      }
    }
    if (gen !== generationRef.current) return;

    const { content, error } = askCompletedTurn(state);
    const assistantTurn: ChatTurn = {
      id: localId('local-assistant'),
      role: 'assistant',
      text: content,
      createdAt: Date.now(),
      tools: state.toolCalls.length ? state.toolCalls : null,
      provenance: state.provenance,
      ...(error ? { error: true } : {}),
    };
    setTurns((prev) => [...prev, assistantTurn]);
    setLive(null);
    if (!error) setUnsentQuestion('');
    onAssistantTurnRef.current?.(assistantTurn);
  }, []);

  const answerCard = useCallback(async (response: CardResponse) => {
    const gen = generationRef.current;
    setCardBusy(true);
    setCardError(null);
    try {
      await adapterRef.current.answerCard(response);
    } catch (err) {
      if (gen !== generationRef.current) return;
      const code = err instanceof ChatTurnRefusedError ? askTurnRefusalState(err.body).errorCode : errorCodeOf(err);
      setCardError(askErrorMessage(code, 'card'));
    } finally {
      if (gen === generationRef.current) setCardBusy(false);
    }
  }, []);

  const answerPersistedCard = useMemo(() => {
    const impl = adapter.answerPersistedCard;
    if (!impl) return null;
    return async (answer: PersistedCardAnswer) => {
      const gen = generationRef.current;
      setCardBusy(true);
      setCardError(null);
      try {
        await impl(answer);
        if (gen !== generationRef.current) return;
        // Reflect the answer locally so the card reads answered without a reload.
        setTurns((prev) =>
          prev.map((t) => {
            if (t.id !== answer.turn.id || !t.tools) return t;
            const tools = t.tools.map((call, i) =>
              i === answer.toolIndex ? { ...call, answered: { picks: answer.picks, at: Date.now() } } : call,
            );
            return { ...t, tools };
          }),
        );
      } catch (err) {
        if (gen !== generationRef.current) return;
        setCardError(askErrorMessage(errorCodeOf(err), 'card'));
      } finally {
        if (gen === generationRef.current) setCardBusy(false);
      }
    };
  }, [adapter.answerPersistedCard]);

  const loadEarlier = useCallback(async () => {
    if (!hasMoreEarlier || loadingHistory) return;
    const first = turns.find((t) => typeof t.seq === 'number');
    await loadHistoryPage(first?.seq, 'prepend');
  }, [hasMoreEarlier, loadingHistory, turns, loadHistoryPage]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const appendLocalTurns = useCallback((incoming: readonly ChatTurn[]) => {
    if (incoming.length === 0) return;
    setTurns((prev) => {
      const seen = new Set(prev.map((t) => t.id));
      const fresh = incoming.filter((t) => !seen.has(t.id));
      return fresh.length === 0 ? prev : [...prev, ...fresh];
    });
  }, []);

  const retryTarget = askRetryTarget({ hasSurfaceError: surfaceError !== null, chatId: conversationId, unsentQuestion });

  const retry = useCallback(async () => {
    if (retryTarget === 'conversation') {
      await loadHistoryPage(undefined, 'replace');
    } else if (retryTarget === 'question') {
      setSurfaceError(null);
      await send(unsentQuestion);
    }
  }, [retryTarget, loadHistoryPage, send, unsentQuestion]);

  const streaming = live !== null && !live.done;
  const pendingCards = live?.cards ?? [];

  return {
    conversationId,
    turns,
    live,
    streaming,
    busy: streaming || loadingHistory || cardBusy,
    loadingHistory,
    hasMoreEarlier,
    pendingCards,
    cardBusy,
    cardError,
    surfaceError,
    unsentQuestion,
    retryTarget,
    send,
    answerCard,
    answerPersistedCard,
    retry,
    loadEarlier,
    abort,
    appendLocalTurns,
  };
}
