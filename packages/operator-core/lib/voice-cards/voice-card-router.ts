/**
 * voice-card-router — small client-side controller that maps STT
 * transcripts onto an in-flight `chat:ask_choice` card.
 *
 * Plan: apps/operator/docs/plans/voice-aware-cards-2026-05-14.md
 *   §C.1 (router branches) + §C.1a (snapshot-arrival race buffer)
 *
 * The router holds two pieces of state:
 *
 *   - pending: a brain `tool_call` for `chat:ask_choice` has been
 *     observed on the SSE stream but no state-snapshot has landed
 *     yet. Transcripts arriving here are buffered (up to 1 s) so
 *     they don't race past the snapshot.
 *
 *   - active: a state-snapshot has delivered a focused card with
 *     voiceAnswerable === true. Transcripts arriving here are
 *     parsed via matchVoiceAnswer.
 *
 * The provider owns the React-lifecycle plumbing (state-snapshot
 * subscription, voiceActive flip, workspace switch). This module
 * stays a pure controller — no React imports, no fetch.
 */

import type { OpenCardSnapshot } from '@papercusp/agent-mcp';

import {
  matchVoiceAnswer,
  type MatchResult,
  type VoiceTranscript,
} from './match-voice-answer';

/** Card spec the router needs. Subset of OpenCardWithRun. */
export interface RouterCard {
  correlationId: string;
  runId: string;
  card: OpenCardSnapshot;
}

export type RouterOutcome =
  | { kind: 'submit'; correlationId: string; runId: string; payload: { picks: string[] } }
  | { kind: 'decline'; correlationId: string; runId: string }
  | { kind: 'ambiguous'; correlationId: string; runId: string; prompt: string; round: number }
  | { kind: 'buffered' }
  | { kind: 'fall_through' };

export interface RouterState {
  pendingObservedAtMs: number | null;
  active: RouterCard | null;
  /** Transcripts buffered while pending is set, awaiting snapshot. */
  buffer: VoiceTranscript[];
  /** Disambiguation rounds for the current active card. Resets on submit/decline/clear. */
  ambiguityRounds: number;
}

export function createRouterState(): RouterState {
  return {
    pendingObservedAtMs: null,
    active: null,
    buffer: [],
    ambiguityRounds: 0,
  };
}

/** Max disambiguation rounds before falling through. Plan §C.1 / M5. */
export const MAX_AMBIGUITY_ROUNDS = 2;

/** Buffer window for pre-snapshot transcripts. Plan §C.1a. */
export const BUFFER_WINDOW_MS = 1000;

/** Pre-card grace: transcript >250 ms older than pending arming bypasses buffer. */
export const PRE_CARD_GRACE_MS = 250;

/**
 * Route a transcript through the router. Returns the outcome the
 * provider should act on. The router does NOT POST or speak — the
 * provider owns those side effects.
 */
export function routeTranscript(
  state: RouterState,
  transcript: VoiceTranscript,
  composeAmbiguity: (card: OpenCardSnapshot, candidateIds: readonly string[]) => string,
): RouterOutcome {
  // Pending → buffer (unless transcript predates arming by > grace).
  if (state.pendingObservedAtMs !== null && state.active === null) {
    if (transcript.tsMs < state.pendingObservedAtMs - PRE_CARD_GRACE_MS) {
      return { kind: 'fall_through' };
    }
    state.buffer.push(transcript);
    return { kind: 'buffered' };
  }

  if (state.active === null) {
    return { kind: 'fall_through' };
  }

  const result: MatchResult = matchVoiceAnswer(transcript, state.active.card);
  if (result === null) {
    // No match: fall through. Card stays active for the next utterance.
    return { kind: 'fall_through' };
  }

  if (result.action === 'submit') {
    const out: RouterOutcome = {
      kind: 'submit',
      correlationId: state.active.correlationId,
      runId: state.active.runId,
      payload: result.payload,
    };
    clearActive(state);
    return out;
  }

  if (result.action === 'decline') {
    const out: RouterOutcome = {
      kind: 'decline',
      correlationId: state.active.correlationId,
      runId: state.active.runId,
    };
    clearActive(state);
    return out;
  }

  // ambiguous
  state.ambiguityRounds += 1;
  if (state.ambiguityRounds > MAX_AMBIGUITY_ROUNDS) {
    // Give up — fall through with the original transcript. Don't clear
    // active here; the next state-snapshot drop or voice-off will
    // clean up. Provider should treat this turn as user_message.
    return { kind: 'fall_through' };
  }
  const prompt = composeAmbiguity(state.active.card, result.candidateIds);
  return {
    kind: 'ambiguous',
    correlationId: state.active.correlationId,
    runId: state.active.runId,
    prompt,
    round: state.ambiguityRounds,
  };
}

/** Brain emitted a chat:ask_choice tool_call. Arm pending. */
export function markPending(state: RouterState, nowMs: number): void {
  state.pendingObservedAtMs = nowMs;
}

/**
 * State-snapshot delivered a focused card. Promote pending → active
 * (if pending) or just arm active. Returns buffered transcripts
 * (oldest first) that the caller should now route. Buffer drains.
 */
export function attachActive(
  state: RouterState,
  card: RouterCard,
): VoiceTranscript[] {
  state.active = card;
  state.ambiguityRounds = 0;
  state.pendingObservedAtMs = null;
  const drained = state.buffer.slice();
  state.buffer = [];
  return drained;
}

/**
 * Buffer window elapsed without a state-snapshot. Flush buffered
 * transcripts back to the caller as fall-through (they become
 * user_message dispatches). Clears pending.
 */
export function expirePending(state: RouterState): VoiceTranscript[] {
  state.pendingObservedAtMs = null;
  const drained = state.buffer.slice();
  state.buffer = [];
  return drained;
}

/** State-snapshot dropped the focused card (resolved / aborted). */
export function clearActive(state: RouterState): void {
  state.active = null;
  state.ambiguityRounds = 0;
}

/** Voice deactivated / workspace switched. Reset everything. */
export function resetRouter(state: RouterState): void {
  state.pendingObservedAtMs = null;
  state.active = null;
  state.buffer = [];
  state.ambiguityRounds = 0;
}
