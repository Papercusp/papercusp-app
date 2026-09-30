/**
 * The mobile desktop-local voice route is interactive: if the brain has not
 * produced any stream event promptly, waiting for the converse tool's generic
 * ten-minute ceiling is worse than failing the turn and letting the owner retry.
 */
export const VOICE_BRAIN_FIRST_EVENT_TIMEOUT_MS = 45_000;

export const VOICE_BRAIN_TIMEOUT_MESSAGE =
  'The voice response took too long — please try again';

/**
 * Surfaced when the brain stream COMPLETED cleanly (no error, no timeout, not
 * aborted) but yielded no spoken/persisted reply — an empty completion or a
 * silently-dropped brain call, which correlates with pool latency under load.
 * Without this, the route fired a silent `done` and the phone showed / spoke
 * nothing at all (EI-13027). Reuse the existing `error` surface so already-
 * shipped clients render a retry prompt instead of silence.
 */
export const VOICE_BRAIN_NO_REPLY_MESSAGE =
  "I didn't catch a reply — please try again";

/**
 * Did the brain turn produce nothing the user can perceive? True when there is
 * no spoken/persisted reply (no `<say>`/`<report>` text AND no audio chunks
 * emitted) AND the turn was not a deliberate going-silent `<sleep>`. The route
 * uses this to surface {@link VOICE_BRAIN_NO_REPLY_MESSAGE} instead of a silent
 * `done`. EI-13027.
 *
 * `wentSilent` guards the legitimate case: a `<sleep>` turn intentionally emits
 * no `<say>` (silence IS the response) and must NOT be reported as a dropped turn.
 */
export function voiceTurnProducedNoReply(o: {
  say?: string | null;
  report?: unknown;
  audioChunks: number;
  wentSilent?: boolean;
}): boolean {
  if (o.wentSilent) return false;
  const hasSay = typeof o.say === 'string' && o.say.trim().length > 0;
  const hasReport = o.report != null;
  return !hasSay && !hasReport && o.audioChunks <= 0;
}

export interface VoiceBrainFirstEventDeadline {
  signal: AbortSignal;
  /** Stop the first-event timer once the brain proves it is making progress. */
  observeEvent(): void;
  /** True only when this deadline fired, not when the caller disconnected. */
  didTimeout(): boolean;
  dispose(): void;
}

/**
 * Compose the request signal with a voice-specific first-event deadline.
 * The converse dispatch gets the child signal; disconnects still propagate,
 * while the route can distinguish its own timeout and render stable copy.
 */
export function createVoiceBrainFirstEventDeadline(
  parentSignal: AbortSignal,
  timeoutMs = VOICE_BRAIN_FIRST_EVENT_TIMEOUT_MS,
): VoiceBrainFirstEventDeadline {
  const controller = new AbortController();
  let timedOut = false;
  let settled = false;

  const clearDeadline = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
  };
  const abortFromParent = (): void => {
    clearDeadline();
    controller.abort(parentSignal.reason);
  };

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    timedOut = true;
    controller.abort(new DOMException('voice brain first event timed out', 'TimeoutError'));
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener('abort', abortFromParent, { once: true });

  return {
    signal: controller.signal,
    observeEvent: clearDeadline,
    didTimeout: () => timedOut,
    dispose: () => {
      clearDeadline();
      parentSignal.removeEventListener('abort', abortFromParent);
    },
  };
}
