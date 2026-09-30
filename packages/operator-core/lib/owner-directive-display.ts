/**
 * owner-directive-display — the ONE display rule for an owner directive's text
 * on every agent surface (D-004 of owner-directive-delivery-redesign-2026-09-22).
 *
 * PURE and dependency-free on purpose: the turn-start Orientation renders on a
 * hot path that must not statically load the database client, and every other
 * surface (the 📌 block, orders:list, the obligation rows) must apply the SAME
 * rule — two hand-spelled copies of a display rule drift into two different
 * renderings of the same owner sentence.
 */

/**
 * A directive at or under this many chars renders VERBATIM, in full, on every
 * surface; a longer one renders its agent-written summary instead. Chosen from
 * the measured length distribution (60% of captures are ≤ 500 chars; raising it
 * to 800 would cover only 3% more).
 */
export const OWNER_DIRECTIVE_VERBATIM_CAP = 500;
/** The forced summary of an over-cap directive is at most this long (a DB CHECK enforces it too). */
export const OWNER_DIRECTIVE_SUMMARY_MAX = 200;

export interface DirectiveDisplayInput {
  id: number;
  verbatimText: string;
  summaryText?: string | null;
  summaryBy?: string | null;
}

/** True when a directive is too long to render verbatim and therefore needs an agent-written summary. */
export function directiveNeedsSummary(row: Pick<DirectiveDisplayInput, 'verbatimText'>): boolean {
  return row.verbatimText.trim().length > OWNER_DIRECTIVE_VERBATIM_CAP;
}

/** The 12-char session handle every directive line uses. */
export function shortOwner(ownerId: string): string {
  return ownerId.length > 12 ? ownerId.slice(0, 12) : ownerId;
}

/**
 * D-004(1) of directive-ownership-clarity-2026-09-23: identical text pasted into
 * N sessions stays N rows, one per addressee, each closed independently — so a
 * row whose text is also open for other sessions says so. `n` counts OTHER
 * sessions holding an OPEN copy (a closed copy can no longer be closed by
 * mistake). Empty for 0/unknown, so an undecorated line never claims "unique".
 */
export function alsoSentToNote(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  return ` (also sent to ${n} other session${n === 1 ? '' : 's'}; each copy is its own addressee's to close)`;
}

/**
 * Nothing is truncated: a directive of at most OWNER_DIRECTIVE_VERBATIM_CAP
 * chars renders the owner's words in full; a longer one renders its agent
 * summary, labeled with its author so it is never mistaken for owner speech,
 * or an explicit placeholder while no summary exists. A cut fragment of the
 * owner's words is never rendered: it reads as the whole order and is not.
 */
export function directiveDisplayText(row: DirectiveDisplayInput): string {
  const text = row.verbatimText.trim();
  if (text.length <= OWNER_DIRECTIVE_VERBATIM_CAP) return JSON.stringify(text);
  if (row.summaryText) {
    return `summary by ${shortOwner(row.summaryBy ?? 'unknown')}: ${JSON.stringify(row.summaryText)} [full text: orders:get #${row.id}]`;
  }
  return `long message (${text.length} chars), summary not written yet [full text: orders:get #${row.id}]`;
}
