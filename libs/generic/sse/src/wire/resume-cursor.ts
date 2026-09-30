/**
 * Resume cursor carried in the STREAM URL (WI-2141694).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The SSE spec resumes a stream with the `Last-Event-ID` REQUEST HEADER, and
 * the browser sets that header itself — but only when *it* reconnects an
 * EventSource instance it already owns. It is instance state.
 *
 * Every deliberate close in `resilient-event-source.ts` ends that instance and
 * later builds a NEW `EventSource(url)`, which starts with an empty last-event
 * id and therefore sends NO header. That is not a corner case: it is the
 * visibility-pause path (already shipping), the bfcache `pagehide`/`pageshow`
 * path, the zombie watchdog rebuild, the backoff reconnect, and `reconnect()`.
 * A browser EventSource cannot be given custom headers, so the cursor has
 * nowhere to travel except the URL.
 *
 * The consequence was quiet in both directions, which is why it survived:
 *   - endpoint SUPPLIES `replay` ⇒ the server sees no cursor, so `sinceId` is
 *     0 and it replays the WHOLE ring buffer — silent RE-DELIVERY of events
 *     the client already handled;
 *   - endpoint supplies NO `replay` ⇒ the resumed stream simply starts at
 *     "now" — a silent GAP over whatever was emitted while paused.
 * Neither errors, and `lei-reconnect-resume.test.ts` could not catch either:
 * it drives a raw HTTP client that sets the header by hand, so it proves the
 * SERVER resumes correctly and never exercises the client wrapper at all.
 *
 * ── WHY A SHARED CONSTANT RATHER THAN TWO STRING LITERALS ──────────────────
 * The reader (server) and the writer (client) live in different trees and are
 * tested separately. A param name spelled in two places is a second copy of a
 * truth one side owns, and it drifts silently: the client keeps appending a
 * cursor the server stops reading, and the failure mode is once again a
 * successful-looking stream that replays or skips. Both sides import THIS.
 */

/**
 * Query-parameter name carrying the last event id a client has already
 * processed. Semantics are identical to the `Last-Event-ID` header: "resume
 * AFTER this id". The header still WINS when both are present, so the
 * browser's own native reconnect is never second-guessed.
 */
export const RESUME_CURSOR_PARAM = 'lastEventId';

/**
 * Append the resume cursor to a stream URL.
 *
 * Takes the PRISTINE url every time and returns a new string — it never
 * mutates or re-reads its own output, so repeated reconnects cannot
 * accumulate `?lastEventId=3&lastEventId=7&…`. Deliberately string-based
 * rather than `new URL()`: stream urls here are frequently relative
 * ('/api/sync/stream'), and `new URL()` needs a base that is not available in
 * a non-DOM host.
 */
export function withResumeCursor(url: string, cursor: string | null | undefined): string {
  if (cursor == null || cursor === '') return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${RESUME_CURSOR_PARAM}=${encodeURIComponent(cursor)}`;
}
