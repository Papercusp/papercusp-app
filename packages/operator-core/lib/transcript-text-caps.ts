/**
 * The ONE cap governing how much of a transcript part survives to a reader,
 * plus the per-kind STORE caps derived from it.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * These numbers used to live apart, in packages that never imported each other:
 * the render budget as `THINKING_ENTRY_TEXT_CAP` (8,000) in the harness stream
 * route, and the store cap as `PART_TEXT_CAP` (2,000) in session-ingest. Nothing
 * but a COMMENT tied them together — session-ingest justified its 2,000 with
 *
 *     "The render pane caps at THINKING_ENTRY_TEXT_CAP anyway,
 *      so a wider store would buy nothing a reader can see."
 *
 * — while that pane's actual budget was FOUR TIMES the store's. So every prose
 * part between 2,000 and 8,000 chars was destroyed at ingest to save bytes the
 * reader was always entitled to see, and the comment asserting otherwise read
 * as a justification rather than the drift alarm it actually was.
 *
 * Measured when it was found (2026-08-16, EI-20637908167729753): 129,472 of
 * 766,895 stored parts — 16.9% of the whole transcript store — carried a
 * truncation marker, and a 7,051-char audit written FOR the owner rendered in
 * the session viewer with 5,051 chars missing, despite being comfortably inside
 * the pane's own 8,000-char budget.
 *
 * A COMMENT CANNOT HOLD AN INVARIANT. The render budget is now the single
 * source of truth and the store caps DERIVE from it, so widening the pane's
 * budget widens the store with it and the two cannot silently drift apart
 * again. `transcript-text-caps.test.ts` pins that relationship, and pins it by
 * BEHAVIOUR (feed the ingest cleaner a body sized from the render cap) rather
 * than by asserting two constants are equal — a name-only test would pass
 * against two independently-hardcoded copies, which is the bug it is meant to
 * catch.
 */

/**
 * THE canonical cap: how many characters of a single transcript entry the
 * timeline pane will render. Everything else here derives from it — change it
 * HERE and the store follows.
 */
export const TRANSCRIPT_RENDER_TEXT_CAP = 8_000;

/** The faithful-render part kinds stored in `harness_shared.session_turn_parts`. */
export type TranscriptPartKind = 'text' | 'thinking' | 'tool_use' | 'tool_result';

/**
 * PROSE parts — the assistant's own words and reasoning, which a human READS in
 * the pane. Stored to the full render budget: anything the pane would show, the
 * store keeps.
 */
export const PART_TEXT_CAP_PROSE = TRANSCRIPT_RENDER_TEXT_CAP;

/**
 * TOOL payloads — deliberately tighter than prose, and this cap IS load-bearing:
 * measured over 7 real days of claude JSONL (443,595 lines), `tool_result` alone
 * was 218 MB against text's 21 MB, and capping at 2k recovered 61% of it.
 *
 * Keeping this tight is only honest because a truncated tool payload stays
 * RECOVERABLE while the session's JSONL is on disk — the harness stream route
 * detects a store-truncated part and serves the verbatim file instead (see
 * `backfillFromSessionParts` / `storeTruncated`). The pane therefore degrades
 * to the file rather than to a lie.
 */
export const PART_TEXT_CAP_TOOL = 2_000;

/** The store cap for one part kind. Prose gets the render budget; tools get the volume cap. */
export function partTextCapFor(kind: TranscriptPartKind): number {
  return kind === 'tool_use' || kind === 'tool_result' ? PART_TEXT_CAP_TOOL : PART_TEXT_CAP_PROSE;
}

/**
 * The single spelling of the truncation marker, used by BOTH the ingest cleaner
 * and the render capper — and matched by `TRUNCATION_MARKER_POSIX_RE` below.
 * One definition, so a reader-facing string and the query that detects it can
 * never disagree.
 */
export function truncationMarker(omittedChars: number): string {
  return `… [truncated ${omittedChars} chars]`;
}

/**
 * POSIX-regex form of `truncationMarker`, for the SQL that asks "was this row
 * truncated when it was STORED?". Kept beside the writer on purpose: if the
 * marker text ever changes, both sides are in this file and change together.
 */
export const TRUNCATION_MARKER_POSIX_RE = '… \\[truncated [0-9]+ chars\\]$';

/** Apply a cap, marking the truncation rather than silently cutting. */
export function capWithMarker(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}${truncationMarker(text.length - cap)}` : text;
}
