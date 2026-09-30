/**
 * Voice-side bridge between the realtime/Conv-AI session and the
 * operator-conversation tag dispatcher.
 *
 * The voice agent (EL Conv AI / OpenAI Realtime / Gemini Live) emits
 * assistant text events as it speaks. When the operator is in active
 * mode, those utterances will contain the same <say>/<set_mode>/<sleep>
 * tags the text-path /api/agent-mcp/operator-converse route emits — same
 * prompt, same wire shape. This module:
 *
 *   1. Buffers incremental text events into utterance boundaries.
 *   2. Parses each completed utterance for tags via the shared
 *      parseOperatorTurn().
 *   3. Dispatches the side effects (mode flip, sleep timer) through
 *      the same sessionStorage hooks the text path uses, so a
 *      <set_mode>passive</set_mode> from voice flips the navbar
 *      toggle in lockstep with a <set_mode> from text.
 *
 * Buffering rule: an "utterance" is the assistant's text from the last
 * silence to the next. The voice engines fire onAssistantText with
 * incremental chunks and (sometimes) a final chunk. We treat any flush
 * (caller-driven or 1.2s of no chunks) as a boundary and parse what we
 * have. If parsing finds no tags the utterance is just spoken voice
 * with no side effects; we drop it silently.
 *
 * Importantly: <say> content already passes through TTS via the agent
 * itself. We do NOT re-render <say> here — that would double-render
 * the line. We only honor <set_mode> + <sleep> for side effects.
 */

import {
  consumeRecentDismissal,
  parseOperatorTurn,
  sleepTagToEpochMs,
  writeOperatorModeToSession,
  writeSleepUntilMs,
} from './operator-converse-tags';

const FLUSH_MS = 1200;
const MAX_DEFER_MS = 8000;

/**
 * Heuristic: does the buffer end in a tag opener that hasn't been
 * closed yet? If so, the 1.2s flush boundary would parse a partial
 * tag and drop it. Defer the flush until the closing `>` arrives.
 *
 * Detects:
 *   - "...<sa" or "...<spawn role=" → open tag, no `>` yet
 *   - "...<say>partial" → opening tag closed but no </say> yet
 *
 * We only care about the trailing chunk; earlier `<...>` pairs in
 * the buffer are already complete. Scan from the end backward to the
 * nearest unmatched `<`.
 */
function hasUnclosedTrailingTag(buf: string): boolean {
  const lastOpen = buf.lastIndexOf('<');
  if (lastOpen < 0) return false;
  const tail = buf.slice(lastOpen);
  // Opening still in flight (no `>` yet).
  if (!tail.includes('>')) return true;
  // Self-closing tags (<spawn ... />, <sleep ... />) are complete.
  // Paired tags need their closer; detect by sniffing the opener.
  const openerMatch = tail.match(/^<\s*(\w+)/);
  if (!openerMatch) return false;
  const tagName = openerMatch[1].toLowerCase();
  // Self-closing / void tags in our schema.
  if (tagName === 'spawn' || tagName === 'sleep') return false;
  // Paired tags: <say>, <set_mode>. Check for closer.
  const closer = `</${tagName}>`;
  return !tail.toLowerCase().includes(closer);
}

export interface OperatorVoiceTagObserver {
  /** Feed an incremental assistant-text chunk from the engine. */
  push(text: string): void;
  /** Force-flush + parse the buffered utterance now. */
  flush(): void;
  /** Tear down the auto-flush timer. Call on session disconnect. */
  dispose(): void;
}

/**
 * Create a buffered tag observer. Independent of any specific engine —
 * voice-mode.ts wires this into elevenlabs-conv / openai-realtime /
 * etc. via the existing onAssistantText callback.
 */
export function createOperatorVoiceTagObserver(): OperatorVoiceTagObserver {
  let buf = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  // First-push timestamp of the current buffered utterance. Used to
  // bound the defer-on-unclosed-tag wait so a truly broken stream
  // can't leave us buffering forever.
  let bufStartTs = 0;

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!buf.trim()) {
      buf = '';
      bufStartTs = 0;
      return;
    }
    // B6: if the trailing chunk is an unclosed tag opener and we
    // haven't exhausted our defer budget, wait for more chunks
    // rather than parsing a fragment that would silently drop the
    // tag. Force-flush only when dispose() is called (session end).
    const ageMs = bufStartTs > 0 ? Date.now() - bufStartTs : 0;
    if (hasUnclosedTrailingTag(buf) && ageMs < MAX_DEFER_MS) {
      flushTimer = setTimeout(flush, FLUSH_MS);
      return;
    }
    const parsed = parseOperatorTurn(buf);
    buf = '';
    bufStartTs = 0;

    // We do NOT honor parsed.say here — the voice agent has already
    // spoken it via TTS. Re-rendering would double-up.

    if (parsed.sleep) {
      writeSleepUntilMs(sleepTagToEpochMs(parsed.sleep));
    }

    // E1: voice-path dismissal enforcement. If a recent user
    // utterance matched the dismissal heuristic AND the brain didn't
    // emit <set_mode>passive</set_mode> in this turn, force the flip.
    // Symmetric to the text-path enforcement in the chat provider's
    // runGeneration. `consumeRecentDismissal` always clears the stamp
    // (one-shot), so a stale flag can't fire on a later turn.
    let effectiveMode = parsed.setMode;
    if (!effectiveMode && consumeRecentDismissal()) {
      effectiveMode = 'passive';
    }

    if (effectiveMode) {
      writeOperatorModeToSession(effectiveMode);
      try {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('papercusp:operatorMode', { detail: { mode: effectiveMode } }),
          );
        }
      } catch { /* ignore */ }
    }
  };

  const push = (text: string) => {
    if (!text) return;
    if (buf.length === 0) bufStartTs = Date.now();
    buf += text;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_MS);
  };

  const dispose = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    buf = '';
    bufStartTs = 0;
  };

  return { push, flush, dispose };
}
