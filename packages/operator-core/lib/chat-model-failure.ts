/**
 * A stable CODE for a chat turn that failed because of the MODEL ACCOUNT behind it.
 *
 * WI-10003494 (owner #723): a hosted workspace whose Codex account was capped until
 * Oct 3 and whose Claude credential was revoked showed its viewer only "That turn did
 * not complete" / "Papercup is not reachable right now". The real reason was already in
 * the operator's error frame — as PROSE (`codex exited 1: You've hit your usage limit
 * ... try again at Oct 3rd, 2026 5:30 PM.`). The portal correctly refuses to forward
 * upstream prose across its boundary (it can name paths and internal detail), so the
 * reason died there: nothing machine-readable said WHICH kind of failure it was.
 *
 * This is that machine-readable part. The error frame keeps its `message` and gains:
 *   - `code`: one of {@link ChatModelFailureCode}, only when the failure is one the
 *     viewer can act on (connect another account, sign in again, wait);
 *   - `resetAt`: epoch ms the usage cap lifts, only when the provider NAMED the instant
 *     (header or explicit date) — an inferred day is not something to promise a viewer;
 *   - `retryAfterMs`: for a transient rate limit, when the backend said how long.
 *
 * Classification is the shared turn-error taxonomy (`classifySubprocessResult`), the
 * same one the fleet governor backs off on — not a second set of patterns. Anything it
 * does not place in one of the three actionable classes gets NO code, so the consumer
 * keeps its honest generic sentence.
 *
 * Imports the PURE `agent/turn-error` subpath, not the `agent` barrel, because the web
 * portal host imports this module too — to classify error frames from operators built
 * before this change — and must not bundle the governor/runtime the barrel re-exports.
 */
import { classifySubprocessResult, type UsageResetPrecision } from '@papercusp/papercusp-shared/agent/turn-error';

export type ChatModelFailureCode = 'model_usage_limited' | 'model_auth_required' | 'model_rate_limited';

export interface ChatModelFailure {
  code: ChatModelFailureCode;
  /** Epoch ms the usage cap lifts — present only for a provider-named instant. */
  resetAt?: number;
  /** Transient rate limit: how long the backend asked to wait. */
  retryAfterMs?: number;
}

/** Safe fallback stored in transcript JSONB instead of backend error prose. */
export const CHAT_TURN_FAILURE_SAFE_MESSAGE = 'That turn did not complete. Try asking again.';

/** Only these precisions name an instant explicitly; `clock`/`relative` are partly inferred. */
const NAMED_RESET: ReadonlySet<UsageResetPrecision> = new Set<UsageResetPrecision>(['header', 'dated']);

/**
 * Whose clock a wall-clock reset in the text was printed in.
 *
 * `dated` ("try again at Oct 3rd, 2026 5:30 PM") is a WALL CLOCK with no zone: Codex prints
 * it in the local zone of the host that ran it. Converting it to an instant is only right
 * where that zone is this process's zone — i.e. the operator classifying its own backend's
 * output. A classifier on ANOTHER host (the portal reading an older operator's prose) does
 * not know the emitter's zone: measured WI-10003494, avi-test runs Etc/UTC and the portal
 * host America/New_York, so the same text parsed there lands 4h late. `'unknown'` keeps the
 * code and drops every wall-clock-derived instant; a `header` instant is zone-free and stays.
 */
export type WallClockZone = 'local' | 'unknown';

export interface ClassifyChatModelFailureOptions {
  /** Default `'local'`: the text was emitted on this host. */
  wallClockZone?: WallClockZone;
}

/**
 * Classify a failed chat turn's error text. Returns null when the failure is not one of
 * the actionable model-account classes (or there is no text to classify).
 */
