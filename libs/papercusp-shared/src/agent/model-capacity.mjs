// Dependency-free source shared by the TypeScript turn taxonomy and the
// standalone interactive PTY bootstrap. Keep the signature defined once.
export const MODEL_CAPACITY_RETRY_AFTER_MS = 60_000;
export const MODEL_CAPACITY_RE = /\bselected\s+model\s+is\s+at\s+capacity\b/i;

const RETRY_AFTER_RE =
  /(?:retry after|try again in|wait)\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds|m|min|minutes|ms)?/i;
const MODEL_CAPACITY_LINE_RE = new RegExp(
  '^[\\s\\W]{0,8}(?:API Error:\\s*)?' + MODEL_CAPACITY_RE.source,
  'i',
);
const DEFAULT_DETECTOR_BUFFER_CHARS = 8_192;

/** Keep the shared one-minute minimum while honoring a longer CLI hint. */
export function modelCapacityRetryAfterMs(text) {
  const retryHint = RETRY_AFTER_RE.exec(String(text ?? ''));
  if (!retryHint) return MODEL_CAPACITY_RETRY_AFTER_MS;

  const value = Number.parseFloat(retryHint[1]);
  const unit = (retryHint[2] ?? 's').toLowerCase();
  const parsedMs = unit.startsWith('ms')
    ? value
    : unit.startsWith('m')
      ? value * 60_000
      : value * 1_000;
  return Number.isFinite(parsedMs)
    ? Math.max(MODEL_CAPACITY_RETRY_AFTER_MS, parsedMs)
    : MODEL_CAPACITY_RETRY_AFTER_MS;
}

/**
 * Classify only a line that begins with the shared capacity signature. The PTY
 * also carries ordinary assistant prose, so scanning arbitrary text would turn
 * a discussion of the error into a false wall. Callers should normalize ANSI
 * and carriage returns before passing the live terminal stream.
 */
export function modelCapacityLineMatch(text) {
  for (const line of String(text ?? '').split(/\n/)) {
    if (!MODEL_CAPACITY_LINE_RE.test(line)) continue;
    return {
      errorClass: 'rate_limited',
      retryable: true,
      retryAfterMs: modelCapacityRetryAfterMs(line),
      matchedPattern: String(MODEL_CAPACITY_RE),
      matchedExcerpt: line.replace(/\s+/g, ' ').trim().slice(0, 200),
    };
  }
  return null;
}

/**
 * Detect a capacity line across arbitrary PTY chunk boundaries. Repeated TUI
 * paints of the same still-visible line produce one edge; the bounded buffer
 * forgets old output so a later independent capacity line can be classified.
 */
export function makeModelCapacityDetector({ maxBufferChars = DEFAULT_DETECTOR_BUFFER_CHARS } = {}) {
  const cap =
    Number.isFinite(Number(maxBufferChars)) && Number(maxBufferChars) > 0
      ? Math.max(256, Math.floor(Number(maxBufferChars)))
      : DEFAULT_DETECTOR_BUFFER_CHARS;
  let recentOutput = '';
  let activeExcerpt = null;

  return {
    observe(text) {
      recentOutput += String(text ?? '').replace(/\r\n?/g, '\n');
      if (recentOutput.length > cap) {
        const trimmed = recentOutput.slice(-cap);
        const firstLineEnd = trimmed.indexOf('\n');
        recentOutput = firstLineEnd < 0 ? '' : trimmed.slice(firstLineEnd + 1);
      }

      const hit = modelCapacityLineMatch(recentOutput);
      if (!hit) {
        activeExcerpt = null;
        return null;
      }
      if (hit.matchedExcerpt === activeExcerpt) return null;
      activeExcerpt = hit.matchedExcerpt;
      return hit;
    },
    reset() {
      recentOutput = '';
      activeExcerpt = null;
    },
  };
}