export function classifyChatModelFailure(
  message: string | null | undefined,
  now: number = Date.now(),
  options: ClassifyChatModelFailureOptions = {},
): ChatModelFailure | null {
  const text = (message ?? '').trim();
  if (!text) return null;
  // The text is a failed backend's own report, so classify it as a failed subprocess:
  // exit 1 is what enables the stdout/stderr provider-wall scan.
  const turnError = classifySubprocessResult({ exitCode: 1, stderr: text }, 'unknown', now);
  switch (turnError.class) {
    case 'usage_limit': {
      const zoneKnown = (options.wallClockZone ?? 'local') === 'local';
      const named =
        turnError.resetAt !== undefined &&
        turnError.resetAt > now &&
        turnError.resetPrecision !== undefined &&
        NAMED_RESET.has(turnError.resetPrecision) &&
        (zoneKnown || turnError.resetPrecision === 'header');
      return { code: 'model_usage_limited', ...(named ? { resetAt: turnError.resetAt } : {}) };
    }
    case 'auth':
      return { code: 'model_auth_required' };
    case 'rate_limited': {
      const retryAfterMs =
        typeof turnError.retryAfterMs === 'number' && Number.isFinite(turnError.retryAfterMs) && turnError.retryAfterMs > 0
          ? Math.round(turnError.retryAfterMs)
          : undefined;
      return { code: 'model_rate_limited', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    default:
      return null;
  }
}

/**
 * The fields to spread onto an SSE `error` frame's data for a failed turn:
 * `{ code, resetAt?, retryAfterMs? }` or `{}` when the failure is not actionable.
 */
export function chatModelFailureFields(
  message: string | null | undefined,
  now: number = Date.now(),
): Partial<ChatModelFailure> {
  return classifyChatModelFailure(message, now) ?? {};
}

export interface SafeChatFailureTranscriptFields extends Partial<ChatModelFailure> {
  content: string;
  error: true;
}

/** Persist a safe transcript sentence plus any actionable, stable failure fields. */
export function safeChatFailureTranscriptFields(
  message: string | null | undefined,
  now: number = Date.now(),
): SafeChatFailureTranscriptFields {
  return {
    content: CHAT_TURN_FAILURE_SAFE_MESSAGE,
    error: true,
    ...chatModelFailureFields(message, now),
  };
}

export interface ChatFailureTranscriptTurnInput {
  content?: unknown;
  error?: unknown;
  code?: unknown;
  resetAt?: unknown;
  retryAfterMs?: unknown;
}

const CHAT_MODEL_FAILURE_CODES: readonly ChatModelFailureCode[] = [
  'model_usage_limited',
  'model_auth_required',
  'model_rate_limited',
];

/**
 * Project a persisted error turn for a viewer. Old transcript rows may still
 * contain backend prose in `content`; keep the stable actionable fields and
 * replace that prose before it reaches a transcript reader.
 */
export function projectChatFailureTranscriptTurn<T extends ChatFailureTranscriptTurnInput>(
  turn: T,
  now?: number,
): T;
export function projectChatFailureTranscriptTurn(turn: unknown, now?: number): unknown;
export function projectChatFailureTranscriptTurn(turn: unknown, now: number = Date.now()): unknown {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return turn;
  const source = turn as Record<string, unknown>;
  if (source.error !== true) return turn;

  // The original prose was emitted by another host, whose local timezone this
  // reader does not know. Keep an explicit UTC/header reset, but do not parse a
  // provider's unzoned wall-clock date into a misleading instant here.
  const classified = classifyChatModelFailure(
    typeof source.content === 'string' ? source.content : undefined,
    now,
    { wallClockZone: 'unknown' },
  );
  const code = CHAT_MODEL_FAILURE_CODES.includes(source.code as ChatModelFailureCode)
    ? source.code as ChatModelFailureCode
    : classified?.code;
  const resetAt = typeof source.resetAt === 'number' && Number.isFinite(source.resetAt) && source.resetAt > 0
    ? source.resetAt
    : classified?.resetAt;
  const retryAfterMs = typeof source.retryAfterMs === 'number' && Number.isFinite(source.retryAfterMs) && source.retryAfterMs > 0
    ? source.retryAfterMs
    : classified?.retryAfterMs;

  const projected: Record<string, unknown> = {
    ...source,
    content: CHAT_TURN_FAILURE_SAFE_MESSAGE,
    error: true,
  };
  if (code) projected.code = code;
  else delete projected.code;
  if (resetAt !== undefined) projected.resetAt = resetAt;
  else delete projected.resetAt;
  if (retryAfterMs !== undefined) projected.retryAfterMs = retryAfterMs;
  else delete projected.retryAfterMs;
  return projected;
}

/** Preserve non-array transcript values, and project each turn in valid arrays. */
export function projectChatFailureTranscript(transcript: unknown, now: number = Date.now()): unknown {
  return Array.isArray(transcript)
    ? transcript.map((turn) => projectChatFailureTranscriptTurn(turn, now))
    : transcript;
}
